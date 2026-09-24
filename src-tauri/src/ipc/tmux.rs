//! tmux 会话管理器 IPC。
//!
//! aitm **不**完整兼容 tmux（tmux 会吞掉 OSC 转义序列，完整支持要改 PTY 协议层），
//! 只做"看见 + 一键进入 + 基本干预"的会话管理器。本模块是无状态的：每条命令
//! fork 一次 tmux 子进程，不持有任何共享状态、不碰既有会话表。

use serde::{Deserialize, Serialize};
use std::process::Command;

/// 字段分隔符：ASCII Unit Separator (0x1F)。
///
/// 不用制表符 / 竖线，是因为会话名、窗格标题、工作目录里都可能出现这些可见字符，
/// 而 0x1F 不会出现在正常文本里。
const FIELD_SEP: char = '\u{1f}';

/// `tmux list-sessions -F` 的格式串，字段顺序与 [`TmuxSession`] 一一对应。
const LIST_FORMAT: &str = "#{session_name}\u{1f}#{session_windows}\u{1f}#{session_attached}\u{1f}#{session_created}\u{1f}#{pane_current_path}\u{1f}#{pane_current_command}\u{1f}#{pane_title}\u{1f}#{session_id}\u{1f}#{window_activity}";

/// tmux 输出里代表"服务端没起来 / 没有会话"的措辞。
///
/// 命中这些不是故障——用户只是没开 tmux，UI 应显示空状态而不是红色错误。
const NO_SERVER_MARKERS: &[&str] = &["no server running", "no sessions", "error connecting"];

/// tmux 可执行文件的候选绝对路径，按常见程度排序。
///
/// 为什么不直接用裸名字 `"tmux"` 让 PATH 去查找：**macOS 上从访达 / 程序坞
/// 启动的 `.app` 不继承 shell 的 PATH**。`launchctl getenv PATH` 是空的，GUI 进程
/// 拿到的是系统默认的 `/usr/bin:/bin:/usr/sbin:/sbin`，而 tmux 通常装在 Homebrew
/// 前缀下（Apple Silicon 是 `/opt/homebrew/bin`，Intel 是 `/usr/local/bin`），
/// 根本不在那个最小 PATH 里，spawn 直接 `NotFound` —— 表现就是面板永远说
/// "未检测到 tmux"。
///
/// 开发模式下 `pnpm tauri dev` 是从终端起的、继承了完整 PATH，所以这个问题
/// 在 dev 里完全看不出来，只有装成 `.app` 再打开才会暴露。
const TMUX_CANDIDATES: &[&str] = &[
    "/opt/homebrew/bin/tmux", // Homebrew（Apple Silicon）
    "/usr/local/bin/tmux",    // Homebrew（Intel）
    "/opt/local/bin/tmux",    // MacPorts
    "/usr/bin/tmux",          // 系统自带 / 多数 Linux 发行版
];

/// 在候选绝对路径里挑第一个真实存在的；都不存在就回退到裸名字 `name`。
///
/// 回退不是摆设：dev 模式和 Linux 上 PATH 是全的，裸名字查得到；用户把 tmux 装在
/// 冷门位置时，让 spawn 自己去 PATH 上碰一次运气，也好过直接判定不可用。
///
/// `exists` 作为参数注入，测试里就不必真去碰文件系统。
fn resolve_bin<'a>(
    name: &'a str,
    candidates: &[&'a str],
    exists: impl Fn(&str) -> bool,
) -> &'a str {
    candidates
        .iter()
        .copied()
        .find(|p| exists(p))
        .unwrap_or(name)
}

/// 本次调用要用的 tmux 可执行文件路径。
fn tmux_bin() -> &'static str {
    resolve_bin("tmux", TMUX_CANDIDATES, |p| {
        std::path::Path::new(p).exists()
    })
}

/// 一个 tmux 会话的快照。字段名保持 snake_case 直接透给前端（与 `TabMetadata` 一致）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TmuxSession {
    /// 会话名，attach / kill 的标识。
    pub name: String,
    /// 窗口数量。
    pub windows: u32,
    /// 当前已连接的客户端数；0 表示无人连接。
    pub attached: u32,
    /// 创建时间，Unix 秒。
    pub created: i64,
    /// 活动窗格的工作目录。
    pub current_path: Option<String>,
    /// 活动窗格正在跑的命令名。注意：常驻程序可能改写自己的进程名，
    /// 这个字段未必可读，UI 以 [`title`](Self::title) 为主标签。
    pub current_command: Option<String>,
    /// 活动窗格标题，作为任务标签展示。
    pub title: Option<String>,
    /// tmux 的 `session_id`（形如 `$96`）。**所有针对具体会话的操作都按它定位**：
    /// 按名字定位时 tmux 做前缀匹配，目标已被关掉时会误中名字以它开头的另一个会话；
    /// 而 id 精确且改名后不变。见 [`validate_session_id`]。
    pub id: String,
    /// 会话最近一次有输出的时间，Unix 秒：取它所有窗口里最新的 `window_activity`
    /// （见 [`latest_window_activity`]）。前端据此判断"上次查看后有没有新输出"。
    pub activity: i64,
}

/// 列各会话每个窗口最近一次有输出的时间，用来算会话的活动时间。
const WINDOW_ACTIVITY_FORMAT: &str = "#{session_id}\u{1f}#{window_activity}";

/// 解析 `list-windows -a -F WINDOW_ACTIVITY_FORMAT`：每个会话取所有窗口里最新的时间。
///
/// **不能用 `session_activity`**：它只在有客户端输入 / 接入时才更新，会话在后台产生
/// 输出时纹丝不动——1.6.0 的"新输出提示"就因此正好反了：用户自己接入、打字时亮，
/// 后台真有输出时反而不亮。`window_activity` 才随窗格输出变化；多窗口会话里任何一个
/// 窗口有输出都该算，所以取最大值。
fn latest_window_activity(stdout: &str) -> std::collections::HashMap<String, i64> {
    let mut latest = std::collections::HashMap::new();
    for line in stdout.lines() {
        let mut f = line.split(FIELD_SEP);
        let (Some(id), Some(t)) = (f.next(), f.next()) else {
            continue;
        };
        let Ok(t) = t.trim().parse::<i64>() else {
            continue;
        };
        latest
            .entry(id.to_string())
            .and_modify(|v: &mut i64| *v = (*v).max(t))
            .or_insert(t);
    }
    latest
}

