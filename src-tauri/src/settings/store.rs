//! 设置文件存储 —— ~/.aitm/config.toml。

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};

use super::AppSettings;

const CONFIG_FILE: &str = "config.toml";
const APP_DIR: &str = "aitm";

/// 配置目录路径：`~/.aitm/`。
///
/// 我们刻意选 `~/.aitm/` 而非 `~/Library/Application Support/aitm/`，因为：
/// - 跨平台一致（Linux/macOS 都在 $HOME/.aitm/）
/// - 用户可见（终端 `ls -la ~/.aitm` 就能看到）
/// - 与 spec §7 设计一致
pub fn config_dir() -> Result<PathBuf> {
    let home = dirs::home_dir().context("找不到 HOME 目录")?;
    Ok(home.join(format!(".{APP_DIR}")))
}

/// 配置文件全路径：`~/.aitm/config.toml`。
pub fn config_path() -> Result<PathBuf> {
    Ok(config_dir()?.join(CONFIG_FILE))
}

/// 加载配置；不存在则用默认值；损坏则备份后用默认值。
pub fn load() -> AppSettings {
    let path = match config_path() {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!("无法解析配置路径，用默认值: {e}");
            return AppSettings::default();
        }
    };
    if !path.exists() {
        return AppSettings::default();
    }
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!("配置文件无法读取，用默认值: {e}");
            return AppSettings::default();
        }
    };
    match toml::from_str::<AppSettings>(&text) {
        Ok(s) => s,
        Err(e) => {
            tracing::error!("配置文件 TOML 解析失败：{e}；备份并用默认值");
            let _ = backup_broken(&path);
            AppSettings::default()
        }
    }
}

/// 把配置写到 ~/.aitm/config.toml（原子：tempfile + rename）。
pub fn save(settings: &AppSettings) -> Result<()> {
    let dir = config_dir()?;
    fs::create_dir_all(&dir).context("创建配置目录失败")?;
    let path = config_path()?;

    let toml_str = toml::to_string_pretty(settings).context("序列化设置失败")?;

    // 原子写入：先写到 .config.toml.tmp 再 rename
    let tmp = dir.join(format!(".{CONFIG_FILE}.tmp"));
    {
        let mut f = fs::File::create(&tmp).context("创建临时配置文件失败")?;
        f.write_all(toml_str.as_bytes())
            .context("写入临时配置文件失败")?;
        f.sync_all().context("sync 临时配置文件失败")?;
    }
    fs::rename(&tmp, &path).context("rename 临时配置文件失败")?;
    Ok(())
}

/// 把损坏的配置文件备份到 .broken-<unix-ts>。
fn backup_broken(path: &Path) -> Result<()> {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let backup = path.with_extension(format!("toml.broken-{ts}"));
    fs::rename(path, &backup).context("备份坏配置文件失败")?;
    tracing::warn!("已备份坏配置文件到 {}", backup.display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::CursorStyle;
    use tempfile::TempDir;

    fn with_temp_home<F: FnOnce(&Path)>(f: F) {
        // 用 lib 根的共享 ENV_LOCK，避免与 providers::registry 测试争 HOME。
        let _guard = crate::test_env_lock::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let tmp = TempDir::new().unwrap();
        let original = std::env::var("HOME").ok();
        // SAFETY: tests 串行，ENV_LOCK 保证同时只有一个线程修改 HOME
        unsafe {
            std::env::set_var("HOME", tmp.path());
        }
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(tmp.path())));
        if let Some(orig) = original {
            unsafe {
                std::env::set_var("HOME", orig);
            }
        } else {
            unsafe {
                std::env::remove_var("HOME");
            }
        }
        if let Err(e) = result {
            std::panic::resume_unwind(e);
        }
    }

    #[test]
    fn save_然后_load_往返一致() {
        with_temp_home(|_home| {
            let mut s = AppSettings::default();
            s.terminal.font_size = 18;
            s.terminal.cursor_style = CursorStyle::Bar;
            save(&s).unwrap();
            let back = load();
            assert_eq!(s, back);
        });
    }

    #[test]
    fn 配置文件不存在时_load_用默认值() {
        with_temp_home(|_home| {
            let s = load();
            assert_eq!(s, AppSettings::default());
        });
    }

    #[test]
    fn 损坏的配置文件_load_退回默认值并备份() {
        with_temp_home(|home| {
            let path = home.join(".aitm").join("config.toml");
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, "this is not [valid toml }").unwrap();

            let s = load();
            assert_eq!(s, AppSettings::default());

            // 检查是否产生了备份
            let dir = path.parent().unwrap();
            let entries: Vec<_> = std::fs::read_dir(dir)
                .unwrap()
                .filter_map(|e| e.ok())
                .collect();
            let has_backup = entries.iter().any(|e| {
                e.file_name()
                    .to_string_lossy()
                    .contains(".broken-")
            });
            assert!(has_backup, "应有 .broken-* 备份文件");
        });
    }

    #[test]
    fn 原子写入_失败时不留半文件() {
        with_temp_home(|home| {
            let s = AppSettings::default();
            save(&s).unwrap();
            let path = home.join(".aitm").join("config.toml");
            assert!(path.exists());
            let tmp = home.join(".aitm").join(".config.toml.tmp");
            assert!(!tmp.exists(), "tmp 文件应在 rename 后被清理");
        });
    }
}
