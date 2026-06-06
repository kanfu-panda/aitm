//! scope IPC 命令集成测试。
//!
//! 直接调 `*_impl` 函数（而非 `#[tauri::command]` async wrapper），避免起
//! Tauri AppHandle / State 系统。命令 wrapper 只做 `spawn_blocking` 转发，
//! 行为等价于 impl。
//!
//! 用 `tempfile::TempDir` + 串行化的 `AITM_HOME` env 避免测试间互扰。

use std::fs;
use std::path::Path;
use std::sync::Mutex as StdMutex;

use tempfile::TempDir;

use aitm_lib::ipc::scope::{
    ScopeDto, mark_ignored_impl, project_init_impl, scope_resolve_impl,
};
use aitm_lib::scope::marker;
use aitm_lib::store::{AitmDb, repo_global};

// AITM_HOME 是进程级 env，多测试串行（独立 binary 自带 mutex）。
static HOME_LOCK: StdMutex<()> = StdMutex::new(());

fn with_home<F: FnOnce(&Path)>(f: F) {
    let _g = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
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

/// 把 cwd 路径 canonicalize 成字符串（与 impl 内部一致），方便对比期望值。
fn canon_str(p: &Path) -> String {
    p.canonicalize()
        .unwrap_or_else(|_| p.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

// ===== scope_resolve =====

#[test]
fn scope_resolve_无_marker_无_ignored_返回_needs_init() {
    with_home(|_aitm_home| {
        // cwd 在独立 TempDir（不在 aitm_home 下，避免被无意当成项目根）
        let cwd = TempDir::new().unwrap();
        let db = AitmDb::new();
        let cwd_str = cwd.path().to_string_lossy().into_owned();

        let scope = scope_resolve_impl(&cwd_str, &db).expect("解析应成功");
        match scope {
            ScopeDto::NeedsInit { cwd: c } => {
                assert_eq!(c, canon_str(cwd.path()));
            }
            other => panic!("期望 NeedsInit，实得 {other:?}"),
        }
    });
}

#[test]
fn scope_resolve_有_marker_返回_project() {
    with_home(|_| {
        let proj = TempDir::new().unwrap();
        // 先 init 一个项目
        let init = project_init_impl(
            &proj.path().to_string_lossy(),
            "demo",
            &AitmDb::new(),
        )
        .expect("init 应成功");

        // 再 resolve（用同一个 home env，不同 db 实例都 ok 因为读盘）
        let db2 = AitmDb::new();
        let scope = scope_resolve_impl(&proj.path().to_string_lossy(), &db2)
            .expect("resolve 应成功");
        match scope {
            ScopeDto::Project { uuid, root_path } => {
                assert_eq!(uuid, init.uuid, "resolve 出的 UUID 应等于 init 返回的");
                assert_eq!(root_path, canon_str(proj.path()));
            }
            other => panic!("期望 Project，实得 {other:?}"),
        }
    });
}

#[test]
fn scope_resolve_ignored_返回_global() {
    with_home(|_| {
        let cwd = TempDir::new().unwrap();
        let cwd_str = cwd.path().to_string_lossy().into_owned();
        let db = AitmDb::new();

        // 先 mark_ignored
        mark_ignored_impl(&cwd_str, &db).expect("mark_ignored 应成功");

        // resolve 同一 cwd 应返回 Global
        let scope = scope_resolve_impl(&cwd_str, &db).expect("resolve 应成功");
        assert_eq!(scope, ScopeDto::Global);
    });
}

// ===== project_init =====

#[test]
fn project_init_创建_marker_文件_和_注册到_global_projects() {
    with_home(|aitm_home| {
        let proj = TempDir::new().unwrap();
        let db = AitmDb::new();

        let result = project_init_impl(
            &proj.path().to_string_lossy(),
            "my-project",
            &db,
        )
        .expect("init 应成功");

        // 1. 返回值字段
        assert_eq!(result.name, "my-project");
        assert_eq!(result.root_path, canon_str(proj.path()));
        assert!(!result.uuid.is_empty(), "应生成非空 UUID");

        // 2. .aitm/project.json 文件存在 + 内容正确
        let marker_path = proj.path().join(".aitm").join("project.json");
        assert!(marker_path.exists(), "应写出 marker 文件");
        let m = marker::read(proj.path())
            .expect("读 marker 应成功")
            .expect("marker 应存在");
        assert_eq!(m.name, "my-project");
        assert_eq!(m.id.hyphenated().to_string(), result.uuid);

        // 3. .aitm/.gitignore 文件存在
        let gi = proj.path().join(".aitm").join(".gitignore");
        assert!(gi.exists(), "应写出 .gitignore");

        // 4. 全局 projects 表有这条记录
        let row = db
            .with_global(|conn| repo_global::projects::get_by_uuid(conn, &result.uuid))
            .expect("查全局 projects 应成功")
            .expect("应能查到注册的项目");
        assert_eq!(row.name, "my-project");
        assert_eq!(row.last_seen_path, canon_str(proj.path()));

        // 5. 项目 db 文件已懒创建
        let db_path = aitm_home
            .join("projects")
            .join(&result.uuid)
            .join("data.db");
        assert!(db_path.exists(), "项目 db 应被懒创建: {}", db_path.display());
    });
}

#[test]
fn project_init_然后_resolve_往返() {
    with_home(|_| {
        let proj = TempDir::new().unwrap();
        let cwd_str = proj.path().to_string_lossy().into_owned();
        let db = AitmDb::new();

        let init = project_init_impl(&cwd_str, "round-trip", &db).expect("init 应成功");
        let scope = scope_resolve_impl(&cwd_str, &db).expect("resolve 应成功");

        match scope {
            ScopeDto::Project { uuid, root_path } => {
                assert_eq!(uuid, init.uuid);
                assert_eq!(root_path, init.root_path);
            }
            other => panic!("期望 Project，实得 {other:?}"),
        }
    });
}

#[test]
fn project_init_子目录_resolve_仍能找到项目() {
    // spec §A6 场景：项目根在 /foo，cwd 在 /foo/sub/deep 也应识别同一项目
    with_home(|_| {
        let proj = TempDir::new().unwrap();
        let init = project_init_impl(
            &proj.path().to_string_lossy(),
            "deep-test",
            &AitmDb::new(),
        )
        .expect("init 应成功");

        let deep = proj.path().join("sub").join("deep");
        fs::create_dir_all(&deep).unwrap();

        let db2 = AitmDb::new();
        let scope = scope_resolve_impl(&deep.to_string_lossy(), &db2)
            .expect("resolve 应成功");
        match scope {
            ScopeDto::Project { uuid, .. } => {
                assert_eq!(uuid, init.uuid, "子目录 resolve 应找到根的 UUID");
            }
            other => panic!("期望 Project，实得 {other:?}"),
        }
    });
}

// ===== mark_ignored =====

#[test]
fn mark_ignored_后_is_ignored_命中() {
    with_home(|_| {
        let cwd = TempDir::new().unwrap();
        let cwd_str = cwd.path().to_string_lossy().into_owned();
        let db = AitmDb::new();

        // 加之前不在 ignored
        let before: bool = db
            .with_global(|conn| {
                repo_global::ignored_paths::is_ignored(conn, &canon_str(cwd.path()))
            })
            .unwrap();
        assert!(!before, "加之前不应命中");

        mark_ignored_impl(&cwd_str, &db).expect("mark_ignored 应成功");

        // 加之后命中（用 canonicalize 后的路径查，与 impl 内部一致）
        let after: bool = db
            .with_global(|conn| {
                repo_global::ignored_paths::is_ignored(conn, &canon_str(cwd.path()))
            })
            .unwrap();
        assert!(after, "加之后应命中");
    });
}

#[test]
fn mark_ignored_重复调用_幂等() {
    with_home(|_| {
        let cwd = TempDir::new().unwrap();
        let cwd_str = cwd.path().to_string_lossy().into_owned();
        let db = AitmDb::new();

        mark_ignored_impl(&cwd_str, &db).unwrap();
        mark_ignored_impl(&cwd_str, &db).unwrap();
        mark_ignored_impl(&cwd_str, &db).unwrap();

        let list: Vec<String> = db
            .with_global(repo_global::ignored_paths::list)
            .unwrap();
        // 只应有一条记录（INSERT OR IGNORE 去重）
        let canon = canon_str(cwd.path());
        let count = list.iter().filter(|p| **p == canon).count();
        assert_eq!(count, 1, "重复 mark_ignored 应幂等，实得 {count} 条");
    });
}
