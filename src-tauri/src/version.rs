//! aitm 版本工具。

/// 返回构建期烘焙的版本字符串。
pub fn current() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 版本与_cargo_pkg_version_一致() {
        assert_eq!(current(), env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn 版本符合_semver_格式() {
        let v = current();
        let parts: Vec<&str> = v.split('.').collect();
        assert_eq!(parts.len(), 3, "期望 MAJOR.MINOR.PATCH，实际 {v}");
        for part in parts {
            assert!(part.chars().all(|c| c.is_ascii_digit() || c == '-'),
                "semver 段含非数字：{part}");
        }
    }
}
