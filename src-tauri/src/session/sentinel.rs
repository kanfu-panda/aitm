//! 命令结束 sentinel（v1.3.0 T1 / plan A2）。
//!
//! `run_command` 过去是「写命令 → 固定盲等 5 秒 → 返回」，长命令（`pip install` /
//! `python -m venv`）根本没跑完就返回半截输出，且 **AI 完全不知道命令成功与否**。
//!
//! 本模块提供 sentinel 标记法（与 VS Code shell integration 同思路）：把用户命令
//! 包装成「跑完后 `printf` 一个私有 OSC 序列带回 `$?`」，后端在 PTY 原始字节流里
//! 扫这个序列 —— **扫到 = 命令真结束**，同时拿到真实退出码。
//!
//! ## v1.3.0 P1 之后：包装法降为兜底，主路径是 shell 钩子
//!
//! 包装法的代价是**命令行被终端原样回显**（用户看到满屏 `eval '...'; printf '...'`）。
//! P1 起 zsh / bash 改由 [`super::shell_hook`] 注入的钩子在每条命令开始 / 结束时发
//! 标记，命令本身一个字都不改。本模块因此同时提供两套：
//!
//! - **包装法**（[`wrap_command`] + [`scan_exit_code`]，配 `aitm-done` + 随机 req_id）：
//!   钩子不可用时的兜底 —— 其它 POSIX shell、用户 rc 冲掉了钩子等。
//! - **钩子法**（[`scan_exec_seq`] / [`scan_end_code`]，配 [`EXEC_KIND`] / [`END_KIND`]
//!   + 会话内单调递增的序号）：主路径。
//!
//! ## 序列格式
//!
//! ```text
//! ESC ] 6969 ; aitm-done ; <退出码> ; <请求 ID> BEL
//! ```
//!
//! 终止符 BEL（0x07）和 ST（`ESC \`）都认，与项目已有的两个 OSC 解析器保持一致。
//!
//! ## 为什么用私有 OSC 而不是可见的 echo
//!
//! xterm.js 不认识私有 OSC 码 → 用户终端里**看不到脏字符**；而后端 ring buffer 存
//! 的是原始 bytes，扫得到。喂给 LLM 时 [`crate::tools::ansi::strip_for_llm`] 的 OSC
//! 规则会把整条序列一并剥掉，不污染上下文。
//!
//! ## 为什么不用「提示符正则检测」
//!
//! 用户的 PS1 / oh-my-zsh 主题 / starship 千变万化还带 ANSI，正则必漏；且提示符
//! 出现 ≠ 上条命令成功（拿不到退出码）。
//!
//! ## 为什么用 `eval '<原命令>'` 而不是直接 `<原命令>; printf ...`
//!
//! 直接拼接会**破坏用户命令语义**（红线）：
//!
//! | 原命令 | 直接拼 `; printf` 的后果 |
//! |---|---|
//! | `sleep 5 &` | 变成 `sleep 5 &; printf ...` → bash/sh 语法错误，**命令根本没跑** |
//! | `echo "abc`（引号未闭合） | printf 被吞进字符串 → shell 停在 PS2 等续行，一直挂到超时 |
//! | `cmd \`（尾部续行符） | 同样吞掉后半段 |
//!
//! 把原命令整体单引号化后交给 `eval`，则 `;` / 管道 / `&&` / `||` / 后台 `&` / 引号
//! 未闭合全都被隔离在字符串内部：语法合法的照常执行，语法非法的由 `eval` 自己报错
//! 并给出非 0 退出码（而不是把我们的 sentinel 一起带沟里）。`eval` 在当前 shell 里
//! 解析执行，`cd` / 变量赋值 / 后台任务 / 别名的行为与直接键入一致。
//!
//! **退出码取的是 `eval` 的返回值 = 用户命令的整体结果**（`a && b` 取整体、管道取
//! 最后一段），不是 `printf` 自己的。

use std::path::Path;

