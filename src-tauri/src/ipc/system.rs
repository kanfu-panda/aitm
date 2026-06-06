//! 系统资源实时监控 IPC（Phase 2A T5 + v0.4.2 T4）。
//!
//! 后端 1.5s 一次 sysinfo 汇总 aitm 主进程 + 所有子孙进程（含 PTY shell、
//! 用户在终端 spawn 的命令、浏览器 WKWebView 等）的 RSS / CPU%，emit
//! 给前端 status bar。
//!
//! v0.4.2：从 self pid 改为 self + descendants（plan T4）。维护者 反馈
//! v0.4.1 数字几乎不动，真实消耗未反映。已知限制：macOS WKWebView
//! 的 helper 进程（WebContent / GPU / Networking）由 launchd 而非主
//! 进程启动，**不在** ptree 内，未被汇总。如真机测仍不准，后续 patch
//! 加 bundle-id 查询（launchctl）作 macOS-specific fallback。
//!
//! 启动时机：lib.rs 的 `setup` callback 里直接 spawn 一次定时任务，
//! 不依赖前端调 IPC（前端只负责订阅 `system:metrics` 事件）。
//! 仍保留 [`system_metrics_start`] 命令做幂等 trigger，方便测试 + 异常重试。

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;
use tokio::time::interval;

use crate::ipc::session::SessionState;

/// `system:metrics` 事件 payload。
///
/// 字段单位（v0.4.2 起含义为"全进程树总和"）：
/// - `rss_mb`：主进程 + 所有子孙进程 Resident Set Size 之和（MB，向下取整）
/// - `cpu_pct`：主进程 + 所有子孙进程 CPU 占用百分比之和（0-100*核数；
///   macOS 4 核机跑满 = 400）
/// - `active_sessions`：当前活跃 PTY session 数（SessionManager 内 map 大小）
#[derive(Debug, Clone, Serialize)]
pub struct SystemMetricsEvent {
    pub rss_mb: u32,
    pub cpu_pct: f32,
    pub active_sessions: usize,
}

/// 标记定时器是否已启动，避免重复 spawn。
#[derive(Default)]
pub struct SystemMonitorState {
    started: Mutex<bool>,
}

/// 启动后台定时任务：每 1.5s 刷一次 self + descendants 的 RSS / CPU + 查
/// 活跃 session 数，emit `system:metrics` 给前端。已启动时直接 return（幂等）。
///
/// 通常由 lib.rs `setup` callback 启动，但也提供为命令以便测试 / 重试场景。
#[tauri::command]
pub async fn system_metrics_start(
    state: State<'_, Arc<SystemMonitorState>>,
    session_state: State<'_, Arc<SessionState>>,
    app: AppHandle,
) -> Result<(), String> {
    start_monitor(state.inner().clone(), session_state.inner().clone(), app).await;
    Ok(())
}

/// 内部启动函数，lib.rs setup callback 直接调用走这个，避免 State<'_> 借用问题。
pub async fn start_monitor(
    state: Arc<SystemMonitorState>,
    session_state: Arc<SessionState>,
    app: AppHandle,
) {
    let mut started = state.started.lock().await;
    if *started {
        return;
    }
    *started = true;
    drop(started);

    tokio::spawn(async move {
        let mut sys = System::new();
        let main_pid = Pid::from_u32(std::process::id());
        let mut tick = interval(Duration::from_millis(1500));
        // sysinfo CPU 算法第一次返 0（需要两次 refresh 取差），所以前 1-2 个
        // tick 的 cpu_pct 可能是 0；交给前端按 number 显示，无需特殊处理。
        loop {
            tick.tick().await;
            // 改用 All：要遍历所有进程找 parent_pid 链到 self，必须刷全表。
            // 桌面常见 200-500 进程，sysinfo 单次 refresh 1-2ms 完全可接受。
            sys.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                ProcessRefreshKind::nothing().with_cpu().with_memory(),
            );
            let descendants = collect_descendants(&sys, main_pid);
            let mut total_rss_bytes: u64 = 0;
            let mut total_cpu: f32 = 0.0;
            for pid in &descendants {
                if let Some(proc) = sys.process(*pid) {
                    total_rss_bytes = total_rss_bytes.saturating_add(proc.memory());
                    total_cpu += proc.cpu_usage();
                }
            }
            let active_sessions = session_state.mgr.session_count().await;
            let payload = SystemMetricsEvent {
                rss_mb: (total_rss_bytes / 1024 / 1024) as u32,
                cpu_pct: total_cpu,
                active_sessions,
            };
            // emit 失败不致命：app 关闭时会报错，让循环 break 即可
            if app.emit("system:metrics", payload).is_err() {
                break;
            }
        }
    });
}

/// 用 BFS 从 root 遍历所有子孙进程（含 root 自己）。
///
/// 抽出一层 helper：先把 sysinfo 的 `process.parent()` 拍成 `HashMap<Pid,
/// Option<Pid>>`，再调用纯算法 [`collect_descendants_from_map`]，方便
/// 单测覆盖（sysinfo 的 Process 私有字段无法构造 mock）。
fn collect_descendants(sys: &System, root: Pid) -> HashSet<Pid> {
    let mut pid_to_parent = std::collections::HashMap::new();
    for (pid, proc) in sys.processes() {
        pid_to_parent.insert(*pid, proc.parent());
    }
    collect_descendants_from_map(&pid_to_parent, root)
}

