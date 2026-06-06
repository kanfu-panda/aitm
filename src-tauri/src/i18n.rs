//! NSMenu i18n 查找表（v0.10.6 T1）。
//!
//! 三语 JSON（`src-tauri/locales/menu.{en,zh-CN,ja}.json`）通过 `include_str!`
//! 编译期嵌入二进制，启动时一次性 parse 进 `Lazy<HashMap>`。运行时 `t(lang, key)`
//! 查表，缺 key 走 fallback：当前语言 → en → key 字符串本身（绝不 panic）。
//!
//! 与前端 i18n（src/locales/*.json + i18next）刻意保持**两套独立资源**：
//! - 前端 JSON 含 UI 文案（settings 面板、对话框、按钮 ……）量大，塞进二进制会
//!   增加包体（v0.10.6 性能宪章 < 25MB）
//! - 后端只需 NSMenu 文案（< 1KB / 语言）
//!
//! Tauri 2 `MenuItemBuilder::with_id(..).text(text)` 要求 `Into<String>`，本模块
//! 返回 `&'static str`（HashMap 值是 String，但 once_cell Lazy 让生命周期 = 进程
//! 生命周期，调用方拿 leaked &str 即可）。
//!
//! 调用方典型用法：
//! ```ignore
//! let label = crate::i18n::t(lang, "menu.file.closeTab");
//! MenuItemBuilder::with_id("close-tab", label).accelerator("Cmd+W").build(app)?;
//! ```
//!
//! 新增 key 时三语 JSON 必须同步加；缺失会 fallback en，仍漏会显示 key 字符串
//! （UI 上能立刻看出来 → 提醒补译）。

use once_cell::sync::Lazy;
use std::collections::HashMap;

/// 三语菜单文案表：lang -> (key -> text)。
///
/// 启动期一次性 parse JSON；后续 `t()` 调用纯 HashMap lookup（O(1)）。
static MENU_I18N: Lazy<HashMap<&'static str, HashMap<String, String>>> = Lazy::new(|| {
    let mut m = HashMap::new();
    m.insert("en", parse_menu_json(include_str!("../locales/menu.en.json")));
    m.insert(
        "zh-CN",
        parse_menu_json(include_str!("../locales/menu.zh-CN.json")),
    );
    m.insert("ja", parse_menu_json(include_str!("../locales/menu.ja.json")));
    m
});

/// 解析单语 JSON 成 `HashMap<key, text>`。
///
/// 失败（JSON 格式错误 / 类型不对）直接 panic —— 资源是编译期嵌入的，
/// 启动即崩比运行时返回空表更早发现问题。
fn parse_menu_json(raw: &str) -> HashMap<String, String> {
    serde_json::from_str::<HashMap<String, String>>(raw)
        .expect("menu i18n JSON 解析失败（编译期嵌入资源损坏？）")
}

/// 查 `lang` 语言下 `key` 对应的菜单文案。
///
/// Fallback 链：
/// 1. 当前 `lang` 找到 → 返回
/// 2. en 找到 → 返回（保证至少有英文兜底）
/// 3. en 也缺 → 返回 `key` 字符串本身（UI 显示 raw key，便于发现漏译）
///
/// 返回 `&'static str`：Lazy 让 HashMap 生命周期 = 进程生命周期，String 内部
/// 缓冲区不会被释放；调用方安全持有 &str。
pub fn t(lang: &str, key: &str) -> &'static str {
    // 1. 当前语言
    if let Some(table) = MENU_I18N.get(lang) {
        if let Some(value) = table.get(key) {
            // Lazy + HashMap 让 String 生命周期 = 'static
            return leak_str(value.as_str());
        }
    }
    // 2. fallback to en
    if lang != "en" {
        if let Some(table) = MENU_I18N.get("en") {
            if let Some(value) = table.get(key) {
                return leak_str(value.as_str());
            }
        }
    }
    // 3. fallback to key 本身（找不到 key 的 raw 字符串也要返回 &'static str）
    leak_str_owned(key.to_string())
}

/// 把 HashMap 里的 String slice 强制提升成 `&'static str`。
///
/// 安全性：MENU_I18N 是 `Lazy<HashMap>`，进程生命周期内不会 drop；HashMap 的
/// String value 内部 heap buffer 也跟着活到进程结束。这里 transmute 生命周期
/// 在工程上等价于"Lazy 给的引用就是 'static"，符合 once_cell 设计预期。
fn leak_str(s: &str) -> &'static str {
    // SAFETY: MENU_I18N 是 once_cell::Lazy，初始化后永不 drop；s 指向的
    // String 内部 buffer 跟着 HashMap 活到进程结束，'static 转换安全。
    unsafe { std::mem::transmute::<&str, &'static str>(s) }
}

/// 把临时构造的 String leak 成 `&'static str`（最后兜底分支专用）。
///
/// 仅在 key 三层 fallback 都失败时调用一次（漏译场景）；正常路径不走这里，
/// 没有持续内存泄漏。
fn leak_str_owned(s: String) -> &'static str {
    Box::leak(s.into_boxed_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 查到当前语言_zh_cn() {
        assert_eq!(t("zh-CN", "menu.file.closeTab"), "关闭标签页");
    }

    #[test]
    fn 查到当前语言_ja() {
        assert_eq!(t("ja", "menu.file.closeTab"), "タブを閉じる");
    }

    #[test]
    fn 查到当前语言_en() {
        assert_eq!(t("en", "menu.file.closeTab"), "Close Tab");
    }

    #[test]
    fn 未知语言_fallback_to_en() {
        // "fr" 未注册 → fallback en
        assert_eq!(t("fr", "menu.file.closeTab"), "Close Tab");
    }

    #[test]
    fn 缺_key_fallback_to_key_字符串() {
        // 三语都没有这个 key → 返回 raw key
        let raw = "menu.nonexistent.key";
        assert_eq!(t("en", raw), raw);
        assert_eq!(t("zh-CN", raw), raw);
        assert_eq!(t("ja", raw), raw);
    }

    #[test]
    fn 三语_key_对齐_无漏译() {
        // 取 en 全部 key，要求 zh-CN / ja 都有对应；任一缺则说明漏译。
        let en = MENU_I18N.get("en").expect("en 必须存在");
        let zh = MENU_I18N.get("zh-CN").expect("zh-CN 必须存在");
        let ja = MENU_I18N.get("ja").expect("ja 必须存在");

        let mut missing_zh = Vec::new();
        let mut missing_ja = Vec::new();
        for key in en.keys() {
            if !zh.contains_key(key) {
                missing_zh.push(key.clone());
            }
            if !ja.contains_key(key) {
                missing_ja.push(key.clone());
            }
        }
        assert!(
            missing_zh.is_empty(),
            "zh-CN 缺以下 key：{missing_zh:?}"
        );
        assert!(missing_ja.is_empty(), "ja 缺以下 key：{missing_ja:?}");
    }

    #[test]
    fn 返回_static_str_可跨域使用() {
        // 编译期保证：t() 返回 &'static str 可塞进任意需要 'static 的接口
        // （例如 Tauri MenuItemBuilder）
        let s: &'static str = t("en", "menu.app.quit");
        assert_eq!(s, "Quit aitm");
    }
}
