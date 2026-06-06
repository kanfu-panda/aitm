//! 流式 OSC 7 解析器（v0.9.0 T3）。
//!
//! 增量喂入 PTY raw bytes，识别 OSC 7（shell 主动汇报 cwd 的事实标准）并吐出绝对路径。
//!
//! ## 协议
//!
//! ```text
//! OSC 7 ; <payload> ST
//! ```
//!
//! 其中：
//! - OSC 引导：`ESC ] 7 ;`（`ESC` = 0x1B）
//! - `<payload>` 支持两种 shell 习惯：
//!   1. **file:// URI**：`file://<host>/<absolute-path>`（zsh / bash 在 Linux/macOS 默认；
//!      VTE 系终端也用这种）。`<host>` 通常是 hostname，aitm 不校验，直接丢；`<path>`
//!      做 URL 解码（`%XX` → byte）后用 UTF-8 解释。
//!   2. **`~/...` 字面量**：少数 macOS zsh 配置在 `chpwd` 钩子里直接 `print -nP '\e]7;~/%d\a'`，
//!      payload 为 `~/<rest>` 而非 `file://`。aitm 用 [`dirs::home_dir`] 还原 `~` 到 `$HOME`。
//! - 终止符（ST）支持两种：`BEL`（0x07，xterm 兼容）+ `ESC \`（0x1B 0x5C，正经 ST）。
//!
//! ## 状态机
//!
//! ```text
//! Idle      → ESC → Esc
//! Esc       → ']' → Osc（清 buffer）
//! Esc       → 其他 → Idle（透传）
//! Osc       → '7' → Osc7Param（继续收集 payload 头部 '7'）
//! Osc       → 其他数字 / 字符 → Idle（不关心的 OSC 类型，丢弃）
//! Osc7Param → BEL → 解析 payload 后 → Idle
//! Osc7Param → ESC → EscEnd
//! Osc7Param → 其他 → 累加进 buffer
//! EscEnd    → '\\' (0x5C) → 解析 payload 后 → Idle
//! EscEnd    → 其他 → 把 ESC + 本字符都回退到 buffer，回 Osc7Param
//! ```
//!
//! ## 安全
//!
//! - `max_buffer`（默认 4096 字节）：单条 OSC 7 payload 超长 → 整段丢弃 + 回 Idle。
//!   防止恶意 / 损坏输入吃光内存。
//! - OSC 0 / 1 / 8 / 9 / 99 / 777 等其他 OSC 序列**安静跳过**，不报错也不吐事件。
//!   （OSC 9/99/777 由 `notifications::OscParser` 处理；两套解析器并行喂同一份字节流。）
//!
//! ## 用例
//!
//! ```ignore
//! let mut parser = Osc7Parser::new();
//! let chunk = b"\x1b]7;file:///Users/leo/code/aitm\x07";
//! if let Some(cwd) = parser.feed(chunk) {
//!     assert_eq!(cwd, "/Users/leo/code/aitm");
//! }
//! ```

const ESC: u8 = 0x1B;
const BEL: u8 = 0x07;
const BACKSLASH: u8 = 0x5C;

/// 默认单条 OSC 7 payload 上限（字节）。超出 → 整段丢弃 + 回 Idle。
const DEFAULT_MAX_BUFFER: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    /// 普通字节流，等 ESC。
    Idle,
    /// 看到 ESC，等下一字符确认是 `]`。
    Esc,
    /// 在 `ESC ]` 之后，等 OSC 类型码首字符（决定是不是 7）。
    Osc,
    /// 已确认是 OSC 7，正在收集 payload（不含 `7;` 前缀的剩余部分）。
    Osc7Param,
    /// 在 OSC 7 内看到 ESC，等下一字符确认是不是 `\`（构成 ST 终止）。
    EscEnd,
}

/// 流式 OSC 7 解析器。
pub struct Osc7Parser {
    state: State,
    buffer: Vec<u8>,
    max_buffer: usize,
    /// 已收到 OSC 头的第几个字符：判定到底是 OSC 7 还是 OSC 70/77/...
    /// 进入 Osc 状态后第一个字符决定走向。
    seen_semicolon: bool,
}

impl Default for Osc7Parser {
    fn default() -> Self {
        Self::new()
    }
}

impl Osc7Parser {
    pub fn new() -> Self {
        Self::new_with_limit(DEFAULT_MAX_BUFFER)
    }