/// 纯算法：给定一张 pid → parent_pid 表，BFS 找 root 的全部子孙（含 root）。
///
/// 实现策略：不断扩张 set 直到没有新节点加入。最坏 O(P²) where P =
/// 系统总进程数，对桌面 200-500 进程完全够用（< 1ms）。
///
/// 性质：
/// - root 在不在 map 里都返回 `{root}` 至少
/// - 不会无限循环（即使 parent 链成环，HashSet 去重）
fn collect_descendants_from_map(
    pid_to_parent: &std::collections::HashMap<Pid, Option<Pid>>,
    root: Pid,
) -> HashSet<Pid> {
    let mut set = HashSet::new();
    set.insert(root);
    loop {
        let mut grew = false;
        for (pid, parent_opt) in pid_to_parent {
            if set.contains(pid) {
                continue;
            }
            if let Some(parent) = parent_opt {
                if set.contains(parent) {
                    set.insert(*pid);
                    grew = true;
                }
            }
        }
        if !grew {
            break;
        }
    }
    set
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn system_metrics_event_序列化_字段名_snake_case() {
        let ev = SystemMetricsEvent {
            rss_mb: 27,
            cpu_pct: 1.5,
            active_sessions: 3,
        };
        let json = serde_json::to_string(&ev).unwrap();
        // 与前端 SystemMetricsEvent TS 类型对齐：snake_case
        assert!(json.contains("\"rss_mb\":27"), "rss_mb 字段缺失：{json}");
        assert!(json.contains("\"cpu_pct\":1.5"), "cpu_pct 字段缺失：{json}");
        assert!(
            json.contains("\"active_sessions\":3"),
            "active_sessions 字段缺失：{json}"
        );
    }

    #[tokio::test]
    async fn system_monitor_state_默认值_未启动() {
        let s = SystemMonitorState::default();
        assert!(!*s.started.lock().await);
    }

    #[test]
    fn collect_descendants_单进程_仅返回自身() {
        let mut map = HashMap::new();
        map.insert(Pid::from_u32(1), None);
        let res = collect_descendants_from_map(&map, Pid::from_u32(1));
        assert_eq!(res.len(), 1);
        assert!(res.contains(&Pid::from_u32(1)));
    }

    #[test]
    fn collect_descendants_深层链_全部覆盖() {
        // 1 -> 2 -> 3 -> 4（4 级链）
        let mut map = HashMap::new();
        map.insert(Pid::from_u32(1), None);
        map.insert(Pid::from_u32(2), Some(Pid::from_u32(1)));
        map.insert(Pid::from_u32(3), Some(Pid::from_u32(2)));
        map.insert(Pid::from_u32(4), Some(Pid::from_u32(3)));
        let res = collect_descendants_from_map(&map, Pid::from_u32(1));
        assert_eq!(res.len(), 4);
        for i in 1..=4 {
            assert!(res.contains(&Pid::from_u32(i)), "pid {i} 缺失");
        }
    }

    #[test]
    fn collect_descendants_分支树_排除无关进程() {
        // 1 -> 2; 1 -> 3; 2 -> 4; 5（无关 root）
        let mut map = HashMap::new();
        map.insert(Pid::from_u32(1), None);
        map.insert(Pid::from_u32(2), Some(Pid::from_u32(1)));
        map.insert(Pid::from_u32(3), Some(Pid::from_u32(1)));
        map.insert(Pid::from_u32(4), Some(Pid::from_u32(2)));
        map.insert(Pid::from_u32(5), None);
        let res = collect_descendants_from_map(&map, Pid::from_u32(1));
        assert_eq!(res.len(), 4); // 1, 2, 3, 4
        assert!(!res.contains(&Pid::from_u32(5)), "无关进程 5 不该被纳入");
    }

    #[test]
    fn collect_descendants_root_不在_map_仍返回自身() {
        // map 完全空 / root 不在 map 时，至少返回 {root}（保证发 metrics 不崩）
        let map = HashMap::new();
        let res = collect_descendants_from_map(&map, Pid::from_u32(99999));
        assert_eq!(res.len(), 1);
        assert!(res.contains(&Pid::from_u32(99999)));
    }

    #[test]
    fn collect_descendants_环依赖_不死循环() {
        // 病态用例：1 -> 2 -> 1 形成环（理论上 OS 不可能，但算法应鲁棒）
        // 注：从一个不在环里的 root 启动，set 应稳定收敛
        let mut map = HashMap::new();
        map.insert(Pid::from_u32(1), Some(Pid::from_u32(2)));
        map.insert(Pid::from_u32(2), Some(Pid::from_u32(1)));
        map.insert(Pid::from_u32(99), None); // 独立 root
        let res = collect_descendants_from_map(&map, Pid::from_u32(99));
        // 99 没有子进程，仅含自身
        assert_eq!(res.len(), 1);
    }

    #[test]
    fn collect_descendants_宽分支_多子进程() {
        // 1 是 root，有 5 个直接子进程
        let mut map = HashMap::new();
        map.insert(Pid::from_u32(1), None);
        for child in 2..=6 {
            map.insert(Pid::from_u32(child), Some(Pid::from_u32(1)));
        }
        let res = collect_descendants_from_map(&map, Pid::from_u32(1));
        assert_eq!(res.len(), 6);
    }
}