/// 解析 `tmux list-sessions -F LIST_FORMAT` 的 stdout。
///
/// 容错口径（坏一行不影响其余行）：
/// - 字段数不足 7 → 整行跳过
/// - 数字字段解析失败 → 兜底 0
/// - 空字符串字段 → 归一为 `None`
fn parse_sessions(stdout: &str) -> Vec<TmuxSession> {
    stdout
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|line| {
            let f: Vec<&str> = line.split(FIELD_SEP).collect();
            if f.len() < 9 || f[7].is_empty() {
                return None;
            }
            Some(TmuxSession {
                name: f[0].to_string(),
                windows: f[1].parse().unwrap_or(0),
                attached: f[2].parse().unwrap_or(0),
                created: f[3].parse().unwrap_or(0),
                current_path: non_empty(f[4]),
                current_command: non_empty(f[5]),
                title: non_empty(f[6]),
                id: f[7].to_string(),
                activity: f[8].parse().unwrap_or(0),
            })
        })
        .collect()
}

/// 解析 stdout；**有输出却一条都解析不出来时报错，而不是当成"没有会话"**。
///
/// 这条守的是一类最难发现的故障：tmux 明明列出了会话，但分隔符被环境改写
/// （locale 缺失时控制字符会变成 `_`），于是每行字段数不足被整行丢弃。
/// 如果这时候返回空列表，界面会理直气壮地显示"当前没有 tmux 会话"——
/// **一个自信的错误答案比一个报错危险得多**。
fn parse_or_report(stdout: &str) -> Result<Vec<TmuxSession>, String> {
    let sessions = parse_sessions(stdout);
    let non_empty_lines = stdout.lines().filter(|l| !l.trim().is_empty()).count();
    if sessions.is_empty() && non_empty_lines > 0 {
        return Err(format!(
            "tmux 返回了 {non_empty_lines} 行，但一条都解析不出来——\
             分隔符可能被环境改写（检查 LANG / LC_CTYPE）"
        ));
    }
    Ok(sessions)
}

/// 空字符串归一为 `None`。
fn non_empty(s: &str) -> Option<String> {
    if s.is_empty() {
        None
    } else {
        Some(s.to_string())
    }
}

/// 把任意字符串包成 shell 单引号字面量。
///
/// **这是本模块唯一的安全关键函数**：会话名由 tmux 的使用者创建，对 aitm 来说是
/// 不可信输入，而 attach 命令是唯一会被 shell 解释的路径（要写进终端标签页的 PTY）。
/// 单引号内除了单引号本身没有任何元字符有特殊含义，所以只需把内部的 `'` 换成
/// `'\''`（闭合 → 转义单引号 → 重新开启）。
fn shell_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// 构造一条可以安全写入 PTY 的 attach 命令文本。**不执行任何东西**。
///
/// 按 `session_id` 定位（见 [`validate_session_id`]）。id 形如 `$96`，写进 shell 时
/// **必须单引号包裹**，否则 `$96` 会被当成位置参数展开成空串。
///
/// `takeover = true` 时加 `-d`，踢掉该会话的其它客户端独占接入。
///
/// `bin` 传解析出的 tmux 路径（[`tmux_bin`]），**不要写裸 `tmux`**：命令是在标签页的
/// shell 里执行的，而 aitm 起的是非登录 shell、不读 `~/.zprofile`——Homebrew 默认把
/// PATH 配在那里，于是标签页里根本找不到 `tmux`。路径同样单引号包裹。
fn build_attach_command(bin: &str, id: &str, takeover: bool) -> Result<String, String> {
    validate_session_id(id)?;
    let flag = if takeover { " -d" } else { "" };
    Ok(format!(
        "{} attach-session{flag} -t {}",
        shell_single_quote(bin),
        shell_single_quote(id)
    ))
}

/// 校验 `session_id` 形如 `$` 加至少一位数字，**其它一律拒绝**。
///
/// 这是 id 进入 tmux 目标解析前的唯一关口：只放行这一种形状，就不可能借 id 参数
/// 塞进 `=前缀`、`:窗口`、`.窗格` 或任何 shell 元字符。
fn validate_session_id(id: &str) -> Result<(), String> {
    let digits = id.strip_prefix('$').unwrap_or("");
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return Err(format!("无效的会话 id：{id:?}"));
    }
    Ok(())
}

/// 窗格级命令（capture-pane、send-keys）的目标：`$96:` 表示该会话的当前窗口。
fn pane_target(id: &str) -> Result<String, String> {
    validate_session_id(id)?;
    Ok(format!("{id}:"))
}

/// 新建 / 改名时的会话名校验。
///
/// - `.` 与 `:` 在 tmux 目标语法里分别是窗格、窗口分隔符，名字里带了会让按名字
///   定位的其它工具（以及用户自己在终端里 `tmux a -t`）出错
/// - 控制字符会弄乱列表显示，也没有正当用途
fn validate_session_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("会话名不能为空".to_string());
    }
    if name.contains('.') || name.contains(':') {
        return Err("会话名不能包含 . 或 :".to_string());
    }
    if name.chars().any(char::is_control) {
        return Err("会话名不能包含控制字符".to_string());
    }
    Ok(())
}

/// `new-session` 的参数。`-P -F '#{session_id}'` 让 tmux 直接打印新会话的 id。
///
/// `cwd` 由调用方先确认是目录再传进来；为 `None` 时不带 `-c`，由 tmux 用默认目录。
fn new_session_args(name: &str, cwd: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = ["new-session", "-d", "-P", "-F", "#{session_id}", "-s", name]
        .iter()
        .map(|s| s.to_string())
        .collect();
    if let Some(dir) = cwd {
        args.push("-c".to_string());
        args.push(dir.to_string());
    }
    args
}

/// 预览要显示的最后几行。
const PREVIEW_LINES: usize = 30;

/// 把 `capture-pane` 的原始输出裁成"最后 `n` 行有效内容"。
///
/// `capture-pane -S -N` 返回的是"往回 N 行历史 + 整个可见窗格"，窗格下半部分常是
/// 空行（实测 `-S -30` 拿到 41 行）。所以多取一些，再去掉尾部空行、只留最后 `n` 行。
fn trim_preview(raw: &str, n: usize) -> String {
    let lines: Vec<&str> = raw.lines().collect();
    let end = lines
        .iter()
        .rposition(|l| !l.trim().is_empty())
        .map(|i| i + 1)
        .unwrap_or(0);
    let start = end.saturating_sub(n);
    lines[start..end].join("\n")
}

