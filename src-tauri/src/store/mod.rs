//! SQLite 数据访问层。
//!
//! 双层 schema：
//! - 全局 db `~/.aitm/global.db`：projects / ignored_paths / token_usage_monthly
//! - 项目 db `~/.aitm/projects/<UUID>/data.db`：conversations / messages
//!
//! 关键设计：
//! - **懒创建**：用户没用 AI 不创建任何文件（spec §7.2）。`AitmDb::new` 不
//!   open 全局 db；首次需要时才 open + migrate。
//! - **rusqlite + bundled**：静态链接 sqlite3，避免依赖系统库。
//! - **同步 API + spawn_blocking**：rusqlite 是同步的，IPC 命令调用前
//!   需要用 `tokio::task::spawn_blocking` 包一下避免阻塞 tokio worker。

pub mod paths;
pub mod repo_global;
pub mod repo_project;
pub mod schema;

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use anyhow::{Context, Result};
use rusqlite::Connection;

/// 全局 + 项目 db 连接池。
///
/// 用 `std::sync::Mutex` 而非 `tokio::sync::Mutex`：rusqlite 调用是同步的，
/// 持锁时间极短（单 sql 语句 < 1ms），不会跨 await。所有 IPC 调用都包
/// `spawn_blocking` 在阻塞 worker 跑。
pub struct AitmDb {
    /// 全局 db 连接。`None` 表示尚未打开（懒创建）。
    global: Mutex<Option<Connection>>,
    /// 项目 db 连接池：bucket_id → Connection。bucket_id 是 UUID 字符串
    /// 或 `_global_`（全局桶占位）。同一 bucket 多次访问复用连接。
    projects: Mutex<HashMap<String, Connection>>,
}

impl AitmDb {
    /// 创建空 AitmDb，**不**打开任何 db 文件（懒创建）。
    pub fn new() -> Self {
        Self {
            global: Mutex::new(None),
            projects: Mutex::new(HashMap::new()),
        }
    }

    /// 取（必要时打开 + migrate）全局 db 连接，传给闭包用。
    ///
    /// 闭包内是同步代码（rusqlite 同步 API）；持锁期间其他对 global db
    /// 的访问会等待 — 但全局 db 的负载就是 projects/ignored 等元信息，
    /// 写少读少，争用可忽略。
    pub fn with_global<F, T>(&self, f: F) -> Result<T>
    where
        F: FnOnce(&Connection) -> Result<T>,
    {
        let mut guard = self.global.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_none() {
            let conn = open_and_migrate_global()?;
            *guard = Some(conn);
        }
        let conn = guard.as_ref().expect("guard 已确保 Some");
        f(conn)
    }

    /// 取（必要时懒创建）项目 db 连接，传给闭包用。
    ///
    /// `bucket_id` 是 UUID 字符串或 `_global_`。
    pub fn with_project<F, T>(&self, bucket_id: &str, f: F) -> Result<T>
    where
        F: FnOnce(&Connection) -> Result<T>,
    {
        let mut pool = self.projects.lock().unwrap_or_else(|e| e.into_inner());
        if !pool.contains_key(bucket_id) {
            let conn = open_and_migrate_project(bucket_id)?;
            pool.insert(bucket_id.to_string(), conn);
        }
        let conn = pool.get(bucket_id).expect("已插入");
        f(conn)
    }
}

impl Default for AitmDb {
    fn default() -> Self {
        Self::new()
    }
}

fn open_and_migrate_global() -> Result<Connection> {
    let path = paths::global_db_path()?;
    ensure_parent_dir(&path)?;
    let conn = Connection::open(&path)
        .with_context(|| format!("打开全局 db 失败: {}", path.display()))?;
    schema::migrate_global(&conn)?;
    Ok(conn)
}

fn open_and_migrate_project(bucket_id: &str) -> Result<Connection> {
    let path = paths::project_db_path(bucket_id)?;
    ensure_parent_dir(&path)?;
    let conn = Connection::open(&path)
        .with_context(|| format!("打开项目 db 失败: {}", path.display()))?;
    schema::migrate_project(&conn)?;
    Ok(conn)
}

fn ensure_parent_dir(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("创建目录失败: {}", parent.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn with_home<F: FnOnce(&std::path::Path)>(f: F) {
        // 共享 lib 根的 ENV_LOCK 与 store::paths / scope 其他测试串行
        let _g = crate::test_env_lock::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let tmp = TempDir::new().unwrap();
        let prev = std::env::var("AITM_HOME").ok();
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
    fn new_不创建任何文件_懒创建() {
        with_home(|tmp| {
            let _db = AitmDb::new();
            assert!(!tmp.exists() || tmp.read_dir().unwrap().next().is_none());
        });
    }

    #[test]
    fn with_global_首次访问_创建_db_目录_和_schema() {
        with_home(|tmp| {
            let db = AitmDb::new();
            db.with_global(|conn| {
                let cnt: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='projects'",
                        [],
                        |r| r.get(0),
                    )?;
                assert_eq!(cnt, 1);
                Ok(())
            })
            .unwrap();

            assert!(tmp.join("global.db").exists());
        });
    }

    #[test]
    fn with_project_懒创建_bucket_目录() {
        with_home(|tmp| {
            let db = AitmDb::new();
            db.with_project("test-bucket", |conn| {
                conn.execute_batch("INSERT INTO _meta (key, value) VALUES ('hello', 'world')")?;
                Ok(())
            })
            .unwrap();

            assert!(tmp
                .join("projects")
                .join("test-bucket")
                .join("data.db")
                .exists());
        });
    }

    #[test]
    fn with_project_同_bucket_id_复用连接() {
        with_home(|_| {
            let db = AitmDb::new();
            db.with_project("b1", |c| {
                c.execute_batch("INSERT INTO _meta (key, value) VALUES ('k', 'v1')")?;
                Ok(())
            })
            .unwrap();
            // 第二次访问 b1 应能读到 v1（同一连接 / 同一 db 文件）
            let v: String = db
                .with_project("b1", |c| {
                    Ok(c.query_row("SELECT value FROM _meta WHERE key = 'k'", [], |r| r.get(0))?)
                })
                .unwrap();
            assert_eq!(v, "v1");
        });
    }

    #[test]
    fn with_global_闭包返回错误_向上传播() {
        with_home(|_| {
            let db = AitmDb::new();
            let r: Result<()> = db.with_global(|_| anyhow::bail!("boom"));
            assert!(r.is_err());
            assert!(r.err().unwrap().to_string().contains("boom"));
        });
    }

    #[test]
    fn 多个_bucket_并存() {
        with_home(|_| {
            let db = AitmDb::new();
            db.with_project("a", |c| {
                c.execute_batch("INSERT INTO _meta (key, value) VALUES ('who', 'a')")?;
                Ok(())
            })
            .unwrap();
            db.with_project("b", |c| {
                c.execute_batch("INSERT INTO _meta (key, value) VALUES ('who', 'b')")?;
                Ok(())
            })
            .unwrap();

            let from_a: String = db
                .with_project("a", |c| {
                    Ok(c.query_row("SELECT value FROM _meta WHERE key='who'", [], |r| r.get(0))?)
                })
                .unwrap();
            let from_b: String = db
                .with_project("b", |c| {
                    Ok(c.query_row("SELECT value FROM _meta WHERE key='who'", [], |r| r.get(0))?)
                })
                .unwrap();
            assert_eq!(from_a, "a");
            assert_eq!(from_b, "b");
        });
    }
}
