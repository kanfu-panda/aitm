//! CLI 子命令入口。
//!
//! 目前仅 `aitm init [path] [--name NAME]`。设计要点：
//!
//! - **不启动 Tauri**：main.rs 在见到 `init` 子命令时走这条分支，避免冷启动。
//! - **手写 args 解析**：项目当前不依赖 clap，子命令不多，自己几十行就够。
//! - **复用 IPC impl**：尽量贴近 GUI 走的 `ipc::scope::project_init_impl` 逻辑，
//!   避免双份实现。已有 marker 时返回 idempotent 信息；首次则走完整 init。
//! - **可测**：核心逻辑放 [`run_init_with`]，写入 (stdout/stderr) 通过
//!   trait object 注入，单测断言文本而不 spawn 子进程。

use std::fmt::Write as _;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::scope::marker;
use crate::store::AitmDb;

/// CLI 退出码。
pub const EXIT_OK: i32 = 0;
pub const EXIT_USAGE: i32 = 2;
pub const EXIT_FAILURE: i32 = 1;

/// `aitm init` 解析后的参数。
#[derive(Debug, Clone, PartialEq, Eq)]
struct InitArgs {
    /// 目标路径（已展开但未 canonicalize）。
    path: PathBuf,
    /// 用户显式指定的项目名；`None` 表示用 path basename。
    name: Option<String>,
}

/// 解析 `aitm init` 后面的参数。
///
/// 接受形式：
/// - `init` （path = cwd, name = basename）
/// - `init <path>` （path 可以是 `.` / 相对 / 绝对）
/// - `init <path> --name X` 或 `init --name X <path>`
/// - `--name=X` 形式同样支持
///
/// 不支持 `-n` 短选项；只一个子命令不值得搞那么复杂。
fn parse_init_args(rest: &[String]) -> Result<InitArgs, String> {
    let mut path: Option<PathBuf> = None;
    let mut name: Option<String> = None;

    let mut i = 0;
    while i < rest.len() {
        let arg = &rest[i];
        if let Some(value) = arg.strip_prefix("--name=") {
            if name.is_some() {
                return Err("--name 只能指定一次".to_string());
            }
            if value.is_empty() {
                return Err("--name 值不能为空".to_string());
            }
            name = Some(value.to_string());
            i += 1;
        } else if arg == "--name" {
            let next = rest
                .get(i + 1)
                .ok_or_else(|| "--name 后缺少值".to_string())?;
            if next.is_empty() {
                return Err("--name 值不能为空".to_string());
            }
            name = Some(next.clone());
            i += 2;
        } else if arg == "--help" || arg == "-h" {
            return Err("__HELP__".to_string());
        } else if arg.starts_with("--") {
            return Err(format!("未知参数：{arg}"));
        } else {
            if path.is_some() {
                return Err(format!("多余的位置参数：{arg}"));
            }
            path = Some(PathBuf::from(arg));
            i += 1;
        }
    }

    let path = match path {
        Some(p) => p,
        None => std::env::current_dir().map_err(|e| format!("读取当前目录失败: {e}"))?,
    };

    Ok(InitArgs { path, name })
}

/// `aitm init` 入口，从 `args` 切片（不含 `aitm init` 本身）跑一次。
///
/// 返回退出码。所有输出写 [`Writers`]，便于单测断言。
pub fn run_init(rest: &[String]) -> i32 {
    let mut stdout = std::io::stdout().lock();
    let mut stderr = std::io::stderr().lock();
    run_init_with(rest, &mut stdout, &mut stderr)
}

