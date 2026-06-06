//! API key 环境变量加载 + UI 掩码。

use std::collections::HashMap;
use std::path::PathBuf;

/// 解析 `.env` 文件返回 key→value map。**不写入** std::env。
///
/// 为什么不直接 `dotenvy::from_path`？因为 dotenvy 内部用 `std::env::set_var`，
/// Rust 1.85+ 把它标记为 unsafe（多线程下 UB），Tauri runtime 启动早期已经多
/// 线程，set_var 的写入可能 silently 不生效。所以我们改为返回 map，让调用方
/// 显式优先 std::env::var、回退到这个 map。
pub fn load_dotenv_map() -> HashMap<String, String> {
    let mut map = HashMap::new();
    if let Some(p) = env_path() {
        if let Ok(iter) = dotenvy::from_path_iter(&p) {
            for entry in iter.flatten() {
                map.insert(entry.0, entry.1);
            }
        }
    }
    map
}

/// 从 std::env::var 读，回退到 dotenv map；都没有或为空 → None。
pub fn lookup(map: &HashMap<String, String>, key: &str) -> Option<String> {
    if let Ok(v) = std::env::var(key) {
        if !v.is_empty() {
            return Some(v);
        }
    }
    map.get(key).cloned().filter(|s| !s.is_empty())
}

/// 兼容老调用：尝试用 dotenvy::from_path 注入系统 env（best-effort，
/// 在 Rust 1.85 多线程环境下不一定生效，新代码请用 [`load_dotenv_map`]）。
#[deprecated(note = "改用 load_dotenv_map + lookup")]
pub fn load_env_file() {
    if let Some(p) = env_path() {
        let _ = dotenvy::from_path(&p);
    }
}

/// `~/.aitm/.env`。
pub fn env_path() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    Some(home.join(".aitm").join(".env"))
}

/// 把 API key 显示为 `sk-***********abc1`（前后保留点字符 + 隐藏中间）。
///
/// 通用规则：保留前 3 位 + 后 4 位，中间用 `•` 填充（最少 8 个）。
pub fn mask_api_key(key: &str) -> String {
    let chars: Vec<char> = key.chars().collect();
    let n = chars.len();
    if n <= 7 {
        return "•".repeat(n.max(1));
    }
    let prefix: String = chars.iter().take(3).collect();
    let suffix: String = chars.iter().skip(n - 4).collect();
    let dots_count = std::cmp::max(8, n.saturating_sub(7));
    format!("{}{}{}", prefix, "•".repeat(dots_count), suffix)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mask_短_key_全打码() {
        assert_eq!(mask_api_key(""), "•");
        assert_eq!(mask_api_key("abc"), "•••");
        assert_eq!(mask_api_key("abcdefg"), "•••••••");
    }

    #[test]
    fn mask_长_key_保留头尾() {
        let masked = mask_api_key("sk-abcdefghijklmnopqrstuvwxyz1234");
        assert!(masked.starts_with("sk-"));
        assert!(masked.ends_with("1234"));
        assert!(masked.contains('•'));
    }

    #[test]
    fn mask_长度合理() {
        let masked = mask_api_key("sk-1234567890abcdef");
        // 19 字符长度的 key
        assert_eq!(masked.chars().take(3).collect::<String>(), "sk-");
        assert_eq!(masked.chars().rev().take(4).collect::<String>().chars().rev().collect::<String>(), "cdef");
    }
}