/// sentinel 用的私有 OSC 码。
///
/// **选 6969 的理由**：
/// - 避开项目已占用的 —— OSC 7（[`super::osc_parser`] cwd 上报）、
///   OSC 9 / 99 / 777（[`crate::notifications::OscParser`] 通知）。
/// - 避开业界已有约定 —— 0/1/2（窗口标题）、4 / 10-19（调色板）、8（超链接）、
///   52（剪贴板）、104（重置调色板）、133（FinalTerm 语义提示符）、
///   633（VS Code shell integration）、697（ConEmu）、1337（iTerm2）。
/// - 6969 落在无人认领的私有区间，且是 4 位数，不会与 `7` / `9` 前缀混淆
///   （两个既有解析器都按完整字段比对，`6969` 对它们是「不关心的 OSC」，安静跳过）。
pub const SENTINEL_OSC_CODE: &str = "6969";

/// sentinel 的类型字段。与 OSC 码一起构成不会误命中的前缀。
pub const SENTINEL_KIND: &str = "aitm-done";

/// shell 钩子的**命令开始**类型字段（zsh `preexec` / bash `trap DEBUG` 发）。
/// 载荷：`aitm-exec;<序号>;<命令行原文>`（命令行放最后一段，含 `;` 也解析得出来）。
pub const EXEC_KIND: &str = "aitm-exec";

/// shell 钩子的**命令结束**类型字段（zsh `precmd` / bash `PROMPT_COMMAND` 发）。
/// 载荷：`aitm-end;<退出码>;<序号>`。
pub const END_KIND: &str = "aitm-end";

const ESC: char = '\x1b';
const BEL: char = '\x07';

/// 生成一次 `run_command` 的请求 ID（8 位十六进制）。
///
/// 作用是**防串台**：ring buffer 里可能还留着上一条命令的 sentinel，只有 ID 对得上
/// 才算「这一次」的结束信号。取 uuid v4 前 8 位（32 bit）够用 —— 同一时刻一个 session
/// 只有一个待匹配 ID，不存在生日悖论式碰撞压力；短一点还能减少命令行回显噪音。
pub fn new_request_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..8].to_string()
}

/// POSIX 单引号转义：把字符串安全地包进一对单引号。
///
/// 单引号内除了 `'` 本身没有任何元字符会被解释，所以只需把每个 `'` 换成
/// `'\''`（闭合 → 转义单引号 → 重新开引号）这一标准写法。
fn single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// 把用户命令包装成「执行 + 汇报退出码」的一行 shell 命令。
///
/// ⚠️ **必须在安全检查（L1 黑名单 / L2 风险分级 / L3 白名单 / L4 审批）全部通过之后
/// 再调用**：包装后的字符串含 `;` `$` `'` 等元字符，白名单的元字符防注入规则会直接
/// 判定不命中，黑名单 / 风险分级看到的也不再是用户原命令。参见
/// `crate::tools::run_command` 里的调用点（在 `Tool::execute` 内，晚于 `tool_loop`
/// 的四层门）。
pub fn wrap_command(cmd: &str, req_id: &str) -> String {
    format!(
        "eval {quoted}; printf '\\033]{code};{kind};%s;{req}\\007' \"$?\"",
        quoted = single_quote(cmd),
        code = SENTINEL_OSC_CODE,
        kind = SENTINEL_KIND,
        req = req_id,
    )
}

/// 在 PTY 原始输出里扫 sentinel，返回匹配 `req_id` 的退出码。
///
/// - 未出现 / 只收到半截（还没等到终止符）→ `None`（调用方继续等）
/// - `req_id` 不匹配（上一条命令的残留）→ 忽略，继续往后扫
/// - 出现多条匹配 → 取**最后一条**（正常只会有一条）
pub fn scan_exit_code(haystack: &str, req_id: &str) -> Option<i32> {
    let mut result = None;
    for (kind, payload) in iter_sentinels(haystack) {
        if kind != SENTINEL_KIND {
            continue;
        }
        let mut fields = payload.split(';');
        if let (Some(code), Some(id), None) = (fields.next(), fields.next(), fields.next()) {
            if id == req_id {
                if let Ok(c) = code.trim().parse::<i32>() {
                    result = Some(c);
                }
            }
        }
    }
    result
}

