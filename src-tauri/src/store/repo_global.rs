//! 全局 db 仓储：projects / ignored_paths / token_usage_monthly。
//!
//! 纯函数风格 CRUD（不包 struct），调用方拿 `&Connection` 用 `with_global`
//! 闭包传入即可。所有错误统一转 `anyhow::Result`，不漏 rusqlite::Error。

use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension, params};

/// 项目元信息表（`projects`）的 CRUD。
pub mod projects {
    use super::*;

    /// projects 表一行。
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct ProjectRow {
        /// UUID 字符串（v7 hyphenated）。
        pub id: String,
        /// 项目展示名（init 时来自 dirname，可被用户改）。
        pub name: String,
        /// 创建时间（Unix 秒）。
        pub created_at: i64,
        /// 最后一次启动时识别到的 cwd（仅展示用，不参与作用域解析）。
        pub last_seen_path: String,
    }

    /// 插入或更新项目。
    ///
    /// 同 id 时更新 `name` + `last_seen_path`，**不动** `created_at`。
    pub fn upsert(conn: &Connection, project: &ProjectRow) -> Result<()> {
        conn.execute(
            "INSERT INTO projects (id, name, created_at, last_seen_path) \
             VALUES (?1, ?2, ?3, ?4) \
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, last_seen_path = excluded.last_seen_path",
            params![
                project.id,
                project.name,
                project.created_at,
                project.last_seen_path,
            ],
        )
        .context("upsert projects 失败")?;
        Ok(())
    }

    /// 列出所有已知项目，按 `created_at DESC` 排序。
    pub fn list_known(conn: &Connection) -> Result<Vec<ProjectRow>> {
        let mut stmt = conn
            .prepare(
                "SELECT id, name, created_at, last_seen_path FROM projects ORDER BY created_at DESC",
            )
            .context("准备 list_known 查询失败")?;
        let rows = stmt
            .query_map([], |r| {
                Ok(ProjectRow {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    created_at: r.get(2)?,
                    last_seen_path: r.get(3)?,
                })
            })
            .context("执行 list_known 失败")?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// 按 UUID 查项目；不存在返回 `None`。
    pub fn get_by_uuid(conn: &Connection, id: &str) -> Result<Option<ProjectRow>> {
        let row = conn
            .query_row(
                "SELECT id, name, created_at, last_seen_path FROM projects WHERE id = ?1",
                [id],
                |r| {
                    Ok(ProjectRow {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        created_at: r.get(2)?,
                        last_seen_path: r.get(3)?,
                    })
                },
            )
            .optional()
            .context("查询 get_by_uuid 失败")?;
        Ok(row)
    }

    /// 仅更新 `last_seen_path`，不会创建。
    ///
    /// 若 id 不存在则**静默忽略**不报错（启动时刷新 last seen 是 best-effort）。
    pub fn update_last_seen(conn: &Connection, id: &str, path: &str) -> Result<()> {
        conn.execute(
            "UPDATE projects SET last_seen_path = ?2 WHERE id = ?1",
            params![id, path],
        )
        .context("update_last_seen 失败")?;
        Ok(())
    }

    /// 删除项目记录（不会删项目 db 文件 —— 那是 T12 / Phase 2 的事）。
    ///
    /// 不存在静默忽略不报错。
    pub fn delete(conn: &Connection, id: &str) -> Result<()> {
        conn.execute("DELETE FROM projects WHERE id = ?1", [id])
            .context("delete project 失败")?;
        Ok(())
    }
}

/// 永久忽略目录列表（用户选"别再问我这个目录"会写到这）。
pub mod ignored_paths {
    use super::*;

    /// 加一条；已存在静默 OK（INSERT OR IGNORE）。
    pub fn add(conn: &Connection, path: &str) -> Result<()> {
        let now = unix_now();
        conn.execute(
            "INSERT OR IGNORE INTO ignored_paths (path, added_at) VALUES (?1, ?2)",
            params![path, now],
        )
        .context("add ignored_path 失败")?;
        Ok(())
    }

