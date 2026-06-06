//! v0.5.0-B：监听端口检测。
//!
//! `lsof -i -P -n` 一次拿全表（避免每 pid 跑一次），用 sysinfo BFS shell 子孙
//! pid 列表过滤，解析 `TYPE` 为 LISTEN 的行的端口号 → 去重 sorted。
//!
//! 详见 plan §2.3。

use std::collections::HashSet;
use std::process::Command;

use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

/// 一次性拿 shell pid 子孙树所有监听端口。失败（lsof 不存在 / 权限）→ 空 vec。
///
/// **注意**：该函数会同步调 lsof（系统调用，可能几十 ms）。caller 应在
/// 后台 tokio task 内调，不要阻塞 main thread。
pub fn list_listening_ports(shell_pid: u32) -> Vec<u16> {
    let pids = collect_descendant_pids(shell_pid);
    if pids.is_empty() {
        return Vec::new();
    }

    let Ok(out) = Command::new("lsof").args(["-i", "-P", "-n"]).output() else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    parse_lsof_listening(&stdout, &pids)
}

/// BFS shell pid 子孙树。复用 v0.4.2 T4 同款算法（ipc/system.rs 内私有，本模块
/// 重复一份避免跨模块 visibility 改动；逻辑很短）。
fn collect_descendant_pids(shell_pid: u32) -> HashSet<u32> {
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing(),
    );

    let mut pid_to_parent: std::collections::HashMap<u32, Option<u32>> =
        std::collections::HashMap::new();
    for (pid, proc) in sys.processes() {
        pid_to_parent.insert(pid.as_u32(), proc.parent().map(|p: Pid| p.as_u32()));
    }
    collect_from_map(&pid_to_parent, shell_pid)
}

fn collect_from_map(
    pid_to_parent: &std::collections::HashMap<u32, Option<u32>>,
    root: u32,
) -> HashSet<u32> {
    let mut set = HashSet::new();
    set.insert(root);
    loop {
        let mut grew = false;
        for (pid, parent_opt) in pid_to_parent {
            if set.contains(pid) {
                continue;
            }
            if let Some(parent) = parent_opt {
                if set.contains(parent) {
                    set.insert(*pid);
                    grew = true;
                }
            }
        }
        if !grew {
            break;
        }
    }
    set
}

/// 解析 lsof 输出，过滤出 pid in pids 的 LISTEN 行的端口号。
///
/// lsof 输出格式（macOS）：
/// ```text
/// COMMAND   PID   USER   FD   TYPE   DEVICE  SIZE/OFF  NODE  NAME
/// node      1234  user   18u  IPv4   0x...   0t0       TCP   *:3000 (LISTEN)
/// node      1234  user   19u  IPv6   0x...   0t0       TCP   *:5173 (LISTEN)
/// ```
/// 我们只关心：PID 在 pids 集合内 + NAME 含 `(LISTEN)` + NAME 含 `:<port>`
///
/// 提取 port：找最后一个 `:` 后的数字串到第一个非数字字符。
/// 跳过 header 行（第一列 `COMMAND` 字面值）。
pub fn parse_lsof_listening(stdout: &str, pids: &HashSet<u32>) -> Vec<u16> {
    let mut ports: HashSet<u16> = HashSet::new();
    for line in stdout.lines() {
        if line.starts_with("COMMAND") {
            continue;
        }
        // 至少 9 列；最后一列可能含 (LISTEN) 也可能是别的状态
        if !line.contains("(LISTEN)") {
            continue;
        }
        // 用 whitespace 切，第 2 列是 PID
        let mut fields = line.split_whitespace();
        let _command = fields.next();
        let Some(pid_str) = fields.next() else {
            continue;
        };
        let Ok(pid) = pid_str.parse::<u32>() else {
            continue;
        };
        if !pids.contains(&pid) {
            continue;
        }
        // 找最后一个 `:` 后的数字串
        if let Some(port) = extract_port_from_lsof_line(line) {
            ports.insert(port);
        }
    }
    let mut sorted: Vec<u16> = ports.into_iter().collect();
    sorted.sort();
    sorted
}

