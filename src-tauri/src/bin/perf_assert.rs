//! perf_assert —— **Rust 侧**性能回归门。
//!
//! # 这个门测的不是什么（先说清楚，免得再被当成宪章达标证明）
//!
//! 设计规范 §6.1 的两条头号指标是「冷启动**到首屏**」和「5 个标签的**应用**内存」。
//! **本工具两条都测不到**，因为它整个跑在一个普通的 Rust 进程里，既没有窗口也没有
//! WebView：
//!
//! - 「冷启动」这里量的是 `aitm --version` —— 一条解析完参数就退出的 CLI 路径。
//!   它能抓住"有人在启动路径上加了重初始化 / 连数据库"，但**不代表首屏时间**。
//! - 「内存」这里量的是**本进程自己**开 5 个 PTY 后的占用，不含 WebView。
//!   实测应用的内存大头恰恰在 WebView 侧：1 标签时 Rust 主进程 34 MB，而
//!   `WebKit.WebContent` 67 MB、`WebKit.GPU` 18 MB；5 标签合计约 150 MB。
//!   也就是说**本门绿着，跟应用是否满足 §6.1 没有关系**。
//!
//! 历史教训：这两条以前分别被标成「冷启动 < 200ms」和「5 PTY 空闲 RSS < 80MB」，
//! 读起来就像宪章达标证明，而 80MB 这个数字既和规范里的 150MB 对不上、量的又是
//! 另一个进程。名字和阈值现在都按**实际测量对象**重写。
//!
//! # 这个门测的是什么
//!
//! 1. CLI 启动开销（`aitm --version` 10 次中位）—— 启动路径上的重活会被它抓住
//! 2. Rust 侧 5 个 PTY 的常驻内存 —— ring buffer / 每 session 结构体膨胀会被它抓住
//!
//! 想验 §6.1 的真实指标，得起完整应用并汇总 WebKit 子进程，见
//! `docs/maintainer/` 里的测量记录。
//!
//! # 用法
//!
//! ```text
//! perf_assert                # 两项都跑（CLI 启动那项需要 release 二进制）
//! perf_assert --only=memory  # 只跑内存，不需要 release 二进制
//! perf_assert --only=startup # 只跑 CLI 启动
//! ```
//!
//! 退出码 0 = 全部通过；1 = 任一项超标。

use std::process::Command;
use std::time::{Duration, Instant};

use aitm_lib::session::manager::SessionManager;
use aitm_lib::session::{default_shell, SessionConfig};

/// `aitm --version` 的耗时预算。**不是**「冷启动到首屏」——见模块文档。
const CLI_START_BUDGET_MS: u128 = 200;
/// Rust 侧 5 个 PTY 的常驻内存预算。**不含 WebView**——见模块文档。
///
/// **实测基线：2 MB**（macOS，phys_footprint 口径）。取 16 MB 留 8 倍余量——
/// 这个门是用来抓「量级跑偏」的（比如 ring buffer 被调大一个数量级、每个 session
/// 多挂一份缓存），不是卡几 MB 抖动。
///
/// 旧值是 80 MB，**是实测值的 40 倍，永远不可能触发**——加上它量的还是别的进程，
/// 这个门此前是双重无效的。
///
/// ⚠️ 非 macOS 回退 RSS 口径（数值天然偏高，见 [`current_process_memory`]），
/// 若要在 Linux / Windows 上启用，需按 RSS 重新校准本阈值。
const FIVE_PTY_MEM_BUDGET_MB: u64 = 16;
const RUNS: usize = 10;
const TABS: usize = 5;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let only = std::env::args()
        .find_map(|a| a.strip_prefix("--only=").map(str::to_string));
    let run_startup = only.as_deref().is_none_or(|o| o == "startup");
    let run_memory = only.as_deref().is_none_or(|o| o == "memory");
    let mut failed = false;

    println!("注意：本门测的是 Rust 侧开销，**不覆盖** WebView，");
    println!("      因此它通过并不等于满足设计规范 §6.1 的应用级指标。\n");

    if run_startup {
        let bin_path = locate_aitm_binary();
        println!("二进制路径：{bin_path}");
        let median_ms = measure_cli_start(&bin_path);
        println!(
            "[CLI 启动] `aitm --version` 中位数（{RUNS} 次）：{median_ms} ms （预算 < {CLI_START_BUDGET_MS} ms）"
        );
        if median_ms > CLI_START_BUDGET_MS {
            eprintln!("    失败：超出预算");
            failed = true;
        } else {
            println!("    通过");
        }
    }

    if run_memory {
        let mem_mb = measure_five_session_memory().await;
        println!(
            "[Rust 内存] 本进程 5 个 PTY 常驻：{mem_mb} MB （预算 < {FIVE_PTY_MEM_BUDGET_MB} MB，不含 WebView）"
        );
        if mem_mb > FIVE_PTY_MEM_BUDGET_MB {
            eprintln!("    失败：超出预算");
            failed = true;
        } else {
            println!("    通过");
        }
    }

    if failed {
        std::process::exit(1);
    }
    println!("\n全部通过 ✅");
}