    /// 是否在忽略名单。
    pub fn is_ignored(conn: &Connection, path: &str) -> Result<bool> {
        let cnt: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM ignored_paths WHERE path = ?1",
                [path],
                |r| r.get(0),
            )
            .context("查询 is_ignored 失败")?;
        Ok(cnt > 0)
    }

    /// 列出所有忽略路径，按 `added_at DESC` 排序。
    pub fn list(conn: &Connection) -> Result<Vec<String>> {
        let mut stmt = conn
            .prepare("SELECT path FROM ignored_paths ORDER BY added_at DESC")
            .context("准备 list ignored 查询失败")?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .context("执行 list ignored 失败")?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// 移除一条；不存在静默 OK。
    pub fn remove(conn: &Connection, path: &str) -> Result<()> {
        conn.execute("DELETE FROM ignored_paths WHERE path = ?1", [path])
            .context("remove ignored_path 失败")?;
        Ok(())
    }
}

/// token 用量按 (project, provider, yyyymm) 桶累加。
pub mod token_usage {
    use super::*;
    use time::OffsetDateTime;
    use time::macros::format_description;

    /// 单条月度用量记录。
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct UsageRow {
        /// 项目 UUID 字符串，或 `_global_`（全局桶）。
        pub project_id: String,
        /// provider 标识（如 `openai` / `anthropic` / `qwen`）。
        pub provider_id: String,
        /// 月份字符串 `YYYYMM`（如 `202605`）。
        pub yyyymm: String,
        /// 输入 token 累计。
        pub input_tokens: i64,
        /// 输出 token 累计。
        pub output_tokens: i64,
    }

    /// 累加用量到指定 `(project_id, provider_id, yyyymm)` 桶。
    ///
    /// 不存在则插入；存在则把 `input_tokens` 加 `delta_in`、
    /// `output_tokens` 加 `delta_out`。用 `ON CONFLICT DO UPDATE`
    /// 一条 SQL 完成，避免读后改的 race。
    pub fn accumulate(
        conn: &Connection,
        project_id: &str,
        provider_id: &str,
        yyyymm: &str,
        delta_in: i64,
        delta_out: i64,
    ) -> Result<()> {
        conn.execute(
            "INSERT INTO token_usage_monthly \
                 (project_id, provider_id, yyyymm, input_tokens, output_tokens) \
             VALUES (?1, ?2, ?3, ?4, ?5) \
             ON CONFLICT(project_id, provider_id, yyyymm) DO UPDATE SET \
                 input_tokens = input_tokens + excluded.input_tokens, \
                 output_tokens = output_tokens + excluded.output_tokens",
            params![project_id, provider_id, yyyymm, delta_in, delta_out],
        )
        .context("accumulate token_usage 失败")?;
        Ok(())
    }

    /// 拉指定项目的所有月度记录（all providers / all months），按 `yyyymm DESC`。
    pub fn monthly_summary(conn: &Connection, project_id: &str) -> Result<Vec<UsageRow>> {
        let mut stmt = conn
            .prepare(
                "SELECT project_id, provider_id, yyyymm, input_tokens, output_tokens \
                 FROM token_usage_monthly \
                 WHERE project_id = ?1 \
                 ORDER BY yyyymm DESC, provider_id ASC",
            )
            .context("准备 monthly_summary 查询失败")?;
        let rows = stmt
            .query_map([project_id], |r| {
                Ok(UsageRow {
                    project_id: r.get(0)?,
                    provider_id: r.get(1)?,
                    yyyymm: r.get(2)?,
                    input_tokens: r.get(3)?,
                    output_tokens: r.get(4)?,
                })
            })
            .context("执行 monthly_summary 失败")?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// 取当前月份字符串 `YYYYMM`（UTC）。
    ///
    /// 用 `time` crate 取 UTC 当前时间格式化（pure Rust，比 chrono 轻），
    /// 用 UTC 而不是 local — 月度用量是粗粒度统计，时区差异可忽略，
    /// 用 UTC 避免时区相关 flaky 测试。
    pub fn current_yyyymm() -> String {
        format_yyyymm(OffsetDateTime::now_utc())
    }

    /// 把 `OffsetDateTime` 格式化为 `YYYYMM`。抽出来便于单测注入固定时间。
    pub(crate) fn format_yyyymm(dt: OffsetDateTime) -> String {
        let fmt = format_description!("[year][month]");
        dt.format(&fmt)
            .expect("[year][month] 格式化必然成功")
    }
}

/// Unix 秒时间戳（用于 `ignored_paths.added_at` 等）。
fn unix_now() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::schema;

