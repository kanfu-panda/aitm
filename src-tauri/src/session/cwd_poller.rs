//! Per-session cwd 轮询器（v0.9.0 H2）。
//!
//! 每 1s 查每个活跃 PTY shell 进程的 cwd，跟上次 baseline 对比；变了就 emit
//! `pty:cwd-changed` 事件。OSC 7 parser（[`super::osc_parser::Osc7Parser`]）
//! 保留作快速路径；本模块是跨 shell 通用兜底。
//!
//! ## 为什么需要这层
//!
//! T3 实现了流式 OSC 7 解析 + emit 事件，但 维护者 真机测试发现完全不工作：
//! 终端 `cd` 提示符变了，**tab title 没更新**。
//!
//! 根因：macOS 默认 zsh **不**默认发 OSC 7。`\e]7;...\a` 提示符 hook 只在
//! macOS 自家 Terminal.app 启动时由 `/etc/zshrc_Apple_Terminal` 注入，
//! 第三方终端（aitm / iTerm2）启动的 zsh 不会自动加载这个钩子。
//! 普通用户的 `.zshrc` 也基本不会发。
//!
//! ## 与 OSC 7 parser 互补
//!
//! 两者都 emit 同一个 `pty:cwd-changed` 事件，前端 tabs store 自然去重
//! （path 没变就不刷 title）：
//!
//! - shell 主动发 OSC 7（fish / 配过的 zsh）→ 即时更新（< 100ms 延迟）
//! - shell 不发 OSC 7（macOS 默认 zsh / bash）→ 轮询兜底（最长 1s 延迟）
//!
//! ## 性能开销
//!
//! `sysinfo::System::refresh_processes_specifics` 在 macOS 通过 `proc_pidinfo`
//! system call 拿 cwd，单 PID 约 50µs；活跃 PTY 数量通常 < 10，1s tick
//! 一次的 CPU 开销低于 0.05%（百万分之 500 占用），完全可忽略。
//!
//! ## 平台限制
//!
//! - macOS / Linux：sysinfo 能拿到 cwd，工作正常
//! - Windows：sysinfo Process::cwd() 在 Windows 上**不可用**（OS API 限制），
//!   返 `None`；轮询路径上 read_pid_cwd 始终返 None，等于这层禁用。
//!   Windows 上 cwd 跟踪仅依赖 OSC 7（PowerShell 7+ 支持）。文档化已知
//!   限制，不阻 v0.9.0 发布。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::{AppHandle, Emitter, EventTarget};

use crate::ipc::session::PtyCwdChangedEvent;

/// Per-session cwd 跟踪器。注册到 Tauri State，IPC `session_open` /
/// `session_close` 在生命周期两端调 [`Self::register`] / [`Self::unregister`]。
pub struct CwdPoller {
    /// session_id 字符串 → (shell_pid, 上次 emit 过的 cwd)
    tracked: Arc<Mutex<HashMap<String, (u32, String)>>>,
}