/// 注入 IO 的核心实现，单测专用。
pub fn run_init_with<O: Write, E: Write>(
    rest: &[String],
    out: &mut O,
    err: &mut E,
) -> i32 {
    let args = match parse_init_args(rest) {
        Ok(a) => a,
        Err(msg) if msg == "__HELP__" => {
            print_init_help(out);
            return EXIT_OK;
        }
        Err(msg) => {
            let _ = writeln!(err, "用法错误: {msg}");
            print_init_help(err);
            return EXIT_USAGE;
        }
    };

    // 1. 检查 path 存在 + 是目录
    if !args.path.exists() {
        let _ = writeln!(err, "初始化失败: {} 不存在", args.path.display());
        return EXIT_FAILURE;
    }
    if !args.path.is_dir() {
        let _ = writeln!(err, "初始化失败: {} 不是目录", args.path.display());
        return EXIT_FAILURE;
    }

    // 2. canonicalize（与 ipc::scope::project_init_impl 一致）
    let abs = args
        .path
        .canonicalize()
        .unwrap_or_else(|_| args.path.clone());

    // 3. 默认 name = basename
    let name = match args.name.clone() {
        Some(n) => n,
        None => default_name_from_path(&abs).unwrap_or_else(|| "aitm".to_string()),
    };

    // 4. 已有 marker → idempotent
    match marker::read(&abs) {
        Ok(Some(existing)) => {
            let _ = writeln!(
                out,
                "{} 已是 aitm 项目（\"{}\"，UUID={}）",
                abs.display(),
                existing.name,
                existing.id.hyphenated()
            );
            return EXIT_OK;
        }
        Ok(None) => {} // fallthrough 走 init
        Err(e) => {
            // marker 文件存在但 JSON 损坏：直接报错让用户处理
            let _ = writeln!(err, "初始化失败: 解析既有 marker 失败: {e}");
            return EXIT_FAILURE;
        }
    }

    // 5. 走 init impl（构造一个独立 AitmDb 实例；CLI 是一次性进程）
    let db = AitmDb::new();
    let abs_str = abs.to_string_lossy().into_owned();
    match crate::ipc::scope::project_init_impl(&abs_str, &name, &db) {
        Ok(result) => {
            let _ = writeln!(
                out,
                "已在 {} 初始化项目\"{}\"，UUID={}",
                result.root_path, result.name, result.uuid,
            );
            EXIT_OK
        }
        Err(e) => {
            let _ = writeln!(err, "初始化失败: {e}");
            EXIT_FAILURE
        }
    }
}

/// 打印 `aitm init` 用法。
fn print_init_help<W: Write>(w: &mut W) {
    let mut s = String::new();
    let _ = writeln!(s, "用法: aitm init [path] [--name NAME]");
    let _ = writeln!(s);
    let _ = writeln!(s, "  在 path（默认当前目录）下创建 .aitm/project.json + .gitignore，");
    let _ = writeln!(s, "  并把项目注册到全局 db。已存在 marker 时幂等返回。");
    let _ = writeln!(s);
    let _ = writeln!(s, "选项:");
    let _ = writeln!(s, "  --name NAME    项目展示名（默认取 path 末段目录名）");
    let _ = writeln!(s, "  -h, --help     显示此帮助");
    let _ = w.write_all(s.as_bytes());
}

