//! conversations IPC 命令。
//!
//! 给前端 chat store 用做对话 CRUD + 消息持久化。8 个命令：
//! - `conv_list` / `conv_create` / `conv_delete` / `conv_rename` / `conv_set_model`
//! - `conv_append_message` / `conv_replace_message_payload` / `conv_get_messages`
//!
//! 设计要点：
//! - 所有 db 调用走 `tokio::task::spawn_blocking` 把同步 rusqlite 隔离到
//!   阻塞 worker，不卡 tokio runtime。
//! - 入参 `scope` 用 `crate::scope::Scope`（已带 `#[serde(tag="kind",
//!   rename_all="snake_case")]`），前端拿到的 JSON 形状是 discriminated
//!   union，TS 端友好。`Scope::bucket_id()` 已定义 → Project 用 UUID 桶，
//!   Global / NeedsInit 都走 `_global_` 桶（NeedsInit 路径理论上不会写入，
//!   1H init 决议前 ai_chat_send 已被暂停）。
//! - 错误向前端透传成 `String`：所有 anyhow / db 错误经 `.to_string()`
//!   包装；命令体抽成 `*_impl` fn 方便集成测试不绕 Tauri AppHandle。
//! - 命令体内只 await spawn_blocking 一次，不做多次 db 调用避免锁打断。
//!   需要"读+写"的命令（如 `conv_rename`）把 read-modify-write 合到同一闭包。

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::ipc::scope::ScopeDto;
use crate::store::{repo_project, AitmDb};

/// 把 scope 转成对应的 db bucket id（项目 db 的目录名）。
///
/// `Project` → UUID 桶；`Global` / `NeedsInit` 都走 `_global_` 全局桶。
/// `NeedsInit` 路径理论上不会进到 conversations IPC（init 决议前 chat
/// 已被暂停），这里返回全局桶仅作占位。
fn scope_to_bucket(scope: &ScopeDto) -> &str {
    match scope {
        ScopeDto::Project { uuid, .. } => uuid.as_str(),
        ScopeDto::Global | ScopeDto::NeedsInit { .. } => crate::store::paths::GLOBAL_BUCKET_ID,
    }
}

/// 一条对话的 IPC DTO。前端 chat store `SingleConversation` 字段对齐。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationDto {
    pub id: String,
    pub title: String,
    pub title_auto: bool,
    pub provider_id: String,
    pub model_id: String,
    pub created_at: i64,
    pub updated_at: i64,
}

impl From<repo_project::ConversationRow> for ConversationDto {
    fn from(r: repo_project::ConversationRow) -> Self {
        Self {
            id: r.id,
            title: r.title,
            title_auto: r.title_auto,
            provider_id: r.provider_id,
            model_id: r.model_id,
            created_at: r.created_at,
            updated_at: r.updated_at,
        }
    }
}

/// 一条消息的 IPC DTO。`payload_json` 是字符串，前端按 `kind` 自己解析。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageDto {
    pub id: i64,
    pub seq: i64,
    pub kind: String,
    pub payload_json: String,
    pub created_at: i64,
}

impl From<repo_project::MessageRow> for MessageDto {
    fn from(r: repo_project::MessageRow) -> Self {
        Self {
            id: r.id,
            seq: r.seq,
            kind: r.kind,
            payload_json: r.payload,
            created_at: r.created_at,
        }
    }
}

/// 取当前 unix 秒。系统时间倒退（很罕见）时返回 0。
fn unix_secs_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// =====================================================================
// 实现层（同步）—— 集成测试直接调，避免起 Tauri AppHandle / tokio runtime
// =====================================================================

/// `conv_list` 实现。列出指定 scope 桶下的所有对话（按 updated_at DESC）。
pub fn conv_list_impl(db: &AitmDb, scope: &ScopeDto) -> Result<Vec<ConversationDto>, String> {
    let bucket = scope_to_bucket(scope).to_string();
    db.with_project(&bucket, repo_project::conversations::list)
        .map(|rows| rows.into_iter().map(ConversationDto::from).collect())
        .map_err(|e| e.to_string())
}

