//! NSMenu 运行时重建 IPC（v0.10.6 T1）。
//!
//! 前端 settings.ui.language 变化时调用本 IPC，让后端按新语言重新构建并装上
//! NSMenu。Tauri 2 的 `app.set_menu(new_menu)` 支持运行时整体替换，所以不需要
//! 走 "get_item().set_text()" 增量改文案。
//!
//! ## 平台
//!
//! - macOS：真正执行 build + set_menu
//! - 其他平台：silently no-op（菜单在 webview 内部，无需后端 rebuild）
//!
//! ## 与 `crate::menu::install_menu_event_handler` 的关系
//!
//! event handler 在 lib.rs setup() 已挂一次（per-app 单例）；本 IPC 仅替换菜单
//! 结构，**不**重新注册 event handler（否则 click 会多次触发）。menu item id
//! 保持稳定（quit-confirm / close-tab / font-* …），event handler 路由仍生效。

use tauri::AppHandle;

/// 按指定语言重新构建并装上 NSMenu。
///
/// 失败 case：
/// - macOS 上 Tauri menu build / set_menu 出错 → 返回错误信息字符串
/// - lang 是未知值（如 "fr"） → 不报错，i18n 模块 fallback en（用户层面看到
///   英文菜单 + 设置面板里仍是用户选的语言；提示后续补译）
///
/// 非 macOS 平台直接返回 Ok(())，前端不需要按平台分支。
#[tauri::command]
pub fn menu_rebuild(app: AppHandle, lang: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let menu = crate::menu::build_menu(&app, &lang)
            .map_err(|e| format!("build_menu 失败 (lang={lang}): {e}"))?;
        app.set_menu(menu)
            .map_err(|e| format!("set_menu 失败 (lang={lang}): {e}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, lang);
        Ok(())
    }
}