    pub fn new_with_limit(max_buffer: usize) -> Self {
        Self {
            state: State::Idle,
            buffer: Vec::with_capacity(256),
            max_buffer,
            seen_semicolon: false,
        }
    }

    /// 重置到 Idle，清 buffer。用于 payload 超长 / 终止 / 异常回退。
    fn reset(&mut self) {
        self.state = State::Idle;
        self.buffer.clear();
        self.seen_semicolon = false;
    }

    /// 增量喂入字节，返回本次解析出的绝对路径（最后一个），或 None。
    ///
    /// **返回最后一个**：单次 feed 内可能包含多次 OSC 7（极少见，比如 shell 连续两个
    /// chpwd），调用方只关心当前 cwd 即返回最新那个就够；中间状态丢弃节流。
    pub fn feed(&mut self, bytes: &[u8]) -> Option<String> {
        let mut latest: Option<String> = None;
        for &b in bytes {
            if let Some(path) = self.step(b) {
                latest = Some(path);
            }
        }
        latest
    }

    fn step(&mut self, b: u8) -> Option<String> {
        match self.state {
            State::Idle => {
                if b == ESC {
                    self.state = State::Esc;
                }
                // 其他字节透传，不处理
                None
            }
            State::Esc => {
                if b == b']' {
                    self.state = State::Osc;
                    self.buffer.clear();
                    self.seen_semicolon = false;
                } else {
                    // ESC + 非 `]` 是别的 ANSI 序列（CSI/DCS 等），回 Idle
                    self.state = State::Idle;
                }
                None
            }
            State::Osc => {
                // 进入 OSC 后第一段是类型码 + ';'。我们只关心 '7;'。
                // 任何其他 OSC（0/1/8/9/99/777/...）= 跳过整条直到终止符。
                if b == b'7' && !self.seen_semicolon && self.buffer.is_empty() {
                    // 仅当 buffer 还没收到字符时第一字符是 '7' 才可能是 OSC 7
                    self.buffer.push(b'7');
                    None
                } else if b == b';' && self.buffer == [b'7'] {
                    // OSC 7 ; — 进入 payload
                    self.buffer.clear();
                    self.seen_semicolon = true;
                    self.state = State::Osc7Param;
                    None
                } else if b == BEL || (b == ESC) {
                    // 非 OSC 7 整段结束（BEL 或 ESC \\）—— 安静吞掉
                    // ESC 情况我们简单回 Idle；后续若立刻又 ESC ] 也能重新进 OSC
                    self.reset();
                    None
                } else {
                    // 还在收集类型码，但已经不是 '7;' → 不关心，吞到终止
                    // 把 buffer 转用来缓存"不关心 OSC 的 payload"也行；为简单：直接累计字符限长
                    self.buffer.push(b);
                    if self.buffer.len() > self.max_buffer {
                        self.reset();
                    }
                    None
                }
            }
            State::Osc7Param => {
                if b == BEL {
                    let result = self.finish_payload();
                    self.reset();
                    result
                } else if b == ESC {
                    self.state = State::EscEnd;
                    None
                } else {
                    self.buffer.push(b);
                    if self.buffer.len() > self.max_buffer {
                        // 超长 → 整段丢弃
                        self.reset();
                    }
                    None
                }
            }
            State::EscEnd => {
                if b == BACKSLASH {
                    // ESC \ — String Terminator，完成
                    let result = self.finish_payload();
                    self.reset();
                    result
                } else {
                    // ESC 后不是 '\\'，说明 ESC 是 payload 一部分 + 本字符也是
                    // payload。回填 ESC + 本字符，回到 Osc7Param 继续。
                    self.buffer.push(ESC);
                    self.buffer.push(b);
                    self.state = State::Osc7Param;
                    if self.buffer.len() > self.max_buffer {
                        self.reset();
                    }
                    None
                }
            }
        }
    }

    /// 解析当前 buffer 为绝对路径。失败（空 / 解析不出）返 None。
    fn finish_payload(&self) -> Option<String> {
        let payload = std::str::from_utf8(&self.buffer).ok()?;
        let trimmed = payload.trim();
        if trimmed.is_empty() {
            return None;
        }
        parse_osc7_payload(trimmed)
    }
}