fn locate_aitm_binary() -> String {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let candidates = [
        format!("{manifest_dir}/target/release/aitm"),
        format!("{manifest_dir}/../target/release/aitm"),
    ];
    for path in &candidates {
        if std::path::Path::new(path).exists() {
            return path.clone();
        }
    }
    panic!(
        "找不到 aitm release 二进制；尝试过：{:?}。先跑 `cargo build --release --bin aitm`。",
        candidates
    );
}

/// 量 `aitm --version` 的耗时。**不是**首屏时间——见模块文档。
fn measure_cli_start(bin: &str) -> u128 {
    let mut samples = Vec::with_capacity(RUNS);
    // 预热一次（跳过首次测量，规避文件系统缓存差异）
    let _ = Command::new(bin).arg("--version").status();
    for _ in 0..RUNS {
        let start = Instant::now();
        let status = Command::new(bin)
            .arg("--version")
            .status()
            .expect("启动 aitm 失败");
        let elapsed = start.elapsed().as_millis();
        assert!(status.success());
        samples.push(elapsed);
    }
    samples.sort();
    samples[RUNS / 2]
}

/// 量本进程开 5 个 PTY 后的常驻内存。**不含 WebView**——见模块文档。
async fn measure_five_session_memory() -> u64 {
    let mgr = SessionManager::new();
    let mut ids = Vec::with_capacity(TABS);
    for _ in 0..TABS {
        // perf 门用最小 shell：默认走 default_shell()（跨平台），保证 macOS / Linux 都能跑
        let cfg = SessionConfig {
            shell: Some(default_shell()),
            ..Default::default()
        };
        let id = mgr.open(cfg).await.expect("开 session 失败");
        ids.push(id);
    }
    // 等子进程稳定
    tokio::time::sleep(Duration::from_secs(2)).await;

    let bytes = current_process_memory();

    // 清理
    for id in ids {
        let _ = mgr.close(id).await;
    }
    // 给 read thread 退出时间
    tokio::time::sleep(Duration::from_millis(200)).await;

    bytes / (1024 * 1024)
}

/// macOS 走 `footprint -p`（即 Activity Monitor「内存」列的 `phys_footprint`）。
///
/// **不用 RSS**：macOS 的 RSS 把共享内存（系统框架、dyld shared cache）重复计入，
/// 量出来的数字显著虚高，跨进程比较更是没有意义。之前这里用的正是 RSS，
/// 导致一度误判应用"空闲占 109MB"，实际 footprint 只有 39MB。
///
/// `footprint` 不可用时回退到 `ps -o rss=`，并在输出里标明口径。
#[cfg(target_os = "macos")]
fn current_process_memory() -> u64 {
    let pid = std::process::id().to_string();
    if let Ok(out) = Command::new("footprint").args(["-p", &pid]).output() {
        let s = String::from_utf8_lossy(&out.stdout);
        if let Some(bytes) = parse_footprint(&s) {
            return bytes;
        }
    }
    eprintln!("    （footprint 不可用，回退 RSS 口径，数值偏高）");
    let out = Command::new("ps")
        .args(["-o", "rss=", "-p", &pid])
        .output()
        .expect("ps 失败");
    let s = String::from_utf8_lossy(&out.stdout);
    s.trim().parse::<u64>().unwrap_or(0) * 1024
}

/// 从 `footprint` 输出里抠出 `phys_footprint: <N> <KB|MB|GB>` 并归一为字节。
///
/// 单位是**混用**的（小进程给 KB，大进程给 MB），只取数字会差三个数量级——
/// 我第一次解析时就把 `6977 KB` 读成了 6977 MB。
#[cfg(target_os = "macos")]
fn parse_footprint(out: &str) -> Option<u64> {
    let line = out
        .lines()
        .find(|l| l.trim_start().starts_with("phys_footprint:"))?;
    let mut it = line.split_whitespace().skip(1);
    let value: u64 = it.next()?.parse().ok()?;
    Some(match it.next()? {
        "KB" => value * 1024,
        "MB" => value * 1024 * 1024,
        "GB" => value * 1024 * 1024 * 1024,
        "B" => value,
        _ => return None,
    })
}

#[cfg(not(target_os = "macos"))]
fn current_process_memory() -> u64 {
    use sysinfo::{Pid, ProcessRefreshKind, RefreshKind, System};
    let pid = Pid::from(std::process::id() as usize);
    let mut sys = System::new_with_specifics(
        RefreshKind::nothing().with_processes(ProcessRefreshKind::nothing().with_memory()),
    );
    sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
    sys.process(pid).map(|p| p.memory()).unwrap_or(0)
}
