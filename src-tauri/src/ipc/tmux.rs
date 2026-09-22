//! tmux 会话管理器 IPC。
//!
//! 定位见 `docs/02_design/architecture/-tmux-session-manager-arch.md`：
//! aitm **不**完整兼容 tmux（tmux 会吞掉 OSC 转义序列，完整支持要改 PTY 协议层），
//! 只做"看见 + 一键进入 + 基本干预"的会话管理器。本模块是无状态的：每条命令
//! fork 一次 tmux 子进程，不持有任何共享状态、不碰既有会话表。

use serde::{Deserialize, Serialize};
use std::process::Command;

/// 字段分隔符：ASCII Unit Separator (0x1F)。
///
/// 不用制表符 / 竖线，是因为会话名、窗格标题、工作目录里都可能出现这些可见字符，
/// 而 0x1F 不会出现在正常文本里。
const FIELD_SEP: char = '\u{1f}';

/// `tmux list-sessions -F` 的格式串，字段顺序与 [`TmuxSession`] 一一对应。
const LIST_FORMAT: &str = "#{session_name}\u{1f}#{session_windows}\u{1f}#{session_attached}\u{1f}#{session_created}\u{1f}#{pane_current_path}\u{1f}#{pane_current_command}\u{1f}#{pane_title}";

/// tmux 输出里代表"服务端没起来 / 没有会话"的措辞。
///
/// 命中这些不是故障——用户只是没开 tmux，UI 应显示空状态而不是红色错误。
const NO_SERVER_MARKERS: &[&str] = &["no server running", "no sessions", "error connecting"];

/// 一个 tmux 会话的快照。字段名保持 snake_case 直接透给前端（与 `TabMetadata` 一致）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TmuxSession {
    /// 会话名，attach / kill 的标识。
    pub name: String,
    /// 窗口数量。
    pub windows: u32,
    /// 当前已连接的客户端数；0 表示无人连接。
    pub attached: u32,
    /// 创建时间，Unix 秒。
    pub created: i64,
    /// 活动窗格的工作目录。
    pub current_path: Option<String>,
    /// 活动窗格正在跑的命令名。注意：常驻程序可能改写自己的进程名，
    /// 这个字段未必可读，UI 以 [`title`](Self::title) 为主标签。
    pub current_command: Option<String>,
    /// 活动窗格标题，作为任务标签展示。
    pub title: Option<String>,
}

/// 解析 `tmux list-sessions -F LIST_FORMAT` 的 stdout。
///
/// 容错口径（坏一行不影响其余行）：
/// - 字段数不足 7 → 整行跳过
/// - 数字字段解析失败 → 兜底 0
/// - 空字符串字段 → 归一为 `None`
fn parse_sessions(stdout: &str) -> Vec<TmuxSession> {
    stdout
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|line| {
            let f: Vec<&str> = line.split(FIELD_SEP).collect();
            if f.len() < 7 {
                return None;
            }
            Some(TmuxSession {
                name: f[0].to_string(),
                windows: f[1].parse().unwrap_or(0),
                attached: f[2].parse().unwrap_or(0),
                created: f[3].parse().unwrap_or(0),
                current_path: non_empty(f[4]),
                current_command: non_empty(f[5]),
                title: non_empty(f[6]),
            })
        })
        .collect()
}

/// 空字符串归一为 `None`。
fn non_empty(s: &str) -> Option<String> {
    if s.is_empty() {
        None
    } else {
        Some(s.to_string())
    }
}

/// 把任意字符串包成 shell 单引号字面量。
///
/// **这是本模块唯一的安全关键函数**：会话名由 tmux 的使用者创建，对 aitm 来说是
/// 不可信输入，而 attach 命令是唯一会被 shell 解释的路径（要写进终端标签页的 PTY）。
/// 单引号内除了单引号本身没有任何元字符有特殊含义，所以只需把内部的 `'` 换成
/// `'\''`（闭合 → 转义单引号 → 重新开启）。
fn shell_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// 构造一条可以安全写入 PTY 的 attach 命令文本。**不执行任何东西**。
///
/// `takeover = true` 时加 `-d`，踢掉该会话的其它客户端独占接入。
fn build_attach_command(name: &str, takeover: bool) -> Result<String, String> {
    if name.trim().is_empty() {
        return Err("会话名不能为空".to_string());
    }
    let flag = if takeover { " -d" } else { "" };
    Ok(format!(
        "tmux attach-session{flag} -t {}",
        shell_single_quote(name)
    ))
}

/// stderr 是否代表"服务端没起来 / 没有会话"（而非真故障）。
fn is_no_server_error(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    NO_SERVER_MARKERS.iter().any(|m| lower.contains(m))
}