/// 把 OSC 7 的 payload 文本解析成绝对路径字符串。
///
/// 支持：
/// - `file://<host>/<absolute>`：剥 `file://`、扔掉 `host`、URL 解码 path
/// - `~/<rest>` 或 `~`：用 `dirs::home_dir()` 还原
fn parse_osc7_payload(payload: &str) -> Option<String> {
    // 1) file:// 形式
    if let Some(after_scheme) = payload.strip_prefix("file://") {
        // file:// 后面可能跟 host（可以是空串、`localhost`、hostname）。
        // 第一个 `/` 是 path 开始。
        let path_part = match after_scheme.find('/') {
            Some(idx) => &after_scheme[idx..],
            None => {
                // file://hostname（没 path）不接受
                return None;
            }
        };
        let decoded = url_decode(path_part)?;
        if decoded.is_empty() || !decoded.starts_with('/') {
            return None;
        }
        return Some(decoded);
    }

    // 2) ~ / ~/ 形式
    if payload == "~" {
        return dirs::home_dir().map(|p| p.to_string_lossy().into_owned());
    }
    if let Some(rest) = payload.strip_prefix("~/") {
        let home = dirs::home_dir()?;
        let mut out = home.to_string_lossy().into_owned();
        if !out.ends_with('/') {
            out.push('/');
        }
        out.push_str(rest);
        return Some(out);
    }

    // 其他形式（裸绝对路径 / 相对 / Windows C:）暂不接受——OSC 7 协议强制 file://
    None
}

