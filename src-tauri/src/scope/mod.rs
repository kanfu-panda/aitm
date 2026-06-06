//! 项目作用域解析。
//!
//! 调用方传入 cwd（当前活跃 PTY tab 的 shell cwd），返回 [`Scope`]：
//! - [`Scope::Project`]：找到 `.aitm/project.json`（项目模式）
//! - [`Scope::Global`]：找不到 marker 但 cwd 在 `ignored_paths`（用户已选"别再问"）
//! - [`Scope::NeedsInit`]：找不到 marker 也不在 ignored，需弹 init 对话框
//!
//! spec §7.4 + plan §2.6。

pub mod marker;
// T5 将实现 MEMORY.md 加载，T4 先占位。
pub mod memory;

use std::path::{Path, PathBuf};

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::store::AitmDb;
use marker::ProjectMarker;

/// 三种作用域。`#[serde(tag = "kind")]` 让前端拿到的 JSON 长这样：
/// `{"kind":"project","uuid":"...","root_path":"..."}` / `{"kind":"global"}` /
/// `{"kind":"needs_init","cwd":"..."}`，TS 端 discriminated union 友好。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Scope {
    /// 在已 init 的项目里。
    Project {
        /// 项目 UUID（hyphenated 字符串）。
        uuid: String,
        /// 项目根的绝对路径（已 canonicalize 解析过符号链接）。
        root_path: String,
    },
    /// 用户选过"临时全局"或"永久忽略"，对话走全局桶。
    Global,
    /// 既无 marker 也不在 ignored 名单，需要弹 init 对话框。
    /// `cwd` 是已 canonicalize 的 cwd 字符串，前端弹窗后回传到
    /// `project_init` / `mark_ignored` 命令时直接复用。
    NeedsInit { cwd: String },
}

impl Scope {
    /// 这个 scope 对应的 db bucket id（项目 db 的目录名）。
    ///
    /// `NeedsInit` 也返回 `_global_`：仅作为占位（实际 chat 在
    /// init 对话框决议前不会写盘，spec §7.2 懒创建）。
    pub fn bucket_id(&self) -> &str {
        match self {
            Scope::Project { uuid, .. } => uuid,
            Scope::Global => crate::store::paths::GLOBAL_BUCKET_ID,
            Scope::NeedsInit { .. } => crate::store::paths::GLOBAL_BUCKET_ID,
        }
    }
}

/// 解析 `cwd` → [`Scope`]。
///
/// 流程（spec §7.4 + plan §2.6）：
/// 1. cwd canonicalize（解析符号链接 + 相对路径；失败时退回原路径）
/// 2. 从 cwd 向上查找 `.aitm/project.json`，最多 64 层防符号链接死循环
///    - 找到合法 marker → [`Scope::Project`]
///    - marker 文件存在但损坏 → 视为没找到，继续向上（spec §A6 容错）
/// 3. 没找到 marker → 查 `ignored_paths`
///    - 命中 → [`Scope::Global`]
///    - 未命中 → [`Scope::NeedsInit`]
pub fn resolve_scope(cwd_in: &Path, db: &AitmDb) -> Result<Scope> {
    // 1. canonicalize：把 `..` / `~`（已展开） / 符号链接都规整化。失败
    //    时（比如 cwd 不存在）退回原路径，让上层走 NeedsInit 路径。
    let cwd = cwd_in
        .canonicalize()
        .unwrap_or_else(|_| cwd_in.to_path_buf());

    // 2. 向上找 marker
    if let Some((root, marker)) = find_marker_upward(&cwd) {
        return Ok(Scope::Project {
            uuid: marker.id.hyphenated().to_string(),
            root_path: root.to_string_lossy().into_owned(),
        });
    }

    // 3. 查 ignored
    let cwd_str = cwd.to_string_lossy().into_owned();
    let ignored = db.with_global(|conn| {
        crate::store::repo_global::ignored_paths::is_ignored(conn, &cwd_str)
    })?;
    if ignored {
        return Ok(Scope::Global);
    }

    // 4. 默认：需要 init
    Ok(Scope::NeedsInit { cwd: cwd_str })
}

