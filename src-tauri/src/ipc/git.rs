//! Git 状态相关 IPC（v0.9.1 HR3-6）。
//!
//! 目前只有一个能力：[`git_status`] —— 给指定 `cwd` 的 git 工作区算出
//! 每个文件的状态（modified / added / deleted / untracked / renamed / conflict）。
//!
//! 前端 FileTree 5s 轮询调本 IPC → 把返回的绝对路径 → status 映射存到
//! `git-status` zustand store；FileTreeRow 根据每个文件路径查 store 染色
//! （VS Code 风格：modified 琥珀、added 翠绿、untracked 灰斜体等）。
//!
//! ## 失败语义（fail-soft）
//!
//! - `cwd` 根本不在 git 仓库里：不报错，返 `Ok(vec![])`。前端 UI 视为"无 git 状态"
//!   全 zinc 灰，毫无副作用。
//! - `cwd` 路径无效 / 拿不到 statuses：返 `Err(String)` —— 前端 catch 后只 console.warn，
//!   不弹 dialog（轮询每 5s 一次，弹窗会刷屏）。
//!
//! ## 性能
//!
//! - `Repository::open` 自身不会 walk 全树；只读 .git 元信息。
//! - `Repository::statuses(opts)` 在大 repo 上才是开销大头（O(working_tree)）；
//!   include_untracked 启用，但**不** include_unmodified（默认不包），干净文件
//!   不进结果集。
//! - aitm 主体的 git_status 调用频率：前端每 5s 一次；典型项目（aitm 自身 ~500
//!   tracked file）单次 < 5ms，5s 占 0.1% CPU 可忽略。
//! - 超大 repo（chromium / linux kernel 量级）需要节流，留到 v1.0 优化（plan §HR3-6 风险）。

use serde::Serialize;