/// 迭代 haystack 里所有**完整**的 aitm 私有 OSC 序列，产出 `(类型字段, 其余载荷)`。
///
/// 只认真的 ESC 字节引导的序列 —— 命令回显里的 `\033]6969;…` 是字面文本，
/// 不会被误判（这是「包装法的回显」与「真 sentinel」的分界线）。
/// 序列没收完整（跨 chunk 只到一半）时提前停止，等下一轮轮询再看。
fn iter_sentinels(haystack: &str) -> Vec<(&str, &str)> {
    let prefix = format!("{ESC}]{SENTINEL_OSC_CODE};");
    let mut out = Vec::new();
    let mut rest = haystack;

    while let Some(pos) = rest.find(&prefix) {
        let after = &rest[pos + prefix.len()..];
        // 终止符两种都认：BEL（0x07，1 字节）或 ST（ESC \，2 字节）。取先出现的那个；
        // 第二个元素是**终止符自身长度**，用来跳过它继续往后扫。
        let bel = after.find(BEL).map(|i| (i, 1));
        let st = after.find("\x1b\\").map(|i| (i, 2));
        let Some((end, term_len)) = [bel, st].into_iter().flatten().min_by_key(|(i, _)| *i) else {
            break; // 序列还没收完整（跨 chunk），本轮不作结论
        };
        let body = &after[..end];
        if let Some((kind, payload)) = body.split_once(';') {
            out.push((kind, payload));
        }
        rest = &after[end + term_len..];
    }
    out
}

// ===== v1.3.0 P1：shell 钩子模式（命令不改写）的扫描 =====

/// 扫出 haystack 里最大的钩子序号（exec / end 都算）。
///
/// 用途：写命令**之前**先记下"到目前为止已经跑过几条命令"，之后只认序号更大的
/// 标记 —— 这样 ring buffer 里残留的历史标记不会被误当成本次结果。
pub fn scan_max_seq(haystack: &str) -> u64 {
    let mut max = 0;
    for (kind, payload) in iter_sentinels(haystack) {
        let seq = match kind {
            EXEC_KIND => exec_fields(payload).map(|(seq, _)| seq),
            END_KIND => end_fields(payload).map(|(_, seq)| seq),
            _ => None,
        };
        if let Some(seq) = seq {
            max = max.max(seq);
        }
    }
    max
}

/// 解析 exec 载荷 `<序号>;<命令行原文>`。命令行是**最后一段**（只切一刀），
/// 所以命令里含 `;` / 引号 / 管道都不影响。
fn exec_fields(payload: &str) -> Option<(u64, &str)> {
    let (seq, cmd) = payload.split_once(';')?;
    Some((seq.trim().parse::<u64>().ok()?, cmd))
}

/// 解析 end 载荷 `<退出码>;<序号>`。字段数必须正好两段。
fn end_fields(payload: &str) -> Option<(i32, u64)> {
    let mut fields = payload.split(';');
    let (Some(code), Some(seq), None) = (fields.next(), fields.next(), fields.next()) else {
        return None;
    };
    Some((code.trim().parse::<i32>().ok()?, seq.trim().parse::<u64>().ok()?))
}