/// stderr 是否代表"服务端没起来 / 没有会话"（而非真故障）。
fn is_no_server_error(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    NO_SERVER_MARKERS.iter().any(|m| lower.contains(m))
}

/// 构造一个跑 tmux 的 `Command`，并补上 UTF-8 locale。
///
/// **locale 这步不能省**：`.app` 从访达 / 程序坞启动时拿不到 `LANG` / `LC_CTYPE`，
/// tmux 在非 UTF-8 locale 下会把格式输出里的**所有控制字符替换成 `_`**——包括
/// [`FIELD_SEP`]。结果是每行只剩一个字段，[`parse_sessions`] 因为字段数不足全部
/// 丢弃，列表被解析成空，UI 上表现为"当前没有 tmux 会话"，而实际会话好好地跑着。
///
/// 实测（同一个 tmux、同一条命令，只差环境）：
/// - 有 `LANG`：`b"aim-quant\x1f1\x1f1"`
/// - 无 `LANG`：`b"aim-quant_1_1"`
fn tmux_command() -> Command {
    let mut cmd = Command::new(tmux_bin());
    for (key, value) in crate::session::platform::missing_utf8_locale_env() {
        cmd.env(key, value);
    }
    cmd
}

/// 跑一条 tmux 子命令，成功时返回 stdout。参数以数组传递，**不经过 shell**。
async fn run_tmux_output(args: Vec<String>) -> Result<String, String> {
    let out = tokio::task::spawn_blocking(move || tmux_command().args(&args).output())
        .await
        .map_err(|e| format!("执行 tmux 任务失败：{e}"))?;

    match out {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Err("本机未安装 tmux".to_string())
        }
        Err(e) => Err(format!("执行 tmux 失败：{e}")),
        Ok(o) if o.status.success() => Ok(String::from_utf8_lossy(&o.stdout).into_owned()),
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr).trim().to_string();
            Err(if stderr.is_empty() {
                "tmux 命令执行失败".to_string()
            } else {
                stderr
            })
        }
    }
}

/// 跑一条 tmux 子命令，只关心成败。
async fn run_tmux(args: Vec<String>) -> Result<(), String> {
    run_tmux_output(args).await.map(|_| ())
}

/// 一个已连接的 tmux 客户端。
#[derive(Debug, Clone, PartialEq, Eq)]
struct TmuxClient {
    pid: u32,
    session_id: String,
    session_name: String,
}

/// 某个标签接入着的 tmux 会话，给前端的关标签确认框用。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TmuxSessionRef {
    pub id: String,
    pub name: String,
}

const CLIENTS_FORMAT: &str = "#{client_pid}\u{1f}#{session_id}\u{1f}#{session_name}";

/// 解析 `tmux list-clients -F CLIENTS_FORMAT`。坏行跳过。
fn parse_clients(stdout: &str) -> Vec<TmuxClient> {
    stdout
        .lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.split(FIELD_SEP).collect();
            if f.len() < 3 || f[1].is_empty() {
                return None;
            }
            Some(TmuxClient {
                pid: f[0].parse().ok()?,
                session_id: f[1].to_string(),
                session_name: f[2].to_string(),
            })
        })
        .collect()
}

/// 父进程链最多往上追几层。tmux 客户端通常就是 shell 的直接子进程；留点余量给
/// 中间隔了一层包装（如 `script`、`sudo`）的情况，同时防止进程表快照不一致时死循环。
const MAX_ANCESTOR_DEPTH: usize = 8;

/// 在客户端里找**挂在 `shell_pid` 之下**的那一个，返回它接入的会话。
///
/// 按进程父子关系判断，而不是看标签标题——这样用户在任意标签里手敲
/// `tmux attach` / `tmux new` 也能识别，不限于从面板点开的标签。
fn find_client_session(
    clients: &[TmuxClient],
    shell_pid: u32,
    parent_of: impl Fn(u32) -> Option<u32>,
) -> Option<TmuxSessionRef> {
    clients.iter().find_map(|c| {
        let mut cur = c.pid;
        for _ in 0..MAX_ANCESTOR_DEPTH {
            let parent = parent_of(cur)?;
            if parent == shell_pid {
                return Some(TmuxSessionRef {
                    id: c.session_id.clone(),
                    name: c.session_name.clone(),
                });
            }
            cur = parent;
        }
        None
    })
}

/// 查 `shell_pid` 下面有没有 tmux 客户端、接的是哪个会话。
/// tmux 没装、服务端没起来、或没有客户端时返回 `None`——都不是错误。
async fn session_of_shell(shell_pid: u32) -> Option<TmuxSessionRef> {
    let out = run_tmux_output(vec![
        "list-clients".into(),
        "-F".into(),
        CLIENTS_FORMAT.into(),
    ])
    .await
    .ok()?;
    let clients = parse_clients(&out);
    if clients.is_empty() {
        return None;
    }
    tokio::task::spawn_blocking(move || {
        use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
        let mut sys = System::new();
        sys.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing(),
        );
        find_client_session(&clients, shell_pid, |pid| {
            sys.process(Pid::from_u32(pid))
                .and_then(|p| p.parent())
                .map(|pp| pp.as_u32())
        })
    })
    .await
    .ok()
    .flatten()
}

/// 关标签前查询：这个标签（aitm 会话）里是否接着某个 tmux 会话。
///
/// 前端据此把确认框换成"关闭并保留会话 / 关闭并结束会话"两个选项。
/// 关标签本身只会断开这个 tmux 客户端，会话会继续在后台运行。
#[tauri::command]
pub async fn tmux_session_of_tab(
    id: crate::session::SessionId,
    state: tauri::State<'_, std::sync::Arc<crate::ipc::session::SessionState>>,
) -> Result<Option<TmuxSessionRef>, String> {
    let Ok(session) = state.mgr.get(id).await else {
        return Ok(None);
    };
    let Some(shell_pid) = session.shell_pid() else {
        return Ok(None);
    };
    drop(session);
    Ok(session_of_shell(shell_pid).await)
}

/// 本机是否能用 tmux。
///
/// 能成功启动 `tmux -V` 进程即视为可用。**不返回错误**——没装 tmux 是正常情况，
/// 不是故障，UI 据此显示空状态。
#[tauri::command]
pub async fn tmux_available() -> Result<bool, String> {
    tokio::task::spawn_blocking(|| tmux_command().arg("-V").output().is_ok())
        .await
        .map_err(|e| format!("探测 tmux 失败：{e}"))
}

