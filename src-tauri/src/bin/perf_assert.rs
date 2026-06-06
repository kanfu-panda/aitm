//! perf_assert —— A5 性能宪章硬指标的强制门。
//!
//! 检查项：
//! 1. 冷启动 `aitm --version`：< 200 ms（10 次中位）
//! 2. 5 个 PTY session 空闲 RSS：< 80 MB（任务 11）
//!
//! 退出码 0 = 全部通过；1 = 任一项超标。

use std::process::Command;
use std::time::{Duration, Instant};

use aitm_lib::session::manager::SessionManager;
use aitm_lib::session::{default_shell, SessionConfig};

const COLD_START_BUDGET_MS: u128 = 200;
const FIVE_TAB_RSS_BUDGET_MB: u64 = 80;
const RUNS: usize = 10;
const TABS: usize = 5;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let mut failed = false;

    let bin_path = locate_aitm_binary();
    println!("二进制路径：{}", bin_path);

    let median_ms = measure_cold_start(&bin_path);
    println!("[1/2] 冷启动中位数（{RUNS} 次）：{median_ms} ms （预算 < {COLD_START_BUDGET_MS} ms）");
    if median_ms > COLD_START_BUDGET_MS {
        eprintln!("    失败：超出预算");
        failed = true;
    } else {
        println!("    通过");
    }

    let rss_mb = measure_five_session_rss().await;
    println!("[2/2] 5 个 PTY session 空闲 RSS：{rss_mb} MB （预算 < {FIVE_TAB_RSS_BUDGET_MB} MB）");
    if rss_mb > FIVE_TAB_RSS_BUDGET_MB {
        eprintln!("    失败：超出预算");
        failed = true;
    } else {
        println!("    通过");
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

fn measure_cold_start(bin: &str) -> u128 {
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

async fn measure_five_session_rss() -> u64 {
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

    let rss_bytes = current_process_rss();

    // 清理
    for id in ids {
        let _ = mgr.close(id).await;
    }
    // 给 read thread 退出时间
    tokio::time::sleep(Duration::from_millis(200)).await;

    rss_bytes / (1024 * 1024)
}

#[cfg(target_os = "macos")]
fn current_process_rss() -> u64 {
    // 通过 `ps -o rss=` 拿当前进程 RSS（KB）
    let pid = std::process::id();
    let out = Command::new("ps")
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output()
        .expect("ps 失败");
    let s = String::from_utf8_lossy(&out.stdout);
    let kb: u64 = s.trim().parse().unwrap_or(0);
    kb * 1024
}

#[cfg(not(target_os = "macos"))]
fn current_process_rss() -> u64 {
    use sysinfo::{Pid, ProcessRefreshKind, RefreshKind, System};
    let pid = Pid::from(std::process::id() as usize);
    let mut sys = System::new_with_specifics(
        RefreshKind::nothing().with_processes(ProcessRefreshKind::nothing().with_memory()),
    );
    sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
    sys.process(pid).map(|p| p.memory()).unwrap_or(0)
}