/// 找出「我们刚写进去的那条命令」对应的钩子序号。
///
/// 判据两条同时满足才算：
/// 1. 序号 > `base_seq`（本次写入之后才开始的命令）
/// 2. 钩子记录的命令行原文与 `cmd` 匹配（见 [`cmdline_matches`]）—— **防串台**：
///    用户手动在同一个 tab 敲的命令序号也会递增，只按序号配对会串到他的退出码上。
///
/// 有多条匹配时取**序号最小**的那条（我们写入后的第一条同名命令）。
pub fn scan_exec_seq(haystack: &str, cmd: &str, base_seq: u64) -> Option<u64> {
    iter_sentinels(haystack)
        .into_iter()
        .filter(|(kind, _)| *kind == EXEC_KIND)
        .filter_map(|(_, payload)| exec_fields(payload))
        .filter(|(seq, recorded)| *seq > base_seq && cmdline_matches(recorded, cmd))
        .map(|(seq, _)| seq)
        .min()
}

/// 扫指定序号的命令结束标记，返回退出码。序号在一个 shell 会话内单调递增且唯一，
/// 所以这里可以扫全缓冲区（不怕历史残留串台）。
pub fn scan_end_code(haystack: &str, seq: u64) -> Option<i32> {
    iter_sentinels(haystack)
        .into_iter()
        .filter(|(kind, _)| *kind == END_KIND)
        .filter_map(|(_, payload)| end_fields(payload))
        .find(|(_, s)| *s == seq)
        .map(|(code, _)| code)
}

/// 钩子记录的命令行 vs 我们写进去的命令，是否算同一条。
///
/// - 两边 trim 后相等 → 是（zsh `preexec $1` / bash `history 1` 的正常情况）
/// - 记录的是我们命令的**首个 token 段前缀** → 也算（bash 在 history 不可用时退回
///   `$BASH_COMMAND`，复合命令 `a && b` 只拿得到 `a`）。要求断在空格边界上，
///   避免 `git` 误配 `github-cli ...` 这类。
pub fn cmdline_matches(recorded: &str, expected: &str) -> bool {
    let recorded = recorded.trim();
    let expected = expected.trim();
    if recorded.is_empty() {
        return false;
    }
    if recorded == expected {
        return true;
    }
    // 前缀必须断在空格边界：`git` 不能配上 `github-cli status`
    expected
        .strip_prefix(recorded)
        .is_some_and(|rest| rest.starts_with(' '))
}

/// 该 shell 是否支持 sentinel 包装（POSIX 系：`eval` + `$?` + `printf` 三件套）。
///
/// 不支持的（Windows `cmd.exe` / PowerShell / fish）**绝不能包装**：
/// - `cmd.exe` 把 `;` 当参数分隔符，且没有 `eval` / `printf` → 用户命令直接跑不起来
/// - fish 不认 `$?`（用 `$status`）→ 整行解析失败，用户命令同样不执行
///
/// 这类 shell 退回旧的盲等策略，宁可拿不到退出码，也不能破坏用户命令。
pub fn is_posix_shell(shell: &str) -> bool {
    let base = Path::new(shell)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(shell)
        .to_ascii_lowercase();
    let base = base.strip_suffix(".exe").unwrap_or(&base);
    matches!(base, "sh" | "bash" | "zsh" | "dash" | "ksh" | "mksh" | "ash")
}

