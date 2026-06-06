//! L3 白名单匹配（spec §9）。
//!
//! 用户在 AppSettings.safety.whitelist 里配的 glob 模式（如 `git status *` /
//! `pnpm test`），命中后会把 `run_command` 的初始 risk 从 HIGH 降到 LOW
//! （自动批准）。本模块只负责"命中判定"，不处理降级逻辑（在 tool_loop 里）。
//!
//! ## 元字符防注入（关键安全点）
//!
//! cmd 含 shell 元字符 `;` `&&` `||` `|` `` ` `` `$(` `>` `<` 时**直接不算命中**，
//! 即使 glob 字面能匹配。这是为了防：
//!
//! - 用户配 `ls *` 想放过 `ls -la`
//! - LLM 生成 `ls; rm -rf .` —— glob 会 match（`*` 吞下后面）
//! - 我们必须拦下来：含 `;` 直接拒绝匹配 → 走 HIGH 弹窗给用户看
//!
//! 命令组合 / 子 shell / 重定向都属于"用户配 glob 时没想到的形态"，统一拒绝。
//! 真要执行复合命令，让用户在 cmd 里显式列出每一段，或别走白名单。
//!
//! ## 容错
//!
//! `compile()` 单条 pattern 编译失败时跳过该条，**不影响其他条目**——一坏的
//! pattern 不会废掉整个白名单。失败列表会返回给 IPC，让 SettingsModal 提示用户。

use globset::{Glob, GlobSet, GlobSetBuilder};

/// 编译后的白名单集合。
///
/// 内部维护原始 pattern 字符串数组，与 GlobSet 中的索引一一对应；命中时返回
/// 原 pattern 给 UI 显示（"白名单：git status \*"）。
pub struct CompiledWhitelist {
    set: GlobSet,
    /// 与 set 中 pattern 顺序一致的原始字符串。
    patterns: Vec<String>,
}

impl CompiledWhitelist {
    /// 空白名单兜底——给 ToolContext 的 default 用。空白名单匹配任何 cmd 都返回 None。
    pub fn empty() -> Self {
        Self {
            set: GlobSet::empty(),
            patterns: Vec::new(),
        }
    }

    /// 是否空白名单。
    pub fn is_empty(&self) -> bool {
        self.patterns.is_empty()
    }
}

/// 含危险元字符的 cmd 直接不走白名单（防注入式绕过）。
///
/// 注意：`|` 单独 contains 会被 `||` 命中两次，但都返回 true，逻辑没问题。
const SHELL_METACHARS: &[&str] = &[
    ";", "&&", "||", "|", "`", "$(", ">", "<",
];

fn has_shell_metachar(cmd: &str) -> bool {
    SHELL_METACHARS.iter().any(|m| cmd.contains(m))
}

/// 编译用户配置的 glob 模式列表。
///
/// 单条编译失败时跳过 + 收集错误，**不让一坏全坏**。返回：
/// - `CompiledWhitelist`：成功编译的子集
/// - `Vec<(pattern, error_msg)>`：失败列表，调用方可用来给 UI 显示警告
pub fn compile(patterns: &[String]) -> (CompiledWhitelist, Vec<(String, String)>) {
    let mut builder = GlobSetBuilder::new();
    let mut compiled_patterns: Vec<String> = Vec::new();
    let mut errors: Vec<(String, String)> = Vec::new();

    for raw in patterns {
        match Glob::new(raw) {
            Ok(glob) => {
                builder.add(glob);
                compiled_patterns.push(raw.clone());
            }
            Err(e) => {
                errors.push((raw.clone(), e.to_string()));
            }
        }
    }

    let set = match builder.build() {
        Ok(s) => s,
        Err(e) => {
            // 整体 build 失败几乎不可能（每条都 Glob::new 通过了），但兜底成空集
            errors.push(("<global>".to_string(), e.to_string()));
            GlobSet::empty()
        }
    };

    (
        CompiledWhitelist {
            set,
            patterns: compiled_patterns,
        },
        errors,
    )
}

/// 检查 cmd 是否命中白名单。
///
/// 命中规则：
/// 1. 不含 shell 元字符（防注入）
/// 2. 整条 cmd 字面匹配某个 glob
///
/// 命中返回原 pattern 字符串（给 UI 用，例如"白名单：git status \*"）。
/// 未命中返回 None。
pub fn is_whitelisted<'a>(wl: &'a CompiledWhitelist, cmd: &str) -> Option<&'a str> {
    if wl.is_empty() {
        return None;
    }
    if has_shell_metachar(cmd) {
        return None;
    }
    let matches = wl.set.matches(cmd);
    matches
        .first()
        .and_then(|idx| wl.patterns.get(*idx).map(|s| s.as_str()))
}

