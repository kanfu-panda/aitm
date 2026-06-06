//! 多会话管理器。

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{anyhow, Result};
use tokio::sync::Mutex;

use super::pty_session::Session;
use super::{SessionConfig, SessionId};

/// 跨多个 tab 共享 session 状态。
pub struct SessionManager {
    sessions: Mutex<HashMap<SessionId, Arc<Session>>>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// 打开新会话，返回 session id。
    pub async fn open(&self, cfg: SessionConfig) -> Result<SessionId> {
        let session = Session::spawn(cfg)?;
        let id = session.id;
        self.sessions.lock().await.insert(id, Arc::new(session));
        Ok(id)
    }

    /// 写入会话。
    pub async fn write(&self, id: SessionId, data: &[u8]) -> Result<()> {
        let session = self.get(id).await?;
        session.write(data).await
    }

    /// 调整尺寸。
    pub async fn resize(&self, id: SessionId, cols: u16, rows: u16) -> Result<()> {
        let session = self.get(id).await?;
        session.resize(cols, rows).await
    }

    /// 关闭会话。drop 掉 Arc 后 PTY 会自动清理；子进程 wait 在 read loop 里做。
    pub async fn close(&self, id: SessionId) -> Result<()> {
        let mut map = self.sessions.lock().await;
        map.remove(&id)
            .ok_or_else(|| anyhow!("session 不存在: {id}"))?;
        Ok(())
    }

    /// 测试用：非阻塞收一段 chunk。
    pub async fn try_recv(&self, id: SessionId) -> Option<Vec<u8>> {
        let session = self.get(id).await.ok()?;
        session.try_recv().await
    }

    /// 取出 session 的 Arc 句柄（IPC 后台 forward task 用）。
    pub async fn get(&self, id: SessionId) -> Result<Arc<Session>> {
        self.sessions
            .lock()
            .await
            .get(&id)
            .cloned()
            .ok_or_else(|| anyhow!("session 不存在: {id}"))
    }

    /// 拷一份当前所有 session 的 Arc 句柄（避免长时间持锁）。
    /// 给跨 session 的查询接口用（如 [`Self::search_recent`]）。
    pub async fn snapshot_sessions(&self) -> Vec<Arc<Session>> {
        self.sessions.lock().await.values().cloned().collect()
    }

    /// 当前活跃 session 数量。给 status bar / 监控类接口用。
    pub async fn session_count(&self) -> usize {
        self.sessions.lock().await.len()
    }

    /// 读取指定 session 最近 N 行输出。session 不存在时返回 None。
    pub async fn recent_output(&self, id: SessionId, lines: usize) -> Option<String> {
        let session = self.get(id).await.ok()?;
        Some(session.recent_output(lines))
    }

    /// 实时查指定 session 的 shell 当前工作目录。session 不存在 / 平台不支持
    /// / 进程已退出时返回 None。AI 工具用它让 read_file / list_files 跟随
    /// 用户实际在 PTY 里 cd 到的目录。
    pub async fn current_cwd(&self, id: SessionId) -> Option<std::path::PathBuf> {
        let session = self.get(id).await.ok()?;
        session.current_cwd()
    }

    /// 跨所有 session 子串搜索 query，每命中一行附带 session_id。
    /// 总命中数受 `max_results` 截断（按 session 顺序遍历，先到先得）。
    pub async fn search_recent(
        &self,
        query: &str,
        max_results: usize,
    ) -> Vec<(SessionId, String)> {
        if query.is_empty() || max_results == 0 {
            return Vec::new();
        }
        let sessions = self.snapshot_sessions().await;
        let mut results = Vec::new();
        for s in sessions {
            if results.len() >= max_results {
                break;
            }
            let remaining = max_results - results.len();
            for line in s.search_buffer(query, remaining) {
                results.push((s.id, line));
                if results.len() >= max_results {
                    break;
                }
            }
        }
        results
    }
}

impl Default for SessionManager {
    fn default() -> Self {
        Self::new()
    }
}

// hardcode `/bin/sh` — Unix-only 测试集，Windows target 跳过。
#[cfg(all(test, unix))]
mod tests {
    use super::*;

    /// 用 spawn 出来的真实 session，但绕开 PTY 直接 inject 字节。
    /// 因为 PTY 输出时序不可控，单测改用 inject 钩子稳定一些。
    async fn open_and_inject(mgr: &SessionManager, payload: &[u8]) -> SessionId {
        let cfg = SessionConfig {
            shell: Some("/bin/sh".to_string()),
            cols: 80,
            rows: 24,
            ..Default::default()
        };
        let id = mgr.open(cfg).await.unwrap();
        let session = mgr.get(id).await.unwrap();
        session.inject_for_test(payload);
        id
    }

    #[tokio::test]
    async fn recent_output_session_不存在_返回_none() {
        let mgr = SessionManager::new();
        let fake = SessionId::new();
        assert!(mgr.recent_output(fake, 10).await.is_none());
    }

    #[tokio::test]
    async fn recent_output_读到注入的最后_n_行() {
        let mgr = SessionManager::new();
        let id = open_and_inject(&mgr, b"a\nb\nc\nd\ne\n").await;
        let out = mgr.recent_output(id, 2).await.unwrap();
        assert_eq!(out, "d\ne");
        // 关掉，避免子进程继续跑
        let _ = mgr.write(id, b"exit\n").await;
        let _ = mgr.close(id).await;
    }

    #[tokio::test]
    async fn search_recent_跨_session_命中() {
        let mgr = SessionManager::new();
        let id_a = open_and_inject(&mgr, b"INFO ok\nERROR foo\n").await;
        let _id_b = open_and_inject(&mgr, b"WARN bar\nERROR baz\n").await;

        let hits = mgr.search_recent("ERROR", 10).await;
        assert_eq!(hits.len(), 2, "两个 session 各命中一条");
        assert!(hits.iter().any(|(_, l)| l == "ERROR foo"));
        assert!(hits.iter().any(|(_, l)| l == "ERROR baz"));

        // 同名工具友好性：第一条来自 id_a 的 session_id 应能匹配
        assert!(hits.iter().any(|(sid, _)| *sid == id_a));
    }

    #[tokio::test]
    async fn search_recent_max_results_截断() {
        let mgr = SessionManager::new();
        let _ = open_and_inject(&mgr, b"hit\nhit\nhit\n").await;
        let _ = open_and_inject(&mgr, b"hit\nhit\nhit\n").await;

        let hits = mgr.search_recent("hit", 2).await;
        assert_eq!(hits.len(), 2);
    }

    #[tokio::test]
    async fn search_recent_空_query_返回空() {
        let mgr = SessionManager::new();
        let _ = open_and_inject(&mgr, b"anything\n").await;
        assert!(mgr.search_recent("", 10).await.is_empty());
    }

    #[tokio::test]
    async fn session_count_正确反映_session_数量() {
        let mgr = SessionManager::new();
        assert_eq!(mgr.session_count().await, 0);
        let _id1 = open_and_inject(&mgr, b"x\n").await;
        assert_eq!(mgr.session_count().await, 1);
        let id2 = open_and_inject(&mgr, b"y\n").await;
        assert_eq!(mgr.session_count().await, 2);
        mgr.close(id2).await.unwrap();
        assert_eq!(mgr.session_count().await, 1);
    }
}