/// 去掉 PTY 回显里带 sentinel 的那些行（喂给 LLM 前的清理）。
///
/// 终端会把我们写进 stdin 的整行命令原样回显，其中包含 `printf '\033]6969;...'`
/// 这段**字面文本**（不是真的 ESC 字节，所以 `strip_for_llm` 的 OSC 规则剥不掉它）。
///
/// 三个判据都查，是因为 zsh 主题 / 语法高亮插件重绘长命令行时可能在折行处插入真换行，
/// 把回显劈成两行 —— 只认 `req_id` 会漏掉前半段：
/// 1. `req_id`（随机串，只可能来自我们注入的文本）
/// 2. `aitm-done` 类型字段
/// 3. `]6969;` 字面 OSC 前缀
///
/// 命令自身的输出出现这三者的概率可忽略，误删风险远小于漏删造成的上下文污染。
pub fn remove_echo_lines(text: &str, req_id: &str) -> String {
    let literal_prefix = format!("]{SENTINEL_OSC_CODE};");
    let mut out = String::with_capacity(text.len());
    for line in text.lines() {
        if line.contains(req_id) || line.contains(SENTINEL_KIND) || line.contains(&literal_prefix) {
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sentinel_bytes(code: i32, req: &str) -> String {
        format!("\x1b]{SENTINEL_OSC_CODE};{SENTINEL_KIND};{code};{req}\x07")
    }

    // ===== 构造 =====

    #[test]
    fn 请求_id_是_8_位十六进制且每次不同() {
        let a = new_request_id();
        let b = new_request_id();
        assert_eq!(a.len(), 8, "实际：{a}");
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()), "实际：{a}");
        assert_ne!(a, b, "两次生成不应相同");
    }

    #[test]
    fn 包装后含私有_osc_码与请求_id() {
        let w = wrap_command("ls -la", "deadbeef");
        assert!(w.contains("eval 'ls -la'"), "实际：{w}");
        assert!(w.contains("\\033]6969;aitm-done;%s;deadbeef\\007"), "实际：{w}");
        assert!(w.contains("\"$?\""), "必须取 $? 而不是 printf 自己的退出码：{w}");
    }

    #[test]
    fn 包装避开已占用的_osc_码() {
        // 红线：不得与 OSC 7（cwd）/ 9 / 99 / 777（通知）冲突
        assert_ne!(SENTINEL_OSC_CODE, "7");
        assert_ne!(SENTINEL_OSC_CODE, "9");
        assert_ne!(SENTINEL_OSC_CODE, "99");
        assert_ne!(SENTINEL_OSC_CODE, "777");
    }

    #[test]
    fn 单引号命令被正确转义() {
        let w = wrap_command("echo 'hello world'", "abc12345");
        // 'echo '\''hello world'\'''
        assert!(w.contains(r"'echo '\''hello world'\'''"), "实际：{w}");
    }

    // ===== 解析 =====

    #[test]
    fn 扫到匹配的退出码_0() {
        let out = format!("some output\n{}", sentinel_bytes(0, "abc12345"));
        assert_eq!(scan_exit_code(&out, "abc12345"), Some(0));
    }

    #[test]
    fn 扫到非_0_退出码() {
        let out = sentinel_bytes(1, "abc12345");
        assert_eq!(scan_exit_code(&out, "abc12345"), Some(1));
        let out = sentinel_bytes(127, "abc12345");
        assert_eq!(scan_exit_code(&out, "abc12345"), Some(127));
    }

    #[test]
    fn 请求_id_不匹配_不算命中_防串台() {
        let out = sentinel_bytes(0, "0ldreq00");
        assert_eq!(scan_exit_code(&out, "abc12345"), None);
    }

    #[test]
    fn 残留旧_sentinel_与新_sentinel_共存_取新的() {
        let out = format!(
            "{}\nnew command output\n{}",
            sentinel_bytes(1, "0ldreq00"),
            sentinel_bytes(0, "abc12345")
        );
        assert_eq!(scan_exit_code(&out, "abc12345"), Some(0));
    }

    #[test]
    fn 序列未收完整_返回_none() {
        let partial = "\x1b]6969;aitm-done;0;abc123";
        assert_eq!(scan_exit_code(partial, "abc12345"), None);
    }

    #[test]
    fn st_终止符也认() {
        let out = "\x1b]6969;aitm-done;3;abc12345\x1b\\";
        assert_eq!(scan_exit_code(out, "abc12345"), Some(3));
    }

    #[test]
    fn 命令回显里的字面文本不会被误判为结束() {
        // 终端回显的是 `\033]...` 字面字符（没有真的 ESC 字节），不能算命中
        let echoed = wrap_command("ls", "abc12345");
        assert_eq!(scan_exit_code(&echoed, "abc12345"), None);
    }

    #[test]
    fn 字段数不对_不解析() {
        // 少一段
        assert_eq!(scan_exit_code("\x1b]6969;aitm-done;0\x07", "abc12345"), None);
        // 多一段
        assert_eq!(
            scan_exit_code("\x1b]6969;aitm-done;0;abc12345;x\x07", "abc12345"),
            None
        );
    }

    #[test]
    fn 退出码非数字_不解析() {
        assert_eq!(
            scan_exit_code("\x1b]6969;aitm-done;oops;abc12345\x07", "abc12345"),
            None
        );
    }

    #[test]
    fn 中文输出混杂时仍能扫到() {
        let out = format!("正在安装依赖…\n完成 ✓\n{}", sentinel_bytes(0, "abc12345"));
        assert_eq!(scan_exit_code(&out, "abc12345"), Some(0));
    }

    // ===== v1.3.0 P1：钩子模式的扫描 =====

    fn exec_bytes(seq: u64, cmd: &str) -> String {
        format!("\x1b]{SENTINEL_OSC_CODE};{EXEC_KIND};{seq};{cmd}\x07")
    }

    fn end_bytes(code: i32, seq: u64) -> String {
        format!("\x1b]{SENTINEL_OSC_CODE};{END_KIND};{code};{seq}\x07")
    }

    #[test]
    fn scan_max_seq_取最大序号() {
        let text = format!(
            "{}out\n{}{}",
            exec_bytes(3, "ls"),
            end_bytes(0, 3),
            exec_bytes(4, "pwd")
        );
        assert_eq!(scan_max_seq(&text), 4);
    }

    #[test]
    fn scan_max_seq_没有钩子标记时为_0() {
        assert_eq!(scan_max_seq("普通输出\nfile.txt\n"), 0);
        // 旧包装法的 aitm-done 不算钩子标记
        assert_eq!(scan_max_seq(&sentinel_bytes(0, "abc12345")), 0);
    }

    #[test]
    fn 钩子_exec_按命令行匹配到序号() {
        let text = format!("{}\nsome output", exec_bytes(7, "pnpm build"));
        assert_eq!(scan_exec_seq(&text, "pnpm build", 6), Some(7));
    }

    #[test]
    fn 钩子_end_解析退出码() {
        let text = format!("output\n{}", end_bytes(127, 7));
        assert_eq!(scan_end_code(&text, 7), Some(127));
        // 序号对不上不认
        assert_eq!(scan_end_code(&text, 8), None);
    }

    /// 防串台核心：用户手动敲的命令序号也会涨，命令行对不上就不认。
    #[test]
    fn 命令行不匹配_不认_防串台() {
        let text = format!(
            "{}{}",
            exec_bytes(8, "vim notes.md"), // 用户手动敲的
            end_bytes(0, 8)
        );
        assert_eq!(
            scan_exec_seq(&text, "pnpm build", 7),
            None,
            "命令行不匹配不能认成自己的"
        );
    }

    /// 序号 <= base 的是我们写入之前就已存在的历史，必须忽略
    /// （否则 AI 连续两次跑同一条命令时会拿到上一次的退出码）。
    #[test]
    fn 序号不大于_base_的历史标记被忽略() {
        let text = format!("{}{}", exec_bytes(5, "ls"), end_bytes(0, 5));
        assert_eq!(scan_exec_seq(&text, "ls", 5), None);
        assert_eq!(scan_exec_seq(&text, "ls", 4), Some(5));
    }

    /// 同一条命令跑两次时，取写入后的第一条（序号最小的那条）。
    #[test]
    fn 同名命令多次出现_取写入后的第一条() {
        let text = format!("{}{}", exec_bytes(6, "ls"), exec_bytes(7, "ls"));
        assert_eq!(scan_exec_seq(&text, "ls", 5), Some(6));
    }

    #[test]
    fn 命令行含分号与引号仍能完整解析() {
        let cmd = "echo 'a;b' && ls -la; pwd";
        let text = exec_bytes(2, cmd);
        assert_eq!(scan_exec_seq(&text, cmd, 1), Some(2));
    }

    #[test]
    fn 前后空白差异不影响匹配() {
        let text = exec_bytes(2, "ls -la");
        assert_eq!(scan_exec_seq(&text, "  ls -la  ", 1), Some(2));
    }

    /// bash 在 history 不可用时退回 `$BASH_COMMAND`，复合命令只拿得到第一段。
    #[test]
    fn bash_只记录首段复合命令时按空格边界前缀匹配() {
        assert!(cmdline_matches("echo hi", "echo hi && false"));
        assert!(cmdline_matches("ls", "ls -la"));
        // 不能断在词中间：git ≠ github-cli
        assert!(!cmdline_matches("git", "github-cli status"));
        // 反向不成立（记录比我们写的还长 → 不是同一条）
        assert!(!cmdline_matches("ls -la /tmp", "ls -la"));
        assert!(!cmdline_matches("", "ls"));
    }

    #[test]
    fn 钩子序列未收完整_返回_none() {
        let partial = format!("\x1b]{SENTINEL_OSC_CODE};{END_KIND};0;9");
        assert_eq!(scan_end_code(&partial, 9), None);
    }

    #[test]
    fn 钩子命令行回显的字面文本不会被误判() {
        // 用户 `cat` 一个含字面 "\033]6969;aitm-exec;..." 的文件：没有真 ESC 字节，不算
        let literal = format!("\\033]{SENTINEL_OSC_CODE};{EXEC_KIND};9;ls\\007");
        assert_eq!(scan_exec_seq(&literal, "ls", 0), None);
        assert_eq!(scan_max_seq(&literal), 0);
    }

    #[test]
    fn 钩子标记与旧包装法标记互不干扰() {
        let mixed = format!(
            "{}{}{}",
            sentinel_bytes(3, "abc12345"),
            exec_bytes(2, "ls"),
            end_bytes(0, 2)
        );
        assert_eq!(scan_exit_code(&mixed, "abc12345"), Some(3));
        assert_eq!(scan_exec_seq(&mixed, "ls", 1), Some(2));
        assert_eq!(scan_end_code(&mixed, 2), Some(0));
    }

    // ===== shell 兼容判定 =====

    #[test]
    fn posix_shell_识别() {
        assert!(is_posix_shell("/bin/zsh"));
        assert!(is_posix_shell("/bin/bash"));
        assert!(is_posix_shell("/bin/sh"));
        assert!(is_posix_shell("/usr/local/bin/bash"));
        assert!(is_posix_shell("dash"));
    }

    #[test]
    fn 非_posix_shell_不包装() {
        assert!(!is_posix_shell("C:\\Windows\\System32\\cmd.exe"));
        assert!(!is_posix_shell("cmd.exe"));
        assert!(!is_posix_shell("powershell.exe"));
        assert!(!is_posix_shell("pwsh"));
        assert!(!is_posix_shell("/usr/local/bin/fish"));
        assert!(!is_posix_shell(""));
    }

    // ===== 回显清理 =====

    #[test]
    fn 回显行按请求_id_删除() {
        let text = "eval 'ls'; printf '\\033]6969;aitm-done;%s;abc12345\\007' \"$?\"\nfile.txt\n";
        let out = remove_echo_lines(text, "abc12345");
        assert!(!out.contains("aitm-done"), "实际：{out:?}");
        assert!(out.contains("file.txt"));
    }

    #[test]
    fn 回显清理不误删普通输出() {
        let text = "a.txt\nb.txt\n";
        assert_eq!(remove_echo_lines(text, "abc12345"), "a.txt\nb.txt\n");
    }

    #[test]
    fn 回显被主题重绘劈成两行也清得掉() {
        // 长命令行被折行插入真换行：req_id 只在后半段，前半段靠 OSC 前缀 / 类型字段兜住
        let text = "eval 'pnpm build'; printf '\\033]6969;aitm-\ndone;%s;abc12345\\007' \"$?\"\nbuilt ok\n";
        let out = remove_echo_lines(text, "abc12345");
        assert!(!out.contains("6969"), "实际：{out:?}");
        assert!(!out.contains("printf"), "实际：{out:?}");
        assert!(out.contains("built ok"));
    }

    /// 真机 sh 执行：验证包装后的命令**语法合法 + 退出码是用户命令的整体结果**。
    /// 这是红线「拼接不得破坏原命令语义」的正面证据 —— 直接把包装串丢给真 shell 跑。
    #[cfg(unix)]
    mod 真实_sh_执行 {
        use super::*;

        /// 用 `/bin/sh -c <包装后命令>` 真跑一遍，返回 (stdout 文本, 扫出的退出码)。
        fn run(cmd: &str) -> (String, Option<i32>) {
            let req = "t1t1t1t1";
            let wrapped = wrap_command(cmd, req);
            let out = std::process::Command::new("/bin/sh")
                .arg("-c")
                .arg(&wrapped)
                .output()
                .expect("跑 /bin/sh 失败");
            let text = String::from_utf8_lossy(&out.stdout).into_owned();
            let code = scan_exit_code(&text, req);
            (text, code)
        }

        #[test]
        fn 简单命令_成功_退出码_0() {
            let (text, code) = run("echo hello-t1");
            assert!(text.contains("hello-t1"), "实际输出：{text:?}");
            assert_eq!(code, Some(0));
        }

        #[test]
        fn 简单命令_失败_退出码非_0() {
            assert_eq!(run("false").1, Some(1));
        }

        #[test]
        fn 复合命令_and_取整体结果() {
            // true && false → 整体 1（不是第一段的 0）
            assert_eq!(run("true && false").1, Some(1));
            // false && true → 短路，整体 1
            assert_eq!(run("false && true").1, Some(1));
            assert_eq!(run("true && true").1, Some(0));
        }

        #[test]
        fn 复合命令_or_取整体结果() {
            assert_eq!(run("false || true").1, Some(0));
            assert_eq!(run("false || false").1, Some(1));
        }

        #[test]
        fn 复合命令_分号_取最后一段() {
            let (text, code) = run("echo one; false");
            assert!(text.contains("one"), "实际：{text:?}");
            assert_eq!(code, Some(1));
        }

        #[test]
        fn 管道_取管道整体退出码() {
            // grep 没匹配到 → 1
            let (_, code) = run("echo abc | grep zzz");
            assert_eq!(code, Some(1));
            let (text, code) = run("echo abc | grep abc");
            assert!(text.contains("abc"));
            assert_eq!(code, Some(0));
        }

        #[test]
        fn 后台任务_不炸且立即返回_0() {
            // 直接拼 `; printf` 会得到 `sleep 1 &; printf` → sh 语法错误，命令不执行。
            // eval 包装后语法合法。
            let (_, code) = run("sleep 1 &");
            assert_eq!(code, Some(0), "后台命令不应破坏包装");
        }

        #[test]
        fn 引号未闭合_报错但仍拿到非_0_退出码() {
            // 关键：sentinel 仍然发出（不会把 shell 挂在 PS2 上等续行）
            let (_, code) = run("echo \"abc");
            assert!(
                matches!(code, Some(c) if c != 0),
                "语法错误应给非 0 退出码，实际：{code:?}"
            );
        }

        #[test]
        fn 命令自带单引号_原样执行() {
            let (text, code) = run("echo 'it''s fine'");
            assert_eq!(code, Some(0), "实际输出：{text:?}");
        }

        #[test]
        fn 命令含变量与重定向_语义不变() {
            let (text, code) = run("echo $((1+2)) > /dev/null; echo done-t1");
            assert!(text.contains("done-t1"), "实际：{text:?}");
            assert_eq!(code, Some(0));
        }

        #[test]
        fn 找不到的命令_退出码_127() {
            assert_eq!(run("aitm-no-such-command-xyz").1, Some(127));
        }
    }
}
