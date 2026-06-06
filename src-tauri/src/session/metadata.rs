//! v0.5.0-B：Tab 元信息（git branch / dirty / 未推送 commits / cwd / 监听端口）。
//!
//! 数据流：
//! 1. 后台 tokio task 每 2s 给每个 active session refresh 一次
//! 2. 前端 IPC `tab_get_metadata(session_id)` 拉
//! 3. AI 工具 `terminal_history` / `list_files` 自动 prepend 给 LLM 看

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use super::SessionId;

/// 单个 tab 的元信息。所有字段都可缺失（None / 空 vec）；前端按存在与否决定是否
/// 显示对应 chip。
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct TabMetadata {
    /// git branch 短名（如 "main" / "feat/x"）；不在 git 仓库时为 None
    pub git_branch: Option<String>,
    /// git 工作区是否 dirty（有 staged / unstaged / untracked）
    pub git_dirty: bool,
    /// 未推送 commits 数；本地分支无上游或读不到 origin ref 时返 None
    pub git_unpushed_count: Option<u32>,
    /// 当前 shell 的 cwd（绝对路径，前端显示时缩到 ~）
    pub cwd: Option<String>,
    /// shell 子进程树下监听的端口（去重 + sorted ASC）
    pub listening_ports: Vec<u16>,
}

impl TabMetadata {
    /// 至少有一项非默认才"有内容"（决定前端是否显示 chip / AI 工具是否 prepend）
    pub fn has_any(&self) -> bool {
        self.git_branch.is_some() || !self.listening_ports.is_empty() || self.cwd.is_some()
    }

    /// 给 AI 工具 prepend 用的中文摘要。空时返空字符串（caller 判空决定是否 prepend）。
    pub fn to_ai_summary(&self) -> String {
        if !self.has_any() {
            return String::new();
        }
        let mut parts: Vec<String> = Vec::new();
        if let Some(branch) = &self.git_branch {
            let mut s = format!("分支: {branch}");
            if self.git_dirty {
                s.push_str("（dirty）");
            }
            if let Some(n) = self.git_unpushed_count {
                if n > 0 {
                    s.push_str(&format!("（{n} commits 未推送）"));
                }
            }
            parts.push(s);
        }
        if let Some(cwd) = &self.cwd {
            parts.push(format!("cwd: {cwd}"));
        }
        if !self.listening_ports.is_empty() {
            let ports: Vec<String> =
                self.listening_ports.iter().map(|p| p.to_string()).collect();
            parts.push(format!("监听端口: {}", ports.join(", ")));
        }
        parts.join(" / ")
    }
}

/// 读 cwd 的 git 元信息（branch + dirty + unpushed count）。
/// 不是 git 仓库 / 拿不到 HEAD 时返 None（caller 把整个 TabMetadata 留 git_* 字段空）。
pub fn read_git_metadata(cwd: &Path) -> Option<(String, bool, Option<u32>)> {
    let repo = git2::Repository::discover(cwd).ok()?;
    let head = repo.head().ok()?;
    let branch_name = head.shorthand()?.to_string();

    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true);
    let statuses = repo.statuses(Some(&mut opts)).ok()?;
    let dirty = !statuses.is_empty();

    let unpushed = read_unpushed_count(&repo, &branch_name);

    Some((branch_name, dirty, unpushed))
}

/// 计算本地分支领先 origin/<branch> 的 commit 数。
/// 上游 ref 不存在（如刚 init 未 push）→ None。
fn read_unpushed_count(repo: &git2::Repository, branch_name: &str) -> Option<u32> {
    let local_oid = repo
        .find_branch(branch_name, git2::BranchType::Local)
        .ok()?
        .get()
        .target()?;
    let upstream_ref = format!("refs/remotes/origin/{branch_name}");
    let upstream_oid = repo.refname_to_id(&upstream_ref).ok()?;

    let (ahead, _behind) = repo.graph_ahead_behind(local_oid, upstream_oid).ok()?;
    Some(ahead as u32)
}

/// 后端 cache：每个 session 一份 TabMetadata。前端 IPC 拉 / AI 工具读都走这里。
#[derive(Clone, Default)]
pub struct SessionMetadataCache {
    inner: Arc<RwLock<HashMap<SessionId, TabMetadata>>>,
}

