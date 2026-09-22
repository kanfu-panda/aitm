//! 敏感文件与目录的权限收紧 —— 仅 Unix 生效。
//!
//! `~/.aitm/` 下存着明文 API 密钥（`config.toml`）与 AI 对话数据库。
//! 进程默认 umask 通常是 022，落盘就是 0644 / 0755；而在 macOS 上所有本地账户
//! 默认同属 `staff` 组，于是同组用户可以读到密钥和对话内容。
//!
//! 所以写这些文件时必须**显式**收紧权限，不能依赖 umask —— umask 由启动环境决定，
//! 应用无法假设它是什么。
//!
//! Windows 没有 POSIX mode 位，两个函数在非 Unix 平台是 no-op。

use std::path::Path;

use anyhow::Result;

/// 把目录收紧到 0700：仅属主可进入 / 读 / 写。
pub fn set_private_dir(path: &Path) -> Result<()> {
    set_mode(path, 0o700)
}

/// 把文件收紧到 0600：仅属主可读写。
pub fn set_private_file(path: &Path) -> Result<()> {
    set_mode(path, 0o600)
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> Result<()> {
    use anyhow::Context;
    use std::os::unix::fs::PermissionsExt;

    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
        .with_context(|| format!("设置权限 {mode:o} 失败：{}", path.display()))
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) -> Result<()> {
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use tempfile::TempDir;

    fn mode_of(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn set_private_dir_把目录收紧到_700() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("sub");
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();

        set_private_dir(&dir).unwrap();

        assert_eq!(mode_of(&dir), 0o700);
    }

    #[test]
    fn set_private_file_把文件收紧到_600() {
        let tmp = TempDir::new().unwrap();
        let file = tmp.path().join("secret.toml");
        std::fs::write(&file, "k = 1").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();

        set_private_file(&file).unwrap();

        assert_eq!(mode_of(&file), 0o600);
    }

    #[test]
    fn 路径不存在时返回错误而不是panic() {
        let tmp = TempDir::new().unwrap();
        let missing = tmp.path().join("不存在");

        assert!(set_private_file(&missing).is_err());
    }
}
