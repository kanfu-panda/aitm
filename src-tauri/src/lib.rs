//! aitm 核心库。
//!
//! `run_gui()` 是 main.rs 在无 CLI 子命令时的入口。

pub mod cli;
pub mod i18n;
pub mod ipc;
#[cfg(target_os = "macos")]
pub mod menu;
pub mod notifications;
pub mod orchestrator;
pub mod providers;
pub mod safety;
pub mod scope;
pub mod session;
pub mod settings;
pub mod skills;
pub mod store;
pub mod tools;
pub mod version;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run_gui() {
    // v0.7.0-A：Aptabase plugin 内部用 tokio::spawn 异步上报 event，必须在
    // 一个 tokio Runtime context 里。aitm 的 main.rs 是同步 fn main，
    // 没自动建 runtime——这里建一个 multi-thread runtime 并 enter，让
    // 整个 run_gui 内部（含 Tauri builder / plugins / event handlers）
    // 都有 current runtime 可用。否则启动即 panic "there is no reactor running"
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("启动 tokio runtime 失败");
    let _guard = rt.enter();

    // 启动期 load 一次 settings，喂给 AiState 做三源合并；
    // SettingsState 自己再 load 一次（启动期磁盘读两次开销可忽略，
    // 换来两个 state 各自拥有独立的 AppSettings 副本，避免共享所有权复杂度）。
    let settings = settings::store::load();
    // v0.10.6 T1：把启动语言摘出来供 macOS setup 阶段 build 菜单用。
    // 启动后切语言走前端 menu_rebuild IPC，不再用本变量。
    #[cfg(target_os = "macos")]
    let startup_lang = settings.ui.language.clone();

    use tauri::Manager;
    // v0.7.0-A：Aptabase 匿名使用统计。
    // EventTracker trait 给 `App` / `AppHandle` / `Window` 加 `track_event`
    // 方法；setup hook 调一次 app_started、RunEvent::Exit 调 app_exited
    // 是 Aptabase 推荐的最小启动 / 关闭埋点（其余 event 由前端 wrapper 上报）。
    use tauri_plugin_aptabase::EventTracker;