/// 单文件 Git 状态。映射到 git2::Status 的"用户关心位"（plan §HR3-6）：
///
/// | 状态 | git2::Status 来源 |
/// |---|---|
/// | Conflict | `CONFLICTED` |
/// | Renamed | `INDEX_RENAMED` / `WT_RENAMED` |
/// | Deleted | `INDEX_DELETED` / `WT_DELETED` |
/// | Added | `INDEX_NEW`（已 stage 的新文件） |
/// | Modified | `INDEX_MODIFIED` / `WT_MODIFIED` / `INDEX_TYPECHANGE` / `WT_TYPECHANGE` |
/// | Untracked | `WT_NEW`（未 stage 新文件） |
/// | Ignored | `IGNORED`（v0.10.2：被 .gitignore 命中的文件） |
///
/// 优先级（同 entry 命中多位时）：Conflict > Renamed > Deleted > Added >
/// Modified > Untracked > Ignored（最弱）。
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GitStatus {
    Modified,
    Added,
    Deleted,
    Untracked,
    Renamed,
    Conflict,
    Ignored,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct GitFileStatus {
    /// 文件**绝对路径**（已 join `repo.workdir() + entry.path()`）。
    /// 前端 FileTree 的 node.path 也是绝对路径，直接相等比对即可。
    pub path: String,
    pub status: GitStatus,
}

/// IPC：返回 `cwd` 所在 git 仓库的脏文件状态列表。
///
/// 不在 git 仓库（discover 失败）→ `Ok(vec![])` 不报错。
///
/// **v0.9.1 HR4-7 path 一致性修**：
/// 前端 FileTree 的 node.path 来自 [`crate::ipc::fs::fs_tree`]，其 root 经
/// [`std::fs::canonicalize`] 解过 symlink（物理路径形式）；这里 git2 的
/// `repo.workdir()` 直接基于 user 传入的 cwd 字符串，**不会 resolve 路径上
/// 的 symlink**。差异最典型出现在 macOS：
/// - `/tmp` vs `/private/tmp`
/// - `/var/folders/...` vs `/private/var/folders/...`
/// - sysinfo 给 shell PID 返物理路径而 user 终端 `pwd` 是 logical 路径
///
/// 任一不一致都让 `byPath[node.path]` 精确等值查不到 → FileTree 文件名不染色。
/// 修法：拿到 workdir 后**也 canonicalize 一次**，对每条 entry path join 时
/// 用 canonical workdir，输出路径形式和 fs_tree 完全一致。canonicalize 失败
/// （极少：repo 路径不可读 / 权限）→ 退回原 workdir，至少不 panic。
#[tauri::command]
pub fn git_status(cwd: String) -> Result<Vec<GitFileStatus>, String> {
    // Repository::discover 自动往上找 .git，比 open 更宽容
    // —— 用户 cwd 可能是 subdir。
    let repo = match git2::Repository::discover(&cwd) {
        Ok(r) => r,
        Err(_) => return Ok(Vec::new()),
    };

    // bare repo（没 working tree）无法谈"文件状态"。直接返空。
    let workdir = match repo.workdir() {
        Some(w) => w.to_path_buf(),
        None => return Ok(Vec::new()),
    };

    // HR4-7：统一物理路径形式（resolve symlink）。失败时退回原值（fail-soft）。
    // canonicalize 是一次性的，不影响每文件循环性能。
    let workdir = std::fs::canonicalize(&workdir).unwrap_or(workdir);

    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true)
        // 显示 untracked dir 里的每个文件，否则只看到目录被标 untracked
        // 单个文件名（更贴合 FileTree 按文件路径染色的需求）。
        .recurse_untracked_dirs(true)
        // v0.10.2 维护者 反馈：被 .gitignore 的文件也要标出来。
        // include_ignored=true + recurse_ignored_dirs=false：
        //   只列 .gitignore 命中的**顶层**目录 / 文件名，不递归进去（典型场景
        //   像 node_modules/ 整个 dir 标 ignored 而非展开 N 千个文件，避免
        //   git2 性能炸 + 前端 store 占内存）。
        //   后端 fs_tree 自身也跳过 node_modules / target / dist 等大目录，
        //   所以前端 FileTree 看到的 ignored 主要是 .env / .DS_Store / build
        //   等小路径，对染色性能无压力。
        .include_ignored(true)
        .recurse_ignored_dirs(false);

    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| format!("读 git status 失败：{e}"))?;

    let mut out = Vec::with_capacity(statuses.len());
    for entry in statuses.iter() {
        let Some(rel_path) = entry.path() else {
            continue;
        };
        let status = map_status(entry.status());
        let abs_path = workdir.join(rel_path);
        out.push(GitFileStatus {
            path: abs_path.to_string_lossy().into_owned(),
            status,
        });
    }
    Ok(out)
}

