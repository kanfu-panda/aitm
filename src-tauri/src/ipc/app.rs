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
