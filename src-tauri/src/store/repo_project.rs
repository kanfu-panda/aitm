//! 项目 db 仓储 —— `conversations` / `messages` 两张表的访问层。
//!
//! 设计要点：
//! - `messages` 是流式表，`payload` 存 JSON 字符串（不在这层解析，让上层
//!   按 `kind` 自己反序列化，避免 enum tag dispatch 拖累 SQL 层）。
//! - `messages.append` 在事务内自动取 `max(seq) + 1`，并同时刷新
//!   `conversations.updated_at`，保证"消息追加 → 对话置顶"原子。
//! - 用 `unchecked_transaction()` 是因为 `&Connection` 拿不到 mut；项目 db
//!   的访问已经在 `AitmDb::with_project` 的 Mutex 锁内串行化（外层独占），
//!   所以 unchecked 是安全的。
//! - 错误统一用 `anyhow::Result`（不暴露 rusqlite::Error），方便上层 IPC
//!   命令直接 `?` 透传。

use anyhow::{Context, Result};
use rusqlite::{params, Connection};

/// 一行 `conversations`。
///
/// `title_auto`：bool 标志这条 title 是不是 LLM 自动起的（用户改过就置 0）。
/// `provider_id` / `model_id`：用空串表示"用全局默认"。
/// `created_at` / `updated_at`：unix 秒。`updated_at` 在每次 append message
/// 时被刷新，列表按它降序就是"最近活跃在前"。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConversationRow {
    pub id: String,
    pub title: String,
    pub title_auto: bool,
    pub provider_id: String,
    pub model_id: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 一行 `messages`。
///
/// `payload` 是 JSON 字符串，结构按 `kind` 不同（见 plan §2.2）：
/// - `user` → `{"content": "..."}`
/// - `assistant` → `{"content": "...", "usage": {...}}`
/// - `tool_call` → `{"call_id", "name", "args_preview", "risk", "status", "result", ...}`
///
/// 这层不做 JSON 解析，让上层按需反序列化。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageRow {
    pub id: i64,
    pub conversation_id: String,
    pub seq: i64,
    pub kind: String,
    pub payload: String,
    pub created_at: i64,
}

/// 取当前 unix 秒。系统时间倒退（很罕见）时返回 0。
fn unix_secs_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// `conversations` 表的 CRUD。
pub mod conversations {
    use super::*;