/// `conv_create` 实现。生成 UUID v7 + 默认空 provider/model + title_auto=true。
pub fn conv_create_impl(
    db: &AitmDb,
    scope: &ScopeDto,
    title: String,
) -> Result<ConversationDto, String> {
    let bucket = scope_to_bucket(scope).to_string();
    let id = uuid::Uuid::now_v7().hyphenated().to_string();
    let now = unix_secs_now();
    let row = repo_project::ConversationRow {
        id: id.clone(),
        title,
        title_auto: true,
        provider_id: String::new(),
        model_id: String::new(),
        created_at: now,
        updated_at: now,
    };
    db.with_project(&bucket, |conn| {
        repo_project::conversations::insert(conn, &row)
    })
    .map_err(|e| e.to_string())?;
    Ok(row.into())
}

/// `conv_delete` 实现。messages 走 FK CASCADE 自动清。
pub fn conv_delete_impl(db: &AitmDb, scope: &ScopeDto, cid: String) -> Result<(), String> {
    let bucket = scope_to_bucket(scope).to_string();
    db.with_project(&bucket, |conn| {
        repo_project::conversations::delete(conn, &cid)
    })
    .map_err(|e| e.to_string())
}

/// `conv_rename` 实现。手动改名 → `title_auto = false`。
///
/// 读 + 写一气呵成（同一闭包内同 connection），保留原有 provider / model。
pub fn conv_rename_impl(
    db: &AitmDb,
    scope: &ScopeDto,
    cid: String,
    title: String,
) -> Result<(), String> {
    let bucket = scope_to_bucket(scope).to_string();
    db.with_project(&bucket, |conn| {
        let cur = repo_project::conversations::get(conn, &cid)?;
        let (provider_id, model_id) = match cur {
            Some(c) => (c.provider_id, c.model_id),
            None => (String::new(), String::new()),
        };
        repo_project::conversations::update_meta(
            conn,
            &cid,
            &title,
            false, // title_auto = false（用户手动改名）
            &provider_id,
            &model_id,
        )
    })
    .map_err(|e| e.to_string())
}

/// `conv_set_model` 实现。改 provider / model，保留 title 和 title_auto。
pub fn conv_set_model_impl(
    db: &AitmDb,
    scope: &ScopeDto,
    cid: String,
    provider_id: String,
    model_id: String,
) -> Result<(), String> {
    let bucket = scope_to_bucket(scope).to_string();
    db.with_project(&bucket, |conn| {
        let cur = repo_project::conversations::get(conn, &cid)?;
        let (title, title_auto) = match cur {
            Some(c) => (c.title, c.title_auto),
            None => (String::new(), true),
        };
        repo_project::conversations::update_meta(
            conn,
            &cid,
            &title,
            title_auto,
            &provider_id,
            &model_id,
        )
    })
    .map_err(|e| e.to_string())
}

/// `conv_append_message` 实现。事务内取 max(seq)+1 + 同步 touch updated_at。
pub fn conv_append_message_impl(
    db: &AitmDb,
    scope: &ScopeDto,
    cid: String,
    kind: String,
    payload_json: String,
) -> Result<MessageDto, String> {
    let bucket = scope_to_bucket(scope).to_string();
    db.with_project(&bucket, |conn| {
        let (id, seq) = repo_project::messages::append(conn, &cid, &kind, &payload_json)?;
        // append 内部已写过 created_at = now()，这里再 query 一次拿到准确值
        // 比"算 SystemTime"靠谱（避免事务跨秒边界）
        let created_at: i64 = conn.query_row(
            "SELECT created_at FROM messages WHERE id = ?1",
            [id],
            |r| r.get(0),
        )?;
        Ok(MessageDto {
            id,
            seq,
            kind,
            payload_json,
            created_at,
        })
    })
    .map_err(|e| e.to_string())
}

/// `conv_replace_message_payload` 实现。给 1H 工具调用状态流转用。
pub fn conv_replace_message_payload_impl(
    db: &AitmDb,
    scope: &ScopeDto,
    cid: String,
    seq: i64,
    payload_json: String,
) -> Result<(), String> {
    let bucket = scope_to_bucket(scope).to_string();
    db.with_project(&bucket, |conn| {
        repo_project::messages::replace_payload(conn, &cid, seq, &payload_json)
    })
    .map_err(|e| e.to_string())
}

