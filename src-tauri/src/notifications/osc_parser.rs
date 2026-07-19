//! 流式 OSC 通知协议解析器（plan §3.2）。
//!
//! 增量喂入 PTY raw bytes，吐出 [`NotificationEvent`]。处理三种 OSC 序列：
//!
//! | 协议    | 格式                                            | 流派 / 用例                |
//! |---------|-------------------------------------------------|----------------------------|
//! | OSC 9   | `ESC ] 9 ; <msg> BEL`                           | iTerm2 + cmux + VS Code    |
//! | OSC 99  | `ESC ] 99 ; level=warning ; <msg> BEL`          | cmux 自定义带 metadata     |
//! | OSC 777 | `ESC ] 777 ; notify ; <title> ; <body> BEL`     | urxvt notify-send 流派     |
//!
//! ESC = 0x1B，BEL = 0x07，ST (String Terminator) = `ESC \`（0x1B 0x5C）。
//! 两种 terminator 都支持。
//!
//! 状态机：
//! ```text
//! Normal   → 遇 ESC → SeenEsc
//! SeenEsc  → 遇 ] → InsideOsc（清 buffer）
//! SeenEsc  → 其他 → Normal（透传，可能是其他 ANSI 序列）
//! InsideOsc → 遇 BEL → parse + Normal
//! InsideOsc → 遇 ESC → InsideOscEsc
//! InsideOsc → 其他 → 收到 buffer
//! InsideOscEsc → 遇 \ (0x5C) → parse + Normal（ST 结束）
//! InsideOscEsc → 其他 → 把 ESC + 本字符都放回 buffer 继续 InsideOsc
//! ```
//!
//! 安全保护：buffer 超 8192 字节强制清 + 回 Normal（防恶意输入 DoS）。

use std::time::{SystemTime, UNIX_EPOCH};

use crate::notifications::types::{NotificationEvent, NotificationLevel, NotificationSource};

/// OSC 序列最大长度（buffer 大小上限，防 DoS）
const MAX_OSC_LEN: usize = 8192;

const ESC: u8 = 0x1B;
const BEL: u8 = 0x07;
const BACKSLASH: u8 = 0x5C;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ParserState {
    Normal,
    /// 看到 ESC，等下一个字节看是不是 `]`
    SeenEsc,
    /// 在 OSC payload 内，收集 bytes
    InsideOsc,
    /// 在 OSC 内看到 ESC，等下一字符看是不是 `\`（ST）
    InsideOscEsc,
    /// OSC 超长被丢弃后，吞掉剩余 payload 直到终结符（BEL 或 ST）。
    /// 不能直接回 Normal：否则被丢弃 OSC 的终结符 BEL 会被误判成孤立响铃
    DiscardOsc,
    /// 在 DiscardOsc 内看到 ESC，等下一字符看是不是 `\`（ST）
    DiscardOscEsc,
}

pub struct OscParser {
    state: ParserState,
    buffer: Vec<u8>,
    session_id: String,
}

impl OscParser {
    pub fn new(session_id: String) -> Self {
        Self {
            state: ParserState::Normal,
            buffer: Vec::with_capacity(256),
            session_id,
        }
    }

