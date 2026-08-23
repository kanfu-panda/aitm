//! macOS NSMenu 构建 + 重建（v0.10.6 T1）。
//!
//! 此前（v0.10.0 HR9-8）菜单 inline 写在 `lib.rs::run_gui()` 的 setup() 里，
//! 文案锁死中文，切语言后菜单不变。v0.10.6 T1 抽出到独立模块 + 接 i18n。
//!
//! ## 总体设计
//!
//! - `build_menu(app, lang)` 拼出一棵新 Menu（依赖 `crate::i18n::t` 走文案）；
//!   首次启动在 `lib.rs::setup()` 调用，运行时通过 `menu_rebuild` IPC 再调一次
//!   实现"切语言菜单跟着变"。
//! - `install_menu_event_handler(app)` 注册一次 `on_menu_event` 把菜单 click 桥
//!   到前端事件（reuse v0.10.0 已建的 dialog / closeTab 通路）；不依赖 lang，
//!   只挂一次（重建菜单时 menu item id 不变，event handler 复用）。
//!
//! ## 平台
//!
//! macOS only。Windows / Linux 走 in-window menubar，未来另接（参见 plan §2.6）。
//!
//! ## 菜单 id 表（保持稳定，前端 / event handler 依赖这些 id）
//!
//! | id | 触发事件 / 行为 |
//! |---|---|
//! | `quit-confirm` | emit `app:confirm-quit-requested` |
//! | `close-tab` | emit `app:close-active-tab` |
//! | `font-increase` / `font-decrease` / `font-reset` | emit `menu:font-action`（T4 接 action handler） |

#![cfg(target_os = "macos")]

use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime};

use crate::i18n;

/// 构建一棵完整 NSMenu。
///
/// 调用方负责调 `app.set_menu(menu)?` 装上。首次启动 + `menu_rebuild` 都走本函数。
///
/// `lang`：BCP 47 locale 代码（`"en"` / `"zh-CN"` / `"ja"`）；未知值 fallback en
/// （由 `i18n::t` 兜底，本函数透传不做特殊处理）。
pub fn build_menu<R: Runtime>(app: &AppHandle<R>, lang: &str) -> tauri::Result<Menu<R>> {
    // ---- App submenu（macOS 第一个 submenu = NSApp menu）----
    let quit_item = MenuItemBuilder::with_id("quit-confirm", i18n::t(lang, "menu.app.quit"))
        .accelerator("Cmd+Q")
        .build(app)?;

    // 自定义"关于"项而非 PredefinedMenuItem::about：系统面板只能显示静态
    // metadata，装不下"检查更新"按钮。这里改为打开应用内设置的"关于"页。
    let about_item = MenuItemBuilder::with_id("open-about", i18n::t(lang, "menu.app.about"))
        .build(app)?;

    let app_submenu = SubmenuBuilder::new(app, i18n::t(lang, "menu.app.title"))
        .item(&about_item)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .item(&quit_item)
        .build()?;

    // ---- File submenu ----
    let close_tab_item =
        MenuItemBuilder::with_id("close-tab", i18n::t(lang, "menu.file.closeTab"))
            .accelerator("Cmd+W")
            .build(app)?;
    let file_submenu = SubmenuBuilder::new(app, i18n::t(lang, "menu.file.title"))
        .item(&close_tab_item)
        .build()?;

    // ---- Edit submenu（系统标准剪贴板 / 撤销）----
    // 注意：Tauri 2 SubmenuBuilder::{undo,redo,cut,copy,paste,select_all} 是
    // PredefinedMenuItem，文案由系统决定（macOS 跟系统语言走），无法注入自定义
    // 文案。这里只控制 submenu 标题（"编辑" / "Edit" / "編集"）。
    let edit_submenu = SubmenuBuilder::new(app, i18n::t(lang, "menu.edit.title"))
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    // ---- View submenu（v0.10.6 T4 接 font action handler；T1 占位放 menu item）----
    let font_increase_item = MenuItemBuilder::with_id(
        "font-increase",
        i18n::t(lang, "menu.view.fontIncrease"),
    )
    .accelerator("Cmd+=")
    .build(app)?;
    let font_decrease_item = MenuItemBuilder::with_id(
        "font-decrease",
        i18n::t(lang, "menu.view.fontDecrease"),
    )
    .accelerator("Cmd+-")
    .build(app)?;
    let font_reset_item =
        MenuItemBuilder::with_id("font-reset", i18n::t(lang, "menu.view.fontReset"))
            .accelerator("Cmd+0")
            .build(app)?;

    let view_submenu = SubmenuBuilder::new(app, i18n::t(lang, "menu.view.title"))
        .item(&font_increase_item)
        .item(&font_decrease_item)
        .item(&font_reset_item)
        .separator()
        .fullscreen()
        .build()?;

    // ---- Window submenu ----
    let window_submenu = SubmenuBuilder::new(app, i18n::t(lang, "menu.window.title"))
        .minimize()
        .build()?;

    MenuBuilder::new(app)
        .items(&[
            &app_submenu,
            &file_submenu,
            &edit_submenu,
            &view_submenu,
            &window_submenu,
        ])
        .build()
}

