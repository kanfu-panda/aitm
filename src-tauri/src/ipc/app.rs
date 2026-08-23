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

/// 「关于」页自助诊断用的环境信息。
///
/// 用户报 bug 时最常见的卡点是"日志在哪、我用的什么版本"。把这几项一次性
/// 给出来，用户可以直接复制进 issue，也能一键打开日志目录捞文件。
///
/// 只包含**用户自己机器上的公开信息**：版本号、平台、两个目录路径。
/// 不含用户名以外的任何身份信息、不含配置内容（`config.toml` 里有 API key，
/// 所以这里只给**目录**路径，绝不读文件内容）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct DiagnosticsInfo {
    /// 应用版本（同 `app_version`）。
    pub version: String,
    /// 目标平台，如 `"macos"` / `"windows"` / `"linux"`。
    pub os: String,
    /// 目标架构，如 `"aarch64"` / `"x86_64"`。
    pub arch: String,
    /// 应用日志目录（tauri-plugin-log 的 LogDir target 写在这里）。
    /// 取不到（平台无此概念 / 权限异常）时为 `None`，前端显示"—"。
    pub log_dir: Option<String>,
    /// 日志文件全路径，**存在时**才有值。
    ///
    /// 前端"打开日志目录"要 reveal 的是它而不是目录：应用 identifier 是
    /// `com.aitm.app`，日志目录因此叫 `~/Library/Logs/com.aitm.app`——**目录名以
    /// `.app` 结尾**。macOS 的 `open` 会把任何 `.app` 目录当应用程序包去启动，
    /// 找不到可执行文件就报 "The application cannot be opened because its
    /// executable is missing." 而 `shell_open` 只看 spawn 成功与否、不等退出码，
    /// 于是失败被整个吞掉——点了没反应也没报错（多 webview 场景实测）。
    ///
    /// reveal 日志**文件**走 `open -R`，既绕开 `.app` 误判，又能直接在访达里
    /// 选中日志文件。
    pub log_file: Option<String>,
    /// 配置目录 `~/.aitm/`。**只给目录不给文件**——config.toml 里有 API key。
    pub config_dir: Option<String>,
}

/// 收集「关于」页自助诊断要显示的环境信息。
#[tauri::command]
pub fn diagnostics_info(app: AppHandle) -> DiagnosticsInfo {
    use tauri::Manager;
    let dir = app.path().app_log_dir().ok();
    DiagnosticsInfo {
        version: crate::version::current().to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        log_file: dir
            .as_ref()
            .map(|d| d.join(LOG_FILE_NAME))
            .filter(|p| p.is_file())
            .map(|p| p.to_string_lossy().into_owned()),
        log_dir: dir.map(|p| p.to_string_lossy().into_owned()),
        config_dir: crate::settings::store::config_dir()
            .ok()
            .map(|p| p.to_string_lossy().into_owned()),
    }
}

/// tauri-plugin-log 默认按 `<应用名>.log` 命名（应用名取自 tauri.conf.json 的
/// `productName`）。这里硬编码是因为 plugin 没暴露"日志文件在哪"的查询接口。
const LOG_FILE_NAME: &str = "aitm.log";

/// 日志尾部最多回传多少行。
///
/// 报 issue 时真正有用的是崩溃/报错现场，也就是最后那几十行；整个文件可能有
/// 几 MB，塞进 issue 正文既超 URL 长度又没人看。
const LOG_TAIL_LINES: usize = 50;

/// 读日志文件的最后 [`LOG_TAIL_LINES`] 行，供「报告问题」预填进 issue 正文。
///
/// 单独一个命令而不是塞进 [`diagnostics_info`]：日志可能有几 MB，每次打开
/// 「关于」页都读一遍没必要，用户真要报问题时才读。
///
/// 读不到（文件不存在 / 权限不足）返回 `None` 而不是 Err——报 issue 这条路
/// 不该因为捞不到日志就走不下去。
#[tauri::command]
pub fn diagnostics_log_tail(app: AppHandle) -> Option<String> {
    use tauri::Manager;
    let path = app.path().app_log_dir().ok()?.join(LOG_FILE_NAME);
    let content = std::fs::read_to_string(path).ok()?;
    let lines: Vec<&str> = content.lines().collect();
    let start = lines.len().saturating_sub(LOG_TAIL_LINES);
    Some(lines[start..].join("\n"))
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
