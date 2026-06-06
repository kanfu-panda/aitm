//! MEMORY.md 加载器。
//!
//! 两级 MEMORY.md（spec §7.6 / §7.7）：
//! - `~/.aitm/MEMORY.md`：全局个人偏好，所有 scope 都加载
//! - `<project_root>/.aitm/MEMORY.md`：项目记忆，仅 Project scope 加载
//!
//! 文件不存在静默跳过（最常见情况）；读取失败降级跳过 + warn log。
//!
//! **简化范围（plan §1.2 非目标）**：本阶段**不**解析 frontmatter
//! （spec §7.6 描述的 `---scope/updated---`）— 原文塞 system prompt。
//! frontmatter 等后续再加。
//!
//! **截断**：每段 4096 bytes 上限（约 1K tokens），超过截到 4KB +
//! 加省略标记，避免长 MEMORY 把 context 吃掉（plan §5 R7）。

use std::path::Path;

use crate::scope::Scope;
use crate::store::paths;

/// 单段 MEMORY 最大字节数（约 1K tokens 安全上限，plan §5 R7）。
pub const MEMORY_MAX_BYTES: usize = 4096;

/// 读全局 MEMORY.md（`~/.aitm/MEMORY.md`）。
///
/// 文件不存在 / 读取失败 → `None`。返回字符串已截断到
/// [`MEMORY_MAX_BYTES`]（按 UTF-8 char boundary 安全截断）。
pub fn load_global_memory() -> Option<String> {
    let home = match paths::aitm_home() {
        Ok(h) => h,
        Err(e) => {
            tracing::warn!("加载全局 MEMORY.md 失败：找不到 aitm_home：{e}");
            return None;
        }
    };
    let path = home.join("MEMORY.md");
    read_memory_file(&path)
}

/// 读项目 MEMORY.md（`<root>/.aitm/MEMORY.md`）。
///
/// 文件不存在 / 读取失败 → `None`。返回字符串已截断到
/// [`MEMORY_MAX_BYTES`]。
pub fn load_project_memory(project_root: &Path) -> Option<String> {
    let path = project_root.join(".aitm").join("MEMORY.md");
    read_memory_file(&path)
}

/// 把 base system prompt + 全局 MEMORY + 项目 MEMORY 拼成最终的 system prompt。
///
/// 拼装格式：
/// ```text
/// <base system prompt>
///
/// === 用户全局偏好（~/.aitm/MEMORY.md）===
/// <global memory 原文>
///
/// === 项目记忆（项目根/.aitm/MEMORY.md）===
/// <project memory 原文>
/// ```
///
/// 哪一段为 `None` 就跳过对应 section（不输出 === 标题）。
/// 都没有 → 直接返回 `base`。项目段仅在 [`Scope::Project`] 下加载。
pub fn compose_system_prompt(base: &str, scope: &Scope) -> String {
    let global = load_global_memory();
    let project = match scope {
        Scope::Project { root_path, .. } => load_project_memory(Path::new(root_path)),
        Scope::Global | Scope::NeedsInit { .. } => None,
    };

    let mut out = String::from(base);
    if let Some(g) = global {
        out.push_str("\n\n=== 用户全局偏好（~/.aitm/MEMORY.md）===\n");
        out.push_str(&g);
    }
    if let Some(p) = project {
        out.push_str("\n\n=== 项目记忆（项目根/.aitm/MEMORY.md）===\n");
        out.push_str(&p);
    }
    out
}

