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

/// 把整棵目录收紧：目录 0700、普通文件 0600，返回实际改动的条目数。
///
/// 用于启动时补救**存量安装**：旧版本从没设过权限，文件按 umask 落成 0644 / 0755；
/// 写入路径上的收紧只在下次写同一文件时才生效，用户若从不改设置，旧文件会一直宽松。
///
/// 符号链接不跟随、不修改（避免改到目录外的文件）。根目录不存在视为无事可做。
/// 非 Unix 平台恒返回 0。
#[cfg(unix)]
pub fn tighten_tree(root: &Path) -> Result<usize> {
    use std::os::unix::fs::PermissionsExt;

    let meta = match std::fs::symlink_metadata(root) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e.into()),
    };
    let current = meta.permissions().mode() & 0o777;
    let mut changed = 0;
    if meta.is_dir() {
        if current != 0o700 {
            set_private_dir(root)?;
            changed += 1;
        }
        for entry in std::fs::read_dir(root)? {
            changed += tighten_tree(&entry?.path())?;
        }
    } else if meta.is_file() && current != 0o600 {
        set_private_file(root)?;
        changed += 1;
    }
    Ok(changed)
}

#[cfg(not(unix))]
pub fn tighten_tree(_root: &Path) -> Result<usize> {
    Ok(0)
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
    fn 应该_当旧版本留下宽松权限时_启动收紧把整棵目录收到目录700文件600() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join(".aitm");
        let proj = root.join("projects").join("p1");
        std::fs::create_dir_all(&proj).unwrap();
        let cfg = root.join("config.toml");
        let db = proj.join("data.db");
        std::fs::write(&cfg, "api_key = 'x'").unwrap();
        std::fs::write(&db, "db").unwrap();
        for d in [&root, &root.join("projects"), &proj] {
            std::fs::set_permissions(d, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        for f in [&cfg, &db] {
            std::fs::set_permissions(f, std::fs::Permissions::from_mode(0o644)).unwrap();
        }

        let changed = tighten_tree(&root).unwrap();

        assert_eq!(mode_of(&root), 0o700);
        assert_eq!(mode_of(&root.join("projects")), 0o700);
        assert_eq!(mode_of(&proj), 0o700);
        assert_eq!(mode_of(&cfg), 0o600);
        assert_eq!(mode_of(&db), 0o600);
        assert_eq!(changed, 5);
    }

    #[test]
    fn 应该_当权限已经收紧时_不做任何改动() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join(".aitm");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("config.toml"), "").unwrap();
        set_private_dir(&root).unwrap();
        set_private_file(&root.join("config.toml")).unwrap();

        assert_eq!(tighten_tree(&root).unwrap(), 0);
    }

    #[test]
    fn 应该_当目录不存在时_什么都不做() {
        let tmp = TempDir::new().unwrap();
        assert_eq!(tighten_tree(&tmp.path().join("没有")).unwrap(), 0);
    }

    #[test]
    fn 应该_不跟随符号链接去改目录外的文件() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join(".aitm");
        std::fs::create_dir(&root).unwrap();
        let outside = tmp.path().join("outside.txt");
        std::fs::write(&outside, "x").unwrap();
        std::fs::set_permissions(&outside, std::fs::Permissions::from_mode(0o644)).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();

        tighten_tree(&root).unwrap();

        assert_eq!(mode_of(&outside), 0o644);
    }

    #[test]
    fn 路径不存在时返回错误而不是panic() {
        let tmp = TempDir::new().unwrap();
        let missing = tmp.path().join("不存在");

        assert!(set_private_file(&missing).is_err());
    }
}