    /// 增量喂入字节，返回本次解析出的 0 个或多个事件。
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<NotificationEvent> {
        let mut events = Vec::new();
        // 同一 chunk 内多个孤立 BEL 合并为 1 个 Bell 事件，防 PTY 刷屏
        // （如 `printf '\a\a\a'`）触发事件风暴；前端 markUnread 另有 200ms 节流
        let mut bell_seen = false;

        for &b in bytes {
            match self.state {
                ParserState::Normal => {
                    if b == ESC {
                        self.state = ParserState::SeenEsc;
                    } else if b == BEL && !bell_seen {
                        // 孤立 BEL = 终端响铃（OSC 内的 BEL 是终结符，走 InsideOsc
                        // 分支不会到这里）。macOS Terminal 以响铃点亮 Dock 角标，
                        // Claude Code 等 CLI 完成时正是靠它提示，aitm 对齐该语义
                        bell_seen = true;
                        events.push(NotificationEvent {
                            session_id: self.session_id.clone(),
                            level: NotificationLevel::Done,
                            message: String::new(),
                            source: NotificationSource::Bell,
                            timestamp_ms: now_ms(),
                        });
                    }
                    // 其他普通字符透传，不收集
                }
                ParserState::SeenEsc => {
                    if b == b']' {
                        self.state = ParserState::InsideOsc;
                        self.buffer.clear();
                    } else {
                        // ESC 后面不是 `]`，可能是其他 ANSI 序列（CSI / DCS 等），不关心
                        self.state = ParserState::Normal;
                    }
                }
                ParserState::InsideOsc => {
                    if b == BEL {
                        if let Some(event) = self.parse_payload() {
                            events.push(event);
                        }
                        self.reset();
                    } else if b == ESC {
                        self.state = ParserState::InsideOscEsc;
                    } else {
                        self.buffer.push(b);
                        if self.buffer.len() > MAX_OSC_LEN {
                            // 防 DoS：超长丢弃，进 DiscardOsc 吞到终结符为止
                            self.discard();
                        }
                    }
                }
                ParserState::InsideOscEsc => {
                    if b == BACKSLASH {
                        // ESC \ = ST，OSC 结束
                        if let Some(event) = self.parse_payload() {
                            events.push(event);
                        }
                        self.reset();
                    } else {
                        // 虚惊一场，把 ESC 还原回 buffer 继续收集
                        self.buffer.push(ESC);
                        self.buffer.push(b);
                        self.state = ParserState::InsideOsc;
                        if self.buffer.len() > MAX_OSC_LEN {
                            self.discard();
                        }
                    }
                }
                ParserState::DiscardOsc => {
                    if b == BEL {
                        self.reset();
                    } else if b == ESC {
                        self.state = ParserState::DiscardOscEsc;
                    }
                    // 其他字节继续吞
                }
                ParserState::DiscardOscEsc => {
                    if b == BACKSLASH {
                        // ESC \ = ST，被丢弃 OSC 终于结束
                        self.reset();
                    } else {
                        self.state = ParserState::DiscardOsc;
                    }
                }
            }
        }

        events
    }

    /// 解析当前 buffer 内容；失败返 None
    fn parse_payload(&self) -> Option<NotificationEvent> {
        // buffer 格式：`<NUM> ; <rest>`
        // 找第一个 `;`
        let semi_pos = self.buffer.iter().position(|&b| b == b';')?;
        let num_bytes = &self.buffer[..semi_pos];
        let rest = &self.buffer[semi_pos + 1..];

        let num_str = std::str::from_utf8(num_bytes).ok()?;
        let osc_num: u32 = num_str.parse().ok()?;

        let rest_str = std::str::from_utf8(rest).ok()?;

        let (level, source, message) = match osc_num {
            9 => (
                NotificationLevel::Done,
                NotificationSource::Osc9,
                rest_str.to_string(),
            ),
            99 => parse_osc_99(rest_str),
            777 => parse_osc_777(rest_str)?,
            _ => return None, // 其他 OSC 数字不在范围
        };

        Some(NotificationEvent {
            session_id: self.session_id.clone(),
            level,
            message,
            source,
            timestamp_ms: now_ms(),
        })
    }

    fn reset(&mut self) {
        self.buffer.clear();
        self.state = ParserState::Normal;
    }

    /// 超长 OSC 丢弃：清 buffer + 进 DiscardOsc 吞掉剩余 payload 和终结符
    fn discard(&mut self) {
        self.buffer.clear();
        self.state = ParserState::DiscardOsc;
    }
}

/// OSC 99 payload：`key1=value1;key2=value2;...;<message>`
///
/// `key=value` 段解析 `level=warning|error` 决定 NotificationLevel。
/// 最后一段（无 `=` 的段）作为 message。
/// 解析失败（如键值乱码）→ level 默认 Done，整段作为 message。
fn parse_osc_99(payload: &str) -> (NotificationLevel, NotificationSource, String) {
    let segments: Vec<&str> = payload.split(';').collect();
    let mut level = NotificationLevel::Done;
    let mut message_segments: Vec<&str> = Vec::new();

    for seg in &segments {
        if let Some((k, v)) = seg.split_once('=') {
            // 是合法 key=value 段
            if k.trim().eq_ignore_ascii_case("level") {
                level = match v.trim().to_ascii_lowercase().as_str() {
                    "warning" => NotificationLevel::Waiting,
                    "error" => NotificationLevel::Error,
                    "info" | "" => NotificationLevel::Done,
                    _ => NotificationLevel::Done,
                };
            }
            // 其他 key 忽略（v0.5.0+ 扩展）
        } else {
            // 不是 key=value 段，作为 message
            message_segments.push(seg);
        }
    }

    let message = message_segments.join(";");
    (level, NotificationSource::Osc99, message)
}

