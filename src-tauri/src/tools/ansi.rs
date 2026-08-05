//! ANSI 转义序列剥离 —— 让喂给 LLM 的终端输出干净可读。
//!
//! 终端 PTY 输出常含 CSI 序列（颜色 / 光标 / 屏幕清除）、OSC 序列（窗口标题、
//! 超链接 file://...）、操作系统私有控制（zsh 的 `[?2004h` 括号粘贴模式开关、
//! `[?1l>` 应用键盘模式等）。直接喂给 LLM 它会被乱码淹没、反复重试别的命令。
//!
//! 本模块提供轻量级 strip 函数（regex-based），对中文/UTF-8 文本字符不影响，
//! 仅去掉 ESC 引导的控制序列 + 单独控制字符（BEL、CR 转 \n、退格等）。
//!
//! 不是 PTY emulator —— 不解析光标移动、不做行重构。看 1E-2 决定要不要上 vte。

use once_cell::sync::Lazy;
use regex::Regex;

/// 综合 ANSI escape 正则。覆盖：
/// - CSI: `ESC [ params final`（如 `\x1b[31m`、`\x1b[?2004h`）
/// - OSC: `ESC ] ... BEL` 或 `ESC ] ... ESC \`（窗口标题、超链接）
/// - 单字符 ESC: `ESC @` 到 `ESC _`
/// - DCS / PM / APC: 都是 ESC + P/^/_ + ... + ST
static ANSI_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(concat!(
        r"\x1b\[[0-9;?<=>!]*[ -/]*[@-~]",                  // CSI
        r"|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)",             // OSC
        r"|\x1b[PX^_][^\x1b]*(?:\x1b\\|\x07)",             // DCS / PM / APC
        r"|\x1b[@-Z\\-_]",                                  // 单字符 ESC
    ))
    .expect("ANSI regex 必须能编译")
});

/// 去掉常见 PTY 噪音字符（除 CSI/OSC 外的低位控制字符）。
/// 保留：`\n` `\t` `\r`。其他 \x00-\x1f 全删（含 BEL、垂直制表等）。
fn strip_low_control(s: &str) -> String {
    s.chars()
        .filter(|c| {
            let code = *c as u32;
            !(code < 0x20 && *c != '\n' && *c != '\t' && *c != '\r')
        })
        .collect()
}

/// 把 PTY 原始输出剥成给 LLM 看的纯文本。
///
/// 顺序很重要：先 strip ANSI 再 strip 低位控制（因为 ESC=\x1b 本身是低位控制）。
pub fn strip_for_llm(s: &str) -> String {
    let no_ansi = ANSI_RE.replace_all(s, "");
    let no_ctrl = strip_low_control(&no_ansi);

    // 末尾"压缩"：连续 \r\n 折叠成单 \n，多空行折叠（避免 prompt 重绘留下大量空行）
    let mut out = String::with_capacity(no_ctrl.len());
    let mut last_was_blank = false;
    for line in no_ctrl.lines() {
        let trimmed = line.trim_end();
        let is_blank = trimmed.is_empty();
        if is_blank && last_was_blank {
            continue;
        }
        out.push_str(trimmed);
        out.push('\n');
        last_was_blank = is_blank;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 剥_csi_颜色() {
        let s = "\x1b[31m红色\x1b[0m普通";
        assert_eq!(strip_for_llm(s).trim(), "红色普通");
    }

    #[test]
    fn 剥_zsh_括号粘贴模式() {
        let s = "ls\x1b[?2004l\r\n\x1b[?2004hfile.txt";
        let out = strip_for_llm(s);
        assert!(!out.contains("\x1b"));
        assert!(!out.contains("?2004"));
        assert!(out.contains("ls"));
        assert!(out.contains("file.txt"));
    }

    #[test]
    fn 剥_osc_超链接() {
        // OSC 8: ESC ] 8 ; ; URL ESC \   text  ESC ] 8 ; ; ESC \
        let s = "\x1b]8;;file:///tmp/a\x1b\\link\x1b]8;;\x1b\\";
        let out = strip_for_llm(s);
        assert_eq!(out.trim(), "link");
    }

    #[test]
    fn 剥_osc_窗口标题_bel结尾() {
        let s = "\x1b]2;终端标题\x07hello";
        let out = strip_for_llm(s);
        assert_eq!(out.trim(), "hello");
    }

    #[test]
    fn 保留_中文_utf8() {
        let s = "\x1b[36m中文 + emoji 🎉\x1b[0m";
        let out = strip_for_llm(s);
        assert!(out.contains("中文"));
        assert!(out.contains("🎉"));
    }

    #[test]
    fn 保留_换行_tab() {
        let s = "line1\n\tindented\nline2";
        let out = strip_for_llm(s);
        assert!(out.contains("line1"));
        assert!(out.contains("\tindented"));
        assert!(out.contains("line2"));
    }

    #[test]
    fn 折叠_连续空行() {
        let s = "a\n\n\n\nb";
        let out = strip_for_llm(s);
        // a + 1 空行 + b
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines, vec!["a", "", "b"]);
    }

    /// v1.3.0 T1：`run_command` 的命令结束 sentinel 是私有 OSC 序列，必须被一并剥掉，
    /// 绝不能漏进给 LLM 的内容里。两种终止符（BEL / ST）都要覆盖。
    #[test]
    fn 剥_命令结束_sentinel() {
        let bel = "ok\r\n\x1b]6969;aitm-done;0;abc12345\x07";
        let out = strip_for_llm(bel);
        assert!(out.contains("ok"));
        assert!(!out.contains("aitm-done"), "实际：{out:?}");
        assert!(!out.contains("6969"), "实际：{out:?}");

        let st = "ok\r\n\x1b]6969;aitm-done;127;abc12345\x1b\\";
        let out = strip_for_llm(st);
        assert!(!out.contains("aitm-done"), "实际：{out:?}");
        assert!(!out.contains("127"), "实际：{out:?}");
    }

    #[test]
    fn 真实_zsh_prompt_片段_变干净() {
        // 类似截图中真实抓到的：netstat 命令 + 应用模式切换 + zsh prompt 重绘 + OSC 标题
        let raw = "\x1b[?2004l\r\nnetstat -tulpn | grep :3000\r\n\x1b[?2004h\x1b]2;netstat\x07\x1b]1;netstat\x07netstat: n: unknown or uninstrumented protocol: Undefined error: 0\r\n\x1b[1m\x1b[7m%\x1b[27m\x1b[1m\x1b[0m\x1b]7;file://host/tmp/example\x1b\\";
        let out = strip_for_llm(raw);
        assert!(!out.contains("\x1b"), "不应有 ESC 残留");
        assert!(!out.contains("?2004"));
        assert!(!out.contains("file://"));
        assert!(!out.contains("\x07"));
        assert!(out.contains("netstat -tulpn | grep :3000"));
        assert!(out.contains("unknown or uninstrumented"));
    }
}