    /// 插入一条新对话。
    ///
    /// 调用方负责生成 `id`（UUID v7 字符串）和 `created_at` / `updated_at`
    /// 时间戳；本函数只是直写。
    pub fn insert(conn: &Connection, c: &ConversationRow) -> Result<()> {
        conn.execute(
            "INSERT INTO conversations \
             (id, title, title_auto, provider_id, model_id, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                c.id,
                c.title,
                c.title_auto as i64,
                c.provider_id,
                c.model_id,
                c.created_at,
                c.updated_at,
            ],
        )
        .context("插入 conversation 失败")?;
        Ok(())
    }

    /// 列出所有对话，按 `updated_at DESC`（最近活跃排前面），同 ts 时按
    /// `created_at DESC` 兜底（避免重启后顺序晃）。
    pub fn list(conn: &Connection) -> Result<Vec<ConversationRow>> {
        let mut stmt = conn
            .prepare(
                "SELECT id, title, title_auto, provider_id, model_id, created_at, updated_at \
                 FROM conversations \
                 ORDER BY updated_at DESC, created_at DESC",
            )
            .context("准备 list conversations 语句失败")?;
        let rows = stmt
            .query_map([], |r| {
                Ok(ConversationRow {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    title_auto: r.get::<_, i64>(2)? != 0,
                    provider_id: r.get(3)?,
                    model_id: r.get(4)?,
                    created_at: r.get(5)?,
                    updated_at: r.get(6)?,
                })
            })
            .context("查询 conversations 失败")?;

        let mut out = Vec::new();
        for row in rows {
            out.push(row.context("解析 conversation 行失败")?);
        }
        Ok(out)
    }

    /// 按 id 查；不存在返回 `Ok(None)`。
    pub fn get(conn: &Connection, id: &str) -> Result<Option<ConversationRow>> {
        let mut stmt = conn
            .prepare(
                "SELECT id, title, title_auto, provider_id, model_id, created_at, updated_at \
                 FROM conversations WHERE id = ?1",
            )
            .context("准备 get conversation 语句失败")?;
        let mut rows = stmt
            .query_map([id], |r| {
                Ok(ConversationRow {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    title_auto: r.get::<_, i64>(2)? != 0,
                    provider_id: r.get(3)?,
                    model_id: r.get(4)?,
                    created_at: r.get(5)?,
                    updated_at: r.get(6)?,
                })
            })
            .context("查询 conversation 失败")?;
        match rows.next() {
            Some(r) => Ok(Some(r.context("解析 conversation 行失败")?)),
            None => Ok(None),
        }
    }

    /// 更新元信息（title / title_auto / provider / model），同时刷新
    /// `updated_at = now`。
    ///
    /// id 不存在时**静默忽略**（返回 Ok）—— 上层调用一般是"用户改了 title
    /// 顺便落盘"，不存在不算错；避免上层每次先 get 再 update 的复杂度。
    pub fn update_meta(
        conn: &Connection,
        id: &str,
        title: &str,
        title_auto: bool,
        provider_id: &str,
        model_id: &str,
    ) -> Result<()> {
        let now = unix_secs_now();
        conn.execute(
            "UPDATE conversations \
             SET title = ?1, title_auto = ?2, provider_id = ?3, model_id = ?4, updated_at = ?5 \
             WHERE id = ?6",
            params![title, title_auto as i64, provider_id, model_id, now, id],
        )
        .context("更新 conversation meta 失败")?;
        Ok(())
    }

    /// 删除一条对话。
    ///
    /// 因为 `messages.conversation_id` 有 `ON DELETE CASCADE`（参见
    /// schema.rs），删 conversation 时它的所有 messages 自动级联删；
    /// 不需要在这里手动清理。
    ///
    /// 注意：依赖连接级 `PRAGMA foreign_keys = ON`，已在 `migrate_project`
    /// 里设置过。
    pub fn delete(conn: &Connection, id: &str) -> Result<()> {
        conn.execute("DELETE FROM conversations WHERE id = ?1", params![id])
            .context("删除 conversation 失败")?;
        Ok(())
    }

    /// 刷新 `updated_at = now`，把对话挪到列表最前。
    ///
    /// 一般由 `messages::append` 内部调用；外部也可直接调（比如用户切到这
    /// 个对话时想"激活")。id 不存在静默 Ok。
    pub fn touch(conn: &Connection, id: &str) -> Result<()> {
        let now = unix_secs_now();
        conn.execute(
            "UPDATE conversations SET updated_at = ?1 WHERE id = ?2",
            params![now, id],
        )
        .context("touch conversation 失败")?;
        Ok(())
    }
}

/// `messages` 表的访问。
pub mod messages {
    use super::*;

    /// 追加一条消息。
    ///
    /// 在事务内：
    /// 1. 取该 conversation 当前 `max(seq)`，新行用 `max + 1`（首条为 1）
    /// 2. INSERT 新行
    /// 3. `UPDATE conversations.updated_at = now`（让 list 把它置顶）
    ///
    /// 用 `unchecked_transaction` 是因为 `&Connection` 不能拿 `&mut`；项目
    /// db 的访问在外层 `AitmDb.with_project` 的 Mutex 锁内串行化，无并发
    /// 写，所以 unchecked OK。
    ///
    /// 返回新行的 `(id, seq)`，方便上层关联。
    pub fn append(
        conn: &Connection,
        conversation_id: &str,
        kind: &str,
        payload_json: &str,
    ) -> Result<(i64, i64)> {
        let tx = conn
            .unchecked_transaction()
            .context("开启事务失败")?;

        let next_seq: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE conversation_id = ?1",
                params![conversation_id],
                |r| r.get(0),
            )
            .context("查询 max(seq) 失败")?;

        let now = unix_secs_now();
        tx.execute(
            "INSERT INTO messages (conversation_id, seq, kind, payload, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![conversation_id, next_seq, kind, payload_json, now],
        )
        .context("插入 message 失败")?;
        let id = tx.last_insert_rowid();

        tx.execute(
            "UPDATE conversations SET updated_at = ?1 WHERE id = ?2",
            params![now, conversation_id],
        )
        .context("刷新 conversation.updated_at 失败")?;

