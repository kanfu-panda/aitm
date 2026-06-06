//! v0.5.0-D：Tab 状态跨重启持久化。
//!
//! 启动时检测 ~/Library/Application Support/aitm/sessions/last.json（macOS）/
//! XDG_DATA_HOME/aitm/sessions/last.json（Linux）/ %APPDATA%/aitm/sessions/last.json
//! （Windows）→ 有 snapshot 弹 Dialog 让用户选恢复 / 全新 / 跳过。
//!
//! 不持久化的对象（plan §0.2）：
//! - PTY scrollback（重启 PTY 是新 shell，scrollback 无意义）
//! - 浏览器 tab（v0.4.x 决议每次启动新 webview）
//! - 通知历史（推迟到 v0.6.x）
//!
//! 数据结构详见 plan §1.1。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// 当前 snapshot schema 版本。未来字段变化时 +1；加载时不匹配 → 丢弃 + 走默认路径。
pub const SCHEMA_VERSION: u32 = 1;

/// snapshot JSON 最大大小（防意外膨胀）。256 KB 可支持 ~5000 tab，远超实用。
pub const MAX_SNAPSHOT_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionSnapshot {
    /// schema 版本号，未来字段变化兼容用
    pub schema_version: u32,
    /// 写入时间（epoch ms），调试 + 防过期 snapshot 用
    pub saved_at_ms: u64,
    /// 跨重启的 tab 列表
    pub tabs: Vec<TabSnapshot>,
    /// 上次 active tab 的 id（恢复后定位）；可空（首次启动 / 无 tab）
    pub active_tab_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct TabSnapshot {
    /// 前端内部 id（恢复时保留，让 unread / notification cache 还能对上）
    pub tab_id: String,
    /// 标签名（用户改名 / 自动派生）
    pub title: String,
    /// 上次 PTY 的 cwd（重启时新 PTY 用它做 -d 启动目录）；不可读返 None
    pub cwd: Option<String>,
    /// 未读计数（用户没切过去时保留显示）
    pub unread: u32,
    /// v0.10.0 HR9-5：tab 所属 PaneGroup 的 id。
    ///
    /// 关键背景：snapshot（本文件）和 `settings.ui.pane_layout` 是两份独立持久化；
    /// 重启时 useTabsStore.addTab() 给每个 tab 生成**新 uuid**，旧 layout 里的
    /// group.tab_ids 都用旧 uuid 引用 → 重启后 sanitize filter 全 miss → 所有
    /// group 显示为空。
    ///
    /// 修法：snapshot 记下每个 tab 当时所属的 group_id；restore 时按 group_id
    /// 调 `usePaneLayoutStore.addTabToGroup(group_id, new_tab_id)` 把 new id
    /// 加进对应 group。
    ///
    /// 兼容旧 snapshot：缺省 / None → restore 时 fallback 到 INITIAL_GROUP_ID。
    pub group_id: Option<String>,
}

/// snapshot 文件绝对路径。dirs::data_dir() 失败（理论不该发生）→ fallback HOME/.aitm/sessions/
pub fn snapshot_path() -> PathBuf {
    let base = dirs::data_dir()
        .or_else(|| dirs::home_dir().map(|h| h.join(".aitm-fallback")))
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    base.join("aitm").join("sessions").join("last.json")
}

/// 读 snapshot。文件不存在 / 解析失败 / schema 不匹配 → Ok(None)（兼容启动）。
/// 真 IO 错误（如权限）→ Err。
pub fn load_snapshot() -> Result<Option<SessionSnapshot>, String> {
    load_from(&snapshot_path())
}

/// 内部：从指定路径读，便于单测注入 tempfile 路径。
pub fn load_from(path: &std::path::Path) -> Result<Option<SessionSnapshot>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(path).map_err(|e| format!("读 snapshot 失败：{e}"))?;
    if bytes.len() > MAX_SNAPSHOT_BYTES {
        return Ok(None); // 文件腐败 / 异常膨胀 → 走默认
    }
    let parsed: Result<SessionSnapshot, _> = serde_json::from_slice(&bytes);
    match parsed {
        Ok(s) if s.schema_version == SCHEMA_VERSION => Ok(Some(s)),
        // schema 不匹配 / JSON 损坏 → 静默丢弃，走默认（避免老版本残留 snapshot 阻塞新版启动）
        _ => Ok(None),
    }
}

