//! safety 配置相关 IPC 命令。
//!
//! 给 SettingsModal 的白名单 section 用做实时校验 + 命中预览：
//! - `safety_validate_pattern`：输入框 blur 时调，非法 glob 返回带 message 的 Err
//! - `safety_test_match`：用户在 PatternTester 输入 cmd → 显示命中哪条 pattern
//!
//! 设计：把命令体抽成普通 fn（`validate_pattern_impl` / `test_match_impl`），
//! `#[tauri::command]` 异步包装器只做转发。集成测试直接调 impl 函数，不绕宏。

use crate::safety::whitelist;

/// 校验单条 glob 模式语法是否合法。
///
/// 合法返回 `Ok(())`；非法返回 `Err(message)` 含人类可读的错误描述。
pub fn validate_pattern_impl(pattern: &str) -> Result<(), String> {
    whitelist::validate_pattern(pattern)
}

/// 测试 cmd 是否会被给定 patterns 列表命中（自动批准预览）。
///
/// 命中返回 `Some(pattern)` —— 命中的具体那条；不命中返回 None。
/// 编译失败的 patterns 静默跳过（前端应单独用 `validate_pattern` 校验过）。
pub fn test_match_impl(cmd: &str, patterns: &[String]) -> Option<String> {
    let (wl, _failed) = whitelist::compile(patterns);
    whitelist::is_whitelisted(&wl, cmd).map(|s| s.to_string())
}

/// IPC 命令：校验单条 glob 模式语法。给前端输入框 blur 时调。
#[tauri::command]
pub async fn safety_validate_pattern(pattern: String) -> Result<(), String> {
    validate_pattern_impl(&pattern)
}

/// IPC 命令：测试 cmd 是否会被某组 patterns 命中。
#[tauri::command]
pub async fn safety_test_match(cmd: String, patterns: Vec<String>) -> Option<String> {
    test_match_impl(&cmd, &patterns)
}