    tauri::Builder::default()
        // v0.9.0 T4：拦截主窗口关闭事件，若 settings.ui.confirm_quit=true
        // 则 prevent_close + emit `app:confirm-quit-requested`，让前端弹
        // QuitConfirmDialog；用户点"退出"再走 app_quit_confirmed IPC。
        //
        // 关键约束（plan §6.3 Tauri close-requested 已知坑）：
        // - `api.prevent_close()` 必须在 event handler 同步调用（不能 await 后再调）
        // - 多 webview 时 child webview 关闭也会触发 → 必须 gate `window.label() == "main"`
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                use tauri::{Emitter, Manager};
                let app = window.app_handle();
                let settings_state = app.state::<ipc::settings::SettingsState>();
                // try_lock：on_window_event 是同步 hook，settings_get / update
                // 都是 async 持锁路径；这里 try_lock 拿不到就视为"无法判断 → 默认拦截"
                // 兜底安全（用户能看到 dialog 再决定，比直接放过强 kill 安全）。
                let should_confirm = match settings_state.current.try_lock() {
                    Ok(guard) => guard.ui.confirm_quit,
                    Err(_) => true,
                };
                if should_confirm {
                    api.prevent_close();
                    let _ = window.emit("app:confirm-quit-requested", ());
                }
            }
            // v1.1.0 R1：主窗口聚焦状态 → 前端。用 OS 级 WindowEvent::Focused（可靠），
            // 不用 Tauri JS onFocusChanged（多 webview 真机不触发，是上次焦点门控被迫
            // 全删的原因）。前端据此门控：活跃 tab && 窗口聚焦 → 不 badge（用户正看着，
            // 补全响铃等噪声不该点角标）；切到别的 app（失焦）则一律 badge。
            if let tauri::WindowEvent::Focused(focused) = event {
                use tauri::{Emitter, Manager};
                let _ = window.app_handle().emit_to(
                    tauri::EventTarget::webview("main"),
                    "window:focus-changed",
                    *focused,
                );
            }
        })
        // v1.3.0 P3：裸默认 `Builder::default()` 在 dev 下是 TRACE 全开，
        // `tauri_plugin_aptabase::dispatcher` 每 2 秒刷 "flushing tracking
        // events" + `tao::platform_impl` 的鼠标进出事件把真正有用的诊断信息
        // 全淹没（真机截图确认）——而项目规矩是"真机出问题看 dev log 诊断"，
        // 刷屏之下根本看不了。
        //
        // 分级：全局默认 Info（Error/Warn/Info 都留着，不关掉有用的错误日志，
        // release 下同样适用）；已知噪音源（aptabase 心跳、tao/wry 的窗口 /
        // 输入事件）单独降到 Warn；aitm 自己的代码保持 Debug 不降级，方便
        // 真机诊断。crate 名用 `aitm_lib`（`[lib] name`）——本 crate 内的
        // `log`/`tracing::debug!` 等宏 target 前缀就是这个，不是包名 `aitm`。
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(tauri_plugin_log::log::LevelFilter::Info)
                .level_for("aitm_lib", tauri_plugin_log::log::LevelFilter::Debug)
                .level_for(
                    "tauri_plugin_aptabase",
                    tauri_plugin_log::log::LevelFilter::Warn,
                )
                .level_for("tao", tauri_plugin_log::log::LevelFilter::Warn)
                .level_for("wry", tauri_plugin_log::log::LevelFilter::Warn)
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        // v0.7.0-A：Aptabase 匿名使用统计 plugin。
        // App Key `A-US-6820213489` 是公开 Key（不是 secret），可硬编码；
        // 上报开关由前端 `analytics_opt_in` 控制（关时前端 wrapper 静默丢弃）。
        // 这里 Rust 侧的 app_started / app_exited 是 Aptabase 自带最小埋点，
        // 不受前端 toggle 控制（启动 / 退出已发生，没有 PII）。
        .plugin(tauri_plugin_aptabase::Builder::new("A-US-6820213489").build())
        // 注意：SessionState 用 Arc 包装。orchestrator 的 ToolContext 需要持有
        // `Arc<SessionState>` 以便在 spawn 出去的 task 里跨线程共享，所以
        // Tauri State 直接 manage Arc，命令侧用 `State<'_, Arc<SessionState>>` 取出。
        .manage(std::sync::Arc::new(ipc::session::SessionState::new()))
        .manage(ipc::settings::SettingsState::new())
        .manage(ipc::ai::AiState::new(&settings))
        .manage(std::sync::Arc::new(crate::store::AitmDb::new()))
        .manage(std::sync::Arc::new(ipc::system::SystemMonitorState::default()))
        .manage(std::sync::Arc::new(ipc::browser::BrowserState::default()))
        // v1.1.0 F5：目录树 fs watcher 句柄状态（notify debouncer）
        .manage(ipc::fs::FsWatcherState::new())
        // v0.9.0 H2：cwd 轮询兜底（macOS 默认 zsh 不发 OSC 7 时也能跟 cwd）
        .manage(std::sync::Arc::new(session::cwd_poller::CwdPoller::new()))
        .setup(move |app| {
            // 启动期 spawn 系统资源监控定时器（1.5s 一次 emit `system:metrics`）。
            // 不依赖前端调 IPC——前端只订阅事件就行。
            let handle = app.handle().clone();
            let session_state = handle
                .state::<std::sync::Arc<ipc::session::SessionState>>()
                .inner()
                .clone();
            let monitor_state = handle
                .state::<std::sync::Arc<ipc::system::SystemMonitorState>>()
                .inner()
                .clone();
            tauri::async_runtime::spawn(async move {
                ipc::system::start_monitor(monitor_state, session_state, handle).await;
            });

            // v0.5.0-B T3：spawn 后台 2s 刷新 session metadata（git / 端口）。
            // 后端独立 task，不依赖前端 IPC 轮询；前端只 GET 当前快照。
            let session_state_for_meta = app
                .handle()
                .state::<std::sync::Arc<ipc::session::SessionState>>()
                .inner()
                .clone();
            tauri::async_runtime::spawn(async move {
                ipc::session::start_metadata_refresh_loop(session_state_for_meta).await;
            });

            // v0.9.0 H2：启动 cwd 轮询兜底任务（每 1s 扫所有 tracked shell PID）。
            // OSC 7 parser 仍是快速路径；本路径在 macOS 默认 zsh 不发 OSC 7 时
            // 兜底跟踪 cd 切换，保证 tab title 跟用户实际 cwd 一致。
            let cwd_poller_handle = app
                .handle()
                .state::<std::sync::Arc<session::cwd_poller::CwdPoller>>()
                .inner()
                .clone();
            cwd_poller_handle.start(app.handle().clone());

            // v1.2.0 T-B3：把 AppHandle 存进 BrowserState。
            // `browser_open` 工具要在**一个 webview 都没有**的情况下 emit
            // `browser:open_requested` 请前端开面板，那时没法靠
            // `Webview::app_handle()` 拿 handle，只能启动期存一份。
            app.handle()
                .state::<std::sync::Arc<ipc::browser::BrowserState>>()
                .set_app_handle(app.handle().clone());

            // v0.7.0-A：上报 app_started。Aptabase 自动附加 OS / app version 等
            // 非 PII metadata；这里 props=None 不带任何自定义字段。
            let _ = app.track_event("app_started", None);

            // v0.10.0 HR9-8 + v0.10.6 T1：macOS 自定义 NSMenu 接管 Cmd+W / Cmd+Q
            // 并接 i18n。
            //
            // 必要性（HR9-8）：macOS NSMenu performKeyEquivalent 在 NSApp 层吃掉
            // Cmd+W / Cmd+Q，**不**走 webview keyDown 也不走 RunEvent::ExitRequested
            // （PredefinedMenuItem::quit 直接调 process exit）。所以：
            //   - useShortcuts 的 keydown listener（无论 capture/bubble）接不到
            //   - lib.rs 的 ExitRequested 钩子接不到
            // 唯一办法是重建菜单，把 Quit / Close 换成自定义 ID，on_menu_event
            // 拦截后 emit 给前端走 dialog / closeTab 路径。
            //
            // 运行时 i18n（T1）：菜单结构 + 文案抽到 `crate::menu::build_menu(app, lang)`；
            // 启动期读 settings.ui.language 调一次；运行时切语言由前端
            // `menu_rebuild` IPC 触发再调（参见 ipc::menu::menu_rebuild）。
            //
            // event handler 只 install 一次（per-app 单例）；rebuild 时 menu item
            // id 保持稳定，handler 自动复用。
            //
            // 其它平台（Windows / Linux）默认菜单不拦快捷键，Ctrl+W / Ctrl+Q
            // 可通过 webview keydown 由 useShortcuts 接管，不需要本路径。
            #[cfg(target_os = "macos")]
            {
                let menu = crate::menu::build_menu(app.handle(), &startup_lang)?;
                app.set_menu(menu)?;
                crate::menu::install_menu_event_handler(app.handle());
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ipc::session::session_open,
            ipc::session::session_write,
            ipc::session::session_resize,
            ipc::session::session_close,
            ipc::session::session_current_cwd,
            ipc::session::session_has_running_command,
            ipc::session::tab_get_metadata,
            ipc::session::session_snapshot_load,
            ipc::session::session_snapshot_save,
            ipc::session::session_snapshot_clear,
            ipc::fs::fs_tree,
            ipc::fs::fs_read_text,
            ipc::fs::fs_read_preview,
            ipc::fs::file_write,
            // v0.10.2 #6：文件树右键菜单 CRUD
            ipc::fs::fs_create_file,
            ipc::fs::fs_create_dir,
            ipc::fs::fs_rename,
            ipc::fs::fs_delete,
            // v0.10.3 #10：文件元信息（外部改动检测）
            ipc::fs::fs_stat,
            // v0.9.1 HR3-3：StatusBar 重排（磁盘 + git 分支）
            ipc::fs::fs_disk_usage,
            ipc::fs::git_current_branch,
            // v1.1.0 F5：目录树 fs 自动刷新（notify watcher → fs:changed）
            ipc::fs::fs_watch_start,
            ipc::fs::fs_watch_stop,
            // v0.9.1 HR3-6：FileTree 按 git status 染色（modified / untracked / ...）
            ipc::git::git_status,
            ipc::shell::shell_open,
            ipc::settings::settings_get,
            ipc::settings::settings_update,
            ipc::settings::settings_reset,
            ipc::ai::list_providers,
            ipc::ai::ai_chat_send,
            ipc::ai::ai_chat_resume,
            ipc::ai::ai_chat_cancel,
            ipc::ai::ai_tool_approve,
            ipc::ai::ai_tool_reject,
            ipc::providers::providers_get_config,
            ipc::providers::providers_save_config,
            ipc::providers::providers_test_connection,
            ipc::safety::safety_validate_pattern,
            ipc::safety::safety_test_match,
            ipc::scope::scope_resolve,
            ipc::scope::project_init,
            ipc::scope::mark_ignored,
            ipc::conversations::conv_list,
            ipc::conversations::conv_create,
            ipc::conversations::conv_delete,
            ipc::conversations::conv_rename,
            ipc::conversations::conv_set_model,
            ipc::conversations::conv_append_message,
            ipc::conversations::conv_replace_message_payload,
            ipc::conversations::conv_get_messages,
            ipc::system::system_metrics_start,
            ipc::update::update_check,
            // Phase 4A T1：内嵌浏览器 lifecycle IPC
            ipc::browser::browser_open_tab,
            ipc::browser::browser_close_tab,
            ipc::browser::browser_navigate,
            ipc::browser::browser_set_active,
            ipc::browser::browser_clear_active,
            ipc::browser::browser_set_bounds,
            ipc::browser::browser_suspend_tab,
            ipc::browser::browser_set_scroll_y,
            ipc::browser::browser_panel_close_all,
            ipc::browser::browser_hide_all_active,
            ipc::browser::browser_show_all_active,
            ipc::browser::browser_forward_hotkey,
            // v0.5.0-E Scriptable Browser API
            ipc::browser::browser_inject_snapshot,
            ipc::browser::browser_snapshot_result,
            ipc::browser::browser_eval_js,
            // v1.2.0 T-B3：AI 自己开浏览器 —— 前端建好 tab 后回报结果
            ipc::browser::browser_open_result,
            // v0.9.0 T4：关闭应用二次确认
            ipc::app::app_quit_confirmed,
            // v1.0.1：原生 macOS Dock 角标（绕开 tauri#13905）
            ipc::app::set_dock_badge,
            // v0.10.6 T1：切语言时重建 NSMenu（macOS only；其他平台 no-op）
            ipc::menu::menu_rebuild,
        ])
        .build(tauri::generate_context!())
        .expect("aitm 启动失败")
        .run(|handler, event| {
            // v0.7.0-A：用 closure 形式的 run 是为了在 RunEvent::Exit 钩
            // app_exited + flush_events_blocking，确保最后一波 event 落地
            // Aptabase 服务器再退出。
            //
            // v0.10.0 HR9-7：macOS Cmd+Q 走 `RunEvent::ExitRequested`（**不**经
            // WindowEvent::CloseRequested），所以 lib.rs 上面 on_window_event
            // 那条 hook 只拦窗口红叉点击。Cmd+Q 必须在这里另拦。
            //
            // 链路：用户 Cmd+Q → ExitRequested → 我们 prevent_exit + emit
            // `app:confirm-quit-requested` → 前端 QuitConfirmDialog 弹 → 用户
            // 点退出 → ipc::app::app_quit_confirmed 把 QUIT_CONFIRMED 置 true
            // 再 app.exit(0) → 又触发 ExitRequested 但 flag=true 直接放行。
            use tauri::{Emitter, Manager};
            match event {
                tauri::RunEvent::ExitRequested { api, .. } => {
                    if crate::ipc::app::QUIT_CONFIRMED
                        .load(std::sync::atomic::Ordering::SeqCst)
                    {
                        // 用户已确认退出（app_quit_confirmed 调过）→ 放行
                        return;
                    }
                    let should_confirm = match handler
                        .state::<ipc::settings::SettingsState>()
                        .current
                        .try_lock()
                    {
                        Ok(guard) => guard.ui.confirm_quit,
                        Err(_) => true, // 拿不到锁兜底拦
                    };
                    if should_confirm {
                        api.prevent_exit();
                        if let Some(win) = handler.get_webview_window("main") {
                            let _ = win.emit("app:confirm-quit-requested", ());
                        }
                    }
                }
                tauri::RunEvent::Exit => {
                    let _ = handler.track_event("app_exited", None);
                    handler.flush_events_blocking();
                }
                _ => {}
            }
        });
}

/// 跨测试模块共享的 env mutation 串行锁。
///
/// 多个 mod 各自声明独立 `static Mutex` 时互相不感知，会同时改 HOME 等
/// 全局 env，导致测试相互污染。集中放在 lib 根方便所有 cfg(test) 模块共用。
#[cfg(test)]
pub(crate) mod test_env_lock {
    use std::sync::Mutex;
    pub static ENV_LOCK: Mutex<()> = Mutex::new(());
}