/// 写 snapshot 到磁盘。自动创建父目录。超大小限制 → Err（前端 toast warn 不阻塞）。
pub fn save_snapshot(snap: &SessionSnapshot) -> Result<(), String> {
    save_to(&snapshot_path(), snap)
}

/// 内部：写到指定路径。
pub fn save_to(path: &std::path::Path, snap: &SessionSnapshot) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(snap)
        .map_err(|e| format!("序列化 snapshot 失败：{e}"))?;
    if json.len() > MAX_SNAPSHOT_BYTES {
        return Err(format!(
            "snapshot 过大 ({} bytes > {} 上限)",
            json.len(),
            MAX_SNAPSHOT_BYTES
        ));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建 snapshot 目录失败：{e}"))?;
    }
    std::fs::write(path, &json).map_err(|e| format!("写 snapshot 失败：{e}"))?;
    Ok(())
}

/// 删 snapshot 文件（用户选"全新启动"时调）。文件不存在不算错误。
pub fn clear_snapshot() -> Result<(), String> {
    clear_at(&snapshot_path())
}

pub fn clear_at(path: &std::path::Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    std::fs::remove_file(path).map_err(|e| format!("删 snapshot 失败：{e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn sample_snapshot() -> SessionSnapshot {
        SessionSnapshot {
            schema_version: SCHEMA_VERSION,
            saved_at_ms: 1_700_000_000_000,
            tabs: vec![
                TabSnapshot {
                    tab_id: "tab-1".into(),
                    title: "main".into(),
                    cwd: Some("/Users/x/proj".into()),
                    unread: 0,
                    group_id: Some("g-initial".into()),
                },
                TabSnapshot {
                    tab_id: "tab-2".into(),
                    title: "logs".into(),
                    cwd: Some("/var/log".into()),
                    unread: 3,
                    group_id: Some("g-right".into()),
                },
            ],
            active_tab_id: Some("tab-1".into()),
        }
    }

    #[test]
    fn snapshot_path_是绝对路径() {
        let p = snapshot_path();
        assert!(p.is_absolute(), "应是绝对路径：{}", p.display());
        assert!(p.ends_with("last.json"));
    }

    #[test]
    fn load_不存在的文件_返_ok_none() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("nope.json");
        let r = load_from(&path).unwrap();
        assert!(r.is_none());
    }

    #[test]
    fn save_load_round_trip() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("snap.json");
        let snap = sample_snapshot();

        save_to(&path, &snap).unwrap();
        let loaded = load_from(&path).unwrap().unwrap();
        assert_eq!(loaded, snap);
    }

    #[test]
    fn save_自动创建父目录() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("nested/a/b/snap.json");
        save_to(&path, &sample_snapshot()).unwrap();
        assert!(path.exists());
    }

    #[test]
    fn load_schema_不匹配_返_ok_none() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("snap.json");
        // 写 schema_version=999 的 JSON
        let payload = serde_json::json!({
            "schema_version": 999,
            "saved_at_ms": 0,
            "tabs": [],
            "active_tab_id": null,
        });
        std::fs::write(&path, payload.to_string()).unwrap();
        let r = load_from(&path).unwrap();
        assert!(r.is_none(), "schema 不匹配应返 None（走默认启动）");
    }

    #[test]
    fn load_坏_json_返_ok_none() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("snap.json");
        std::fs::write(&path, "{this is not json").unwrap();
        let r = load_from(&path).unwrap();
        assert!(r.is_none());
    }

    #[test]
    fn load_超大文件_返_ok_none() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("snap.json");
        let huge = vec![b'x'; MAX_SNAPSHOT_BYTES + 100];
        std::fs::write(&path, &huge).unwrap();
        let r = load_from(&path).unwrap();
        assert!(r.is_none(), "超大文件视为腐败");
    }

    #[test]
    fn save_超大_snapshot_返_err() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("snap.json");
        // 构造 6000 个 tab → JSON > 256 KB
        let tabs: Vec<TabSnapshot> = (0..6000)
            .map(|i| TabSnapshot {
                tab_id: format!("tab-{i}"),
                title: format!("title-{i}"),
                cwd: Some(format!("/some/long/path/with/many/segments/{i}")),
                unread: 0,
                group_id: None,
            })
            .collect();
        let big = SessionSnapshot {
            schema_version: SCHEMA_VERSION,
            saved_at_ms: 0,
            tabs,
            active_tab_id: None,
        };
        let r = save_to(&path, &big);
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("过大"));
    }

    #[test]
    fn clear_删除文件() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("snap.json");
        save_to(&path, &sample_snapshot()).unwrap();
        assert!(path.exists());

        clear_at(&path).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn clear_不存在_不报错() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("ghost.json");
        clear_at(&path).unwrap(); // 应 ok
    }

    #[test]
    fn v0_10_hr9_5_老_snapshot_缺_group_id_字段_反序列化为_none() {
        // 模拟 v0.10.0 HR9-5 之前的旧 snapshot（缺 group_id）
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("snap.json");
        let payload = serde_json::json!({
            "schema_version": SCHEMA_VERSION,
            "saved_at_ms": 1_700_000_000_000u64,
            "tabs": [
                {
                    "tab_id": "tab-1",
                    "title": "main",
                    "cwd": "/Users/x",
                    "unread": 0,
                },
                {
                    "tab_id": "tab-2",
                    "title": "logs",
                    "cwd": null,
                    "unread": 5,
                },
            ],
            "active_tab_id": "tab-1",
        });
        std::fs::write(&path, payload.to_string()).unwrap();
        let loaded = load_from(&path).unwrap().unwrap();
        assert_eq!(loaded.tabs.len(), 2);
        assert_eq!(loaded.tabs[0].tab_id, "tab-1");
        // 缺省 group_id → None（restore 时前端 fallback INITIAL_GROUP_ID）
        assert_eq!(loaded.tabs[0].group_id, None);
        assert_eq!(loaded.tabs[1].group_id, None);
        // 其他字段不受影响
        assert_eq!(loaded.tabs[0].title, "main");
        assert_eq!(loaded.tabs[1].unread, 5);
    }

    #[test]
    fn v0_10_hr9_5_group_id_字段_round_trip() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("snap.json");
        let snap = SessionSnapshot {
            schema_version: SCHEMA_VERSION,
            saved_at_ms: 0,
            tabs: vec![
                TabSnapshot {
                    tab_id: "t1".into(),
                    title: "left".into(),
                    cwd: None,
                    unread: 0,
                    group_id: Some("g-initial".into()),
                },
                TabSnapshot {
                    tab_id: "t2".into(),
                    title: "right".into(),
                    cwd: None,
                    unread: 0,
                    group_id: Some("g-right-side".into()),
                },
                TabSnapshot {
                    tab_id: "t3".into(),
                    title: "orphan".into(),
                    cwd: None,
                    unread: 0,
                    group_id: None,
                },
            ],
            active_tab_id: Some("t1".into()),
        };
        save_to(&path, &snap).unwrap();
        let loaded = load_from(&path).unwrap().unwrap();
        assert_eq!(loaded, snap);
        assert_eq!(loaded.tabs[0].group_id.as_deref(), Some("g-initial"));
        assert_eq!(loaded.tabs[1].group_id.as_deref(), Some("g-right-side"));
        assert_eq!(loaded.tabs[2].group_id, None);
    }

    #[test]
    fn 空_tabs_snapshot_合法() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("snap.json");
        let empty = SessionSnapshot {
            schema_version: SCHEMA_VERSION,
            saved_at_ms: 0,
            tabs: vec![],
            active_tab_id: None,
        };
        save_to(&path, &empty).unwrap();
        let loaded = load_from(&path).unwrap().unwrap();
        assert_eq!(loaded.tabs.len(), 0);
    }
}