/// 跑一条 tmux 子命令，只关心成败。参数以数组传递，**不经过 shell**。
async fn run_tmux(args: Vec<String>) -> Result<(), String> {
    let out = tokio::task::spawn_blocking(move || Command::new("tmux").args(&args).output())
        .await
        .map_err(|e| format!("执行 tmux 任务失败：{e}"))?;

    match out {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Err("本机未安装 tmux".to_string())
        }
        Err(e) => Err(format!("执行 tmux 失败：{e}")),
        Ok(o) if o.status.success() => Ok(()),
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr).trim().to_string();
            Err(if stderr.is_empty() {
                "tmux 命令执行失败".to_string()
            } else {
                stderr
            })
        }
    }
}

/// 本机是否能用 tmux。
///
/// 能成功启动 `tmux -V` 进程即视为可用。**不返回错误**——没装 tmux 是正常情况，
/// 不是故障，UI 据此显示空状态。
#[tauri::command]
pub async fn tmux_available() -> Result<bool, String> {
    tokio::task::spawn_blocking(|| Command::new("tmux").arg("-V").output().is_ok())
        .await
        .map_err(|e| format!("探测 tmux 失败：{e}"))
}

/// 列出本机所有 tmux 会话。
///
/// tmux 未安装 / 服务端未启动 → 返回空数组（**不是错误**）。
#[tauri::command]
pub async fn tmux_list_sessions() -> Result<Vec<TmuxSession>, String> {
    let out = tokio::task::spawn_blocking(|| {
        Command::new("tmux")
            .args(["list-sessions", "-F", LIST_FORMAT])
            .output()
    })
    .await
    .map_err(|e| format!("执行 tmux 任务失败：{e}"))?;

    match out {
        // 没装 tmux → 空列表，让 UI 走"未检测到 tmux"空状态
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("执行 tmux 失败：{e}")),
        Ok(o) if o.status.success() => {
            Ok(parse_sessions(&String::from_utf8_lossy(&o.stdout)))
        }
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr);
            if is_no_server_error(&stderr) {
                Ok(Vec::new())
            } else {
                Err(stderr.trim().to_string())
            }
        }
    }
}

/// 构造 attach 命令文本给前端写进终端标签页。见 [`build_attach_command`]。
#[tauri::command]
pub async fn tmux_attach_command(name: String, takeover: bool) -> Result<String, String> {
    build_attach_command(&name, takeover)
}

/// 向会话的活动窗格发 Ctrl-C，中断里面正在跑的前台命令。会话本身保留。
#[tauri::command]
pub async fn tmux_interrupt_session(name: String) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("会话名不能为空".to_string());
    }
    run_tmux(vec![
        "send-keys".to_string(),
        "-t".to_string(),
        name,
        "C-c".to_string(),
    ])
    .await
}

