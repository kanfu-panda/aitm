//! 本地 PTY 会话管理。
//!
//! 一个 [`Session`] = 一个跑在子进程里的 shell（zsh/bash/fish 等），
//! 通过 PTY（伪终端）双向通信。每个 session 由后台 tokio task 持续
//! 读取 PTY 输出，把 raw bytes 通过 Tauri event 推给前端。

use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub mod cwd_poller;
pub mod manager;
pub mod metadata;
pub mod osc_parser;
pub mod platform;
pub mod ports;
pub mod pty_session;
pub mod sentinel;
pub mod shell_hook;
pub mod snapshot;

pub use platform::default_shell;

/// 会话唯一标识。前端和后端都用这个引用具体 session。
#[derive(Debug, Clone, Copy, Hash, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SessionId(pub Uuid);

impl SessionId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for SessionId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for SessionId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// 创建会话所需的配置。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionConfig {
    /// 要执行的 shell；`None` 表示沿用系统 `$SHELL`，再回退到 [`platform::default_shell`]
    /// （macOS `/bin/zsh` / Linux `/bin/bash` / Windows `cmd.exe`）。
    pub shell: Option<String>,
    /// 工作目录；`None` 沿用 `$HOME`。
    pub cwd: Option<String>,
    /// 初始终端列数（character columns）。
    pub cols: u16,
    /// 初始终端行数。
    pub rows: u16,
}

impl Default for SessionConfig {
    fn default() -> Self {
        Self {
            shell: None,
            cwd: None,
            cols: 80,
            rows: 24,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_id_两次生成不相同() {
        let a = SessionId::new();
        let b = SessionId::new();
        assert_ne!(a, b);
    }

    #[test]
    fn session_id_可序列化为透明_uuid_字符串() {
        let id = SessionId::new();
        let json = serde_json::to_string(&id).unwrap();
        // 透明序列化 → 直接是带引号的 UUID 字符串
        assert!(json.starts_with('"'));
        assert!(json.ends_with('"'));
        assert_eq!(json.len(), 38); // 36 字符 UUID + 2 引号
    }

    #[test]
    fn session_config_默认值合理() {
        let cfg = SessionConfig::default();
        assert_eq!(cfg.cols, 80);
        assert_eq!(cfg.rows, 24);
        assert!(cfg.shell.is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn session_spawn_打开_echo_命令_产出_hello_world() {
        use super::manager::SessionManager;
        use std::time::Duration;

        let mgr = SessionManager::new();
        let cfg = SessionConfig {
            shell: Some("/bin/sh".to_string()),
            cwd: None,
            cols: 80,
            rows: 24,
        };

        let id = mgr.open(cfg).await.expect("打开 session 失败");
        // 写 echo 然后退出
        mgr.write(id, b"echo hello-aitm\n").await.unwrap();
        mgr.write(id, b"exit\n").await.unwrap();

        // 给 PTY 时间生产输出
        let mut received = Vec::new();
        let timeout = tokio::time::Instant::now() + Duration::from_secs(3);
        while tokio::time::Instant::now() < timeout {
            if let Some(bytes) = mgr.try_recv(id).await {
                received.extend_from_slice(&bytes);
                if String::from_utf8_lossy(&received).contains("hello-aitm") {
                    break;
                }
            } else {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }

        let text = String::from_utf8_lossy(&received);
        assert!(text.contains("hello-aitm"), "期望看到 echo 输出，实际收到：{text:?}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn session_resize_后_tput_报告新尺寸() {
        use super::manager::SessionManager;
        use std::time::Duration;

        let mgr = SessionManager::new();
        let cfg = SessionConfig {
            shell: Some("/bin/sh".to_string()),
            cols: 80,
            rows: 24,
            ..Default::default()
        };
        let id = mgr.open(cfg).await.unwrap();

        // resize 到 100x40
        mgr.resize(id, 100, 40).await.unwrap();
        // 让子 shell 报告
        mgr.write(id, b"tput cols; tput lines; exit\n").await.unwrap();

        let mut received = Vec::new();
        let timeout = tokio::time::Instant::now() + Duration::from_secs(3);
        while tokio::time::Instant::now() < timeout {
            if let Some(bytes) = mgr.try_recv(id).await {
                received.extend_from_slice(&bytes);
            } else {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }

        let text = String::from_utf8_lossy(&received);
        assert!(text.contains("100"), "tput cols 应为 100，输出：{text:?}");
        assert!(text.contains("40"), "tput lines 应为 40，输出：{text:?}");
    }
}
