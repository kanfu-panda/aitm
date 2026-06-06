//! safety IPC 命令集成测试。
//!
//! 直接调 `validate_pattern_impl` / `test_match_impl`（而非 `#[tauri::command]`
//! 包装的 async 版本），避免起 Tauri AppHandle。命令体在 ipc/safety.rs 已
//! 抽成普通 fn，wrapper 只做转发，所以 impl 行为 = 命令行为。
//!
//! 覆盖：
//! - validate_pattern：合法 / 非法（括号未闭合）/ 空字符串实际行为
//! - test_match：命中 / 不命中 / 元字符防注入 / 空 patterns / 坏 pattern 容错

use aitm_lib::ipc::safety::{test_match_impl, validate_pattern_impl};

// ===== validate_pattern =====

#[test]
fn validate_pattern_合法() {
    assert!(validate_pattern_impl("git status *").is_ok());
}

#[test]
fn validate_pattern_合法_其他形态() {
    assert!(validate_pattern_impl("ls").is_ok());
    assert!(validate_pattern_impl("**/*.rs").is_ok());
    assert!(validate_pattern_impl("pnpm test").is_ok());
}

#[test]
fn validate_pattern_非法_中括号未闭合() {
    let r = validate_pattern_impl("[invalid");
    assert!(r.is_err(), "未闭合括号应报错");
    let msg = r.unwrap_err();
    assert!(!msg.is_empty(), "Err 应携带人类可读的错误信息");
}

#[test]
fn validate_pattern_空字符串() {
    // 实测 globset 对空 glob 接受为合法（构建一个匹配空串的 glob）。
    // 这里只断言"实际行为"——前端如果想拒绝空串可以在 UI 层加判断。
    let r = validate_pattern_impl("");
    assert!(
        r.is_ok(),
        "globset 对空 pattern 视为合法，实际行为应是 Ok：{:?}",
        r
    );
}

// ===== test_match =====

#[test]
fn test_match_命中() {
    let patterns = vec!["git status *".to_string(), "ls *".to_string()];
    let r = test_match_impl("git status -sb", &patterns);
    assert_eq!(r, Some("git status *".to_string()));
}

#[test]
fn test_match_不命中() {
    let patterns = vec!["git *".to_string()];
    let r = test_match_impl("npm install", &patterns);
    assert_eq!(r, None);
}

#[test]
fn test_match_元字符_cmd_不命中() {
    // 关键安全点：cmd 含 `;` 即使 glob 字面匹配也不算命中（防注入式绕过）。
    let patterns = vec!["ls *".to_string()];
    let r = test_match_impl("ls; rm -rf .", &patterns);
    assert_eq!(r, None, "含分号的 cmd 不应命中白名单");
}

#[test]
fn test_match_空_patterns_返回_none() {
    let patterns: Vec<String> = vec![];
    let r = test_match_impl("ls -la", &patterns);
    assert_eq!(r, None);
}

#[test]
fn test_match_坏_pattern_容错() {
    // 坏 pattern 静默跳过，不影响其他好的 pattern 匹配。
    let patterns = vec!["[invalid".to_string(), "ls *".to_string()];
    let r = test_match_impl("ls -la", &patterns);
    assert_eq!(
        r,
        Some("ls *".to_string()),
        "坏 pattern 应被跳过，好 pattern 仍能命中"
    );
}