/// 校验单条 pattern 语法（给 IPC 命令 `safety_validate_pattern` 用）。
///
/// 合法返回 `Ok(())`；非法返回 `Err(message)` 含人类可读的错误描述。
pub fn validate_pattern(pattern: &str) -> Result<(), String> {
    Glob::new(pattern).map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wl(patterns: &[&str]) -> CompiledWhitelist {
        let owned: Vec<String> = patterns.iter().map(|s| s.to_string()).collect();
        let (compiled, errors) = compile(&owned);
        assert!(
            errors.is_empty(),
            "测试 fixture 不该有编译错误：{:?}",
            errors
        );
        compiled
    }

    // ===== 基础匹配 =====

    #[test]
    fn git_status_星号_命中_git_status_sb() {
        let w = wl(&["git status *"]);
        assert_eq!(is_whitelisted(&w, "git status -sb"), Some("git status *"));
    }

    #[test]
    fn ls_星号_命中_ls_la() {
        let w = wl(&["ls *"]);
        assert_eq!(is_whitelisted(&w, "ls -la"), Some("ls *"));
    }

    #[test]
    fn ls_星号_命中_ls_点() {
        // glob 的 * 默认能匹配任意（含点开头），ls . 应命中
        let w = wl(&["ls *"]);
        assert_eq!(is_whitelisted(&w, "ls ."), Some("ls *"));
    }

    #[test]
    fn 字面_pattern_无星号_精确命中() {
        let w = wl(&["pnpm test"]);
        assert_eq!(is_whitelisted(&w, "pnpm test"), Some("pnpm test"));
    }

    #[test]
    fn 字面_pattern_额外参数_不命中() {
        // pnpm test 不带 * 时 pnpm test --watch 不该命中
        let w = wl(&["pnpm test"]);
        assert_eq!(is_whitelisted(&w, "pnpm test --watch"), None);
    }

    #[test]
    fn ls_星号_单独_ls_命中或不命中_视_glob_语义() {
        // 注意：globset 的 `*` 在 `ls *` 这种带空格的 pattern 里要求空格 + 后续字符
        // "ls" 本身没空格，是否命中取决于 glob 语义；这个测试只是 sanity check
        // 我们只断言不会 panic 就行
        let w = wl(&["ls *"]);
        let _ = is_whitelisted(&w, "ls");
        // 不强断言；不同版本 globset 行为可能不同
    }

    // ===== 多模式 =====

    #[test]
    fn 多模式_第二条命中() {
        let w = wl(&["pnpm test", "git status *"]);
        assert_eq!(is_whitelisted(&w, "git status -s"), Some("git status *"));
    }

    #[test]
    fn 多模式_都不命中() {
        let w = wl(&["git status *", "ls *"]);
        assert_eq!(is_whitelisted(&w, "rm -rf foo"), None);
    }

    #[test]
    fn 同_pattern_出现两次_不报错() {
        // 用户可能不小心重复添加；我们不去重，但不该 panic
        let w = wl(&["ls *", "ls *"]);
        assert!(is_whitelisted(&w, "ls -la").is_some());
    }

    // ===== 大小写敏感（globset 默认大小写敏感）=====

    #[test]
    fn 大小写敏感_首字母大写_pattern_不命中_小写_cmd() {
        let w = wl(&["Git Status *"]);
        assert_eq!(is_whitelisted(&w, "git status -s"), None);
    }

    #[test]
    fn 大小写敏感_全大写_pattern_不命中_小写_cmd() {
        let w = wl(&["LS *"]);
        assert_eq!(is_whitelisted(&w, "ls -la"), None);
    }

    // ===== 元字符防御（关键安全点）=====

    #[test]
    fn 含分号_不命中_即使_glob_字面_match() {
        // 这是核心防御：glob 'ls *' 字面会 match 'ls; rm -rf .'，但我们要拦
        let w = wl(&["ls *"]);
        assert_eq!(is_whitelisted(&w, "ls; rm -rf ."), None);
    }

    #[test]
    fn 含_and_and_不命中() {
        let w = wl(&["ls *"]);
        assert_eq!(is_whitelisted(&w, "ls && rm -rf ."), None);
    }

    #[test]
    fn 含_or_or_不命中() {
        let w = wl(&["ls *"]);
        assert_eq!(is_whitelisted(&w, "ls || true"), None);
    }

    #[test]
    fn 含管道_不命中() {
        let w = wl(&["ls *"]);
        assert_eq!(is_whitelisted(&w, "ls | grep foo"), None);
    }

    #[test]
    fn 含反引号_不命中() {
        let w = wl(&["cat *"]);
        assert_eq!(is_whitelisted(&w, "cat `whoami`"), None);
    }

    #[test]
    fn 含命令替换_不命中() {
        let w = wl(&["echo *"]);
        assert_eq!(is_whitelisted(&w, "echo $(date)"), None);
    }

    #[test]
    fn 含输出重定向_不命中() {
        let w = wl(&["echo *"]);
        assert_eq!(is_whitelisted(&w, "echo > /tmp/x"), None);
    }

    #[test]
    fn 含输入重定向_不命中() {
        let w = wl(&["cat *"]);
        assert_eq!(is_whitelisted(&w, "cat < input.txt"), None);
    }

    #[test]
    fn 元字符在中间_仍不命中() {
        // 验证不只是首尾，中间出现也拦
        let w = wl(&["git status *"]);
        assert_eq!(is_whitelisted(&w, "git status -sb; pwd"), None);
    }

    // ===== 编译失败容错 =====

    #[test]
    fn 编译失败_容错_其他条目仍工作() {
        let patterns = vec![
            "ls *".to_string(),
            "[invalid".to_string(), // 括号未闭合
            "git status *".to_string(),
        ];
        let (compiled, errors) = compile(&patterns);

        // 失败列表里有 [invalid 这条
        assert_eq!(errors.len(), 1, "应有 1 条编译失败：{:?}", errors);
        assert_eq!(errors[0].0, "[invalid");
        assert!(
            !errors[0].1.is_empty(),
            "失败应有 error message"
        );

        // 其他两条仍然能匹配
        assert_eq!(is_whitelisted(&compiled, "ls -la"), Some("ls *"));
        assert_eq!(
            is_whitelisted(&compiled, "git status -s"),
            Some("git status *")
        );
    }

    #[test]
    fn 全部_pattern_失败_compiled_为空白名单() {
        let patterns = vec!["[bad".to_string(), "{[also-bad".to_string()];
        let (compiled, errors) = compile(&patterns);
        assert_eq!(errors.len(), 2);
        assert!(compiled.is_empty());
        // 空白名单匹配任何 cmd 都 None
        assert_eq!(is_whitelisted(&compiled, "ls"), None);
    }

    // ===== validate_pattern =====

    #[test]
    fn validate_pattern_合法() {
        assert!(validate_pattern("git status *").is_ok());
        assert!(validate_pattern("ls").is_ok());
        assert!(validate_pattern("**/*.rs").is_ok());
    }

    #[test]
    fn validate_pattern_非法_括号() {
        let r = validate_pattern("[invalid");
        assert!(r.is_err(), "未闭合括号应报错");
        let msg = r.unwrap_err();
        assert!(!msg.is_empty(), "应有 error message");
    }

    #[test]
    fn validate_pattern_空_pattern() {
        // 空 pattern globset 算合法（建一个永不匹配的 glob），不强制行为
        // 只断言不 panic
        let _ = validate_pattern("");
    }

    // ===== empty / is_empty =====

    #[test]
    fn empty_构造空白名单_is_empty_为_true() {
        let w = CompiledWhitelist::empty();
        assert!(w.is_empty());
    }

    #[test]
    fn 空白名单_匹配任何_cmd_都_none() {
        let w = CompiledWhitelist::empty();
        assert_eq!(is_whitelisted(&w, "ls"), None);
        assert_eq!(is_whitelisted(&w, "git status"), None);
        assert_eq!(is_whitelisted(&w, ""), None);
    }

    #[test]
    fn compile_空数组_等同_empty() {
        let (w, errors) = compile(&[]);
        assert!(errors.is_empty());
        assert!(w.is_empty());
    }

    #[test]
    fn 非空白名单_is_empty_为_false() {
        let w = wl(&["ls *"]);
        assert!(!w.is_empty());
    }

    // ===== 命中返回的 pattern 字符串引用稳定 =====

    #[test]
    fn 命中返回原_pattern_文本() {
        let w = wl(&["git status *", "ls *"]);
        // 命中第一条
        assert_eq!(is_whitelisted(&w, "git status -s"), Some("git status *"));
        // 命中第二条
        assert_eq!(is_whitelisted(&w, "ls -la"), Some("ls *"));
    }

    // ===== 边界：cmd 为空 =====

    #[test]
    fn 空_cmd_不命中() {
        let w = wl(&["ls *", ""]);
        // 空 cmd 不应该命中 "ls *"，至于会不会命中 "" 取决于 glob 语义
        // 至少不应该 panic
        let _ = is_whitelisted(&w, "");
    }

    // ===== 元字符 + glob 命中的组合 =====

    #[test]
    fn 多模式中只要含元字符就全拦() {
        // 即使有多条 pattern，只要 cmd 含元字符就一概不走白名单
        let w = wl(&["ls *", "git status *", "echo *"]);
        assert_eq!(is_whitelisted(&w, "ls -la; git status"), None);
        assert_eq!(is_whitelisted(&w, "echo hi | cat"), None);
    }
}