/// 从单行 lsof 输出提取端口号。
///
/// NAME 列形式：`*:3000` / `127.0.0.1:3000` / `[::1]:3000` / `*:3000->.*`
/// 策略：找最后一个空格后开始扫到 `(LISTEN)` 之前的部分，找最后一个 `:` 后的
/// 连续数字。
fn extract_port_from_lsof_line(line: &str) -> Option<u16> {
    let listen_idx = line.find("(LISTEN)")?;
    let name_part = line[..listen_idx].trim_end();
    let colon_idx = name_part.rfind(':')?;
    let port_str: String = name_part[colon_idx + 1..]
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    port_str.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_lsof_单条_listen_命中_pid() {
        let stdout = "\
COMMAND   PID   USER   FD   TYPE   DEVICE  SIZE/OFF  NODE  NAME
node      1234  u      18u  IPv4   0x1     0t0       TCP   *:3000 (LISTEN)
";
        let mut pids = HashSet::new();
        pids.insert(1234);
        assert_eq!(parse_lsof_listening(stdout, &pids), vec![3000]);
    }

    #[test]
    fn parse_lsof_多端口_去重_sorted() {
        let stdout = "\
COMMAND   PID   USER   FD   TYPE   DEVICE  SIZE/OFF  NODE  NAME
node      1234  u      18u  IPv4   0x1     0t0       TCP   *:5173 (LISTEN)
node      1234  u      19u  IPv6   0x2     0t0       TCP   *:3000 (LISTEN)
node      1234  u      20u  IPv4   0x3     0t0       TCP   *:3000 (LISTEN)
";
        let mut pids = HashSet::new();
        pids.insert(1234);
        // 去重后只剩 3000 + 5173，sorted ASC
        assert_eq!(parse_lsof_listening(stdout, &pids), vec![3000, 5173]);
    }

    #[test]
    fn parse_lsof_非_listen_行跳过() {
        let stdout = "\
COMMAND   PID   USER   FD   TYPE   DEVICE  SIZE/OFF  NODE  NAME
node      1234  u      18u  IPv4   0x1     0t0       TCP   127.0.0.1:54321->1.1.1.1:80 (ESTABLISHED)
node      1234  u      19u  IPv4   0x2     0t0       TCP   *:3000 (LISTEN)
";
        let mut pids = HashSet::new();
        pids.insert(1234);
        assert_eq!(parse_lsof_listening(stdout, &pids), vec![3000]);
    }

    #[test]
    fn parse_lsof_pid_不在集合_跳过() {
        let stdout = "\
COMMAND   PID   USER   FD   TYPE   DEVICE  SIZE/OFF  NODE  NAME
other     9999  u      18u  IPv4   0x1     0t0       TCP   *:8080 (LISTEN)
node      1234  u      19u  IPv4   0x2     0t0       TCP   *:3000 (LISTEN)
";
        let mut pids = HashSet::new();
        pids.insert(1234);
        // 只有 1234 命中
        assert_eq!(parse_lsof_listening(stdout, &pids), vec![3000]);
    }

    #[test]
    fn parse_lsof_ipv6_地址_提取_端口() {
        let stdout = "\
COMMAND   PID   USER   FD   TYPE   DEVICE  SIZE/OFF  NODE  NAME
node      1234  u      18u  IPv6   0x1     0t0       TCP   [::1]:8080 (LISTEN)
";
        let mut pids = HashSet::new();
        pids.insert(1234);
        assert_eq!(parse_lsof_listening(stdout, &pids), vec![8080]);
    }

    #[test]
    fn parse_lsof_空输出_返空() {
        let pids = HashSet::new();
        assert!(parse_lsof_listening("", &pids).is_empty());
    }

    #[test]
    fn parse_lsof_只有_header_返空() {
        let stdout = "COMMAND   PID   USER   FD   TYPE   DEVICE  SIZE/OFF  NODE  NAME\n";
        let mut pids = HashSet::new();
        pids.insert(1234);
        assert!(parse_lsof_listening(stdout, &pids).is_empty());
    }

    #[test]
    fn extract_port_纯数字端口() {
        let line = "node 1234 u 18u IPv4 0x1 0t0 TCP *:3000 (LISTEN)";
        assert_eq!(extract_port_from_lsof_line(line), Some(3000));
    }

    #[test]
    fn extract_port_ipv6_括号() {
        let line = "node 1234 u 18u IPv6 0x1 0t0 TCP [::1]:8080 (LISTEN)";
        assert_eq!(extract_port_from_lsof_line(line), Some(8080));
    }
}