impl SessionMetadataCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// 读某 session 的 metadata（克隆出来不持锁）。不存在返 None。
    pub async fn get(&self, id: SessionId) -> Option<TabMetadata> {
        self.inner.read().await.get(&id).cloned()
    }

    /// 同步版本（给 AI 工具调，避免 await；用 blocking_read 在 tokio task 里要小心）。
    /// AI 工具是 async 上下文，但 try_read 不阻塞失败时返 None 可接受降级。
    pub fn try_get(&self, id: SessionId) -> Option<TabMetadata> {
        self.inner.try_read().ok()?.get(&id).cloned()
    }

    /// 覆盖更新某 session 的 metadata。
    pub async fn set(&self, id: SessionId, meta: TabMetadata) {
        self.inner.write().await.insert(id, meta);
    }

    /// session 关闭时调，清条目避免缓存泄漏。
    pub async fn remove(&self, id: SessionId) {
        self.inner.write().await.remove(&id);
    }

    /// 列出所有 session id（后台 refresh 任务用，避免 await 时持锁太久）。
    pub async fn list_session_ids(&self) -> Vec<SessionId> {
        self.inner.read().await.keys().copied().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command;
    use tempfile::TempDir;

    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "test")
            .env("GIT_AUTHOR_EMAIL", "t@t.com")
            .env("GIT_COMMITTER_NAME", "test")
            .env("GIT_COMMITTER_EMAIL", "t@t.com")
            .output()
            .expect("git command failed");
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn init_repo() -> (TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_path_buf();
        git(&path, &["init", "-b", "main"]);
        std::fs::write(path.join("README"), "hi\n").unwrap();
        git(&path, &["add", "README"]);
        git(&path, &["commit", "-m", "init"]);
        (dir, path)
    }

    #[test]
    fn 非_git_目录_返_none() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_git_metadata(dir.path()).is_none());
    }

    #[test]
    fn 干净_git_仓库_branch_main_dirty_false() {
        let (_dir, path) = init_repo();
        let (branch, dirty, unpushed) = read_git_metadata(&path).unwrap();
        assert_eq!(branch, "main");
        assert!(!dirty);
        // 无 origin 上游 → None
        assert_eq!(unpushed, None);
    }

    #[test]
    fn 修改后_dirty_true() {
        let (_dir, path) = init_repo();
        std::fs::write(path.join("README"), "changed\n").unwrap();
        let (_, dirty, _) = read_git_metadata(&path).unwrap();
        assert!(dirty);
    }

    #[test]
    fn untracked_文件_也算_dirty() {
        let (_dir, path) = init_repo();
        std::fs::write(path.join("new.txt"), "x").unwrap();
        let (_, dirty, _) = read_git_metadata(&path).unwrap();
        assert!(dirty);
    }

    #[test]
    fn 切到子目录_仍能找到_repo() {
        let (_dir, path) = init_repo();
        let sub = path.join("subdir");
        std::fs::create_dir(&sub).unwrap();
        let (branch, _, _) = read_git_metadata(&sub).unwrap();
        assert_eq!(branch, "main");
    }

    #[test]
    fn to_ai_summary_空_metadata_返空字符串() {
        let m = TabMetadata::default();
        assert_eq!(m.to_ai_summary(), "");
        assert!(!m.has_any());
    }

    #[test]
    fn to_ai_summary_完整_字段_含中文标签() {
        let m = TabMetadata {
            git_branch: Some("main".into()),
            git_dirty: true,
            git_unpushed_count: Some(3),
            cwd: Some("/Users/x/proj".into()),
            listening_ports: vec![3000, 5173],
        };
        let s = m.to_ai_summary();
        assert!(s.contains("分支: main"));
        assert!(s.contains("dirty"));
        assert!(s.contains("3 commits 未推送"));
        assert!(s.contains("cwd: /Users/x/proj"));
        assert!(s.contains("3000"));
        assert!(s.contains("5173"));
    }

    #[test]
    fn to_ai_summary_未推送_0_不显示() {
        let m = TabMetadata {
            git_branch: Some("main".into()),
            git_dirty: false,
            git_unpushed_count: Some(0),
            ..Default::default()
        };
        let s = m.to_ai_summary();
        assert!(s.contains("分支: main"));
        assert!(!s.contains("未推送"));
    }

    #[tokio::test]
    async fn cache_set_get_remove() {
        let cache = SessionMetadataCache::new();
        let id = SessionId::new();
        assert!(cache.get(id).await.is_none());

        let meta = TabMetadata {
            git_branch: Some("dev".into()),
            ..Default::default()
        };
        cache.set(id, meta.clone()).await;
        assert_eq!(cache.get(id).await, Some(meta));

        cache.remove(id).await;
        assert!(cache.get(id).await.is_none());
    }
}
