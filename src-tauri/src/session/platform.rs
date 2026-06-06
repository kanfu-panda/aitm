//! 跨平台的 session 相关辅助函数。
//!
//! 把 shell 默认值这种依赖宿主操作系统的判断集中到一处，
//! 避免散落在 `pty_session.rs` / `manager.rs` 等地方各自硬编码。

/// 跨平台获取默认 shell 路径。
///
/// 优先级：
/// - Windows：环境变量 `ComSpec`（通常是 `C:\Windows\System32\cmd.exe`），
///   未设时回退到字面量 `"cmd.exe"`（让 portable-pty 自己在 PATH 上找）
/// - macOS：`/bin/zsh`（Catalina+ 起的系统默认）
/// - 其他 Unix（Linux / *BSD）：`/bin/bash`
///
/// 注意：调用方仍然优先尊重用户在 `SessionConfig.shell` 或 `$SHELL` 里
/// 显式给的值；这里只是"什么都没给"时的兜底。
pub fn default_shell() -> String {
    if cfg!(target_os = "windows") {
        // Windows: 环境变量是 ComSpec（混合大小写）；std::env::var 在 Windows 上
        // 对环境变量名大小写不敏感，但为了清晰仍用规范拼写
        std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string())
    } else if cfg!(target_os = "macos") {
        "/bin/zsh".to_string()
    } else {
        "/bin/bash".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_shell_平台分支() {
        let shell = default_shell();
        if cfg!(target_os = "windows") {
            // ComSpec 通常指向 cmd.exe；个别用户可能改成 PowerShell
            assert!(
                shell.to_lowercase().contains("cmd.exe")
                    || shell.to_lowercase().contains("powershell"),
                "Windows 期望 cmd.exe 或 powershell，实际: {shell}"
            );
        } else if cfg!(target_os = "macos") {
            assert_eq!(shell, "/bin/zsh");
        } else {
            assert_eq!(shell, "/bin/bash");
        }
    }

    #[test]
    fn default_shell_非空() {
        // 任何平台下都不应给出空串
        assert!(!default_shell().is_empty());
    }
}