impl CwdPoller {
    pub fn new() -> Self {
        Self {
            tracked: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// 注册一个 PTY session 的 shell PID。
    ///
    /// 立即查一次当前 cwd 作为 baseline（避免首个 tick 误 emit"从空字符串
    /// 变成实际路径"的假变化）。session 关闭时调 [`Self::unregister`]。
    pub fn register(&self, session_id: String, pid: u32) {
        let cwd = read_pid_cwd(pid).unwrap_or_default();
        let mut map = self.tracked.lock().expect("CwdPoller 锁中毒");
        map.insert(session_id, (pid, cwd));
    }

    /// 移除已关闭 session 的跟踪条目。幂等（不存在时 noop）。
    pub fn unregister(&self, session_id: &str) {
        let mut map = self.tracked.lock().expect("CwdPoller 锁中毒");
        map.remove(session_id);
    }

    /// 启动后台 1s tick 任务，每次扫所有 tracked session 的 cwd 变化，
    /// emit `pty:cwd-changed` 给主 webview。
    ///
    /// 用 `tauri::async_runtime::spawn` 而不是 `std::thread`，跟项目其他
    /// 后台 task（system metrics / metadata refresh）保持一致风格，且
    /// async_runtime 自带 tokio executor 不需要自己管线程生命周期。
    pub fn start(self: &Arc<Self>, app: AppHandle) {
        let this = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let mut sys = System::new();
            let mut tick = tokio::time::interval(Duration::from_millis(1000));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tick.tick().await;
                let updates = this.tick_once(&mut sys);
                for (session_id, cwd) in updates {
                    let payload = PtyCwdChangedEvent {
                        session_id,
                        cwd,
                    };
                    // 显式 emit_to(main webview)：避免广播到 browser 子 webview
                    // （跟 OSC 7 路径同样处理）
                    if let Err(e) = app.emit_to(
                        EventTarget::webview("main"),
                        "pty:cwd-changed",
                        &payload,
                    ) {
                        // app 关闭时 emit 会持续失败 → break 退出 task
                        tracing::warn!("emit pty:cwd-changed (poller) 失败: {e}");
                        return;
                    }
                }
            }
        });
    }

    /// 跑一次"刷新所有 tracked PID + 比对 cwd + 返回需 emit 的 (sid, new_cwd) 列表"。
    ///
    /// 抽出为单独方法是因为 [`Self::start`] 内是 async loop 难单测；
    /// 这里 borrow `&mut System` 由调用方持有，便于在测试里直接构造调用。
    ///
    /// 副作用：变化时**就地更新** baseline 到新 cwd（避免下次 tick 又重报）。
    pub fn tick_once(&self, sys: &mut System) -> Vec<(String, String)> {
        let mut map = self.tracked.lock().expect("CwdPoller 锁中毒");
        if map.is_empty() {
            return Vec::new();
        }
        // 一次性收集所有 tracked PID，去重后刷新这些进程的 cwd
        // （sysinfo 的 refresh_processes_specifics 对重复 PID 处理不可靠，
        // 实测 macOS 上传 `[p, p]` 会让后续 `sys.process(p).cwd()` 返 None；
        // 用 HashSet 去重避免该坑。多 session 共享 shell PID 是合法场景：
        // 极端情况下重复打开同一 PID 的 session、或测试场景）
        let unique_pids: std::collections::HashSet<Pid> = map
            .values()
            .map(|(pid, _)| Pid::from_u32(*pid))
            .collect();
        let pids: Vec<Pid> = unique_pids.into_iter().collect();
        sys.refresh_processes_specifics(
            ProcessesToUpdate::Some(&pids),
            true,
            ProcessRefreshKind::nothing().with_cwd(sysinfo::UpdateKind::Always),
        );
        let mut updates = Vec::new();
        for (sid, (pid, last_cwd)) in map.iter_mut() {
            let p = Pid::from_u32(*pid);
            if let Some(new_cwd) = sys
                .process(p)
                .and_then(|proc| proc.cwd().map(|c| c.to_string_lossy().into_owned()))
            {
                if new_cwd != *last_cwd {
                    *last_cwd = new_cwd.clone();
                    updates.push((sid.clone(), new_cwd));
                }
            }
        }
        updates
    }

    /// 测试 / 诊断辅助：当前已注册的 session 数量。
    #[cfg(test)]
    pub fn tracked_count(&self) -> usize {
        self.tracked.lock().expect("CwdPoller 锁中毒").len()
    }
}

impl Default for CwdPoller {
    fn default() -> Self {
        Self::new()
    }
}