/// 从 `cwd` 向上查找 `.aitm/project.json`，返回 `(root_path, marker)`。
///
/// - 最多迭代 64 层防符号链接死循环 / 极深路径意外
/// - marker 文件存在但 JSON 损坏 → 跳过（视为没找到），继续向上查
/// - 到达文件系统根（parent == self）仍未找到 → 返回 `None`
fn find_marker_upward(cwd: &Path) -> Option<(PathBuf, ProjectMarker)> {
    let mut current = cwd.to_path_buf();
    for _ in 0..64 {
        // marker::read 文件不存在返回 Ok(None)、JSON 损坏返回 Err。
        // 两种情况都视为"这一层没有合法 marker"，继续向上。
        if let Ok(Some(m)) = marker::read(&current) {
            return Some((current, m));
        }
        let parent = match current.parent() {
            Some(p) => p.to_path_buf(),
            None => return None,
        };
        if parent == current {
            // 到根了
            return None;
        }
        current = parent;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn with_home<F: FnOnce(&Path)>(f: F) {
        // 共享 lib 根的 ENV_LOCK 与 store / scope 其他测试串行
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

    /// 在 `root` 下写一个合法 marker，返回 marker.id 字符串。
    fn write_marker_at(root: &Path, name: &str) -> String {
        let m = marker::create_new(root, name);
        let id = m.id.hyphenated().to_string();
        marker::write(root, &m).unwrap();
        id
    }

    #[test]
    fn resolve_scope_找到_marker_返回_project() {
        with_home(|_aitm_home| {
            // 这里 cwd 是单独的 TempDir，不在 aitm_home 下
            let proj = TempDir::new().unwrap();
            let id = write_marker_at(proj.path(), "demo");

            let db = AitmDb::new();
            let scope = resolve_scope(proj.path(), &db).unwrap();

            match scope {
                Scope::Project { uuid, root_path } => {
                    assert_eq!(uuid, id);
                    // canonicalize 后路径应等于 proj canonicalize
                    let want = proj
                        .path()
                        .canonicalize()
                        .unwrap_or_else(|_| proj.path().to_path_buf())
                        .to_string_lossy()
                        .into_owned();
                    assert_eq!(root_path, want);
                }
                other => panic!("期望 Project，实得 {other:?}"),
            }
        });
    }

    #[test]
    fn resolve_scope_向上找到_marker() {
        with_home(|_| {
            let proj = TempDir::new().unwrap();
            let id = write_marker_at(proj.path(), "demo");

            // cwd 在 proj/sub/deep
            let deep = proj.path().join("sub").join("deep");
            fs::create_dir_all(&deep).unwrap();

            let db = AitmDb::new();
            let scope = resolve_scope(&deep, &db).unwrap();
            match scope {
                Scope::Project { uuid, root_path } => {
                    assert_eq!(uuid, id);
                    let want = proj
                        .path()
                        .canonicalize()
                        .unwrap_or_else(|_| proj.path().to_path_buf())
                        .to_string_lossy()
                        .into_owned();
                    assert_eq!(root_path, want);
                }
                other => panic!("期望 Project，实得 {other:?}"),
            }
        });
    }

    #[test]
    fn resolve_scope_无_marker_无_ignored_返回_needs_init() {
        with_home(|_| {
            let cwd = TempDir::new().unwrap();
            let db = AitmDb::new();
            let scope = resolve_scope(cwd.path(), &db).unwrap();
            match scope {
                Scope::NeedsInit { cwd: c } => {
                    let want = cwd
                        .path()
                        .canonicalize()
                        .unwrap_or_else(|_| cwd.path().to_path_buf())
                        .to_string_lossy()
                        .into_owned();
                    assert_eq!(c, want);
                }
                other => panic!("期望 NeedsInit，实得 {other:?}"),
            }
        });
    }

    #[test]
    fn resolve_scope_无_marker_有_ignored_返回_global() {
        with_home(|_| {
            let cwd = TempDir::new().unwrap();
            let canon = cwd
                .path()
                .canonicalize()
                .unwrap_or_else(|_| cwd.path().to_path_buf())
                .to_string_lossy()
                .into_owned();

            let db = AitmDb::new();
            db.with_global(|conn| {
                crate::store::repo_global::ignored_paths::add(conn, &canon)?;
                Ok(())
            })
            .unwrap();

            let scope = resolve_scope(cwd.path(), &db).unwrap();
            assert_eq!(scope, Scope::Global);
        });
    }

    #[test]
    fn resolve_scope_marker_损坏_继续向上() {
        with_home(|_| {
            // proj_outer 有合法 marker
            let outer = TempDir::new().unwrap();
            let outer_id = write_marker_at(outer.path(), "outer");

            // proj_outer/inner 有损坏 marker
            let inner = outer.path().join("inner");
            fs::create_dir_all(inner.join(".aitm")).unwrap();
            fs::write(
                inner.join(".aitm").join("project.json"),
                "{ this is not valid json",
            )
            .unwrap();

            let db = AitmDb::new();
            let scope = resolve_scope(&inner, &db).unwrap();
            match scope {
                Scope::Project { uuid, .. } => {
                    // 应继续向上找到 outer 的 marker
                    assert_eq!(uuid, outer_id);
                }
                other => panic!("期望继续向上找到 outer Project，实得 {other:?}"),
            }
        });
    }

    #[test]
    fn resolve_scope_顶层_marker_损坏_无_ignored_返回_needs_init() {
        with_home(|_| {
            // cwd 自己是损坏 marker，且向上也没有合法 marker（macOS /tmp/...
            // 上层不会有 .aitm，spec 容忍）
            let cwd = TempDir::new().unwrap();
            fs::create_dir_all(cwd.path().join(".aitm")).unwrap();
            fs::write(
                cwd.path().join(".aitm").join("project.json"),
                "{ broken json",
            )
            .unwrap();

            let db = AitmDb::new();
            let scope = resolve_scope(cwd.path(), &db).unwrap();
            // 由于 tmp 上层不会有 marker（极小概率不存在），期望 NeedsInit
            // 注：理论上若运行机器恰好 / 或 /tmp 上有 marker 测试会变 Project；
            // tempfile 使用的临时目录通常在 /var/folders/ 或 /tmp/，不会有 marker
            assert!(
                matches!(scope, Scope::NeedsInit { .. }),
                "期望 NeedsInit，实得 {scope:?}",
            );
        });
    }

    #[test]
    fn bucket_id_对应正确() {
        let p = Scope::Project {
            uuid: "u1".to_string(),
            root_path: "/x".to_string(),
        };
        assert_eq!(p.bucket_id(), "u1");

        let g = Scope::Global;
        assert_eq!(g.bucket_id(), crate::store::paths::GLOBAL_BUCKET_ID);

        let n = Scope::NeedsInit {
            cwd: "/y".to_string(),
        };
        assert_eq!(n.bucket_id(), crate::store::paths::GLOBAL_BUCKET_ID);
    }

    #[test]
    fn scope_序列化_前端_discriminated_union() {
        // serde tag = "kind" + snake_case：前端 TS 拿到的 JSON 形状
        let p = Scope::Project {
            uuid: "u1".into(),
            root_path: "/x".into(),
        };
        let j = serde_json::to_value(&p).unwrap();
        assert_eq!(j["kind"], "project");
        assert_eq!(j["uuid"], "u1");
        assert_eq!(j["root_path"], "/x");

        let g = Scope::Global;
        let j = serde_json::to_value(&g).unwrap();
        assert_eq!(j["kind"], "global");

        let n = Scope::NeedsInit {
            cwd: "/y".to_string(),
        };
        let j = serde_json::to_value(&n).unwrap();
        assert_eq!(j["kind"], "needs_init");
        assert_eq!(j["cwd"], "/y");
    }
}