/// 内部：读单个 MEMORY.md 文件 + 截断。
///
/// 不存在 / 任何 IO 错误 → `None`（不区分；前者最常见，后者降级 warn）。
fn read_memory_file(path: &Path) -> Option<String> {
    match std::fs::read_to_string(path) {
        Ok(content) => Some(truncate_at_char_boundary(&content, MEMORY_MAX_BYTES)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => {
            tracing::warn!("读 MEMORY.md 失败 {}：{e}", path.display());
            None
        }
    }
}

/// 把字符串截到 `max_bytes` 边界（按 char boundary，避免切碎 UTF-8）；
/// 截断时末尾加 `\n[…已截断，原文 N 字节]\n` 标记。
///
/// 如果原文 ≤ max_bytes，原样返回（不加标记）。
fn truncate_at_char_boundary(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    // 从 max_bytes 向下找最大的 char boundary。`is_char_boundary(0)` 永远 true，
    // 所以循环必然终止。
    let mut cut = max_bytes;
    while cut > 0 && !s.is_char_boundary(cut) {
        cut -= 1;
    }
    let mut out = String::with_capacity(cut + 64);
    out.push_str(&s[..cut]);
    out.push_str(&format!("\n[…已截断，原文 {} 字节]\n", s.len()));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;
    use tempfile::TempDir;

    use crate::scope::Scope;

    fn with_home<F: FnOnce(&Path)>(f: F) {
        // 用 lib 根的共享 ENV_LOCK — 与 store/paths.rs / store/mod.rs / scope/mod.rs
        // 共用同一把锁，避免并行跑时互相覆盖 AITM_HOME env
        let _g = crate::test_env_lock::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let tmp = TempDir::new().unwrap();
        let prev = std::env::var("AITM_HOME").ok();
        // SAFETY: HOME_LOCK 串行
        unsafe {
            std::env::set_var("AITM_HOME", tmp.path());
        }
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(tmp.path())));
        unsafe {
            match prev {
                Some(v) => std::env::set_var("AITM_HOME", v),
                None => std::env::remove_var("AITM_HOME"),
            }
        }
        if let Err(e) = r {
            std::panic::resume_unwind(e);
        }
    }

    /// 在 `aitm_home` 下写全局 MEMORY.md。
    fn write_global(aitm_home: &Path, content: &str) {
        fs::create_dir_all(aitm_home).unwrap();
        fs::write(aitm_home.join("MEMORY.md"), content).unwrap();
    }

    /// 在 `root` 下写项目 MEMORY.md（自动创建 `.aitm/`）。
    fn write_project(root: &Path, content: &str) {
        fs::create_dir_all(root.join(".aitm")).unwrap();
        fs::write(root.join(".aitm").join("MEMORY.md"), content).unwrap();
    }

    #[test]
    fn load_global_memory_文件不存在_none() {
        with_home(|_| {
            assert_eq!(load_global_memory(), None);
        });
    }

    #[test]
    fn load_global_memory_文件存在_返回内容() {
        with_home(|home| {
            let body = "# 我的偏好\n- 用中文回复\n";
            write_global(home, body);
            let got = load_global_memory().expect("应读到");
            assert_eq!(got, body);
        });
    }

    #[test]
    fn load_global_memory_超长截断() {
        with_home(|home| {
            // 6KB ASCII，超过 4KB 上限
            let body = "x".repeat(6 * 1024);
            write_global(home, &body);
            let got = load_global_memory().expect("应读到");
            // 截断后总长 = MEMORY_MAX_BYTES（≈4096）+ 标记字节
            assert!(got.len() < body.len(), "截断后应短于原文");
            assert!(
                got.contains("已截断"),
                "应含截断标记，实得：{}",
                &got[got.len().saturating_sub(64)..]
            );
            // 标记里应带原文字节数
            assert!(got.contains("6144"), "标记应含原文字节数 6144");
        });
    }

    #[test]
    fn load_project_memory_文件不存在_none() {
        let tmp = TempDir::new().unwrap();
        assert_eq!(load_project_memory(tmp.path()), None);
    }

    #[test]
    fn load_project_memory_文件存在_返回内容() {
        let tmp = TempDir::new().unwrap();
        let body = "# 项目笔记\n- 这个项目用 Rust\n";
        write_project(tmp.path(), body);
        let got = load_project_memory(tmp.path()).expect("应读到");
        assert_eq!(got, body);
    }

    #[test]
    fn load_project_memory_独立于全局_文件() {
        // 全局有内容，项目无内容 → load_project_memory 仍 None
        with_home(|home| {
            write_global(home, "全局偏好");
            let proj = TempDir::new().unwrap();
            assert_eq!(load_project_memory(proj.path()), None);
        });
    }

    #[test]
    fn compose_system_prompt_无_memory_返回_base() {
        with_home(|_| {
            let proj = TempDir::new().unwrap();
            // Project scope 但没写任何 MEMORY
            let scope = Scope::Project {
                uuid: "u1".into(),
                root_path: proj.path().to_string_lossy().into_owned(),
            };
            let got = compose_system_prompt("BASE", &scope);
            assert_eq!(got, "BASE");
        });
    }

    #[test]
    fn compose_system_prompt_仅全局() {
        with_home(|home| {
            write_global(home, "全局偏好内容");
            // 用 NeedsInit scope（不会读项目段）
            let scope = Scope::NeedsInit {
                cwd: "/some/cwd".into(),
            };
            let got = compose_system_prompt("BASE", &scope);
            assert!(got.starts_with("BASE\n\n=== 用户全局偏好"));
            assert!(got.contains("全局偏好内容"));
            assert!(!got.contains("=== 项目记忆"), "NeedsInit 不应有项目段");
        });
    }

    #[test]
    fn compose_system_prompt_仅项目() {
        with_home(|_home| {
            // home 下没全局 MEMORY
            let proj = TempDir::new().unwrap();
            write_project(proj.path(), "项目笔记内容");
            let scope = Scope::Project {
                uuid: "u1".into(),
                root_path: proj.path().to_string_lossy().into_owned(),
            };
            let got = compose_system_prompt("BASE", &scope);
            assert!(got.starts_with("BASE"));
            assert!(!got.contains("=== 用户全局偏好"));
            assert!(got.contains("=== 项目记忆"));
            assert!(got.contains("项目笔记内容"));
        });
    }

    #[test]
    fn compose_system_prompt_全局加项目() {
        with_home(|home| {
            write_global(home, "全局 G");
            let proj = TempDir::new().unwrap();
            write_project(proj.path(), "项目 P");
            let scope = Scope::Project {
                uuid: "u1".into(),
                root_path: proj.path().to_string_lossy().into_owned(),
            };
            let got = compose_system_prompt("BASE", &scope);
            assert!(got.starts_with("BASE"));
            // 顺序：base → 全局 → 项目
            let g_pos = got.find("=== 用户全局偏好").expect("应有全局段");
            let p_pos = got.find("=== 项目记忆").expect("应有项目段");
            assert!(g_pos < p_pos, "全局段应在项目段之前");
            assert!(got.contains("全局 G"));
            assert!(got.contains("项目 P"));
        });
    }

    #[test]
    fn compose_system_prompt_needs_init_只用全局() {
        with_home(|home| {
            write_global(home, "全局 G");
            // NeedsInit 即使在带 .aitm/MEMORY.md 的目录下也不读
            let proj = TempDir::new().unwrap();
            write_project(proj.path(), "项目 P 不应被读");

            let scope = Scope::NeedsInit {
                cwd: proj.path().to_string_lossy().into_owned(),
            };
            let got = compose_system_prompt("BASE", &scope);
            assert!(got.contains("全局 G"));
            assert!(!got.contains("项目 P 不应被读"));
            assert!(!got.contains("=== 项目记忆"));
        });
    }

    #[test]
    fn compose_system_prompt_global_只用全局() {
        with_home(|home| {
            write_global(home, "全局 G");
            // Global scope：项目段也跳过（即使物理上有 .aitm/MEMORY.md）
            let proj = TempDir::new().unwrap();
            write_project(proj.path(), "项目 P 不应被读");

            let scope = Scope::Global;
            let got = compose_system_prompt("BASE", &scope);
            assert!(got.contains("全局 G"));
            assert!(!got.contains("项目 P 不应被读"));
            assert!(!got.contains("=== 项目记忆"));
        });
    }

    #[test]
    fn truncate_at_char_boundary_中文_不切碎() {
        // 一个中文字符（"中"）UTF-8 占 3 字节。构造 ~6KB 的中文串，
        // 截断到 4096 后必须落在字符边界，不能切到中间字节。
        let zh = "中".repeat(2000); // 2000 * 3 = 6000 字节
        let truncated = truncate_at_char_boundary(&zh, 4096);
        // 必须是合法 UTF-8（如果切碎会 panic 在 String 构造，但 .to_string()
        // 已经必然合法 — 这里通过 "再次访问 chars" 兜底确认没切碎）
        let _ = truncated.chars().count();
        // 截到的内容前缀必须是若干个完整 "中"
        // 4096 / 3 = 1365.33 → 1365 个 "中" = 4095 字节（4096 不是 boundary）
        // 实际向下找的 boundary 应是 4095（1365 chars）
        assert!(
            truncated.starts_with("中中中"),
            "前缀应是完整中文字符"
        );
        // 包含截断标记
        assert!(truncated.contains("已截断"));
        assert!(truncated.contains(&6000.to_string()));
    }

    #[test]
    fn truncate_at_char_boundary_短串_原样() {
        let s = "short";
        let got = truncate_at_char_boundary(s, 4096);
        assert_eq!(got, "short");
        assert!(!got.contains("已截断"));
    }
}
