//! SQLite schema + 迁移。
//!
//! 全局 db schema 和项目 db schema 分两套；版本号写在各自 db 的 `app_state` /
//! `_meta` 表里。本 phase 都是 v1，未来加 schema 改动时在 `migrate_*` 里加分支。

use anyhow::{Context, Result};
use rusqlite::Connection;

/// 全局 db 当前 schema 版本。
pub const GLOBAL_SCHEMA_VERSION: u32 = 1;

/// 项目 db 当前 schema 版本。
pub const PROJECT_SCHEMA_VERSION: u32 = 1;

/// 全局 db v1 SQL —— 启动时 idempotent 跑（CREATE TABLE IF NOT EXISTS）。
const GLOBAL_SCHEMA_V1: &str = "\
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS app_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_path TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ignored_paths (
    path TEXT PRIMARY KEY,
    added_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS token_usage_monthly (
    project_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    yyyymm TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (project_id, provider_id, yyyymm)
);
";

/// 项目 db v1 SQL —— 懒创建时跑。
const PROJECT_SCHEMA_V1: &str = "\
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS _meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    title_auto INTEGER NOT NULL,
    provider_id TEXT NOT NULL DEFAULT '',
    model_id TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_conv_seq ON messages(conversation_id, seq);
";

/// 给全局 db 跑 schema 迁移到 [`GLOBAL_SCHEMA_VERSION`]。
///
/// 当前只有 v1；未来 v2/v3 时在这里加 match 分支按 from→to 增量迁移。
pub fn migrate_global(conn: &Connection) -> Result<()> {
    conn.execute_batch(GLOBAL_SCHEMA_V1)
        .context("全局 db schema v1 迁移失败")?;

    let cur = read_global_version(conn)?;
    if cur < GLOBAL_SCHEMA_VERSION {
        // 写当前版本号；未来 v2+ 在这里加 if cur < 2 { ... } 块
        write_global_version(conn, GLOBAL_SCHEMA_VERSION)?;
    }
    Ok(())
}

/// 给项目 db 跑 schema 迁移。
pub fn migrate_project(conn: &Connection) -> Result<()> {
    conn.execute_batch(PROJECT_SCHEMA_V1)
        .context("项目 db schema v1 迁移失败")?;

    let cur = read_project_version(conn)?;
    if cur < PROJECT_SCHEMA_VERSION {
        write_project_version(conn, PROJECT_SCHEMA_VERSION)?;
    }
    Ok(())
}

fn read_global_version(conn: &Connection) -> Result<u32> {
    let v: Option<String> = conn
        .query_row(
            "SELECT value FROM app_state WHERE key = 'schema_version'",
            [],
            |r| r.get(0),
        )
        .ok();
    Ok(v.and_then(|s| s.parse().ok()).unwrap_or(0))
}

fn write_global_version(conn: &Connection, v: u32) -> Result<()> {
    conn.execute(
        "INSERT INTO app_state (key, value) VALUES ('schema_version', ?1) \
         ON CONFLICT(key) DO UPDATE SET value = ?1",
        [v.to_string()],
    )?;
    Ok(())
}

fn read_project_version(conn: &Connection) -> Result<u32> {
    let v: Option<String> = conn
        .query_row(
            "SELECT value FROM _meta WHERE key = 'schema_version'",
            [],
            |r| r.get(0),
        )
        .ok();
    Ok(v.and_then(|s| s.parse().ok()).unwrap_or(0))
}

fn write_project_version(conn: &Connection, v: u32) -> Result<()> {
    conn.execute(
        "INSERT INTO _meta (key, value) VALUES ('schema_version', ?1) \
         ON CONFLICT(key) DO UPDATE SET value = ?1",
        [v.to_string()],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_in_memory() -> Connection {
        Connection::open_in_memory().unwrap()
    }

    #[test]
    fn 全局_migrate_首次创建_4_表() {
        let conn = open_in_memory();
        migrate_global(&conn).unwrap();

        for table in ["app_state", "projects", "ignored_paths", "token_usage_monthly"] {
            let cnt: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    [table],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(cnt, 1, "{table} 应被创建");
        }
    }

    #[test]
    fn 全局_migrate_idempotent() {
        let conn = open_in_memory();
        migrate_global(&conn).unwrap();
        // 跑两次不应报错
        migrate_global(&conn).unwrap();
        migrate_global(&conn).unwrap();

        let v = read_global_version(&conn).unwrap();
        assert_eq!(v, GLOBAL_SCHEMA_VERSION);
    }

    #[test]
    fn 项目_migrate_首次创建_3_表_含索引() {
        let conn = open_in_memory();
        migrate_project(&conn).unwrap();

        for table in ["_meta", "conversations", "messages"] {
            let cnt: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    [table],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(cnt, 1, "{table} 应被创建");
        }

        let idx: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_messages_conv_seq'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(idx, 1);
    }

    #[test]
    fn 项目_migrate_idempotent() {
        let conn = open_in_memory();
        migrate_project(&conn).unwrap();
        migrate_project(&conn).unwrap();
        let v = read_project_version(&conn).unwrap();
        assert_eq!(v, PROJECT_SCHEMA_VERSION);
    }

    #[test]
    fn 全局_messages_级联删除外键开启() {
        let conn = open_in_memory();
        migrate_project(&conn).unwrap();
        // 验证 PRAGMA foreign_keys 真的生效（PRAGMA 是 connection 级，schema SQL 中
        // 的 PRAGMA 在 batch 里执行）
        let on: i64 = conn
            .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
            .unwrap();
        assert_eq!(on, 1);
    }
}