        tx.commit().context("提交事务失败")?;
        Ok((id, next_seq))
    }

    /// 拉某对话的全部消息，按 `seq ASC`（重放对话用 — 最早消息在前）。
    pub fn list_for_conv(conn: &Connection, conversation_id: &str) -> Result<Vec<MessageRow>> {
        let mut stmt = conn
            .prepare(
                "SELECT id, conversation_id, seq, kind, payload, created_at \
                 FROM messages WHERE conversation_id = ?1 \
                 ORDER BY seq ASC",
            )
            .context("准备 list messages 语句失败")?;
        let rows = stmt
            .query_map([conversation_id], |r| {
                Ok(MessageRow {
                    id: r.get(0)?,
                    conversation_id: r.get(1)?,
                    seq: r.get(2)?,
                    kind: r.get(3)?,
                    payload: r.get(4)?,
                    created_at: r.get(5)?,
                })
            })
            .context("查询 messages 失败")?;

        let mut out = Vec::new();
        for row in rows {
            out.push(row.context("解析 message 行失败")?);
        }
        Ok(out)
    }

    /// 替换一条消息的 `payload`，按 `(conversation_id, seq)` 定位。
    ///
    /// 给 1H tool_call 状态流转用：同一条 tool_call 消息的 payload 从
    /// `awaiting_approval` → `running` → `done` 改 status，但 `seq`
    /// 不变（保持时间线顺序）。
    ///
    /// 行不存在时静默 Ok（避免上层每次先查再写）。
    pub fn replace_payload(
        conn: &Connection,
        conversation_id: &str,
        seq: i64,
        payload_json: &str,
    ) -> Result<()> {
        conn.execute(
            "UPDATE messages SET payload = ?1 \
             WHERE conversation_id = ?2 AND seq = ?3",
            params![payload_json, conversation_id, seq],
        )
        .context("替换 message payload 失败")?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::schema::migrate_project;

    /// 起一个 in-memory 项目 db + 跑 schema 迁移。
    fn fresh_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate_project(&conn).unwrap();
        conn
    }

    fn sample_conv(id: &str, title: &str, ts: i64) -> ConversationRow {
        ConversationRow {
            id: id.to_string(),
            title: title.to_string(),
            title_auto: true,
            provider_id: "openai".to_string(),
            model_id: "gpt-4".to_string(),
            created_at: ts,
            updated_at: ts,
        }
    }

    // ---------------- conversations ----------------

    #[test]
    fn 插入并按_id_读回() {
        let conn = fresh_db();
        let c = sample_conv("c1", "你好", 1000);
        conversations::insert(&conn, &c).unwrap();

        let got = conversations::get(&conn, "c1").unwrap().unwrap();
        assert_eq!(got, c);
    }

    #[test]
    fn get_不存在返回_none() {
        let conn = fresh_db();
        assert!(conversations::get(&conn, "no-such").unwrap().is_none());
    }

    #[test]
    fn list_按_updated_at_降序() {
        let conn = fresh_db();
        conversations::insert(&conn, &sample_conv("a", "A", 100)).unwrap();
        conversations::insert(&conn, &sample_conv("b", "B", 300)).unwrap();
        conversations::insert(&conn, &sample_conv("c", "C", 200)).unwrap();

        let list = conversations::list(&conn).unwrap();
        let ids: Vec<&str> = list.iter().map(|r| r.id.as_str()).collect();
        // updated_at: b=300 > c=200 > a=100
        assert_eq!(ids, vec!["b", "c", "a"]);
    }

    #[test]
    fn list_空表返回空_vec() {
        let conn = fresh_db();
        let list = conversations::list(&conn).unwrap();
        assert!(list.is_empty());
    }

    #[test]
    fn update_meta_改字段且刷_updated_at() {
        let conn = fresh_db();
        let c = sample_conv("c1", "旧标题", 100);
        conversations::insert(&conn, &c).unwrap();

        conversations::update_meta(&conn, "c1", "新标题", false, "anthropic", "claude-4").unwrap();

        let got = conversations::get(&conn, "c1").unwrap().unwrap();
        assert_eq!(got.title, "新标题");
        assert!(!got.title_auto);
        assert_eq!(got.provider_id, "anthropic");
        assert_eq!(got.model_id, "claude-4");
        // updated_at 应被刷成 now（>= 现在的某个粗粒度时间，远大于 100）
        assert!(got.updated_at > 1_000_000_000, "updated_at 应被刷新到 now");
        // created_at 不动
        assert_eq!(got.created_at, 100);
    }

    #[test]
    fn update_meta_不存在静默_ok() {
        let conn = fresh_db();
        // 不存在的 id，不应报错
        let r = conversations::update_meta(&conn, "ghost", "x", true, "p", "m");
        assert!(r.is_ok());
    }

    #[test]
    fn delete_删除对话() {
        let conn = fresh_db();
        conversations::insert(&conn, &sample_conv("c1", "T", 100)).unwrap();
        conversations::delete(&conn, "c1").unwrap();
        assert!(conversations::get(&conn, "c1").unwrap().is_none());
    }

    #[test]
    fn delete_级联删_messages() {
        let conn = fresh_db();
        conversations::insert(&conn, &sample_conv("c1", "T", 100)).unwrap();
        messages::append(&conn, "c1", "user", r#"{"content":"hi"}"#).unwrap();
        messages::append(&conn, "c1", "assistant", r#"{"content":"hello"}"#).unwrap();

        conversations::delete(&conn, "c1").unwrap();

        let msgs = messages::list_for_conv(&conn, "c1").unwrap();
        assert!(
            msgs.is_empty(),
            "FK ON DELETE CASCADE 应自动清理 messages，剩 {} 条",
            msgs.len()
        );
    }

    #[test]
    fn touch_刷新_updated_at() {
        let conn = fresh_db();
        conversations::insert(&conn, &sample_conv("c1", "T", 100)).unwrap();
        let before = conversations::get(&conn, "c1").unwrap().unwrap().updated_at;
        assert_eq!(before, 100);

        conversations::touch(&conn, "c1").unwrap();

        let after = conversations::get(&conn, "c1").unwrap().unwrap().updated_at;
        assert!(after > before, "touch 后 updated_at 应被刷成 now");
    }

    #[test]
    fn touch_不存在静默_ok() {
        let conn = fresh_db();
        assert!(conversations::touch(&conn, "ghost").is_ok());
    }

    // ---------------- messages ----------------

    #[test]
    fn append_首条_seq_为_1() {
        let conn = fresh_db();
        conversations::insert(&conn, &sample_conv("c1", "T", 100)).unwrap();
        let (id, seq) = messages::append(&conn, "c1", "user", r#"{"content":"a"}"#).unwrap();
        assert_eq!(seq, 1);
        assert!(id > 0);
    }

    #[test]
    fn append_第二条_seq_为_2() {
        let conn = fresh_db();
        conversations::insert(&conn, &sample_conv("c1", "T", 100)).unwrap();
        let (_, s1) = messages::append(&conn, "c1", "user", r#"{"content":"a"}"#).unwrap();
        let (_, s2) = messages::append(&conn, "c1", "assistant", r#"{"content":"b"}"#).unwrap();
        assert_eq!(s1, 1);
        assert_eq!(s2, 2);
    }

    #[test]
    fn append_不同_conv_独立编号() {
        let conn = fresh_db();
        conversations::insert(&conn, &sample_conv("a", "A", 100)).unwrap();
        conversations::insert(&conn, &sample_conv("b", "B", 100)).unwrap();

        let (_, sa1) = messages::append(&conn, "a", "user", r#"{"content":"x"}"#).unwrap();
        let (_, sb1) = messages::append(&conn, "b", "user", r#"{"content":"y"}"#).unwrap();
        let (_, sa2) = messages::append(&conn, "a", "assistant", r#"{"content":"z"}"#).unwrap();

        // 各自从 1 开始独立编号
        assert_eq!(sa1, 1);
        assert_eq!(sb1, 1);
        assert_eq!(sa2, 2);
    }

    #[test]
    fn list_for_conv_按_seq_升序() {
        let conn = fresh_db();
        conversations::insert(&conn, &sample_conv("c1", "T", 100)).unwrap();
        messages::append(&conn, "c1", "user", r#"{"content":"1"}"#).unwrap();
        messages::append(&conn, "c1", "assistant", r#"{"content":"2"}"#).unwrap();
        messages::append(&conn, "c1", "tool_call", r#"{"call_id":"t","name":"x"}"#).unwrap();

        let list = messages::list_for_conv(&conn, "c1").unwrap();
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].seq, 1);
        assert_eq!(list[0].kind, "user");
        assert_eq!(list[1].seq, 2);
        assert_eq!(list[1].kind, "assistant");
        assert_eq!(list[2].seq, 3);
        assert_eq!(list[2].kind, "tool_call");
    }

    #[test]
    fn list_for_conv_只返回该_conv_的消息() {
        let conn = fresh_db();
        conversations::insert(&conn, &sample_conv("a", "A", 100)).unwrap();
        conversations::insert(&conn, &sample_conv("b", "B", 100)).unwrap();
        messages::append(&conn, "a", "user", r#"{"content":"a"}"#).unwrap();
        messages::append(&conn, "b", "user", r#"{"content":"b"}"#).unwrap();
        messages::append(&conn, "a", "assistant", r#"{"content":"aa"}"#).unwrap();

        let only_a = messages::list_for_conv(&conn, "a").unwrap();
        assert_eq!(only_a.len(), 2);
        for m in &only_a {
            assert_eq!(m.conversation_id, "a");
        }
    }

    #[test]
    fn replace_payload_改字段不动_seq() {
        let conn = fresh_db();
        conversations::insert(&conn, &sample_conv("c1", "T", 100)).unwrap();
        let (_, seq) = messages::append(
            &conn,
            "c1",
            "tool_call",
            r#"{"status":"awaiting_approval"}"#,
        )
        .unwrap();

        messages::replace_payload(&conn, "c1", seq, r#"{"status":"done"}"#).unwrap();

        let list = messages::list_for_conv(&conn, "c1").unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].seq, seq, "seq 不应变");
        assert_eq!(list[0].payload, r#"{"status":"done"}"#);
    }

    #[test]
    fn replace_payload_不存在静默_ok() {
        let conn = fresh_db();
        // (conversation_id, seq) 都不存在不报错
        let r = messages::replace_payload(&conn, "ghost", 999, r#"{}"#);
        assert!(r.is_ok());
    }

    #[test]
    fn append_刷新_conversation_updated_at() {
        let conn = fresh_db();
        // 用很老的 ts 插入，让 append 之后能看到刷新
        conversations::insert(&conn, &sample_conv("c1", "T", 100)).unwrap();
        let before = conversations::get(&conn, "c1").unwrap().unwrap().updated_at;
        assert_eq!(before, 100);

        messages::append(&conn, "c1", "user", r#"{"content":"x"}"#).unwrap();

        let after = conversations::get(&conn, "c1").unwrap().unwrap().updated_at;
        assert!(
            after > before,
            "append 应同事务刷新 conversation.updated_at（{before} → {after}）"
        );
    }

    #[test]
    fn append_后_list_把活跃对话置顶() {
        let conn = fresh_db();
        conversations::insert(&conn, &sample_conv("a", "A", 100)).unwrap();
        conversations::insert(&conn, &sample_conv("b", "B", 200)).unwrap();
        // 此时 list 顺序：b（200）, a（100）

        // 给 a 追加消息 → updated_at 被刷成 now（远大于 200）
        messages::append(&conn, "a", "user", r#"{"content":"hi"}"#).unwrap();

        let list = conversations::list(&conn).unwrap();
        let ids: Vec<&str> = list.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["a", "b"], "刚追加消息的 a 应排到最前");
    }

    #[test]
    fn replace_payload_只改指定_seq() {
        let conn = fresh_db();
        conversations::insert(&conn, &sample_conv("c1", "T", 100)).unwrap();
        let (_, s1) = messages::append(&conn, "c1", "user", r#"{"v":1}"#).unwrap();
        let (_, s2) = messages::append(&conn, "c1", "assistant", r#"{"v":2}"#).unwrap();

        messages::replace_payload(&conn, "c1", s1, r#"{"v":"NEW"}"#).unwrap();

        let list = messages::list_for_conv(&conn, "c1").unwrap();
        assert_eq!(list[0].seq, s1);
        assert_eq!(list[0].payload, r#"{"v":"NEW"}"#);
        assert_eq!(list[1].seq, s2);
        assert_eq!(list[1].payload, r#"{"v":2}"#, "另一条不该被改");
    }

    #[test]
    fn append_payload_原样保存_不解析() {
        let conn = fresh_db();
        conversations::insert(&conn, &sample_conv("c1", "T", 100)).unwrap();
        // 故意塞畸形 JSON —— 这层不解析，应原样存
        let raw = r#"{not valid json"#;
        messages::append(&conn, "c1", "user", raw).unwrap();
        let list = messages::list_for_conv(&conn, "c1").unwrap();
        assert_eq!(list[0].payload, raw);
    }
}
