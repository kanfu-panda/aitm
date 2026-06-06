//! 作用域相关 IPC 命令。
//!
//! 三个命令：
//! - [`scope_resolve`]：前端 AiSidebar 启动 / 切 tab 时调，把 cwd 解析成
//!   `Project` / `Global` / `NeedsInit`，决定从哪个 db bucket 拉对话。
//! - [`project_init`]：用户在 InitProjectDialog 选"初始化为项目"时调；
//!   写 `.aitm/project.json` + `.aitm/.gitignore` + 注册到全局
//!   `projects` 表 + 触发项目 db 懒创建。
//! - [`mark_ignored`]：用户选"别再问我这个目录"时调；把 cwd 写入
//!   `ignored_paths` 表，下次解析直接走 `Global`。
//!
//! 所有 db / 文件 IO 都在 `tokio::task::spawn_blocking` 里执行：
//! rusqlite 是同步阻塞 API，直接在 tokio worker 上跑会阻塞其他 task。
//!
//! ## 测试设计
//!
//! 命令 body 抽成普通 `*_impl` 函数（不带 `#[tauri::command]`），
//! `#[tauri::command]` 包装器只做 `spawn_blocking` 转发。集成测试
//! （`tests/scope_ipc.rs`）直接调 impl 函数，不走 Tauri State 系统。

use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::scope::{Scope, marker};
use crate::store::{AitmDb, repo_global};

// ===== DTO =====

/// 给前端用的 Scope DTO。
///
/// 与 [`crate::scope::Scope`] 字段一致；通过 `From` 转换。前端 TS 拿到的
/// JSON 形如 `{"kind":"project","uuid":"...","root_path":"..."}`，可
/// discriminated union。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ScopeDto {
    /// 已 init 项目。
    Project {
        /// 项目 UUID（hyphenated）。
        uuid: String,
        /// 项目根绝对路径（已 canonicalize）。
        root_path: String,
    },
    /// 全局桶（用户选过临时全局 / 永久忽略）。
    Global,
    /// 需要弹 InitProjectDialog。
    NeedsInit {
        /// 已 canonicalize 的 cwd 字符串，前端弹窗后回传。
        cwd: String,
    },
}

impl From<Scope> for ScopeDto {
    fn from(s: Scope) -> Self {
        match s {
            Scope::Project { uuid, root_path } => Self::Project { uuid, root_path },
            Scope::Global => Self::Global,
            Scope::NeedsInit { cwd } => Self::NeedsInit { cwd },
        }
    }
}

/// 反向转换：前端传 ScopeDto 回来时（如 [`crate::ipc::ai::ai_chat_resume`]）
/// 转回内部类型走逻辑。结构对称，无信息丢失。
impl From<ScopeDto> for Scope {
    fn from(dto: ScopeDto) -> Self {
        match dto {
            ScopeDto::Project { uuid, root_path } => Self::Project { uuid, root_path },
            ScopeDto::Global => Self::Global,
            ScopeDto::NeedsInit { cwd } => Self::NeedsInit { cwd },
        }
    }
}

/// `project_init` 的返回结果，前端用来更新 store + 重发 chat。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProjectInitResult {
    /// 新生成的项目 UUID（v7 hyphenated）。
    pub uuid: String,
    /// 项目根绝对路径（已 canonicalize）。
    pub root_path: String,
    /// 项目展示名（来自 init 入参）。
    pub name: String,
}

// ===== inner impl（集成测试直接调）=====

/// `scope_resolve` 的同步实现：调 [`crate::scope::resolve_scope`] 返回 DTO。
///
/// 集成测试直接调这个；Tauri 命令包 spawn_blocking 调这个。
pub fn scope_resolve_impl(cwd: &str, db: &AitmDb) -> Result<ScopeDto, String> {
    crate::scope::resolve_scope(Path::new(cwd), db)
        .map(ScopeDto::from)
        .map_err(|e| format!("解析作用域失败: {e}"))
}