    /// 起一个跑过 migrate 的内存 db。
    fn fresh_global_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        schema::migrate_global(&conn).unwrap();
        conn
    }

    // ===== projects =====

    #[test]
    fn projects_upsert_首次插入_列表能查到() {
        let conn = fresh_global_conn();
        let p = projects::ProjectRow {
            id: "uuid-1".to_string(),
            name: "demo".to_string(),
            created_at: 1_700_000_000,
            last_seen_path: "/foo".to_string(),
        };
        projects::upsert(&conn, &p).unwrap();
        let list = projects::list_known(&conn).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0], p);
    }

    #[test]
    fn projects_upsert_同_id_只更新_name_和_path_不动_created_at() {
        let conn = fresh_global_conn();
        let p1 = projects::ProjectRow {
            id: "uuid-1".to_string(),
            name: "old".to_string(),
            created_at: 1_700_000_000,
            last_seen_path: "/foo".to_string(),
        };
        projects::upsert(&conn, &p1).unwrap();

        let p2 = projects::ProjectRow {
            id: "uuid-1".to_string(),
            name: "new".to_string(),
            created_at: 9_999_999_999, // 想骗 update created_at
            last_seen_path: "/bar".to_string(),
        };
        projects::upsert(&conn, &p2).unwrap();

        let got = projects::get_by_uuid(&conn, "uuid-1").unwrap().unwrap();
        assert_eq!(got.name, "new");
        assert_eq!(got.last_seen_path, "/bar");
        assert_eq!(got.created_at, 1_700_000_000, "created_at 不应被覆盖");
    }

    #[test]
    fn projects_list_known_按_created_at_desc_排序() {
        let conn = fresh_global_conn();
        for (id, ts) in [("a", 1000_i64), ("b", 3000), ("c", 2000)] {
            projects::upsert(
                &conn,
                &projects::ProjectRow {
                    id: id.to_string(),
                    name: id.to_string(),
                    created_at: ts,
                    last_seen_path: "/x".to_string(),
                },
            )
            .unwrap();
        }
        let list = projects::list_known(&conn).unwrap();
        let ids: Vec<_> = list.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["b", "c", "a"]);
    }

    #[test]
    fn projects_get_by_uuid_命中和_none() {
        let conn = fresh_global_conn();
        projects::upsert(
            &conn,
            &projects::ProjectRow {
                id: "uuid-1".to_string(),
                name: "demo".to_string(),
                created_at: 1,
                last_seen_path: "/x".to_string(),
            },
        )
        .unwrap();

        assert!(projects::get_by_uuid(&conn, "uuid-1").unwrap().is_some());
        assert!(projects::get_by_uuid(&conn, "uuid-404").unwrap().is_none());
    }

    #[test]
    fn projects_update_last_seen_id_不存在_静默_ok() {
        let conn = fresh_global_conn();
        // 表里啥都没有，update 不应报错
        projects::update_last_seen(&conn, "uuid-ghost", "/elsewhere").unwrap();
        // 也确实没插入新行
        assert_eq!(projects::list_known(&conn).unwrap().len(), 0);
    }

    #[test]
    fn projects_update_last_seen_命中_只改_path() {
        let conn = fresh_global_conn();
        projects::upsert(
            &conn,
            &projects::ProjectRow {
                id: "uuid-1".to_string(),
                name: "demo".to_string(),
                created_at: 1,
                last_seen_path: "/orig".to_string(),
            },
        )
        .unwrap();
        projects::update_last_seen(&conn, "uuid-1", "/new").unwrap();
        let got = projects::get_by_uuid(&conn, "uuid-1").unwrap().unwrap();
        assert_eq!(got.last_seen_path, "/new");
        assert_eq!(got.name, "demo", "name 不应被影响");
    }

    #[test]
    fn projects_delete_不存在_静默_ok() {
        let conn = fresh_global_conn();
        projects::delete(&conn, "uuid-ghost").unwrap();
    }

    #[test]
    fn projects_delete_命中_列表减少() {
        let conn = fresh_global_conn();
        projects::upsert(
            &conn,
            &projects::ProjectRow {
                id: "uuid-1".to_string(),
                name: "demo".to_string(),
                created_at: 1,
                last_seen_path: "/x".to_string(),
            },
        )
        .unwrap();
        assert_eq!(projects::list_known(&conn).unwrap().len(), 1);
        projects::delete(&conn, "uuid-1").unwrap();
        assert_eq!(projects::list_known(&conn).unwrap().len(), 0);
    }

    // ===== ignored_paths =====

    #[test]
    fn ignored_paths_add_后_is_ignored_命中() {
        let conn = fresh_global_conn();
        ignored_paths::add(&conn, "/tmp/foo").unwrap();
        assert!(ignored_paths::is_ignored(&conn, "/tmp/foo").unwrap());
        assert!(!ignored_paths::is_ignored(&conn, "/tmp/other").unwrap());
    }

    #[test]
    fn ignored_paths_add_重复_ok_不报错() {
        let conn = fresh_global_conn();
        ignored_paths::add(&conn, "/tmp/foo").unwrap();
        ignored_paths::add(&conn, "/tmp/foo").unwrap();
        ignored_paths::add(&conn, "/tmp/foo").unwrap();
        assert_eq!(ignored_paths::list(&conn).unwrap().len(), 1);
    }

    #[test]
    fn ignored_paths_list_按_added_at_desc() {
        let conn = fresh_global_conn();
        // 直接用 SQL 灌数据控制 added_at
        for (path, ts) in [("/a", 1_i64), ("/b", 3), ("/c", 2)] {
            conn.execute(
                "INSERT INTO ignored_paths (path, added_at) VALUES (?1, ?2)",
                params![path, ts],
            )
            .unwrap();
        }
        let list = ignored_paths::list(&conn).unwrap();
        assert_eq!(list, vec!["/b", "/c", "/a"]);
    }

    #[test]
    fn ignored_paths_remove_不存在_静默_ok() {
        let conn = fresh_global_conn();
        ignored_paths::remove(&conn, "/nope").unwrap();
    }

    #[test]
    fn ignored_paths_remove_命中_后_is_ignored_变_false() {
        let conn = fresh_global_conn();
        ignored_paths::add(&conn, "/tmp/foo").unwrap();
        assert!(ignored_paths::is_ignored(&conn, "/tmp/foo").unwrap());
        ignored_paths::remove(&conn, "/tmp/foo").unwrap();
        assert!(!ignored_paths::is_ignored(&conn, "/tmp/foo").unwrap());
    }

    // ===== token_usage =====

    #[test]
    fn token_usage_accumulate_首次插入() {
        let conn = fresh_global_conn();
        token_usage::accumulate(&conn, "proj-1", "openai", "202605", 100, 50).unwrap();
        let rows = token_usage::monthly_summary(&conn, "proj-1").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].input_tokens, 100);
        assert_eq!(rows[0].output_tokens, 50);
    }

    #[test]
    fn token_usage_accumulate_同桶累加() {
        let conn = fresh_global_conn();
        token_usage::accumulate(&conn, "proj-1", "openai", "202605", 100, 50).unwrap();
        token_usage::accumulate(&conn, "proj-1", "openai", "202605", 30, 70).unwrap();
        token_usage::accumulate(&conn, "proj-1", "openai", "202605", 1, 1).unwrap();
        let rows = token_usage::monthly_summary(&conn, "proj-1").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].input_tokens, 131);
        assert_eq!(rows[0].output_tokens, 121);
    }

    #[test]
    fn token_usage_monthly_summary_多_provider_多月度_排序() {
        let conn = fresh_global_conn();
        // proj-1 同月不同 provider
        token_usage::accumulate(&conn, "proj-1", "openai", "202605", 10, 5).unwrap();
        token_usage::accumulate(&conn, "proj-1", "anthropic", "202605", 20, 10).unwrap();
        // proj-1 不同月
        token_usage::accumulate(&conn, "proj-1", "openai", "202604", 1, 1).unwrap();
        token_usage::accumulate(&conn, "proj-1", "openai", "202607", 7, 7).unwrap();
        // 别的项目不应被纳入
        token_usage::accumulate(&conn, "proj-2", "openai", "202605", 999, 999).unwrap();

        let rows = token_usage::monthly_summary(&conn, "proj-1").unwrap();
        assert_eq!(rows.len(), 4);
        // 排序：yyyymm DESC, provider_id ASC
        let keys: Vec<_> = rows
            .iter()
            .map(|r| (r.yyyymm.as_str(), r.provider_id.as_str()))
            .collect();
        assert_eq!(
            keys,
            vec![
                ("202607", "openai"),
                ("202605", "anthropic"),
                ("202605", "openai"),
                ("202604", "openai"),
            ]
        );
    }

    #[test]
    fn token_usage_monthly_summary_其他项目_隔离() {
        let conn = fresh_global_conn();
        token_usage::accumulate(&conn, "proj-1", "openai", "202605", 10, 5).unwrap();
        token_usage::accumulate(&conn, "proj-2", "openai", "202605", 999, 999).unwrap();
        let rows = token_usage::monthly_summary(&conn, "proj-3").unwrap();
        assert!(rows.is_empty());
    }

    #[test]
    fn token_usage_current_yyyymm_格式_是_6_位数字() {
        let s = token_usage::current_yyyymm();
        assert_eq!(s.len(), 6, "应该是 YYYYMM 共 6 字符: {s}");
        assert!(s.chars().all(|c| c.is_ascii_digit()), "应全为数字: {s}");
        // 前 4 位年份合理范围
        let year: u32 = s[..4].parse().unwrap();
        assert!((2024..=2100).contains(&year), "年份不合理: {year}");
        // 后 2 位月份 01..=12
        let month: u32 = s[4..].parse().unwrap();
        assert!((1..=12).contains(&month), "月份不合理: {month}");
    }

    #[test]
    fn token_usage_format_yyyymm_helper_可注入固定时间() {
        use time::OffsetDateTime;
        // 2026-05-05 00:00:00 UTC
        let dt = OffsetDateTime::from_unix_timestamp(1_777_996_800).unwrap();
        assert_eq!(token_usage::format_yyyymm(dt), "202605");

        // 2024-01-01
        let dt2 = OffsetDateTime::from_unix_timestamp(1_704_067_200).unwrap();
        assert_eq!(token_usage::format_yyyymm(dt2), "202401");

        // 2024-12-31 23:59:59 仍是 12 月
        let dt3 = OffsetDateTime::from_unix_timestamp(1_735_689_599).unwrap();
        assert_eq!(token_usage::format_yyyymm(dt3), "202412");
    }
}