/// 启动期一次性注册菜单事件路由（emit 给前端）。
///
/// 重要：本函数只调用一次（在 `lib.rs::setup()` 里）。Tauri 的 `on_menu_event`
/// 处理器是 per-app 单一回调，重复调用会**叠加多份**（同一 click 触发 N 次 emit）。
/// `build_menu` 重建菜单时 item id 不变，event handler 复用旧的注册，**不要**
/// 在 `menu_rebuild` IPC 里再次调用本函数。
///
/// id 与事件的对照见模块文档表格。
pub fn install_menu_event_handler<R: Runtime>(app: &AppHandle<R>) {
    app.on_menu_event(|app_handle, event| emit_to_main(app_handle, event.id().as_ref()));
}

/// 把菜单事件送给**主 webview**。
///
/// **必须用 `emit_to(EventTarget::webview("main"))`，不能用裸 `emit`**：浏览器面板
/// 一打开就存在子 webview，此时裸 `emit` 送不到主 webview——菜单里的字号缩放、
/// 「关于」、关标签页于是全部静默失效（实测：按 Cmd+- 完全没反应，
/// 前端探针证明事件根本没到）。
///
/// 同一个坑 v1.1.0 R1 已经踩过一次（`window:focus-changed` 当时也是多 webview 下
/// 不触发，被迫改成 emit_to），这里是同一类问题的第二次出现。
fn emit_to_main<R: Runtime>(app_handle: &AppHandle<R>, id: &str) {
    let event = match id {
        "open-about" => "menu:open-about",
        "quit-confirm" => "app:confirm-quit-requested",
        "close-tab" => "app:close-active-tab",
        "font-increase" | "font-decrease" | "font-reset" => "menu:font-action",
        _ => return,
    };
    let target = tauri::EventTarget::webview("main");
    let _ = match id {
        "font-increase" => app_handle.emit_to(target, event, "increase"),
        "font-decrease" => app_handle.emit_to(target, event, "decrease"),
        "font-reset" => app_handle.emit_to(target, event, "reset"),
        _ => app_handle.emit_to(target, event, ()),
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    // build_menu 真正需要 AppHandle<R> 才能跑（依赖 Tauri runtime context），
    // 单元测试拿不到 AppHandle 也不能 mock —— 这是 Tauri 2 menu API 的限制。
    // 这里只测能间接覆盖的部分：i18n key 完整性（保证三语 build 文案都拿得到）。
    //
    // 真机 smoke（T6）覆盖：启动 en/zh-CN/ja 看菜单文案正确 + 切语言重建菜单文案变。

    #[test]
    fn 三语都能拿到_build_menu_用的全部_key() {
        // build_menu 用到的 i18n key 列表
        let keys = [
            "menu.app.title",
            "menu.app.about",
            "menu.app.quit",
            "menu.file.title",
            "menu.file.closeTab",
            "menu.edit.title",
            "menu.view.title",
            "menu.view.fontIncrease",
            "menu.view.fontDecrease",
            "menu.view.fontReset",
            "menu.window.title",
        ];
        for lang in ["en", "zh-CN", "ja"] {
            for key in keys {
                let v = i18n::t(lang, key);
                assert_ne!(
                    v, key,
                    "lang={lang} key={key} 漏译（返回了 raw key）"
                );
                assert!(!v.is_empty(), "lang={lang} key={key} 为空字符串");
            }
        }
    }
}
