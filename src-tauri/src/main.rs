// release 模式下避免 Windows 弹额外控制台窗口；macOS 上无副作用。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;

fn main() {
    // CLI 子命令路由（spec §14：aitm init / aitm doctor 等）
    let args: Vec<String> = env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("init") => {
            // T12：把当前目录初始化为 aitm 项目，复用 ipc::scope::project_init_impl。
            // 不启动 Tauri，CLI 直跑同步逻辑。
            let rest: Vec<String> = args.iter().skip(2).cloned().collect();
            let code = aitm_lib::cli::run_init(&rest);
            std::process::exit(code);
        }
        Some("doctor") => {
            eprintln!("aitm doctor: 尚未实现");
            std::process::exit(2);
        }
        Some("--version") | Some("-V") => {
            println!("aitm {}", env!("CARGO_PKG_VERSION"));
        }
        Some(unknown) if !unknown.starts_with("--") => {
            eprintln!("未知子命令：{unknown}");
            std::process::exit(2);
        }
        _ => {
            // 无子命令 → 启动 GUI
            aitm_lib::run_gui();
        }
    }
}