/// 列出本机所有 tmux 会话。
///
/// tmux 未安装 / 服务端未启动 → 返回空数组（**不是错误**）。
#[tauri::command]
pub async fn tmux_list_sessions() -> Result<Vec<TmuxSession>, String> {
    let out = tokio::task::spawn_blocking(|| {
        tmux_command()
            .args(["list-sessions", "-F", LIST_FORMAT])
            .output()
    })
    .await
    .map_err(|e| format!("执行 tmux 任务失败：{e}"))?;

    match out {
        // 没装 tmux → 空列表，让 UI 走"未检测到 tmux"空状态
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("执行 tmux 失败：{e}")),
        Ok(o) if o.status.success() => {
            let mut sessions = parse_or_report(&String::from_utf8_lossy(&o.stdout))?;
            // 列表里带的是当前窗口的活动时间；再取一次所有窗口的，覆盖成最新值。
            // 这一步失败不影响列表本身，保留当前窗口的值即可
            let windows = tokio::task::spawn_blocking(|| {
                tmux_command()
                    .args(["list-windows", "-a", "-F", WINDOW_ACTIVITY_FORMAT])
                    .output()
            })
            .await;
            if let Ok(Ok(w)) = windows {
                if w.status.success() {
                    let latest = latest_window_activity(&String::from_utf8_lossy(&w.stdout));
                    for s in &mut sessions {
                        if let Some(&t) = latest.get(&s.id) {
                            s.activity = s.activity.max(t);
                        }
                    }
                }
            }
            Ok(sessions)
        }
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr);
            if is_no_server_error(&stderr) {
                Ok(Vec::new())
            } else {
                Err(stderr.trim().to_string())
            }
        }
    }
}

/// 构造 attach 命令文本给前端写进终端标签页。见 [`build_attach_command`]。
#[tauri::command]
pub async fn tmux_attach_command(id: String, takeover: bool) -> Result<String, String> {
    build_attach_command(tmux_bin(), &id, takeover)
}

/// 向会话的活动窗格发 Ctrl-C，中断里面正在跑的前台命令。会话本身保留。
#[tauri::command]
pub async fn tmux_interrupt_session(id: String) -> Result<(), String> {
    let target = pane_target(&id)?;
    run_tmux(vec!["send-keys".into(), "-t".into(), target, "C-c".into()]).await
}

/// 结束整个会话。
///
/// **二次确认由前端负责**（PRD FR-06）：本命令是无条件执行的原语。
#[tauri::command]
pub async fn tmux_kill_session(id: String) -> Result<(), String> {
    validate_session_id(&id)?;
    run_tmux(vec!["kill-session".into(), "-t".into(), id]).await
}

/// 新建一个后台会话，返回它的 `session_id`。
///
/// `cwd` 不是目录（或没给）时不带 `-c`。重名时 tmux 报 `duplicate session: <名>`，原样透出。
#[tauri::command]
pub async fn tmux_new_session(name: String, cwd: Option<String>) -> Result<String, String> {
    validate_session_name(&name)?;
    let cwd = cwd.filter(|d| std::path::Path::new(d).is_dir());
    let out = run_tmux_output(new_session_args(&name, cwd.as_deref())).await?;
    let id = out.trim().to_string();
    validate_session_id(&id).map_err(|_| format!("tmux 没有返回新会话的 id：{id:?}"))?;
    Ok(id)
}

/// 重命名会话。id 不变，所以前端按 id 记的展开 / 已查看状态自然保留。
#[tauri::command]
pub async fn tmux_rename_session(id: String, name: String) -> Result<(), String> {
    validate_session_id(&id)?;
    validate_session_name(&name)?;
    run_tmux(vec!["rename-session".into(), "-t".into(), id, name]).await
}

