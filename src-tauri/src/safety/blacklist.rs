//! L1 黑名单：硬拦截 4 类危险命令。
//!
//! 命中 → 直接返回 ToolResult.is_error=true 告知 LLM；不进 L2-L4。

use once_cell::sync::Lazy;
use regex::Regex;

/// 检查命令是否命中黑名单。
///
/// 返回 `Some(label)` 表示命中（label 是触发原因的中文短语，给用户看）。
/// 返回 `None` 表示放行进下一层。
pub fn is_blacklisted(cmd: &str) -> Option<&'static str> {
    static PATTERNS: Lazy<Vec<(Regex, &'static str)>> = Lazy::new(|| {
        vec![
            // rm -rf /  (注意 rm -rf ./build 不应拦)
            (
                Regex::new(r"\brm\s+(-[rRfF]+\s+)+/(\s|$)").unwrap(),
                "rm -rf / 删根",
            ),
            // dd if=foo of=/dev/disk1
            (
                Regex::new(r"\bdd\s+.*\bof=/dev/").unwrap(),
                "dd 写设备文件",
            ),
            // mkfs.* / mkfs（不应误拦 mkdir）
            (Regex::new(r"\bmkfs(\.|\s)").unwrap(), "mkfs 格式化"),
            // fork bomb :(){:|:&};:  注意 shell 元字符要转义
            (
                Regex::new(r":\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;").unwrap(),
                "fork bomb",
            ),
        ]
    });

    for (re, label) in PATTERNS.iter() {
        if re.is_match(cmd) {
            return Some(label);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    // ===== 应该拦的（4 条 hit）=====

    #[test]
    fn rm_rf_root_拦() {
        assert_eq!(is_blacklisted("rm -rf /"), Some("rm -rf / 删根"));
        assert_eq!(is_blacklisted("rm -rf / "), Some("rm -rf / 删根"));
        assert_eq!(is_blacklisted("sudo rm -rf /"), Some("rm -rf / 删根"));
        assert_eq!(is_blacklisted("rm -fr /"), Some("rm -rf / 删根"));
    }

    #[test]
    fn dd_写_dev_拦() {
        assert!(is_blacklisted("dd if=/dev/zero of=/dev/disk1").is_some());
        assert!(is_blacklisted("dd if=foo.iso of=/dev/sda bs=1M").is_some());
    }

    #[test]
    fn mkfs_拦() {
        assert!(is_blacklisted("mkfs.ext4 /dev/sda1").is_some());
        assert!(is_blacklisted("sudo mkfs /dev/disk2").is_some());
    }

    #[test]
    fn fork_bomb_拦() {
        assert!(is_blacklisted(":(){ :|:& };:").is_some());
        assert!(is_blacklisted(":(){:|:&};:").is_some());
    }

    // ===== 不应该拦的 =====

    #[test]
    fn rm_rf_子目录_不拦() {
        assert!(is_blacklisted("rm -rf ./build").is_none());
        assert!(is_blacklisted("rm -rf node_modules").is_none());
        assert!(is_blacklisted("rm -rf /tmp/foo").is_none());
        assert!(is_blacklisted("rm -rf /home/user/junk").is_none());
    }

    #[test]
    fn dd_读_文件_不拦() {
        // dd 只读文件、不写 /dev 不拦
        assert!(is_blacklisted("dd if=foo of=bar").is_none());
        assert!(is_blacklisted("dd if=/dev/zero of=test.bin").is_none());
    }

    #[test]
    fn mkdir_不被_mkfs_误拦() {
        assert!(is_blacklisted("mkdir foo").is_none());
        assert!(is_blacklisted("mkdir -p deep/path").is_none());
    }

    #[test]
    fn 普通只读_不拦() {
        for cmd in &[
            "ls -la",
            "cat README.md",
            "git status",
            "lsof -i:3000",
            "ps aux",
            "grep error log.txt",
        ] {
            assert!(is_blacklisted(cmd).is_none(), "误拦了：{cmd}");
        }
    }
}