/// `project_init` 的同步实现。
///
/// 流程（plan §3 T6）：
/// 1. cwd canonicalize（解析符号链接 + 相对路径）
/// 2. `marker::create_new` 生成 ProjectMarker（UUID v7）
/// 3. `marker::write` 写 `.aitm/project.json`（原子写）
/// 4. `marker::write_gitignore` 写 `.aitm/.gitignore`
/// 5. 注册到全局 `projects` 表（id / name / created_at / last_seen_path）
/// 6. 触发项目 db 懒创建（`with_project` 首次访问会 open + migrate）
/// 7. 返回 [`ProjectInitResult`]
pub fn project_init_impl(cwd: &str, name: &str, db: &AitmDb) -> Result<ProjectInitResult, String> {
    // 1. canonicalize：解析符号链接 + 相对路径。失败时退回原路径
    //    （比如 cwd 不存在 — 实际上不太可能，前端是从已打开的 tab 拿 cwd）。
    let root = Path::new(cwd)
        .canonicalize()
        .unwrap_or_else(|_| Path::new(cwd).to_path_buf());
    let root_str = root.to_string_lossy().into_owned();

    // 2. 生成 marker
    let m = marker::create_new(&root, name);
    let uuid_str = m.id.hyphenated().to_string();

    // 3. 写 project.json
    marker::write(&root, &m).map_err(|e| format!("写 marker 失败: {e}"))?;

    // 4. 写 .gitignore
    marker::write_gitignore(&root).map_err(|e| format!("写 .gitignore 失败: {e}"))?;

    // 5. 注册到全局 projects 表
    let row = repo_global::projects::ProjectRow {
        id: uuid_str.clone(),
        name: name.to_string(),
        created_at: unix_now(),
        last_seen_path: root_str.clone(),
    };
    db.with_global(|conn| repo_global::projects::upsert(conn, &row))
        .map_err(|e| format!("注册全局 projects 失败: {e}"))?;

    // 6. 触发项目 db 懒创建（首次 with_project 会 open + migrate）
    db.with_project(&uuid_str, |_conn| Ok(()))
        .map_err(|e| format!("创建项目 db 失败: {e}"))?;

    Ok(ProjectInitResult {
        uuid: uuid_str,
        root_path: root_str,
        name: name.to_string(),
    })
}

/// `mark_ignored` 的同步实现：把 cwd canonicalize 后写入 `ignored_paths`。
///
/// 重复调静默 OK（`add` 用 `INSERT OR IGNORE`）。
pub fn mark_ignored_impl(cwd: &str, db: &AitmDb) -> Result<(), String> {
    let canon = Path::new(cwd)
        .canonicalize()
        .unwrap_or_else(|_| Path::new(cwd).to_path_buf())
        .to_string_lossy()
        .into_owned();
    db.with_global(|conn| repo_global::ignored_paths::add(conn, &canon))
        .map_err(|e| format!("加入 ignored_paths 失败: {e}"))?;
    Ok(())
}

// ===== 工具 =====

/// Unix 秒时间戳（用于 projects.created_at）。
fn unix_now() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ===== Tauri 命令包装器 =====

/// 解析 cwd → 作用域。前端 AiSidebar 挂载 / 切 tab 时调。
#[tauri::command]
pub async fn scope_resolve(
    cwd: String,
    db: State<'_, Arc<AitmDb>>,
) -> Result<ScopeDto, String> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || scope_resolve_impl(&cwd, &db))
        .await
        .map_err(|e| format!("spawn_blocking 失败: {e}"))?
}

/// 在 cwd 下初始化一个新项目（写 marker + 注册全局 + 创建项目 db）。
#[tauri::command]
pub async fn project_init(
    cwd: String,
    name: String,
    db: State<'_, Arc<AitmDb>>,
) -> Result<ProjectInitResult, String> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || project_init_impl(&cwd, &name, &db))
        .await
        .map_err(|e| format!("spawn_blocking 失败: {e}"))?
}

/// 把 cwd 加入"永久忽略"名单。
#[tauri::command]
pub async fn mark_ignored(
    cwd: String,
    db: State<'_, Arc<AitmDb>>,
) -> Result<(), String> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || mark_ignored_impl(&cwd, &db))
        .await
        .map_err(|e| format!("spawn_blocking 失败: {e}"))?
}