/// OSC 777 payload：`notify;<title>;<body>`
///
/// 第一段必须是 `notify` keyword（否则返 None 表示解析失败）。
/// title + body 拼接成 message："title: body"（body 空时只 title）。
fn parse_osc_777(payload: &str) -> Option<(NotificationLevel, NotificationSource, String)> {
    let mut parts = payload.splitn(3, ';');
    let cmd = parts.next()?;
    if !cmd.eq_ignore_ascii_case("notify") {
        return None;
    }
    let title = parts.next().unwrap_or("");
    let body = parts.next().unwrap_or("");

    let message = if body.is_empty() {
        title.to_string()
    } else if title.is_empty() {
        body.to_string()
    } else {
        format!("{title}: {body}")
    };

    Some((NotificationLevel::Done, NotificationSource::Osc777, message))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parser() -> OscParser {
        OscParser::new("test-session".to_string())
    }

    #[test]
    fn 解析_osc_9_bel_结尾() {
        let mut p = parser();
        let events = p.feed(b"\x1b]9;build finished\x07");
        assert_eq!(events.len(), 1);
        let e = &events[0];
        assert_eq!(e.session_id, "test-session");
        assert_eq!(e.level, NotificationLevel::Done);
        assert_eq!(e.message, "build finished");
        assert_eq!(e.source, NotificationSource::Osc9);
    }

    #[test]
    fn 解析_osc_9_st_结尾() {
        let mut p = parser();
        let events = p.feed(b"\x1b]9;hello\x1b\\");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].message, "hello");
        assert_eq!(events[0].level, NotificationLevel::Done);
    }

    #[test]
    fn 解析_osc_99_level_warning() {
        let mut p = parser();
        let events = p.feed(b"\x1b]99;level=warning;disk usage high\x07");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].level, NotificationLevel::Waiting);
        assert_eq!(events[0].message, "disk usage high");
        assert_eq!(events[0].source, NotificationSource::Osc99);
    }

    #[test]
    fn 解析_osc_99_level_error() {
        let mut p = parser();
        let events = p.feed(b"\x1b]99;level=error;tests failed\x07");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].level, NotificationLevel::Error);
        assert_eq!(events[0].message, "tests failed");
    }

    #[test]
    fn 解析_osc_99_无_level() {
        let mut p = parser();
        let events = p.feed(b"\x1b]99;just a message\x07");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].level, NotificationLevel::Done);
        assert_eq!(events[0].message, "just a message");
    }

    #[test]
    fn 解析_osc_777_notify_title_body() {
        let mut p = parser();
        let events = p.feed(b"\x1b]777;notify;Build;done in 23s\x07");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].source, NotificationSource::Osc777);
        assert_eq!(events[0].level, NotificationLevel::Done);
        assert_eq!(events[0].message, "Build: done in 23s");
    }

    #[test]
    fn 解析_osc_777_仅_title() {
        let mut p = parser();
        let events = p.feed(b"\x1b]777;notify;Compile done\x07");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].message, "Compile done");
    }

    #[test]
    fn 流式_3_chunk_喂入_仍能解析() {
        let mut p = parser();
        let e1 = p.feed(b"\x1b]9;he");
        let e2 = p.feed(b"llo wo");
        let e3 = p.feed(b"rld\x07");
        assert!(e1.is_empty());
        assert!(e2.is_empty());
        assert_eq!(e3.len(), 1);
        assert_eq!(e3[0].message, "hello world");
    }

    #[test]
    fn 同_1_chunk_内_2_个_osc() {
        let mut p = parser();
        let events = p.feed(b"\x1b]9;first\x07\x1b]9;second\x07");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].message, "first");
        assert_eq!(events[1].message, "second");
    }

    #[test]
    fn osc_夹在普通输出中() {
        let mut p = parser();
        let events = p.feed(b"ls\n\x1b]9;done\x07\nbye\n");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].message, "done");
    }

    #[test]
    fn osc_超过_8192_字节被丢弃() {
        let mut p = parser();
        let mut input = b"\x1b]9;".to_vec();
        input.extend(vec![b'a'; 8200]); // 超长 message
        input.push(BEL);
        let events = p.feed(&input);
        // 超长被丢弃 → DiscardOsc 吞剩余 payload；终结符 BEL 也被吞，
        // 不发 OSC event 也不误判成孤立响铃
        assert_eq!(events.len(), 0);
        // 后续正常 OSC 应能解析（state 已回 Normal）
        let events2 = p.feed(b"\x1b]9;recovered\x07");
        assert_eq!(events2.len(), 1);
        assert_eq!(events2[0].message, "recovered");
    }

    #[test]
    fn 无_terminator_等待_下次_feed_才出_event() {
        let mut p = parser();
        let e1 = p.feed(b"\x1b]9;pending message");
        assert!(e1.is_empty());
        let e2 = p.feed(b" more\x07");
        assert_eq!(e2.len(), 1);
        assert_eq!(e2[0].message, "pending message more");
    }

    #[test]
    fn osc_9_空_message() {
        let mut p = parser();
        let events = p.feed(b"\x1b]9;\x07");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].message, "");
    }

    #[test]
    fn osc_未知数字_osc_52_不解析() {
        let mut p = parser();
        let events = p.feed(b"\x1b]52;c;cGFzdGU=\x07");
        // OSC 52 是粘贴板，不在范围
        assert_eq!(events.len(), 0);
    }

    #[test]
    fn osc_777_无_notify_keyword_不解析() {
        let mut p = parser();
        // 第一段不是 "notify"，解析失败
        let events = p.feed(b"\x1b]777;other;title;body\x07");
        assert_eq!(events.len(), 0);
    }

    #[test]
    fn osc_99_键值对乱码_message_保留() {
        let mut p = parser();
        // `==` 不是合法 key=value（key 空），但 split_once('=') 仍命中
        // key 是空字符串，不是 "level"，所以忽略；后续 "hi" 是 message
        let events = p.feed(b"\x1b]99;==;hi\x07");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].level, NotificationLevel::Done);
        assert_eq!(events[0].message, "hi");
    }

    #[test]
    fn esc_后非右括号_回_normal_不影响后续_osc() {
        let mut p = parser();
        // ESC + 其他字符 → CSI 等其他 ANSI，应被忽略；后续 OSC 仍能解析
        let events = p.feed(b"\x1b[31mred\x1b[0m\x1b]9;after csi\x07");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].message, "after csi");
    }

    #[test]
    fn 孤立_bel_产生_bell_事件() {
        let mut p = parser();
        let events = p.feed(b"command done\x07");
        assert_eq!(events.len(), 1);
        let e = &events[0];
        assert_eq!(e.session_id, "test-session");
        assert_eq!(e.source, NotificationSource::Bell);
        assert_eq!(e.level, NotificationLevel::Done);
        assert_eq!(e.message, "");
    }

    #[test]
    fn osc_终结符_bel_不产生_bell_事件() {
        let mut p = parser();
        // OSC 9 以 BEL 结尾：只出 1 个 Osc9 事件，BEL 不能再被当响铃
        let events = p.feed(b"\x1b]9;done\x07");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].source, NotificationSource::Osc9);
    }

    #[test]
    fn 同_chunk_多_bel_合并为一个事件() {
        let mut p = parser();
        let events = p.feed(b"\x07beep\x07boop\x07");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].source, NotificationSource::Bell);
    }

    #[test]
    fn 跨_chunk_bel_各自产生事件() {
        let mut p = parser();
        assert_eq!(p.feed(b"\x07").len(), 1);
        assert_eq!(p.feed(b"\x07").len(), 1);
    }

    #[test]
    fn 同_chunk_bell_与_osc_9_并存() {
        let mut p = parser();
        let events = p.feed(b"\x07\x1b]9;build ok\x07");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].source, NotificationSource::Bell);
        assert_eq!(events[1].source, NotificationSource::Osc9);
        assert_eq!(events[1].message, "build ok");
    }

    #[test]
    fn osc_内_esc_非_st_虚惊一场() {
        let mut p = parser();
        // OSC payload 内出现 ESC 但不是 \，应继续收集
        // 这里构造 OSC 9 message 含 ESC + 'a' 然后 BEL
        let mut input = b"\x1b]9;msg".to_vec();
        input.extend_from_slice(b"\x1ba"); // ESC + 'a'，虚惊
        input.extend_from_slice(b"more\x07");
        let events = p.feed(&input);
        assert_eq!(events.len(), 1);
        // 包含 ESC + 'a' + 'more' 的 message
        assert!(events[0].message.contains("msg"));
        assert!(events[0].message.contains("more"));
    }
}