/// 取会话活动窗格最后 [`PREVIEW_LINES`] 行输出，**不接入**。
///
/// 不带 `-e`，输出不含转义序列；`-J` 把被折行的长行拼回一行。
#[tauri::command]
pub async fn tmux_capture_pane(id: String) -> Result<String, String> {
    let target = pane_target(&id)?;
    let raw = run_tmux_output(vec![
        "capture-pane".into(),
        "-p".into(),
        "-J".into(),
        "-t".into(),
        target,
        "-S".into(),
        "-200".into(),
    ])
    .await?;
    Ok(trim_preview(&raw, PREVIEW_LINES))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 拼一行 tmux 格式串输出，字段顺序与 `LIST_FORMAT` 一致。
    ///
    /// 给了**恰好 7 个字段**时自动补上 `session_id`（`$1`）与 `window_activity`（`0`），
    /// 让只关心前 7 个字段的老用例不必改动；需要控制 id / activity 的用例直接给满 9 个。
    fn line(fields: &[&str]) -> String {
        let mut v: Vec<&str> = fields.to_vec();
        if v.len() == 7 {
            v.extend(["$1", "0"]);
        }
        v.join(&FIELD_SEP.to_string())
    }

    // === 解析：正常路径 ===

    #[test]
    fn ut_b01_解析单行_七个字段全部正确() {
        let out = line(&[
            "build-farm",
            "3",
            "1",
            "1700000000",
            "/home/dev/project",
            "cargo",
            "nightly build",
        ]);
        let sessions = parse_sessions(&out);
        assert_eq!(sessions.len(), 1);
        let s = &sessions[0];
        assert_eq!(s.name, "build-farm");
        assert_eq!(s.windows, 3);
        assert_eq!(s.attached, 1);
        assert_eq!(s.created, 1_700_000_000);
        assert_eq!(s.current_path.as_deref(), Some("/home/dev/project"));
        assert_eq!(s.current_command.as_deref(), Some("cargo"));
        assert_eq!(s.title.as_deref(), Some("nightly build"));
    }

    #[test]
    fn ut_b02_解析多行_返回等量会话() {
        let out = format!(
            "{}\n{}\n{}",
            line(&["alpha", "1", "0", "1700000001", "/tmp", "zsh", "alpha"]),
            line(&["beta", "2", "1", "1700000002", "/tmp", "vim", "beta"]),
            line(&["gamma", "5", "0", "1700000003", "/tmp", "bash", "gamma"]),
        );
        let sessions = parse_sessions(&out);
        assert_eq!(sessions.len(), 3);
        assert_eq!(sessions[1].name, "beta");
        assert_eq!(sessions[2].windows, 5);
    }

    // === 解析：边界与异常 ===

    #[test]
    fn ut_b03_空字符串字段归一为_none() {
        let out = line(&["solo", "1", "0", "1700000000", "", "", ""]);
        let sessions = parse_sessions(&out);
        assert_eq!(sessions.len(), 1);
        assert!(sessions[0].current_path.is_none());
        assert!(sessions[0].current_command.is_none());
        assert!(sessions[0].title.is_none());
    }

    #[test]
    fn ut_b04_字段数不足的坏行被跳过_不影响其余行() {
        let out = format!(
            "{}\n{}\n{}",
            line(&["good-1", "1", "0", "1700000000", "/tmp", "zsh", "t1"]),
            line(&["broken", "1", "0"]), // 只有 3 个字段
            line(&["good-2", "1", "0", "1700000000", "/tmp", "zsh", "t2"]),
        );
        let sessions = parse_sessions(&out);
        assert_eq!(sessions.len(), 2, "坏行应被跳过，好行照常解析");
        assert_eq!(sessions[0].name, "good-1");
        assert_eq!(sessions[1].name, "good-2");
    }

    #[test]
    fn ut_b05_数字字段非数字时兜底为零_不_panic() {
        let out = line(&["odd", "x", "y", "z", "/tmp", "zsh", "t"]);
        let sessions = parse_sessions(&out);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].windows, 0);
        assert_eq!(sessions[0].attached, 0);
        assert_eq!(sessions[0].created, 0);
    }

    #[test]
    fn ut_b06_空输入返回空数组() {
        assert!(parse_sessions("").is_empty());
        assert!(parse_sessions("\n\n  \n").is_empty());
    }

    // === attach 命令构造与 shell 转义（安全重点）===

    #[test]
    fn ut_b07_attach_命令以单引号包裹_id_防止_shell_展开() {
        // `$96` 不加引号写进 shell 会被当成变量展开成空串
        let cmd = build_attach_command("/opt/homebrew/bin/tmux", "$96", false).unwrap();
        assert_eq!(cmd, "'/opt/homebrew/bin/tmux' attach-session -t '$96'");
    }

    #[test]
    fn 应该_当标签页_shell_的_path_里没有_tmux_时_接入命令仍用解析出的绝对路径() {
        // aitm 起的是非登录 shell，不读 ~/.zprofile；Homebrew 默认把 PATH 配在那里，
        // 于是标签页里敲裸 `tmux` 会报 command not found。命令必须自带完整路径。
        let cmd = build_attach_command(tmux_bin(), "$96", false).unwrap();
        assert!(
            cmd.starts_with(&shell_single_quote(tmux_bin())),
            "接入命令应以解析出的 tmux 路径开头：{cmd}"
        );
        // 路径里含空格等字符时也不能被 shell 拆开
        let odd = build_attach_command("/Apps/My Tools/tmux", "$96", false).unwrap();
        assert!(odd.starts_with("'/Apps/My Tools/tmux' "), "{odd}");
    }

    #[test]
    fn ut_b08_单引号转义为闭合再拼接序列() {
        assert_eq!(shell_single_quote("it's mine"), r#"'it'\''s mine'"#);
    }

    #[test]
    fn ut_b09_注入串作为_id_直接被拒() {
        assert!(build_attach_command("tmux", "x; rm -rf ~", false).is_err());
        assert!(build_attach_command("tmux", "$96; rm -rf ~", false).is_err());
    }

    #[test]
    fn ut_b10_接管模式命令含_d_且在_t_之前() {
        let cmd = build_attach_command("tmux", "$96", true).unwrap();
        assert_eq!(cmd, "'tmux' attach-session -d -t '$96'");
        assert!(cmd.find("-d").unwrap() < cmd.find("-t").unwrap());
    }

    #[test]
    fn ut_b11_非法_id_返回错误() {
        for bad in ["", "   ", "$", "96", "$9a", "=work"] {
            assert!(build_attach_command("tmux", bad, false).is_err(), "{bad:?} 应被拒");
        }
    }

    // === "无服务端" vs 真错误 ===

    #[test]
    fn ut_b12_no_server_running_判定为无会话() {
        assert!(is_no_server_error(
            "no server running on /tmp/tmux-501/default"
        ));
    }

    #[test]
    fn ut_b13_其余无会话措辞同样被识别() {
        assert!(is_no_server_error("no sessions"));
        assert!(is_no_server_error("error connecting to /tmp/tmux-501/default"));
        // 大小写不敏感
        assert!(is_no_server_error("No Server Running"));
    }

    #[test]
    fn ut_b14_其它_stderr_判定为真错误() {
        assert!(!is_no_server_error("session not found: ghost"));
        assert!(!is_no_server_error("permission denied"));
        assert!(!is_no_server_error(""));
    }

    // === locale 缺失导致分隔符被吃掉（安装版真实故障）===

    #[test]
    fn ut_b21_有输出却一条都解析不出来时报错_而不是当成没有会话() {
        // 这正是安装版里看到的 stdout：tmux 把 0x1f 换成了 `_`
        let mangled = "aim-quant_1_1_1700000000_/tmp_zsh_title\nother_1_0_1700000001_/tmp_zsh_t";
        let err = parse_or_report(mangled).unwrap_err();
        assert!(err.contains("2 行"), "应报出实际行数，实际：{err}");
        assert!(
            err.contains("LANG") || err.contains("LC_CTYPE"),
            "错误信息应指向 locale，实际：{err}"
        );
    }

    #[test]
    fn ut_b22_真的没有会话时返回空列表_不报错() {
        assert_eq!(parse_or_report("").unwrap().len(), 0);
        assert_eq!(parse_or_report("\n  \n").unwrap().len(), 0);
    }

    #[test]
    fn ut_b23_正常输出照常解析() {
        let ok = line(&["a", "1", "0", "1700000000", "/tmp", "zsh", "t"]);
        assert_eq!(parse_or_report(&ok).unwrap().len(), 1);
    }

    #[test]
    fn ut_b24_缺失_locale_时会被补上() {
        let _g = crate::test_env_lock::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let saved: Vec<_> = ["LANG", "LC_CTYPE"]
            .iter()
            .map(|k| (*k, std::env::var(k).ok()))
            .collect();
        // SAFETY: ENV_LOCK 串行，与其它改 env 的测试互斥
        unsafe {
            for (k, _) in &saved {
                std::env::remove_var(k);
            }
        }
        let pairs = crate::session::platform::missing_utf8_locale_env();
        let keys: Vec<_> = pairs.iter().map(|(k, _)| *k).collect();
        unsafe {
            for (k, v) in saved {
                match v {
                    Some(v) => std::env::set_var(k, v),
                    None => std::env::remove_var(k),
                }
            }
        }
        assert!(keys.contains(&"LANG"), "LANG 缺失时应被补上");
        assert!(keys.contains(&"LC_CTYPE"), "LC_CTYPE 缺失时应被补上");
    }

    /// 端到端回归：**清掉 locale 之后仍然要能列出会话**。
    ///
    /// 这条直接复现安装版的故障条件——`.app` 从访达启动时 `LANG` / `LC_CTYPE`
    /// 都是空的。修复前在这个条件下 tmux 会把分隔符换成 `_`，解析结果为空；
    /// 修复后 [`tmux_command`] 会把 locale 补回去。
    ///
    /// 复现条件是**同时缺 `LANG` 和 `TMUX`**：任一存在 tmux 都会正常输出控制字符。
    /// 依赖本机真的有 tmux 会话，没有就跳过（CI / 别人的机器）。
    // ENV_LOCK 是 std::sync::Mutex，这里确实跨 await 持有它。
    // 单测跑在 current_thread runtime 上、且 env 是进程级全局状态——
    // 必须整段串行，否则并发测试会互相覆盖 LANG/TMUX。不会死锁。
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn ut_b25_清掉_locale_后仍能列出本机会话() {
        let _g = crate::test_env_lock::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());

        // 先在当前环境下看看本机到底有没有会话；没有就没什么可断言的
        let baseline = tmux_list_sessions().await.unwrap_or_default();
        if baseline.is_empty() {
            return;
        }

        // 必须连 TMUX 一起清掉：开发机的 shell 常常本身就跑在 tmux 里，
        // 而 tmux 子进程看到 TMUX 时即使没有 locale 也会正常输出控制字符——
        // 留着它这条测试就永远是绿的（第一版就栽在这）。
        let saved: Vec<_> = ["LANG", "LC_CTYPE", "LC_ALL", "TMUX", "TMUX_PANE"]
            .iter()
            .map(|k| (*k, std::env::var(k).ok()))
            .collect();
        // SAFETY: ENV_LOCK 串行
        unsafe {
            for (k, _) in &saved {
                std::env::remove_var(k);
            }
        }
        let got = tmux_list_sessions().await;
        unsafe {
            for (k, v) in saved {
                match v {
                    Some(v) => std::env::set_var(k, v),
                    None => std::env::remove_var(k),
                }
            }
        }

        let got = got.expect("清掉 locale 后不应报错");
        assert_eq!(
            got.len(),
            baseline.len(),
            "清掉 LANG / LC_CTYPE 后列出的会话数应与正常环境一致"
        );
    }

    // === id / activity / 新建 / 改名 / 预览 ===

    #[test]
    fn ut_b26_九字段行解析出_id_与_activity() {
        let out = line(&[
            "work", "2", "1", "1700000000", "/tmp", "zsh", "t", "$96", "1700000500",
        ]);
        let s = &parse_sessions(&out)[0];
        assert_eq!(s.id, "$96");
        assert_eq!(s.activity, 1_700_000_500);
    }

    #[test]
    fn ut_b27_缺_id_与_activity_的行被跳过() {
        let eight = ["work", "2", "1", "1700000000", "/tmp", "zsh", "t", "$96"]
            .join(&FIELD_SEP.to_string());
        assert!(parse_sessions(&eight).is_empty());
    }

    #[test]
    fn ut_b28_会话名校验() {
        for bad in ["", "   ", "a.b", "a:b", "x\u{7}y", "tab\there"] {
            assert!(validate_session_name(bad).is_err(), "{bad:?} 应被拒");
        }
        for ok in ["my-proj_1", "中文 名", "a b"] {
            assert!(validate_session_name(ok).is_ok(), "{ok:?} 应放行");
        }
    }

    #[test]
    fn ut_b29_会话_id_校验() {
        for ok in ["$0", "$96", "$123456"] {
            assert!(validate_session_id(ok).is_ok(), "{ok:?} 应放行");
        }
        for bad in ["", "$", "96", "$9a", "$96;rm", "=x", "$96:", " $96"] {
            assert!(validate_session_id(bad).is_err(), "{bad:?} 应被拒");
        }
    }

    #[test]
    fn ut_b30_窗格级目标带冒号() {
        assert_eq!(pane_target("$96").unwrap(), "$96:");
        assert!(pane_target("work").is_err());
    }

    #[test]
    fn ut_b31_预览裁剪去尾部空行并只留最后_n_行() {
        let raw = "l1\nl2\nl3\nl4\n\n\n  \n";
        assert_eq!(trim_preview(raw, 2), "l3\nl4");
    }

    #[test]
    fn ut_b32_预览裁剪_不足_n_行全留_全空返回空串() {
        assert_eq!(trim_preview("a\nb\n", 30), "a\nb");
        assert_eq!(trim_preview("\n\n  \n", 30), "");
    }

    #[test]
    fn ut_b33_新建参数只在给了目录时带_c() {
        let with = new_session_args("proj", Some("/tmp"));
        assert_eq!(
            with,
            ["new-session", "-d", "-P", "-F", "#{session_id}", "-s", "proj", "-c", "/tmp"]
        );
        let without = new_session_args("proj", None);
        assert!(!without.iter().any(|a| a == "-c"));
    }

    /// 本机能用 tmux 才跑的端到端用例的名字前缀。
    const E2E_PREFIX: &str = "aitm-selftest";

    /// 端到端用例里的断言：失败时**返回 Err 而不是 panic**。
    ///
    /// 这些用例在真实的 tmux 服务端上建会话。若在 async 块里直接 `assert!`，panic 会
    /// 跳过后面的清理，把测试会话遗留在用户的 tmux 里；改成返回 Err，清理一定会跑，
    /// 最后再 `unwrap()` 让用例失败。
    fn ensure(cond: bool, msg: String) -> Result<(), String> {
        if cond { Ok(()) } else { Err(msg) }
    }

    /// 只清理**本用例自己建的**会话。
    ///
    /// 不能按前缀一把清：这几条真 tmux 用例若并行，按前缀清会把别的用例正在用的会话
    /// 也杀掉（第一版就这样互相踩，报 `can't find session`）。
    async fn cleanup_names(names: &[&str]) {
        if let Ok(list) = tmux_list_sessions().await {
            for s in list.into_iter().filter(|s| names.contains(&s.name.as_str())) {
                let _ = tmux_kill_session(s.id).await;
            }
        }
    }

    // 真 tmux 的用例共享同一个 tmux 服务端，且 UT-B25 会数会话总数——必须与之串行。
    // 借用全局 ENV_LOCK 做这把串行锁；current_thread runtime 下跨 await 持有不会死锁。
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn ut_b34_端到端_新建_找到_改名_预览_结束() {
        let _g = crate::test_env_lock::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if !tmux_available().await.unwrap_or(false) {
            return;
        }
        let name = format!("{E2E_PREFIX}-{}", std::process::id());
        let renamed = format!("{name}-r");

        let result: Result<(), String> = async {
            let id = tmux_new_session(name.clone(), Some("/tmp".into())).await?;
            ensure(id.starts_with('$'), format!("应返回 session_id，实际 {id:?}"))?;

            let list = tmux_list_sessions().await?;
            let found = list.iter().find(|s| s.id == id).ok_or("列表里找不到新会话")?;
            ensure(found.name == name, format!("名字不符：{:?}", found.name))?;

            tmux_rename_session(id.clone(), renamed.clone()).await?;
            let list = tmux_list_sessions().await?;
            let found = list.iter().find(|s| s.id == id).ok_or("改名后按 id 找不到")?;
            ensure(found.name == renamed, "改名后 id 应不变、名字应更新".into())?;

            // 预览接口能跑通即可（新会话输出可能为空）
            tmux_capture_pane(id.clone()).await?;

            tmux_kill_session(id.clone()).await?;
            let list = tmux_list_sessions().await?;
            ensure(!list.iter().any(|s| s.id == id), "结束后不应再出现".into())?;
            Ok(())
        }
        .await;

        cleanup_names(&[&name, &renamed]).await;
        result.unwrap();
    }

    #[test]
    fn 应该_当会话有多个窗口时_活动时间取所有窗口里最新的一个() {
        let out = format!(
            "$1{s}100\n$1{s}350\n$2{s}200\n坏行\n$1{s}300\n",
            s = FIELD_SEP
        );
        let m = latest_window_activity(&out);
        assert_eq!(m.get("$1"), Some(&350));
        assert_eq!(m.get("$2"), Some(&200));
        assert_eq!(m.len(), 2);
    }

    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn 应该_当没人接着的会话在后台产生输出时_列表里的活动时间随之变大() {
        let _g = crate::test_env_lock::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if !tmux_available().await.unwrap_or(false) {
            return;
        }
        let name = format!("{E2E_PREFIX}-act-{}", std::process::id());

        let result: Result<(), String> = async {
            let id = tmux_new_session(name.clone(), Some("/tmp".into())).await?;
            // 等 shell 起来、首屏输出落定，再取基线
            tokio::time::sleep(std::time::Duration::from_millis(800)).await;
            let before = tmux_list_sessions()
                .await?
                .into_iter()
                .find(|s| s.id == id)
                .ok_or("列表里找不到新会话")?
                .activity;

            // 活动时间按秒计，跨过一秒再产生输出
            tokio::time::sleep(std::time::Duration::from_millis(1_300)).await;
            let sent = tmux_command()
                .args(["send-keys", "-t", &pane_target(&id)?, "echo aitm-activity", "Enter"])
                .status()
                .map_err(|e| e.to_string())?;
            ensure(sent.success(), "send-keys 失败".into())?;
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;

            let after = tmux_list_sessions()
                .await?
                .into_iter()
                .find(|s| s.id == id)
                .ok_or("输出后找不到会话")?
                .activity;
            ensure(
                after > before,
                format!("后台有输出后活动时间应变大：before={before} after={after}"),
            )?;
            Ok(())
        }
        .await;

        cleanup_names(&[&name]).await;
        result.unwrap();
    }

    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn ut_b35_端到端_按不存在的_id_结束不会误中前缀相同的会话() {
        let _g = crate::test_env_lock::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if !tmux_available().await.unwrap_or(false) {
            return;
        }
        let long = format!("{E2E_PREFIX}-long-{}", std::process::id());
        let result: Result<(), String> = async {
            let long_id = tmux_new_session(long.clone(), None).await?;
            // 复现旧缺陷的场景：想结束的会话叫 `<前缀>`，它已经不存在了，而 `<前缀>-long`
            // 还在。旧实现 `kill-session -t <前缀>` 会前缀匹配、把 `-long` 杀掉。
            let prefix = long.trim_end_matches(&format!("-long-{}", std::process::id()));
            let by_name = tmux_kill_session(prefix.to_string()).await;
            ensure(by_name.is_err(), "按名字结束现在应被拒，而不是去前缀匹配".into())?;
            // 不存在的 id 同样不能波及别人
            let _ = tmux_kill_session("$999999".into()).await;
            let list = tmux_list_sessions().await?;
            ensure(list.iter().any(|s| s.id == long_id), format!("{long} 不应被波及"))?;
            Ok(())
        }
        .await;
        cleanup_names(&[&long]).await;
        result.unwrap();
    }

    // === 关标签时识别"这个标签接着哪个 tmux 会话" ===

    fn client(pid: u32, id: &str, name: &str) -> TmuxClient {
        TmuxClient { pid, session_id: id.into(), session_name: name.into() }
    }

    #[test]
    fn ut_b36_解析客户端列表() {
        let out = format!(
            "{}\n{}\nbroken\n",
            ["4242", "$96", "work"].join(&FIELD_SEP.to_string()),
            ["4343", "$97", "other"].join(&FIELD_SEP.to_string()),
        );
        let cs = parse_clients(&out);
        assert_eq!(cs.len(), 2, "坏行应跳过");
        assert_eq!(cs[0].pid, 4242);
        assert_eq!(cs[0].session_id, "$96");
        assert_eq!(cs[1].session_name, "other");
    }

    #[test]
    fn ut_b37_客户端是_shell_的直接子进程时命中() {
        let parents = |p: u32| match p {
            4242 => Some(100),
            _ => None,
        };
        let got = find_client_session(&[client(4242, "$96", "work")], 100, parents);
        assert_eq!(got.map(|r| r.id), Some("$96".to_string()));
    }

    #[test]
    fn ut_b38_客户端隔着几层仍能命中() {
        // shell(100) → 中间进程(200) → tmux 客户端(4242)
        let parents = |p: u32| match p {
            4242 => Some(200),
            200 => Some(100),
            _ => None,
        };
        let got = find_client_session(&[client(4242, "$96", "work")], 100, parents);
        assert_eq!(got.map(|r| r.name), Some("work".to_string()));
    }

    #[test]
    fn ut_b39_多个客户端时只认自己标签下的那个() {
        // 别处终端里的客户端(5000) 不属于本标签的 shell(100)
        let parents = |p: u32| match p {
            5000 => Some(900),
            4242 => Some(100),
            _ => None,
        };
        let cs = [client(5000, "$1", "elsewhere"), client(4242, "$96", "mine")];
        let got = find_client_session(&cs, 100, parents);
        assert_eq!(got.map(|r| r.name), Some("mine".to_string()));
    }

    #[test]
    fn ut_b40_没有挂在该_shell_下的客户端时返回_none() {
        let parents = |p: u32| match p {
            5000 => Some(900),
            _ => None,
        };
        assert!(find_client_session(&[client(5000, "$1", "x")], 100, parents).is_none());
        assert!(find_client_session(&[], 100, |_| None).is_none());
    }

    #[test]
    fn ut_b41_父进程链出现环时不死循环() {
        // 防御：进程表是快照，理论上可能读到不一致的父子关系
        let parents = |p: u32| match p {
            4242 => Some(4343),
            4343 => Some(4242),
            _ => None,
        };
        assert!(find_client_session(&[client(4242, "$96", "w")], 100, parents).is_none());
    }

    /// 端到端（真实 tmux + 真实 PTY 会话）：在 aitm 的会话里敲 attach，应识别出接的是哪个。
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn ut_b42_端到端_识别标签里接入的_tmux_会话() {
        let _g = crate::test_env_lock::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if !tmux_available().await.unwrap_or(false) {
            return;
        }
        let name = format!("{E2E_PREFIX}-tab-{}", std::process::id());
        let mgr = crate::session::manager::SessionManager::new();

        let result: Result<(), String> = async {
            let tmux_id = tmux_new_session(name.clone(), None).await?;
            let sid = mgr
                .open(crate::session::SessionConfig {
                    shell: Some("/bin/sh".into()),
                    cols: 100,
                    rows: 30,
                    ..Default::default()
                })
                .await
                .map_err(|e| e.to_string())?;
            let shell_pid = mgr
                .get(sid)
                .await
                .map_err(|e| e.to_string())?
                .shell_pid()
                .ok_or("拿不到 shell pid")?;

            // 接入前：这个标签没接任何 tmux 会话
            ensure(
                session_of_shell(shell_pid).await.is_none(),
                "接入前不应识别出会话".into(),
            )?;

            let cmd = build_attach_command(tmux_bin(), &tmux_id, false)?;
            mgr.write(sid, format!("{cmd}\n").as_bytes())
                .await
                .map_err(|e| e.to_string())?;

            // 等客户端真的接上（最多 6 秒）
            let mut found = None;
            for _ in 0..60 {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                if let Some(r) = session_of_shell(shell_pid).await {
                    found = Some(r);
                    break;
                }
            }
            let r = found.ok_or("6 秒内没识别出接入的会话")?;
            ensure(r.id == tmux_id, format!("id 不符：{} vs {tmux_id}", r.id))?;
            ensure(r.name == name, format!("名字不符：{}", r.name))?;

            let _ = mgr.close(sid).await;
            // 关标签只断开客户端，会话本身应当还在
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            let list = tmux_list_sessions().await?;
            ensure(
                list.iter().any(|s| s.id == tmux_id),
                "关标签后 tmux 会话应当保留".into(),
            )?;
            Ok(())
        }
        .await;

        cleanup_names(&[&name]).await;
        result.unwrap();
    }

    // === 可执行文件解析（GUI 启动时 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin）===

    #[test]
    fn ut_b16_命中第一个存在的候选路径() {
        let exists = |p: &str| p == "/usr/local/bin/tmux";
        assert_eq!(
            resolve_bin("tmux", TMUX_CANDIDATES, exists),
            "/usr/local/bin/tmux"
        );
    }

    #[test]
    fn ut_b17_多个候选都存在时取列表里靠前的() {
        let exists = |p: &str| p == "/opt/homebrew/bin/tmux" || p == "/usr/bin/tmux";
        assert_eq!(
            resolve_bin("tmux", TMUX_CANDIDATES, exists),
            "/opt/homebrew/bin/tmux",
            "候选顺序应按常见程度排，Homebrew 优先于系统目录"
        );
    }

    #[test]
    fn ut_b18_一个候选都不存在时回退到裸名字() {
        // 回退是有意义的：dev 模式 / Linux 上 PATH 是全的，裸名字查得到；
        // 而且装在冷门位置时，让 spawn 自己去 PATH 上碰运气也比直接放弃好。
        assert_eq!(resolve_bin("tmux", TMUX_CANDIDATES, |_| false), "tmux");
    }

    #[test]
    fn ut_b19_候选列表覆盖两种_homebrew_前缀与_macports() {
        let joined = TMUX_CANDIDATES.join(" ");
        for must in [
            "/opt/homebrew/bin/tmux", // Apple Silicon Homebrew
            "/usr/local/bin/tmux",    // Intel Homebrew
            "/opt/local/bin/tmux",    // MacPorts
            "/usr/bin/tmux",          // 系统自带 / Linux 发行版
        ] {
            assert!(joined.contains(must), "候选列表缺少 {must}");
        }
    }

    #[test]
    fn ut_b20_本机装了_tmux_时解析结果是绝对路径_不依赖_path() {
        // 这条守的是本次修复的核心不变量：解析结果**不能**是裸名字，否则一旦
        // 从访达启动（PATH 只剩 /usr/bin:/bin:/usr/sbin:/sbin）就又找不到了。
        // 本机没装 tmux 时（CI / 别人的机器）这条自然不适用，跳过。
        let installed = TMUX_CANDIDATES
            .iter()
            .any(|p| std::path::Path::new(p).exists());
        if !installed {
            return;
        }
        let bin = tmux_bin();
        assert!(
            bin.starts_with('/'),
            "本机装着 tmux，应解析成绝对路径而不是裸名字，实际拿到 {bin:?}"
        );
    }

    // === 可用性探测（真跑本机，但只断言"不 panic + 返回布尔"）===

    #[tokio::test]
    async fn ut_b15_available_探测不报错也不_panic() {
        // 有无 tmux 都是合法结果（CI / 别人的机器上可能没装），
        // 所以这里断言的是"调用链跑得通且不返回错误"，不断言具体取值。
        tmux_available().await.expect("探测 tmux 可用性不应返回错误");
    }
}
