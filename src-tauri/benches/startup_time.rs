//! aitm 冷启动时间基准。
//!
//! 测量从二进制启动到就绪信号的耗时。
//! Phase 0 用最简单的就绪信号：`--version` 子命令进程退出。
//! Phase 1 改为窗口已显示的真实信号。

use criterion::{Criterion, criterion_group, criterion_main};
use std::process::Command;
use std::time::Instant;

fn bench_version_invocation(c: &mut Criterion) {
    // 使用 release 二进制路径；要求先跑过 `cargo build --release`。
    // CI 在跑基准前会先 release build。
    let bin = concat!(env!("CARGO_MANIFEST_DIR"), "/target/release/aitm");

    c.bench_function("aitm --version 冷启动", |b| {
        b.iter_custom(|iters| {
            let mut total = std::time::Duration::ZERO;
            for _ in 0..iters {
                let start = Instant::now();
                let status = Command::new(bin)
                    .arg("--version")
                    .status()
                    .expect("找不到 aitm 二进制；先跑 `cargo build --release`");
                total += start.elapsed();
                assert!(status.success());
            }
            total
        });
    });
}

criterion_group!(benches, bench_version_invocation);
criterion_main!(benches);
