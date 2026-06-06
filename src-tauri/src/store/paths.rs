//! `~/.aitm/` 下的数据库路径辅助。
//!
//! 全局 db：`~/.aitm/global.db`
//! 项目 db：`~/.aitm/projects/<UUID>/data.db`
//! 全局桶（用户选"临时全局"时对话写这里）：`~/.aitm/projects/_global_/data.db`

use std::path::PathBuf;

use anyhow::{Context, Result};
use uuid::Uuid;

/// 全局桶的 UUID 占位符。spec §7 把"临时全局"对话也按"项目"管理，
/// 用一个固定的非 UUID 字符串作为桶 id，避免和真 UUID 冲突。
pub const GLOBAL_BUCKET_ID: &str = "_global_";

/// `~/.aitm/` 根目录。允许通过 `AITM_HOME` env 覆盖（测试用）。
///
/// 不调 `dirs::home_dir()` 失败 panic，而是返回 Err — 这层是基础设施，
/// 上层可以选择降级（不持久化）或退出。
pub fn aitm_home() -> Result<PathBuf> {
    if let Ok(custom) = std::env::var("AITM_HOME") {
        return Ok(PathBuf::from(custom));
    }
    let home = dirs::home_dir().context("找不到 HOME 目录")?;
    Ok(home.join(".aitm"))
}

/// 全局 db 路径：`~/.aitm/global.db`。
pub fn global_db_path() -> Result<PathBuf> {
    Ok(aitm_home()?.join("global.db"))
}

/// 项目 db 路径：`~/.aitm/projects/<UUID>/data.db`。
///
/// `bucket_id` 可以是 UUID 字符串或 [`GLOBAL_BUCKET_ID`]（"_global_"）。
pub fn project_db_path(bucket_id: &str) -> Result<PathBuf> {
    Ok(aitm_home()?
        .join("projects")
        .join(bucket_id)
        .join("data.db"))
}

/// 项目 bucket 目录：`~/.aitm/projects/<UUID>/`（不含 data.db）。
pub fn project_bucket_dir(bucket_id: &str) -> Result<PathBuf> {
    Ok(aitm_home()?.join("projects").join(bucket_id))
}

/// 把 UUID 转成 bucket id 字符串（连字符格式，与 spec §7.3 示例一致）。
pub fn uuid_to_bucket_id(id: &Uuid) -> String {
    id.hyphenated().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn with_home<F: FnOnce(&std::path::Path)>(f: F) {
        // 共享 lib 根的 ENV_LOCK 与 store/scope 其他模块串行（避免并行 race）
        let _g = crate::test_env_lock::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let tmp = TempDir::new().unwrap();
        let prev = std::env::var("AITM_HOME").ok();
        // SAFETY: HOME_LOCK 串行
        unsafe {
            std::env::set_var("AITM_HOME", tmp.path());
        }
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(tmp.path())));
        unsafe {
            match prev {
                Some(v) => std::env::set_var("AITM_HOME", v),
                None => std::env::remove_var("AITM_HOME"),
            }
        }
        if let Err(e) = r {
            std::panic::resume_unwind(e);
        }
    }

    #[test]
    fn aitm_home_env_覆盖优先() {
        with_home(|tmp| {
            assert_eq!(aitm_home().unwrap(), tmp);
        });
    }

    #[test]
    fn global_db_路径() {
        with_home(|tmp| {
            assert_eq!(global_db_path().unwrap(), tmp.join("global.db"));
        });
    }

    #[test]
    fn project_db_路径_用_uuid() {
        with_home(|tmp| {
            assert_eq!(
                project_db_path("abc-123").unwrap(),
                tmp.join("projects").join("abc-123").join("data.db"),
            );
        });
    }

    #[test]
    fn 全局桶_id_是_underscore_global() {
        with_home(|tmp| {
            assert_eq!(
                project_db_path(GLOBAL_BUCKET_ID).unwrap(),
                tmp.join("projects").join("_global_").join("data.db"),
            );
        });
    }

    #[test]
    fn uuid_to_bucket_id_用连字符格式() {
        let u = Uuid::parse_str("0193abf1-7c2e-4d8a-9f0c-e1a3b5c7d9e2").unwrap();
        assert_eq!(uuid_to_bucket_id(&u), "0193abf1-7c2e-4d8a-9f0c-e1a3b5c7d9e2");
    }
}