/// `conv_get_messages` 实现。按 seq ASC 拉所有消息。
pub fn conv_get_messages_impl(
    db: &AitmDb,
    scope: &ScopeDto,
    cid: String,
) -> Result<Vec<MessageDto>, String> {
    let bucket = scope_to_bucket(scope).to_string();
    db.with_project(&bucket, |conn| {
        repo_project::messages::list_for_conv(conn, &cid)
    })
    .map(|rows| rows.into_iter().map(MessageDto::from).collect())
    .map_err(|e| e.to_string())
}

// =====================================================================
// Tauri 命令 wrapper —— 全部用 spawn_blocking 包同步 db 调用
// =====================================================================

#[tauri::command]
pub async fn conv_list(
    db: State<'_, Arc<AitmDb>>,
    scope: ScopeDto,
) -> Result<Vec<ConversationDto>, String> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || conv_list_impl(&db, &scope))
        .await
        .map_err(|e| format!("spawn_blocking 失败: {e}"))?
}

#[tauri::command]
pub async fn conv_create(
    db: State<'_, Arc<AitmDb>>,
    scope: ScopeDto,
    title: String,
) -> Result<ConversationDto, String> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || conv_create_impl(&db, &scope, title))
        .await
        .map_err(|e| format!("spawn_blocking 失败: {e}"))?
}

#[tauri::command]
pub async fn conv_delete(
    db: State<'_, Arc<AitmDb>>,
    scope: ScopeDto,
    cid: String,
) -> Result<(), String> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || conv_delete_impl(&db, &scope, cid))
        .await
        .map_err(|e| format!("spawn_blocking 失败: {e}"))?
}

#[tauri::command]
pub async fn conv_rename(
    db: State<'_, Arc<AitmDb>>,
    scope: ScopeDto,
    cid: String,
    title: String,
) -> Result<(), String> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || conv_rename_impl(&db, &scope, cid, title))
        .await
        .map_err(|e| format!("spawn_blocking 失败: {e}"))?
}

#[tauri::command]
pub async fn conv_set_model(
    db: State<'_, Arc<AitmDb>>,
    scope: ScopeDto,
    cid: String,
    provider_id: String,
    model_id: String,
) -> Result<(), String> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || conv_set_model_impl(&db, &scope, cid, provider_id, model_id))
        .await
        .map_err(|e| format!("spawn_blocking 失败: {e}"))?
}

#[tauri::command]
pub async fn conv_append_message(
    db: State<'_, Arc<AitmDb>>,
    scope: ScopeDto,
    cid: String,
    kind: String,
    payload_json: String,
) -> Result<MessageDto, String> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || conv_append_message_impl(&db, &scope, cid, kind, payload_json))
        .await
        .map_err(|e| format!("spawn_blocking 失败: {e}"))?
}

#[tauri::command]
pub async fn conv_replace_message_payload(
    db: State<'_, Arc<AitmDb>>,
    scope: ScopeDto,
    cid: String,
    seq: i64,
    payload_json: String,
) -> Result<(), String> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || {
        conv_replace_message_payload_impl(&db, &scope, cid, seq, payload_json)
    })
    .await
    .map_err(|e| format!("spawn_blocking 失败: {e}"))?
}

#[tauri::command]
pub async fn conv_get_messages(
    db: State<'_, Arc<AitmDb>>,
    scope: ScopeDto,
    cid: String,
) -> Result<Vec<MessageDto>, String> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || conv_get_messages_impl(&db, &scope, cid))
        .await
        .map_err(|e| format!("spawn_blocking 失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_to_bucket_project_用_uuid() {
        let s = ScopeDto::Project {
            uuid: "abc-123".to_string(),
            root_path: "/x".to_string(),
        };
        assert_eq!(scope_to_bucket(&s), "abc-123");
    }

    #[test]
    fn scope_to_bucket_global_走_global_桶() {
        let s = ScopeDto::Global;
        assert_eq!(scope_to_bucket(&s), crate::store::paths::GLOBAL_BUCKET_ID);
    }

    #[test]
    fn scope_to_bucket_needs_init_也走_global_桶() {
        let s = ScopeDto::NeedsInit {
            cwd: "/y".to_string(),
        };
        assert_eq!(scope_to_bucket(&s), crate::store::paths::GLOBAL_BUCKET_ID);
    }
}