/// 简易 URL 解码：把 `%XX` 还原成单字节，其余字符原样保留。
/// 失败（`%` 后不是合法 hex）→ None。最终用 UTF-8 解释 byte 序列；不是合法 UTF-8 也回 None。
fn url_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let h = hex_byte(bytes[i + 1])?;
            let l = hex_byte(bytes[i + 2])?;
            out.push((h << 4) | l);
            i += 3;
        } else {
            out.push(b);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn hex_byte(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 完整_file_uri_bel_终止() {
        let mut p = Osc7Parser::new();
        let chunk = b"\x1b]7;file:///Users/leo/code/aitm\x07";
        let got = p.feed(chunk);
        assert_eq!(got.as_deref(), Some("/Users/leo/code/aitm"));
    }

    #[test]
    fn 完整_file_uri_st_终止() {
        let mut p = Osc7Parser::new();
        // ESC \ 作为 ST 终止
        let chunk = b"\x1b]7;file:///tmp/aitm-test\x1b\\";
        let got = p.feed(chunk);
        assert_eq!(got.as_deref(), Some("/tmp/aitm-test"));
    }

    #[test]
    fn chunk_跨多次_feed() {
        let mut p = Osc7Parser::new();
        // 分四段喂入：每次只送一部分
        assert_eq!(p.feed(b"\x1b]7;file://"), None);
        assert_eq!(p.feed(b"localhost"), None);
        assert_eq!(p.feed(b"/Users/leo/proj"), None);
        let got = p.feed(b"ects/aitm\x07");
        assert_eq!(got.as_deref(), Some("/Users/leo/projects/aitm"));
    }

    #[test]
    fn 含噪音_前后混杂普通输出() {
        let mut p = Osc7Parser::new();
        let mut buf = Vec::new();
        buf.extend_from_slice(b"random shell output line 1\n");
        buf.extend_from_slice(b"$ pwd\n");
        buf.extend_from_slice(b"\x1b]7;file:///home/leo/x\x07");
        buf.extend_from_slice(b"prompt> ");
        let got = p.feed(&buf);
        assert_eq!(got.as_deref(), Some("/home/leo/x"));
    }

    #[test]
    fn 超_max_buffer_整段丢弃() {
        let mut p = Osc7Parser::new_with_limit(32);
        let mut buf = Vec::new();
        buf.extend_from_slice(b"\x1b]7;file:///");
        // 50 字符路径，超过 32 上限 → 丢弃，不吐结果
        buf.extend_from_slice(&[b'a'; 50]);
        buf.extend_from_slice(b"\x07");
        assert_eq!(p.feed(&buf), None);

        // 后续正常 OSC 7 还能继续解析（状态机正确回 Idle）
        let ok = b"\x1b]7;file:///ok\x07";
        assert_eq!(p.feed(ok).as_deref(), Some("/ok"));
    }

    #[test]
    fn osc_0_和_osc_1_忽略() {
        let mut p = Osc7Parser::new();
        // OSC 0 = set window title + icon name
        let osc0 = b"\x1b]0;my-window-title\x07";
        assert_eq!(p.feed(osc0), None);
        // OSC 1 = set icon name
        let osc1 = b"\x1b]1;icon-name\x07";
        assert_eq!(p.feed(osc1), None);
        // 然后正常 OSC 7
        let osc7 = b"\x1b]7;file:///z\x07";
        assert_eq!(p.feed(osc7).as_deref(), Some("/z"));
    }

    #[test]
    fn url_encode_中文路径_正确解码() {
        let mut p = Osc7Parser::new();
        // /中/proj → /%E4%B8%AD/proj（UTF-8 3 字节）
        let chunk = b"\x1b]7;file:///%E4%B8%AD/proj\x07";
        let got = p.feed(chunk);
        assert_eq!(got.as_deref(), Some("/中/proj"));
    }

    #[test]
    fn url_encode_空格_正确解码() {
        let mut p = Osc7Parser::new();
        let chunk = b"\x1b]7;file:///Users/leo/My%20Code\x07";
        let got = p.feed(chunk);
        assert_eq!(got.as_deref(), Some("/Users/leo/My Code"));
    }

    #[test]
    fn tilde_展开_使用_home_dir() {
        let mut p = Osc7Parser::new();
        let chunk = b"\x1b]7;~/proj/aitm\x07";
        let got = p.feed(chunk);
        let home = dirs::home_dir().expect("test 需要 HOME");
        let expected = format!(
            "{}{}proj/aitm",
            home.to_string_lossy(),
            if home.to_string_lossy().ends_with('/') {
                ""
            } else {
                "/"
            }
        );
        assert_eq!(got.as_deref(), Some(expected.as_str()));
    }

    #[test]
    fn 裸_tilde_展开为_home() {
        let mut p = Osc7Parser::new();
        let chunk = b"\x1b]7;~\x07";
        let got = p.feed(chunk);
        let home = dirs::home_dir().expect("test 需要 HOME");
        assert_eq!(got, Some(home.to_string_lossy().into_owned()));
    }

    #[test]
    fn 空_payload_拒绝() {
        let mut p = Osc7Parser::new();
        // OSC 7 ; <空> BEL
        let chunk = b"\x1b]7;\x07";
        assert_eq!(p.feed(chunk), None);
    }

    #[test]
    fn host_中间含_user_片段_仍然解析_path() {
        let mut p = Osc7Parser::new();
        // file://hostname/path 形式（hostname 段非空）
        let chunk = b"\x1b]7;file://mac.local/Users/leo/x\x07";
        let got = p.feed(chunk);
        assert_eq!(got.as_deref(), Some("/Users/leo/x"));
    }

    #[test]
    fn 连续两次_osc7_返回最后一个() {
        let mut p = Osc7Parser::new();
        let mut buf = Vec::new();
        buf.extend_from_slice(b"\x1b]7;file:///old\x07");
        buf.extend_from_slice(b"some output\n");
        buf.extend_from_slice(b"\x1b]7;file:///new\x07");
        let got = p.feed(&buf);
        // feed 内部聚合多次结果，返回最新的（避免抖动）
        assert_eq!(got.as_deref(), Some("/new"));
    }

    #[test]
    fn 非法_url_编码_失败_返_none_后续仍能恢复() {
        let mut p = Osc7Parser::new();
        // %ZZ 不是合法 hex
        let chunk = b"\x1b]7;file:///bad%ZZpath\x07";
        assert_eq!(p.feed(chunk), None);
        // 后续合法的 OSC 7 仍能解析
        let ok = b"\x1b]7;file:///ok\x07";
        assert_eq!(p.feed(ok).as_deref(), Some("/ok"));
    }

    #[test]
    fn 截断未终止_不返回_保持状态() {
        let mut p = Osc7Parser::new();
        // 只送 OSC 7 头 + 部分 path，没终止符
        assert_eq!(p.feed(b"\x1b]7;file:///part"), None);
        // 再喂剩余 + 终止
        assert_eq!(p.feed(b"ial\x07").as_deref(), Some("/partial"));
    }

    #[test]
    fn url_decode_无_percent_原样返回() {
        assert_eq!(url_decode("plain/text").as_deref(), Some("plain/text"));
    }

    #[test]
    fn url_decode_percent_后字符不足_返_none() {
        assert_eq!(url_decode("abc%2"), None);
        assert_eq!(url_decode("abc%"), None);
    }
}
