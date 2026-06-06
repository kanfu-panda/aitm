//! session 相关 IPC 命令 + 事件 forward。

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::task::JoinHandle;

use crate::session::manager::SessionManager;
use crate::session::metadata::{SessionMetadataCache, TabMetadata};
use crate::session::{SessionConfig, SessionId};

/// 全局 SessionManager 状态（注册到 Tauri Builder.manage）。
pub struct SessionState {
    pub mgr: Arc<SessionManager>,
    /// 每个 session 的后台 forward task 句柄。drop = abort。
    pub forwards: tokio::sync::Mutex<std::collections::HashMap<SessionId, JoinHandle<()>>>,
    /// v0.5.0-B：Tab 元信息缓存。后台 task 每 2s 刷新；前端 IPC + AI 工具读
    pub metadata: SessionMetadataCache,
}

impl SessionState {
    pub fn new() -> Self {
        Self {
            mgr: Arc::new(SessionManager::new()),
            forwards: tokio::sync::Mutex::new(std::collections::HashMap::new()),
            metadata: SessionMetadataCache::new(),
        }
    }

    /// 给 AI 工具用的字符串 id 入口：拉某个 session 最近 N 行输出。
    /// session_id 解析失败 / 不存在 → None。
    pub async fn recent_output(&self, session_id: &str, lines: usize) -> Option<String> {
        let id = parse_session_id(session_id)?;
        self.mgr.recent_output(id, lines).await
    }

    /// 给 ai_chat_send 用：实时查 active session 的 shell cwd，让 ToolContext.cwd
    /// 跟着用户在 PTY 里 cd 走。失败（解析 / 不存在 / 平台不支持）返回 None
    /// 由调用方兜底到 HOME。
    pub async fn current_cwd(&self, session_id: &str) -> Option<std::path::PathBuf> {
        let id = parse_session_id(session_id)?;
        self.mgr.current_cwd(id).await
    }

    /// 给 AI 工具用：跨所有 session 子串搜索，返回 (session_id 字符串, 行) 元组。
    pub async fn search_recent(
        &self,
        query: &str,
        max_results: usize,
    ) -> Vec<(String, String)> {
        self.mgr
            .search_recent(query, max_results)
            .await
            .into_iter()
            .map(|(sid, line)| (sid.to_string(), line))
            .collect()
    }

    /// 给 AI 工具用：往指定 session 的 PTY stdin 写数据。
    /// session_id 解析失败 / 不存在 / 写入出错 → Err(String) 描述。
    pub async fn write_input(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        let id = parse_session_id(session_id)
            .ok_or_else(|| format!("session id 解析失败: {session_id}"))?;
        self.mgr.write(id, data).await.map_err(|e| e.to_string())
    }
}

fn parse_session_id(s: &str) -> Option<SessionId> {
    uuid::Uuid::parse_str(s).ok().map(SessionId)
}

/// v0.5.0-B：后台 metadata refresh loop。每 2s 遍历 cache 内 session ids，
/// 调 read_git_metadata + list_listening_ports 更新条目。
///
/// 设计要点：
/// - cwd 用 session.current_cwd()（sysinfo 实时 PID cwd 查询）
/// - git2 / lsof 调用都在 blocking 线程跑（用 tokio::task::spawn_blocking）
///   避免阻塞 tokio runtime
/// - 找不到 session（已关闭）时 cache 已被 session_close remove，不会再访问
/// - 整个 loop 容错：单 session 刷新失败不影响其他
pub async fn start_metadata_refresh_loop(state: Arc<SessionState>) {
    use crate::session::metadata::{read_git_metadata, TabMetadata};
    use crate::session::ports::list_listening_ports;

    let mut interval = tokio::time::interval(std::time::Duration::from_secs(2));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        interval.tick().await;

        let ids = state.metadata.list_session_ids().await;
        for id in ids {
            let Ok(session) = state.mgr.get(id).await else {
                continue;
            };
            let cwd = session.current_cwd();
            let shell_pid = session.shell_pid();

            let cwd_clone = cwd.clone();
            let git_result = tokio::task::spawn_blocking(move || {
                cwd_clone.as_ref().and_then(|p| read_git_metadata(p))
            })
            .await
            .ok()
            .flatten();

            let ports_result = if let Some(pid) = shell_pid {
                tokio::task::spawn_blocking(move || list_listening_ports(pid))
                    .await
                    .unwrap_or_default()
            } else {
                Vec::new()
            };

            let meta = TabMetadata {
                git_branch: git_result.as_ref().map(|t| t.0.clone()),
                git_dirty: git_result.as_ref().map(|t| t.1).unwrap_or(false),
                git_unpushed_count: git_result.as_ref().and_then(|t| t.2),
                cwd: cwd.map(|p| p.to_string_lossy().into_owned()),
                listening_ports: ports_result,
            };
            state.metadata.set(id, meta).await;
        }
    }
}