/// 查指定 PID 的 cwd。
///
/// macOS / Linux：sysinfo 借 proc API 拿到 cwd 路径。
/// Windows：sysinfo 不支持 Process::cwd → 返 None（这层等于禁用）。
fn read_pid_cwd(pid: u32) -> Option<String> {
    let mut sys = System::new();
    let pid = Pid::from_u32(pid);
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing().with_cwd(sysinfo::UpdateKind::Always),
    );
    sys.process(pid)
        .and_then(|p| p.cwd().map(|c| c.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 用当前测试进程自身的 PID 作为 mock：它一定存在 + 有 cwd。
    fn self_pid() -> u32 {
        std::process::id()
    }

    #[test]
    fn register_unregister_幂等() {
        let poller = CwdPoller::new();
        assert_eq!(poller.tracked_count(), 0);
        poller.register("s1".to_string(), self_pid());
        assert_eq!(poller.tracked_count(), 1);
        // 重复 register 同 session 覆盖，不增加条目数
        poller.register("s1".to_string(), self_pid());
        assert_eq!(poller.tracked_count(), 1);
        poller.unregister("s1");
        assert_eq!(poller.tracked_count(), 0);
        // 不存在的 unregister 不 panic
        poller.unregister("s1");
        poller.unregister("nonexistent");
    }

    /// Unix 平台：进程自查 cwd 应能拿到（不为空）。
    /// Windows：sysinfo 不支持 → 跳过此用例（read_pid_cwd 返 None 是已知限制）。
    #[cfg(unix)]
    #[test]
    fn read_pid_cwd_自查_返回当前路径() {
        let cwd = read_pid_cwd(self_pid());
        assert!(cwd.is_some(), "Unix 平台 sysinfo 应能拿到自身 cwd");
        let cwd = cwd.unwrap();
        // cwd 必为绝对路径
        assert!(
            cwd.starts_with('/'),
            "cwd 应是绝对路径，实际：{cwd}"
        );
    }

    /// 首次 tick：baseline 已经在 register 时录上，cwd 没变 → 不 emit。
    #[cfg(unix)]
    #[test]
    fn tick_once_无变化_不返回更新() {
        let poller = CwdPoller::new();
        poller.register("s1".to_string(), self_pid());
        let mut sys = System::new();
        let updates = poller.tick_once(&mut sys);
        assert!(
            updates.is_empty(),
            "register 已录 baseline，相同 cwd 不应产出更新，实际：{updates:?}"
        );
    }

    /// 模拟 cwd 变化场景：直接改 tracked map 里的 last_cwd 为"假旧路径"，
    /// 下次 tick 应该检测到差异并 emit。
    #[cfg(unix)]
    #[test]
    fn tick_once_检测到_cwd_变化_返回更新() {
        let poller = CwdPoller::new();
        poller.register("s1".to_string(), self_pid());
        // 把 baseline 改成"绝对不可能是真 cwd 的字符串"，模拟 cd 之后的"旧值"
        {
            let mut map = poller.tracked.lock().unwrap();
            let entry = map.get_mut("s1").unwrap();
            entry.1 = "/nonexistent-aitm-fake-path-12345".to_string();
        }
        let mut sys = System::new();
        let updates = poller.tick_once(&mut sys);
        assert_eq!(updates.len(), 1, "应检测到 1 次变化");
        assert_eq!(updates[0].0, "s1");
        // 新 cwd 必是绝对路径，不是我们设的 fake
        assert!(updates[0].1.starts_with('/'));
        assert_ne!(updates[0].1, "/nonexistent-aitm-fake-path-12345");
        // baseline 应已就地更新；再次 tick 不再 emit
        let updates2 = poller.tick_once(&mut sys);
        assert!(
            updates2.is_empty(),
            "baseline 应已更新，第二次 tick 不应再 emit，实际：{updates2:?}"
        );
    }

    /// 多 session 独立跟踪：两个 session 各自 baseline，互不影响。
    /// 用同 PID 两次 register 顺带覆盖"重复 PID 去重"路径（sysinfo 对
    /// `[p, p]` 处理不可靠的坑，见 tick_once 内 HashSet 去重备忘）。
    #[cfg(unix)]
    #[test]
    fn tick_once_多_session_独立() {
        let poller = CwdPoller::new();
        poller.register("a".to_string(), self_pid());
        poller.register("b".to_string(), self_pid());
        assert_eq!(poller.tracked_count(), 2);
        // 只改 "a" 的 baseline
        {
            let mut map = poller.tracked.lock().unwrap();
            map.get_mut("a").unwrap().1 = "/fake".to_string();
        }
        let mut sys = System::new();
        let updates = poller.tick_once(&mut sys);
        assert_eq!(updates.len(), 1, "只有 a 应 emit");
        assert_eq!(updates[0].0, "a");
    }

    /// 不存在的 PID（已退出 / 假 PID）→ sysinfo 拿不到 process → 不 emit。
    #[test]
    fn tick_once_pid_不存在_不_emit() {
        let poller = CwdPoller::new();
        // PID 0 在 Unix / Windows 都不会是用户进程
        // 用一个极不可能存在的高 PID 4294967294（u32::MAX - 1）
        poller.register("dead".to_string(), u32::MAX - 1);
        let mut sys = System::new();
        let updates = poller.tick_once(&mut sys);
        assert!(
            updates.is_empty(),
            "不存在的 PID 不该产出更新，实际：{updates:?}"
        );
    }

    /// tick_once 空 tracked → 不调用 sysinfo，返回空（性能优化路径）。
    #[test]
    fn tick_once_空_tracked_快速返回() {
        let poller = CwdPoller::new();
        let mut sys = System::new();
        let updates = poller.tick_once(&mut sys);
        assert!(updates.is_empty());
    }
}