/// 取 path 的末段目录名作为默认项目名。
///
/// 处理两个边界：
/// - canonicalize 后是文件系统根（无 file_name）→ 返回 None，调用方兜底
/// - 末段不是合法 UTF-8 → 返回 None
fn default_name_from_path(path: &Path) -> Option<String> {
    path.file_name()
        .map(|os| os.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// AITM_HOME 是进程级 env，与 store / scope 各 mod 共用 lib 根的
    /// `ENV_LOCK` 串行，避免不同 mod 互相覆盖 env。
    fn with_home<F: FnOnce(&Path)>(f: F) {
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

    // ===== parse_init_args =====

    #[test]
    fn parse_无参数_用_cwd() {
        let r = parse_init_args(&[]).unwrap();
        // 当前工作目录（运行测试时存在）
        assert!(r.path.exists());
        assert_eq!(r.name, None);
    }

    #[test]
    fn parse_仅_path() {
        let r = parse_init_args(&["/tmp/foo".to_string()]).unwrap();
        assert_eq!(r.path, PathBuf::from("/tmp/foo"));
        assert_eq!(r.name, None);
    }

    #[test]
    fn parse_path_加_name_空格形式() {
        let r = parse_init_args(&[
            "/tmp/foo".to_string(),
            "--name".to_string(),
            "demo".to_string(),
        ])
        .unwrap();
        assert_eq!(r.path, PathBuf::from("/tmp/foo"));
        assert_eq!(r.name.as_deref(), Some("demo"));
    }

    #[test]
    fn parse_path_加_name_等号形式() {
        let r = parse_init_args(&["/tmp/foo".to_string(), "--name=demo".to_string()]).unwrap();
        assert_eq!(r.path, PathBuf::from("/tmp/foo"));
        assert_eq!(r.name.as_deref(), Some("demo"));
    }

    #[test]
    fn parse_name_在_path_前() {
        let r = parse_init_args(&[
            "--name".to_string(),
            "demo".to_string(),
            "/tmp/foo".to_string(),
        ])
        .unwrap();
        assert_eq!(r.path, PathBuf::from("/tmp/foo"));
        assert_eq!(r.name.as_deref(), Some("demo"));
    }

    #[test]
    fn parse_未知_flag_报错() {
        let e = parse_init_args(&["--bogus".to_string()]).unwrap_err();
        assert!(e.contains("未知参数"));
    }

    #[test]
    fn parse_多余位置参数_报错() {
        let e = parse_init_args(&["/a".to_string(), "/b".to_string()]).unwrap_err();
        assert!(e.contains("多余的位置参数"));
    }

    #[test]
    fn parse_name_缺值_报错() {
        let e = parse_init_args(&["--name".to_string()]).unwrap_err();
        assert!(e.contains("--name 后缺少值"));
    }

    #[test]
    fn parse_name_值为空_报错() {
        let e = parse_init_args(&["--name=".to_string()]).unwrap_err();
        assert!(e.contains("不能为空"));
    }

    #[test]
    fn parse_help() {
        let e = parse_init_args(&["--help".to_string()]).unwrap_err();
        assert_eq!(e, "__HELP__");
        let e = parse_init_args(&["-h".to_string()]).unwrap_err();
        assert_eq!(e, "__HELP__");
    }

    // ===== default_name_from_path =====

    #[test]
    fn default_name_常规目录() {
        assert_eq!(
            default_name_from_path(Path::new("/Users/leo/work/aitm")).as_deref(),
            Some("aitm"),
        );
    }

    #[test]
    fn default_name_根目录_返回_none() {
        assert_eq!(default_name_from_path(Path::new("/")), None);
    }

    // ===== run_init_with =====

    #[test]
    fn run_init_成功_首次_init_输出包含_uuid_和_path() {
        with_home(|aitm_home| {
            let proj = TempDir::new().unwrap();
            let mut out: Vec<u8> = Vec::new();
            let mut err: Vec<u8> = Vec::new();

            let code = run_init_with(
                &[proj.path().to_string_lossy().into_owned()],
                &mut out,
                &mut err,
            );
            assert_eq!(code, EXIT_OK, "stderr={}", String::from_utf8_lossy(&err));

            let stdout = String::from_utf8(out).unwrap();
            assert!(stdout.contains("已在"), "stdout=\n{stdout}");
            assert!(stdout.contains("UUID="), "stdout=\n{stdout}");

            // marker 真的落盘
            assert!(proj.path().join(".aitm").join("project.json").exists());
            assert!(proj.path().join(".aitm").join(".gitignore").exists());

            // 全局 db 注册了
            assert!(aitm_home.join("global.db").exists());
        });
    }

    #[test]
    fn run_init_默认_name_用_basename() {
        with_home(|_| {
            let parent = TempDir::new().unwrap();
            let proj = parent.path().join("my-cool-project");
            std::fs::create_dir(&proj).unwrap();

            let mut out: Vec<u8> = Vec::new();
            let mut err: Vec<u8> = Vec::new();
            let code = run_init_with(
                &[proj.to_string_lossy().into_owned()],
                &mut out,
                &mut err,
            );
            assert_eq!(code, EXIT_OK);

            let m = marker::read(&proj).unwrap().unwrap();
            assert_eq!(m.name, "my-cool-project");
        });
    }

    #[test]
    fn run_init_显式_name_覆盖_basename() {
        with_home(|_| {
            let proj = TempDir::new().unwrap();
            let mut out: Vec<u8> = Vec::new();
            let mut err: Vec<u8> = Vec::new();
            let code = run_init_with(
                &[
                    proj.path().to_string_lossy().into_owned(),
                    "--name".to_string(),
                    "explicit-name".to_string(),
                ],
                &mut out,
                &mut err,
            );
            assert_eq!(code, EXIT_OK);

            let m = marker::read(proj.path()).unwrap().unwrap();
            assert_eq!(m.name, "explicit-name");
        });
    }

    #[test]
    fn run_init_已存在_marker_idempotent_零退出() {
        with_home(|_| {
            let proj = TempDir::new().unwrap();
            // 第一次
            let mut out1: Vec<u8> = Vec::new();
            let mut err1: Vec<u8> = Vec::new();
            let code1 = run_init_with(
                &[proj.path().to_string_lossy().into_owned()],
                &mut out1,
                &mut err1,
            );
            assert_eq!(code1, EXIT_OK);
            let first_uuid = marker::read(proj.path())
                .unwrap()
                .unwrap()
                .id
                .hyphenated()
                .to_string();

            // 第二次：应 idempotent
            let mut out2: Vec<u8> = Vec::new();
            let mut err2: Vec<u8> = Vec::new();
            let code2 = run_init_with(
                &[proj.path().to_string_lossy().into_owned()],
                &mut out2,
                &mut err2,
            );
            assert_eq!(code2, EXIT_OK);

            let stdout2 = String::from_utf8(out2).unwrap();
            assert!(stdout2.contains("已是 aitm 项目"), "stdout=\n{stdout2}");
            assert!(stdout2.contains(&first_uuid), "应原样回显既有 UUID");

            // marker 不应被覆盖（同一 UUID）
            let after_uuid = marker::read(proj.path())
                .unwrap()
                .unwrap()
                .id
                .hyphenated()
                .to_string();
            assert_eq!(after_uuid, first_uuid, "重复 init 不应改变 UUID");
        });
    }

    #[test]
    fn run_init_path_不存在_报错_退出_1() {
        with_home(|_| {
            let mut out: Vec<u8> = Vec::new();
            let mut err: Vec<u8> = Vec::new();
            let code = run_init_with(
                &["/__definitely_not_existing__/aitm-cli-test".to_string()],
                &mut out,
                &mut err,
            );
            assert_eq!(code, EXIT_FAILURE);
            let stderr = String::from_utf8(err).unwrap();
            assert!(stderr.contains("不存在"), "stderr=\n{stderr}");
        });
    }

    #[test]
    fn run_init_path_是文件_报错_退出_1() {
        with_home(|_| {
            let parent = TempDir::new().unwrap();
            let file_path = parent.path().join("a-file.txt");
            std::fs::write(&file_path, b"not a dir").unwrap();

            let mut out: Vec<u8> = Vec::new();
            let mut err: Vec<u8> = Vec::new();
            let code = run_init_with(
                &[file_path.to_string_lossy().into_owned()],
                &mut out,
                &mut err,
            );
            assert_eq!(code, EXIT_FAILURE);
            let stderr = String::from_utf8(err).unwrap();
            assert!(stderr.contains("不是目录"), "stderr=\n{stderr}");
        });
    }

    #[test]
    fn run_init_marker_损坏_报错_退出_1() {
        with_home(|_| {
            let proj = TempDir::new().unwrap();
            std::fs::create_dir_all(proj.path().join(".aitm")).unwrap();
            std::fs::write(
                proj.path().join(".aitm").join("project.json"),
                "{ broken json",
            )
            .unwrap();

            let mut out: Vec<u8> = Vec::new();
            let mut err: Vec<u8> = Vec::new();
            let code = run_init_with(
                &[proj.path().to_string_lossy().into_owned()],
                &mut out,
                &mut err,
            );
            assert_eq!(code, EXIT_FAILURE);
            let stderr = String::from_utf8(err).unwrap();
            assert!(stderr.contains("解析既有 marker 失败"), "stderr=\n{stderr}");
        });
    }

    #[test]
    fn run_init_未知_flag_退出_2_并打印_help() {
        with_home(|_| {
            let mut out: Vec<u8> = Vec::new();
            let mut err: Vec<u8> = Vec::new();
            let code = run_init_with(&["--bogus".to_string()], &mut out, &mut err);
            assert_eq!(code, EXIT_USAGE);
            let stderr = String::from_utf8(err).unwrap();
            assert!(stderr.contains("用法错误"));
            assert!(stderr.contains("用法: aitm init"));
        });
    }

    #[test]
    fn run_init_help_退出_0_打印用法() {
        with_home(|_| {
            let mut out: Vec<u8> = Vec::new();
            let mut err: Vec<u8> = Vec::new();
            let code = run_init_with(&["--help".to_string()], &mut out, &mut err);
            assert_eq!(code, EXIT_OK);
            let stdout = String::from_utf8(out).unwrap();
            assert!(stdout.contains("用法: aitm init"));
        });
    }
}