/// 把 git2 的位标志按优先级映射成 [`GitStatus`]。
///
/// 优先级从高到低：Conflict > Renamed > Deleted > Added > Modified > Untracked > Ignored。
/// Ignored 最弱（被 .gitignore 命中），其它都比它"更需要用户注意"。
fn map_status(s: git2::Status) -> GitStatus {
    use git2::Status as S;
    if s.contains(S::CONFLICTED) {
        return GitStatus::Conflict;
    }
    if s.intersects(S::INDEX_RENAMED | S::WT_RENAMED) {
        return GitStatus::Renamed;
    }
    if s.intersects(S::INDEX_DELETED | S::WT_DELETED) {
        return GitStatus::Deleted;
    }
    if s.contains(S::INDEX_NEW) {
        return GitStatus::Added;
    }
    if s.intersects(
        S::INDEX_MODIFIED
            | S::WT_MODIFIED
            | S::INDEX_TYPECHANGE
            | S::WT_TYPECHANGE,
    ) {
        return GitStatus::Modified;
    }
    if s.contains(S::IGNORED) {
        return GitStatus::Ignored;
    }
    // 剩下的（最常见 WT_NEW）当 untracked
    GitStatus::Untracked
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;
    use tempfile::TempDir;

    /// 在临时目录初始化一个最小 git 仓库 + 一次 commit。
    /// 用真实的 `git` CLI（仓库已用 git2 / git 多处依赖，CI 也有），避免手撸
    /// signature / commit object 的 boilerplate。
    fn init_repo() -> TempDir {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        let run = |args: &[&str]| {
            let out = Command::new("git")
                .args(args)
                .current_dir(root)
                .output()
                .expect("git 调用失败");
            assert!(
                out.status.success(),
                "git {args:?} 失败：stderr={}",
                String::from_utf8_lossy(&out.stderr)
            );
        };

        run(&["init", "-q", "-b", "main"]);
        run(&["config", "user.email", "test@aitm.local"]);
        run(&["config", "user.name", "aitm-test"]);
        run(&["config", "commit.gpgsign", "false"]);

        fs::write(root.join("tracked.txt"), "hello\n").unwrap();
        fs::write(root.join("to_delete.txt"), "bye\n").unwrap();
        fs::create_dir(root.join("sub")).unwrap();
        fs::write(root.join("sub/x.txt"), "x\n").unwrap();

        run(&["add", "."]);
        run(&["commit", "-q", "-m", "init"]);

        tmp
    }

    #[test]
    fn 不在_git_repo_返空_vec() {
        let tmp = TempDir::new().unwrap();
        let out = git_status(tmp.path().to_string_lossy().into_owned()).unwrap();
        assert!(out.is_empty(), "非 git 目录应返空，实际：{out:?}");
    }

    #[test]
    fn 干净_repo_返空_vec() {
        let tmp = init_repo();
        let out = git_status(tmp.path().to_string_lossy().into_owned()).unwrap();
        assert!(out.is_empty(), "刚 commit 完应返空，实际：{out:?}");
    }

    #[test]
    fn 改文件_modified() {
        let tmp = init_repo();
        fs::write(tmp.path().join("tracked.txt"), "hello changed\n").unwrap();
        let out = git_status(tmp.path().to_string_lossy().into_owned()).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].status, GitStatus::Modified);
        assert!(out[0].path.ends_with("tracked.txt"));
        // 绝对路径
        assert!(std::path::Path::new(&out[0].path).is_absolute());
    }

    #[test]
    fn 新增未跟踪_untracked() {
        let tmp = init_repo();
        fs::write(tmp.path().join("new.txt"), "new\n").unwrap();
        let out = git_status(tmp.path().to_string_lossy().into_owned()).unwrap();
        let new_entry = out.iter().find(|e| e.path.ends_with("new.txt")).unwrap();
        assert_eq!(new_entry.status, GitStatus::Untracked);
    }

    #[test]
    fn 新建并_stage_added() {
        let tmp = init_repo();
        fs::write(tmp.path().join("added.txt"), "added\n").unwrap();
        let st = Command::new("git")
            .args(["add", "added.txt"])
            .current_dir(tmp.path())
            .status()
            .unwrap();
        assert!(st.success());

        let out = git_status(tmp.path().to_string_lossy().into_owned()).unwrap();
        let added = out.iter().find(|e| e.path.ends_with("added.txt")).unwrap();
        assert_eq!(added.status, GitStatus::Added);
    }

    #[test]
    fn 删文件_deleted() {
        let tmp = init_repo();
        fs::remove_file(tmp.path().join("to_delete.txt")).unwrap();
        let out = git_status(tmp.path().to_string_lossy().into_owned()).unwrap();
        let del = out
            .iter()
            .find(|e| e.path.ends_with("to_delete.txt"))
            .unwrap();
        assert_eq!(del.status, GitStatus::Deleted);
    }

    #[test]
    fn 从_subdir_调也能_discover_repo() {
        let tmp = init_repo();
        fs::write(tmp.path().join("sub/x.txt"), "changed\n").unwrap();
        // 传 sub 目录而非 repo 根 —— Repository::discover 应往上找到 .git
        let sub = tmp.path().join("sub");
        let out = git_status(sub.to_string_lossy().into_owned()).unwrap();
        // 结果含修改的 sub/x.txt（路径相对 repo 根 = sub/x.txt）
        let found = out.iter().find(|e| e.path.ends_with("sub/x.txt")).unwrap();
        assert_eq!(found.status, GitStatus::Modified);
    }

    #[test]
    fn untracked_目录展开为单文件() {
        let tmp = init_repo();
        fs::create_dir(tmp.path().join("new_dir")).unwrap();
        fs::write(tmp.path().join("new_dir/a.txt"), "a\n").unwrap();
        fs::write(tmp.path().join("new_dir/b.txt"), "b\n").unwrap();
        let out = git_status(tmp.path().to_string_lossy().into_owned()).unwrap();
        // recurse_untracked_dirs=true → 应见 a.txt + b.txt 两条记录
        let a = out.iter().any(|e| e.path.ends_with("new_dir/a.txt"));
        let b = out.iter().any(|e| e.path.ends_with("new_dir/b.txt"));
        assert!(a && b, "应展开 untracked dir 内单文件，实际：{out:?}");
    }

    #[test]
    fn map_status_优先级_conflict_最高() {
        let s = git2::Status::CONFLICTED | git2::Status::WT_MODIFIED;
        assert_eq!(map_status(s), GitStatus::Conflict);
    }

    #[test]
    fn map_status_renamed_优先于_modified() {
        let s = git2::Status::INDEX_RENAMED | git2::Status::WT_MODIFIED;
        assert_eq!(map_status(s), GitStatus::Renamed);
    }

    #[test]
    fn map_status_deleted_优先于_added() {
        let s = git2::Status::WT_DELETED | git2::Status::INDEX_NEW;
        assert_eq!(map_status(s), GitStatus::Deleted);
    }

    #[test]
    fn map_status_wt_new_为_untracked() {
        assert_eq!(map_status(git2::Status::WT_NEW), GitStatus::Untracked);
    }

    #[test]
    fn map_status_index_modified_为_modified() {
        assert_eq!(
            map_status(git2::Status::INDEX_MODIFIED),
            GitStatus::Modified
        );
    }

    #[test]
    fn git_status_不存在路径_返空() {
        // discover 失败 → 视为不在 git 仓库 → 空 vec（fail-soft）
        let out = git_status("/nonexistent/path/aitm-git-test".to_string()).unwrap();
        assert!(out.is_empty());
    }

    /// HR4-7：返回路径必须与 [`std::fs::canonicalize`] 后的形式一致，
    /// 保证前端 FileTree（其 node.path 来自 canonicalized fs_tree）
    /// 用 `byPath[node.path]` 能精确等值命中。
    #[test]
    fn hr4_7_输出路径与_canonicalize_cwd_join_等值() {
        let tmp = init_repo();
        fs::write(tmp.path().join("tracked.txt"), "x\n").unwrap();
        let out = git_status(tmp.path().to_string_lossy().into_owned()).unwrap();
        assert_eq!(out.len(), 1);
        let canonical_cwd = std::fs::canonicalize(tmp.path()).unwrap();
        let expected = canonical_cwd
            .join("tracked.txt")
            .to_string_lossy()
            .into_owned();
        assert_eq!(out[0].path, expected, "git_status 输出应等于 canonical cwd join 文件名");
    }

    /// HR4-7 关键场景：cwd 路径包含 symlink（macOS 上 /tmp → /private/tmp，
    /// 或 /var → /private/var 这类典型 symlink）时，fs_tree 调 canonicalize
    /// 解出物理路径；git_status 必须给出同样的物理路径，否则前端 lookup miss。
    ///
    /// 用 tempdir 主动构造 symlink → 实 dir 形式，让 user 传入 logical 路径，
    /// 期望返回 physical 路径。
    #[cfg(unix)]
    #[test]
    fn hr4_7_symlink_cwd_路径返回物理形式() {
        use std::os::unix::fs::symlink;

        let tmp = init_repo();
        fs::write(tmp.path().join("tracked.txt"), "x\n").unwrap();

        // 在 tempdir 外建一个 logical symlink 指向 repo
        let link_root = TempDir::new().unwrap();
        let link = link_root.path().join("repo-link");
        symlink(tmp.path(), &link).unwrap();

        // 传 symlink 路径作为 cwd
        let out = git_status(link.to_string_lossy().into_owned()).unwrap();
        assert_eq!(out.len(), 1);

        // 期望：物理路径（resolve symlink 后），即 canonicalize(link) join file
        let physical_cwd = std::fs::canonicalize(&link).unwrap();
        let expected = physical_cwd
            .join("tracked.txt")
            .to_string_lossy()
            .into_owned();
        assert_eq!(
            out[0].path, expected,
            "HR4-7：传 symlink cwd 时，输出路径应是 canonical 物理形式，否则\
             和 fs_tree（自带 canonicalize）的 node.path 不匹配 → FileTree 不染色"
        );

        // 不应含 symlink 段
        assert!(
            !out[0].path.contains("repo-link"),
            "输出路径不应保留 symlink 段（应已解为物理路径），实际：{}",
            out[0].path
        );
    }

    #[test]
    fn v0_10_2_被_gitignore_命中_ignored() {
        let tmp = init_repo();
        // 写 .gitignore 排除 build/ + *.log
        fs::write(tmp.path().join(".gitignore"), "build/\n*.log\n").unwrap();
        // 提交 .gitignore 自身（否则 .gitignore 也是 untracked）
        let st = Command::new("git")
            .args(["add", ".gitignore"])
            .current_dir(tmp.path())
            .status()
            .unwrap();
        assert!(st.success());
        let st = Command::new("git")
            .args(["commit", "-q", "-m", "add gitignore"])
            .current_dir(tmp.path())
            .status()
            .unwrap();
        assert!(st.success());

        // 创建被 ignore 的文件 + 目录
        fs::write(tmp.path().join("debug.log"), "log\n").unwrap();
        fs::create_dir(tmp.path().join("build")).unwrap();
        fs::write(tmp.path().join("build/output.bin"), "bin\n").unwrap();
        // 也创建一个正常 untracked 文件做对照
        fs::write(tmp.path().join("normal.txt"), "n\n").unwrap();

        let out = git_status(tmp.path().to_string_lossy().into_owned()).unwrap();

        // debug.log 应该是 Ignored
        let log_entry = out
            .iter()
            .find(|e| e.path.ends_with("debug.log"))
            .expect("debug.log 应在结果里（include_ignored=true）");
        assert_eq!(log_entry.status, GitStatus::Ignored);

        // build/ 整个目录 ignored（recurse_ignored_dirs=false 时报 dir 路径）
        let build_entry = out
            .iter()
            .find(|e| e.path.ends_with("build/") || e.path.ends_with("build"))
            .expect("build 目录应在结果里");
        assert_eq!(build_entry.status, GitStatus::Ignored);
        // recurse_ignored_dirs=false → build/output.bin 不展开
        assert!(
            !out.iter().any(|e| e.path.ends_with("output.bin")),
            "recurse_ignored_dirs=false 时不该展开 ignored dir 内容"
        );

        // normal.txt 仍是 Untracked（ignored 不污染普通 untracked 判定）
        let normal_entry = out
            .iter()
            .find(|e| e.path.ends_with("normal.txt"))
            .unwrap();
        assert_eq!(normal_entry.status, GitStatus::Untracked);
    }

    /// HR4-7：subdir 调用时，输出路径仍应基于 canonical workdir，
    /// 不受 cwd 自身是否 canonical 影响。
    #[test]
    fn hr4_7_subdir_cwd_输出仍基于_canonical_workdir() {
        let tmp = init_repo();
        fs::write(tmp.path().join("sub/x.txt"), "changed\n").unwrap();
        let sub = tmp.path().join("sub");
        let out = git_status(sub.to_string_lossy().into_owned()).unwrap();
        let found = out.iter().find(|e| e.path.ends_with("sub/x.txt")).unwrap();

        // 期望 = canonicalize(repo_root) join "sub/x.txt"
        let canonical_root = std::fs::canonicalize(tmp.path()).unwrap();
        let expected = canonical_root
            .join("sub/x.txt")
            .to_string_lossy()
            .into_owned();
        assert_eq!(found.path, expected);
    }
}