/// 结束整个会话。
///
/// **二次确认由前端负责**（PRD FR-06）：本命令是无条件执行的原语。
#[tauri::command]
pub async fn tmux_kill_session(name: String) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("会话名不能为空".to_string());
    }
    run_tmux(vec!["kill-session".to_string(), "-t".to_string(), name]).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 拼一行 tmux 格式串输出，字段顺序与 `LIST_FORMAT` 一致。
    fn line(fields: &[&str]) -> String {
        fields.join(&FIELD_SEP.to_string())
    }

    // === 解析：正常路径 ===

    #[test]
    fn ut_b01_解析单行_七个字段全部正确() {
        let out = line(&[
            "build-farm",
            "3",
            "1",
            "1700000000",
            "/home/dev/project",
            "cargo",
            "nightly build",
        ]);
        let sessions = parse_sessions(&out);
        assert_eq!(sessions.len(), 1);
        let s = &sessions[0];
        assert_eq!(s.name, "build-farm");
        assert_eq!(s.windows, 3);
        assert_eq!(s.attached, 1);
        assert_eq!(s.created, 1_700_000_000);
        assert_eq!(s.current_path.as_deref(), Some("/home/dev/project"));
        assert_eq!(s.current_command.as_deref(), Some("cargo"));
        assert_eq!(s.title.as_deref(), Some("nightly build"));
    }

    #[test]
    fn ut_b02_解析多行_返回等量会话() {
        let out = format!(
            "{}\n{}\n{}",
            line(&["alpha", "1", "0", "1700000001", "/tmp", "zsh", "alpha"]),
            line(&["beta", "2", "1", "1700000002", "/tmp", "vim", "beta"]),
            line(&["gamma", "5", "0", "1700000003", "/tmp", "bash", "gamma"]),
        );
        let sessions = parse_sessions(&out);
        assert_eq!(sessions.len(), 3);
        assert_eq!(sessions[1].name, "beta");
        assert_eq!(sessions[2].windows, 5);
    }

    // === 解析：边界与异常 ===

    #[test]
    fn ut_b03_空字符串字段归一为_none() {
        let out = line(&["solo", "1", "0", "1700000000", "", "", ""]);
        let sessions = parse_sessions(&out);
        assert_eq!(sessions.len(), 1);
        assert!(sessions[0].current_path.is_none());
        assert!(sessions[0].current_command.is_none());
        assert!(sessions[0].title.is_none());
    }

    #[test]
    fn ut_b04_字段数不足的坏行被跳过_不影响其余行() {
        let out = format!(
            "{}\n{}\n{}",
            line(&["good-1", "1", "0", "1700000000", "/tmp", "zsh", "t1"]),
            line(&["broken", "1", "0"]), // 只有 3 个字段
            line(&["good-2", "1", "0", "1700000000", "/tmp", "zsh", "t2"]),
        );
        let sessions = parse_sessions(&out);
        assert_eq!(sessions.len(), 2, "坏行应被跳过，好行照常解析");
        assert_eq!(sessions[0].name, "good-1");
        assert_eq!(sessions[1].name, "good-2");
    }

    #[test]
    fn ut_b05_数字字段非数字时兜底为零_不_panic() {
        let out = line(&["odd", "x", "y", "z", "/tmp", "zsh", "t"]);
        let sessions = parse_sessions(&out);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].windows, 0);
        assert_eq!(sessions[0].attached, 0);
        assert_eq!(sessions[0].created, 0);
    }

    #[test]
    fn ut_b06_空输入返回空数组() {
        assert!(parse_sessions("").is_empty());
        assert!(parse_sessions("\n\n  \n").is_empty());
    }

    // === attach 命令构造与 shell 转义（安全重点）===

    #[test]
    fn ut_b07_会话名含空格_被单引号包裹() {
        let cmd = build_attach_command("my work", false).unwrap();
        assert_eq!(cmd, "tmux attach-session -t 'my work'");
    }

    #[test]
    fn ut_b08_会话名含单引号_转义为闭合再拼接序列() {
        let cmd = build_attach_command("it's mine", false).unwrap();
        assert_eq!(cmd, r#"tmux attach-session -t 'it'\''s mine'"#);
    }

    #[test]
    fn ut_b09_会话名含分号与危险命令_不逸出引号() {
        let evil = "x; rm -rf ~";
        let cmd = build_attach_command(evil, false).unwrap();
        assert_eq!(cmd, "tmux attach-session -t 'x; rm -rf ~'");
        // 分号必须仍在引号内部：引号外不允许出现分号
        let after_quote_open = cmd.split_once('\'').unwrap().1;
        let inside = after_quote_open.rsplit_once('\'').unwrap().0;
        assert!(inside.contains(';'), "分号应留在引号内");
        assert!(
            !cmd.replace(&format!("'{inside}'"), "").contains(';'),
            "引号外不允许出现分号"
        );
    }

    #[test]
    fn ut_b10_接管模式命令含_d_且在_t_之前() {
        let cmd = build_attach_command("work", true).unwrap();
        assert_eq!(cmd, "tmux attach-session -d -t 'work'");
        assert!(cmd.find("-d").unwrap() < cmd.find("-t").unwrap());
    }

    #[test]
    fn ut_b11_空会话名或纯空白返回错误() {
        assert!(build_attach_command("", false).is_err());
        assert!(build_attach_command("   ", false).is_err());
        assert!(build_attach_command("\t\n", true).is_err());
    }

    // === "无服务端" vs 真错误 ===

    #[test]
    fn ut_b12_no_server_running_判定为无会话() {
        assert!(is_no_server_error(
            "no server running on /tmp/tmux-501/default"
        ));
    }

    #[test]
    fn ut_b13_其余无会话措辞同样被识别() {
        assert!(is_no_server_error("no sessions"));
        assert!(is_no_server_error("error connecting to /tmp/tmux-501/default"));
        // 大小写不敏感
        assert!(is_no_server_error("No Server Running"));
    }

    #[test]
    fn ut_b14_其它_stderr_判定为真错误() {
        assert!(!is_no_server_error("session not found: ghost"));
        assert!(!is_no_server_error("permission denied"));
        assert!(!is_no_server_error(""));
    }

    // === 可用性探测（真跑本机，但只断言"不 panic + 返回布尔"）===

    #[tokio::test]
    async fn ut_b15_available_探测不报错也不_panic() {
        // 有无 tmux 都是合法结果（CI / 别人的机器上可能没装），
        // 所以这里断言的是"调用链跑得通且不返回错误"，不断言具体取值。
        tmux_available().await.expect("探测 tmux 可用性不应返回错误");
    }
}