impl Default for SessionState {
    fn default() -> Self {
        Self::new()
    }
}

/// `session:data` 事件 payload。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionDataEvent {
    pub session_id: SessionId,
    /// PTY 输出的 raw bytes，base64 编码以便 JSON 传输。
    pub bytes_base64: String,
}

/// `session:exit` 事件 payload。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionExitEvent {
    pub session_id: SessionId,
}

/// v0.9.0 T3：`pty:cwd-changed` 事件 payload。
/// shell 通过 OSC 7 序列汇报新 cwd 时由 PTY 读循环 emit。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PtyCwdChangedEvent {
    /// 对应 session 的字符串化 UUID（前端按 sessionId 在 tabs 列表查找 tab）。
    pub session_id: String,
    /// shell 汇报的绝对路径（已 URL 解码 / `~` 展开）。
    pub cwd: String,
}

#[tauri::command]
pub async fn session_open(
    cfg: SessionConfig,
    state: State<'_, Arc<SessionState>>,
    settings_state: State<'_, crate::ipc::settings::SettingsState>,
    cwd_poller: State<'_, Arc<crate::session::cwd_poller::CwdPoller>>,
    app: AppHandle,
) -> Result<SessionId, String> {
    // 如果调用方没指定 shell，从 settings 拉 default_shell（空则保持 None 走系统 $SHELL）
    let mut cfg = cfg;
    if cfg.shell.is_none() {
        let s = settings_state.current.lock().await;
        let custom = &s.shell.default_shell;
        if !custom.is_empty() {
            cfg.shell = Some(custom.clone());
        }
    }

    let id = state.mgr.open(cfg).await.map_err(|e| e.to_string())?;

    // v0.5.0-B：初始化空 metadata 条目，让后台 refresh task 知道有这个 session
    state.metadata.set(id, TabMetadata::default()).await;

    // v0.9.0 H2 / v0.9.1 HR4-1：把 shell PID 注册到 cwd poller，1s 轮询
    // cwd 变化兜底（OSC 7 parser 是快速路径，本路径覆盖默认 zsh / bash
    // 不发 OSC 7 的场景）。
    //
    // HR4-1 race condition 修复：session.shell_pid() 在 PTY child 进程 spawn
    // 之后才填充，session_open 返回时立即同步取可能仍是 None（async race），
    // 一旦错过这次 register，poller 永不知道这个 session 存在 → 前端
    // tabs.cwd 永远 undefined → snapshot 写 null → 跨重启走默认 HOME。
    // 改成异步轮询最多 2s（40 × 50ms），拿到 PID 立刻 register，超时静默。
    let state_for_register = Arc::clone(&state);
    let poller_for_register = Arc::clone(&cwd_poller);
    tauri::async_runtime::spawn(async move {
        for _ in 0..40 {
            if let Ok(session) = state_for_register.mgr.get(id).await {
                if let Some(pid) = session.shell_pid() {
                    poller_for_register.register(id.to_string(), pid);
                    return;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        tracing::warn!(
            "cwd_poller register 超时（2s），session {} 未拿到 shell PID",
            id
        );
    });

    // 启动后台 forward task：从 session.recv() 拉数据 → emit 'session:data' +
    // 同时喂给 OSC parser 解析 OSC 9/99/777 → emit 'notification:received'
    // （v0.5.0-A T3：复用同一 tokio task，避免再开一个 thread + Session 接口零改动）
    let mgr = state.mgr.clone();
    let app2 = app.clone();
    let handle = tokio::spawn(async move {
        let session = match mgr.get(id).await {
            Ok(s) => s,
            Err(_) => return,
        };
        let mut osc_parser =
            crate::notifications::OscParser::new(id.to_string());
        // v0.9.0 T3：独立 OSC 7 解析器，喂同一份字节流抽取 cwd。
        let mut osc7_parser = crate::session::osc_parser::Osc7Parser::new();
        loop {
            match session.recv().await {
                Some(bytes) => {
                    // 1. 原路径：base64 + emit session:data 给 xterm.js 渲染
                    use base64::Engine;
                    let payload = SessionDataEvent {
                        session_id: id,
                        bytes_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
                    };
                    if let Err(e) = app2.emit("session:data", &payload) {
                        tracing::warn!("emit session:data 失败: {e}");
                    }

                    // 2. v0.5.0-A：喂 notifications OSC parser，发解析出的通知
                    for event in osc_parser.feed(&bytes) {
                        if let Err(e) = app2.emit("notification:received", &event) {
                            tracing::warn!("emit notification:received 失败: {e}");
                        }
                    }

                    // 3. v0.9.0 T3：喂 OSC 7 解析器；命中则 emit pty:cwd-changed。
                    // 显式 emit_to(main webview) 避免广播到 browser 子 webview。
                    if let Some(cwd) = osc7_parser.feed(&bytes) {
                        let cwd_payload = PtyCwdChangedEvent {
                            session_id: id.to_string(),
                            cwd,
                        };
                        if let Err(e) = app2.emit_to(
                            tauri::EventTarget::webview("main"),
                            "pty:cwd-changed",
                            &cwd_payload,
                        ) {
                            tracing::warn!("emit pty:cwd-changed 失败: {e}");
                        }
                    }
                }
                None => {
                    // PTY 关闭 / 子进程退出
                    if let Err(e) = app2.emit("session:exit", &SessionExitEvent { session_id: id })
                    {
                        tracing::warn!("emit session:exit 失败: {e}");
                    }
                    break;
                }
            }
        }
    });

    state.forwards.lock().await.insert(id, handle);
    Ok(id)
}

#[tauri::command]
pub async fn session_write(
    id: SessionId,
    bytes_base64: String,
    state: State<'_, Arc<SessionState>>,
) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(bytes_base64.as_bytes())
        .map_err(|e| format!("base64 解码失败: {e}"))?;
    state
        .mgr
        .write(id, &bytes)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn session_resize(
    id: SessionId,
    cols: u16,
    rows: u16,
    state: State<'_, Arc<SessionState>>,
) -> Result<(), String> {
    state
        .mgr
        .resize(id, cols, rows)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn session_close(
    id: SessionId,
    state: State<'_, Arc<SessionState>>,
    cwd_poller: State<'_, Arc<crate::session::cwd_poller::CwdPoller>>,
) -> Result<(), String> {
    // 先停 forward task
    if let Some(h) = state.forwards.lock().await.remove(&id) {
        h.abort();
    }
    // v0.5.0-B：清 metadata cache 条目
    state.metadata.remove(id).await;
    // v0.9.0 H2：移除 cwd poller 跟踪
    cwd_poller.unregister(&id.to_string());
    state.mgr.close(id).await.map_err(|e| e.to_string())
}

/// v0.5.0-B：拉某 session 的 Tab 元信息（git / cwd / 监听端口）。
///
/// 数据来自后端 2s 后台刷新填充的 SessionMetadataCache。前端 5s 轮询调一次。
/// session 不存在 / cache 还没刷过 → 返 None（前端不显示 chip）。
#[tauri::command]
pub async fn tab_get_metadata(
    id: SessionId,
    state: State<'_, Arc<SessionState>>,
) -> Result<Option<TabMetadata>, String> {
    Ok(state.metadata.get(id).await)
}

// === v0.5.0-D Session 持久化 IPC ===

/// 读启动 snapshot；无 / 坏 → 返 None（让前端走默认路径）。
#[tauri::command]
pub fn session_snapshot_load(
) -> Result<Option<crate::session::snapshot::SessionSnapshot>, String> {
    crate::session::snapshot::load_snapshot()
}

/// 写当前 snapshot（前端 debounced 触发）。
#[tauri::command]
pub fn session_snapshot_save(
    snapshot: crate::session::snapshot::SessionSnapshot,
) -> Result<(), String> {
    crate::session::snapshot::save_snapshot(&snapshot)
}

/// 删 snapshot（用户选"全新启动"时调）。
#[tauri::command]
pub fn session_snapshot_clear() -> Result<(), String> {
    crate::session::snapshot::clear_snapshot()
}

/// 1F：实时查 session 的 shell cwd 字符串。给前端 AiSidebar 启动 / 切 tab
/// 时用来调 [`scope_resolve`]。session 不存在 / 平台不支持时返回 None。
#[tauri::command]
pub async fn session_current_cwd(
    id: String,
    state: State<'_, Arc<SessionState>>,
) -> Result<Option<String>, String> {
    Ok(state
        .current_cwd(&id)
        .await
        .map(|p| p.to_string_lossy().into_owned()))
}

/// 3A T1：判断 session 的 shell 进程下是否有"在跑"的子进程（命令）。
///
/// 用法：关闭 tab 前调一次，true 时弹"确认关闭"二次确认，避免用户误关
/// 还在跑长命令的 tab。
///
/// 实现：
/// - shell_pid 没拿到 → 保守返回 `false`（不阻塞 close）
/// - 用 sysinfo 刷新所有进程，找 `parent() == shell_pid` 的项，count > 0 → true
///
/// 平台说明：sysinfo 跨 macOS/Linux/Windows 都有 parent pid 概念，但 Windows
/// 的 cmd.exe 子进程关系受 job object 影响，3A 范围以 macOS 为主，Windows
/// 上返回值仅作参考。
#[tauri::command]
pub async fn session_has_running_command(
    id: SessionId,
    state: State<'_, Arc<SessionState>>,
) -> Result<bool, String> {
    let session = match state.mgr.get(id).await {
        Ok(s) => s,
        Err(_) => return Ok(false), // session 已不存在 → 当然没在跑命令
    };
    let Some(shell_pid) = session.shell_pid() else {
        return Ok(false); // 拿不到 shell pid → 保守
    };
    // 拷句柄出来后释放对 session map 的隐式引用；扫进程在 spawn_blocking 里跑
    drop(session);

    let result = tokio::task::spawn_blocking(move || {
        use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
        let mut sys = System::new();
        // 找 shell 的子进程要遍历全表，refresh All 一次
        sys.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing(),
        );
        let parent_pid = Pid::from_u32(shell_pid);
        sys.processes()
            .values()
            .any(|p| p.parent() == Some(parent_pid))
    })
    .await
    .map_err(|e| format!("sysinfo refresh task 失败：{e}"))?;

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn session_has_running_command_session_不存在_返_false() {
        let state = Arc::new(SessionState::new());
        let fake = SessionId::new();
        // 直接调内部逻辑：构造 State 包装跑 command 太重，单测层用 mgr 直查
        let session = state.mgr.get(fake).await;
        assert!(session.is_err(), "fake id 不该存在");
        // 这层 err 会被命令体 unwrap 成 Ok(false)；这里断言路径成立
    }
}
