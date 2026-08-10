//! 应用级 IPC 命令。
//!
//! v0.9.0 T4：QuitConfirmDialog 用户点"退出"后真正调 `app.exit(0)`。
//! 关闭 dialog 走前端 `setOpen(false)` 即可，不需要 IPC。

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::AppHandle;

/// v0.10.0 HR9-7：标记"用户已在 dialog 点退出，下一次 ExitRequested 不要再拦"。
///
/// 链路（macOS Cmd+Q）：
/// 1. 系统 NSApp terminate → Tauri 发 `RunEvent::ExitRequested`
/// 2. `lib.rs` 钩子读 `QUIT_CONFIRMED` —— **false** 则 prevent_exit + emit
///    `app:confirm-quit-requested` 让前端 QuitConfirmDialog 弹
/// 3. 用户点退出 → 前端调 `app_quit_confirmed` IPC → 这里 **set true** + `app.exit(0)`
/// 4. `app.exit(0)` 又触发一次 ExitRequested → 这次读到 true → 放行
///
/// 不用此标志的话第 4 步会被无限拦下死循环。
pub static QUIT_CONFIRMED: AtomicBool = AtomicBool::new(false);

/// v0.9.0 T4：用户在"确认退出"dialog 点"退出"后调用，真正退出应用。
///
/// 后端 `lib.rs::run_gui()` 的 `on_window_event` + `RunEvent::ExitRequested`
/// 双 hook 在 `confirm_quit=true` 时拦截关窗 / Cmd+Q 并 emit
/// `app:confirm-quit-requested` 事件；前端 `QuitConfirmDialog` 弹出后由
/// 用户点"退出"调本 IPC 真退出。
///
/// 用 `app.exit(0)` 让 Tauri 走正常关闭流程（触发 RunEvent::Exit → flush
/// Aptabase event → 释放资源），而不是直接 `std::process::exit`。
#[tauri::command]
pub fn app_quit_confirmed(app: AppHandle) {
    QUIT_CONFIRMED.store(true, Ordering::SeqCst);
    app.exit(0);
}

/// 返回当前应用版本（编译期烘焙的 `CARGO_PKG_VERSION`）。
///
/// 设置面板"关于"页要在无网络时也能立刻显示版本号，所以不复用
/// `update_check`（它要走 GitHub API，最长等 5s 且可能失败）。
#[tauri::command]
pub fn app_version() -> String {
    crate::version::current().to_string()
}

/// v1.0.1：原生设置 macOS Dock 角标（红色数字 / 文本）。
///
/// 不走 Tauri `Window::setBadgeCount`——它在 macOS 上有 bug（tauri#13905 未修，
/// 真机不显示）。这里直接调 AppKit `NSApp.dockTile().setBadgeLabel()`，是 macOS
/// 所有原生 app（含系统终端）的标准做法，不受该 bug 影响。
///
/// - `label` 为 `None` / 空串 → 清除角标；否则显示该字符串（如未读数 `"3"`）。
/// - AppKit 必须主线程调用，用 `app.run_on_main_thread` 派发。
/// - 非 macOS 平台为 no-op。
#[tauri::command]
pub fn set_dock_badge(app: AppHandle, label: Option<String>) {
    #[cfg(target_os = "macos")]
    {
        // 空串视为清除，避免 Dock 显示空白气泡
        let label = label.filter(|s| !s.is_empty());
        let _ = app.run_on_main_thread(move || {
            use objc2::MainThreadMarker;
            use objc2_app_kit::NSApplication;
            use objc2_foundation::NSString;
            let Some(mtm) = MainThreadMarker::new() else {
                return;
            };
            let ns_app = NSApplication::sharedApplication(mtm);
            let dock_tile = ns_app.dockTile();
            let ns_label = label.as_deref().map(NSString::from_str);
            dock_tile.setBadgeLabel(ns_label.as_deref());
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, label);
    }
}
