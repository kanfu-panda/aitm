//! 单个 PTY 会话的封装。

use std::collections::VecDeque;
#[cfg(unix)]
use std::fs;
use std::io::{Read, Write};
#[cfg(unix)]
use std::path::Path;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};
use std::thread;

use anyhow::{Context, Result};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
#[cfg(unix)]
use tempfile::TempDir;
use tokio::sync::mpsc;
use tokio::sync::Mutex;

use super::{default_shell, SessionConfig, SessionId};

/// 每个 session 保留的输出 ring buffer 上限（字节）。
/// 超过则从队首 drain 老数据，保证最多 64KB 常驻内存。
pub const RING_BUFFER_CAPACITY: usize = 64 * 1024;

/// 一条 PTY 会话。负责 spawn shell 子进程 + 暴露读写通道 + 维护输出 ring buffer。
pub struct Session {
    pub id: SessionId,
    /// PTY master 写句柄。前端输入字符走这里。
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    /// 后台读 task 把 PTY 输出 chunk 推到这个 channel。
    rx: Mutex<mpsc::UnboundedReceiver<Vec<u8>>>,
    /// 子进程 master，用来 resize / kill。
    master: Arc<Mutex<Box<dyn portable_pty::MasterPty + Send>>>,
    /// 输出 ring buffer：与 PTY 读线程共享，AI 工具读历史走这里。
    /// 用 std::sync::Mutex 是因为：读线程是 std::thread 不是 tokio task，
    /// 且持锁时间极短（单次 push_back / drain），不会跨 await 持有。
    buffer: Arc<StdMutex<VecDeque<u8>>>,
    /// 启动时记下 shell 子进程的 PID。用户在 shell 内 `cd` 改的就是这个进程
    /// 的 cwd，AI 工具用 [`current_cwd`] 实时查询，让 read_file / list_files
    /// 跟随用户当前所在目录而不是固定 HOME。
    /// `None`：portable-pty 没拿到 PID（理论不该发生，留 None 兼容）。
    shell_pid: Option<u32>,
    /// zsh 启动用的临时 ZDOTDIR（仅 Unix + shell 是 zsh 时设；用于消除
    /// PROMPT_SP 反白 % 标记 + 保留用户原 .zshrc 行为）。
    /// 字段持有所有权，session drop 时自动清理临时目录。
    /// Windows 上没有 zsh 场景，整字段都 cfg(unix) 掉，避免 TempDir 类型未用警告。
    #[cfg(unix)]
    #[allow(dead_code)]
    zsh_zdotdir: Option<TempDir>,
}

/// 检测给定 shell 路径是不是 zsh（按 basename 判断，兼容 /bin/zsh / /usr/local/bin/zsh 等）。
/// 只在 Unix 用：Windows 上不跑 zsh。
#[cfg(unix)]
fn is_zsh(shell: &str) -> bool {
    Path::new(shell)
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n == "zsh")
        .unwrap_or(false)
}

/// 给 zsh 启动准备临时 ZDOTDIR：写一个 wrapper .zshrc / .zshenv 先 source 用户
/// 原配置，再设 `PROMPT_EOL_MARK=""` 把"刚启动时左上角的反白 %"消掉。
///
/// **为什么需要**：xterm.js 没实现 OSC 633 之类的 prompt-boundary hint，zsh 默认
/// `PROMPT_SP` 选项会在每次画 prompt 前打 `PROMPT_EOL_MARK`（默认为反白 %）来"防止
/// 上行没换行导致 prompt 在半行字符上显示"。在 macOS Terminal.app / iTerm 里有
/// shell integration 协议消除这个标记，xterm.js 没有。aitm 通过 ZDOTDIR 注入
/// `PROMPT_EOL_MARK=""` 把它改空字符串，效果干净（prompt 行为不变，只是不显示 %）。
///
/// **保留用户配置的方式**：临时目录 .zshrc 第一行 `source` 用户原 ZDOTDIR/.zshrc
/// （不存在则 source ~/.zshrc），最后一行 `PROMPT_EOL_MARK=""`。.zshenv 同理。
/// 这样用户的 alias / functions / theme 都不受影响。
///
/// **平台限制**：仅在 Unix 下调用（Windows 不跑 zsh；调用前用 cfg(unix) 围栏）。
#[cfg(unix)]
fn prepare_zsh_zdotdir(cmd: &mut CommandBuilder) -> Result<TempDir> {
    // 用户原 ZDOTDIR 优先；否则 dirs::home_dir()（跨平台抽象，比直接读 HOME 稳）
    let original_dotdir = std::env::var("ZDOTDIR")
        .ok()
        .or_else(|| {
            dirs::home_dir()
                .and_then(|p| p.to_str().map(|s| s.to_string()))
        })
        .unwrap_or_default();

    let tmp = TempDir::new().context("创建临时 ZDOTDIR 失败")?;

    let zshrc_content = format!(
        "# aitm 临时 ZDOTDIR — 先 source 用户原 .zshrc 再消除 PROMPT_SP 反白 % 标记\n\
         [[ -f \"{orig}/.zshrc\" ]] && source \"{orig}/.zshrc\"\n\
         PROMPT_EOL_MARK=\"\"\n",
        orig = original_dotdir
    );
    fs::write(tmp.path().join(".zshrc"), zshrc_content).context("写临时 .zshrc 失败")?;

    let zshenv_content = format!(
        "# aitm 临时 ZDOTDIR — 仅做透传\n\
         [[ -f \"{orig}/.zshenv\" ]] && source \"{orig}/.zshenv\"\n",
        orig = original_dotdir
    );
    fs::write(tmp.path().join(".zshenv"), zshenv_content).context("写临时 .zshenv 失败")?;

    cmd.env("ZDOTDIR", tmp.path());
    Ok(tmp)
}

/// v0.9.1 HR3-1：把上次会话的 last_cwd 字符串解析成实际 PTY 启动目录。
///
/// - 路径存在且是目录 → 用它
/// - 路径不存在 / 是文件 / cfg 没给 → 回退到用户 HOME（[`dirs::home_dir`]
///   跨平台：Unix 读 `$HOME`，Windows 读 `%USERPROFILE%`）
/// - HOME 都没拿到 → `None`（让 portable-pty 走自己的默认）
///
/// 这条路径覆盖用户跨重启间删 / 移走了 last_cwd 目录的场景，避免 PTY
/// spawn 在不存在的目录里失败 / 报错。
fn resolve_initial_cwd(cwd: Option<&str>) -> Option<std::path::PathBuf> {
    cwd.map(std::path::Path::new)
        .filter(|p| p.is_dir())
        .map(|p| p.to_path_buf())
        .or_else(dirs::home_dir)
}

/// 给 PTY child 兜底 UTF-8 locale 环境变量。
///
/// **为什么需要**：macOS launchd 启动 .app 时不继承用户 shell 的 LANG，
/// PTY child 也跟着空 LANG → zsh 走 POSIX/ASCII 模式，UTF-8 多字节字符的
/// 尾字节（C1 范围 0x80-0x9F）显示成 `<00XX>` escape。中文输入法按 shift+`_`
/// 产生 EM DASH `—`（U+2014, UTF-8 0xE2 0x80 0x94）必现。
///
/// 修：缺失或为空 → fallback 到通用 UTF-8 locale。已设的尊重用户偏好不动。
fn ensure_utf8_locale(cmd: &mut CommandBuilder) {
    let lang_set = std::env::var("LANG")
        .ok()
        .map(|v| !v.is_empty())
        .unwrap_or(false);
    if !lang_set {
        cmd.env("LANG", "en_US.UTF-8");
    }
    let ctype_set = std::env::var("LC_CTYPE")
        .ok()
        .map(|v| !v.is_empty())
        .unwrap_or(false);
    if !ctype_set {
        cmd.env("LC_CTYPE", "UTF-8");
    }
    // LC_ALL 不主动设——它会强覆盖所有 LC_*，可能 override 用户其它偏好（如 LC_NUMERIC）
}

impl Session {
    /// 启动一个新会话，spawn 子 shell。
    pub fn spawn(cfg: SessionConfig) -> Result<Self> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: cfg.rows,
                cols: cfg.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("openpty 失败")?;

        // 决定要跑的 shell 与 cwd。
        // 优先级：SessionConfig.shell > 环境变量 $SHELL（Unix 习惯）> 平台默认值
        let shell = cfg
            .shell
            .or_else(|| std::env::var("SHELL").ok())
            .unwrap_or_else(default_shell);
        let mut cmd = CommandBuilder::new(&shell);
        // v0.9.1 HR3-1：cfg.cwd 是上次会话的 last_cwd 路径。用户可能在
        // 重启之间把目录删了 / 移走，此时 fallback 到 HOME 而不是让 PTY
        // 在不存在的目录里 spawn 失败。详见 [`resolve_initial_cwd`]。
        if let Some(cwd) = resolve_initial_cwd(cfg.cwd.as_deref()) {
            cmd.cwd(cwd);
        }
        // 让 shell 知道自己跑在终端里
        cmd.env("TERM", "xterm-256color");
        cmd.env("AITM", "1");
        // R11 修：.app 启动场景下 LANG / LC_CTYPE 缺失会让 zsh 走 POSIX 模式，
        // 中文输入法 EM DASH 等 UTF-8 多字节字符显示成 <00XX> escape。
        ensure_utf8_locale(&mut cmd);

        // zsh-only：临时 ZDOTDIR 注入消除启动时左上角的反白 % 标记。
        // Windows 上不跑 zsh，整个分支 cfg(unix) 跳过。
        #[cfg(unix)]
        let zsh_zdotdir = if is_zsh(&shell) {
            match prepare_zsh_zdotdir(&mut cmd) {
                Ok(t) => Some(t),
                Err(e) => {
                    // 临时目录创建失败不致命，回退到不改 ZDOTDIR（用户能看到 % 但不影响功能）
                    tracing::warn!("准备 zsh ZDOTDIR 失败，回退默认行为: {e}");
                    None
                }
            }
        } else {
            None
        };

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .context("spawn shell 子进程失败")?;
        // 抓 shell PID — 后面 child 会被 move 到 read thread，这里是最后机会
        let shell_pid = child.process_id();
        // slave 端 fd 已交给子进程，drop 掉父进程持有的句柄
        drop(pair.slave);

        let writer = pair.master.take_writer().context("拿不到 PTY writer")?;
        let mut reader = pair.master.try_clone_reader().context("拿不到 PTY reader")?;

        let (tx, rx) = mpsc::unbounded_channel::<Vec<u8>>();

        let buffer = Arc::new(StdMutex::new(VecDeque::with_capacity(RING_BUFFER_CAPACITY)));
        let buffer_for_thread = buffer.clone();

        // PTY read loop。portable-pty 是阻塞 IO，必须放到独立 std::thread。
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break, // EOF
                    Ok(n) => {
                        // 写入 ring buffer（持锁极短，立即释放）
                        push_to_buffer(&buffer_for_thread, &buf[..n]);
                        if tx.send(buf[..n].to_vec()).is_err() {
                            break; // 接收端关闭
                        }
                    }
                    Err(_) => break,
                }
            }
            // 子进程也回收一下，避免僵尸
            let _ = child.wait();
        });

        Ok(Self {
            id: SessionId::new(),
            writer: Arc::new(Mutex::new(writer)),
            rx: Mutex::new(rx),
            master: Arc::new(Mutex::new(pair.master)),
            buffer,
            shell_pid,
            #[cfg(unix)]
            zsh_zdotdir,
        })
    }

    /// 启动时记下的 shell 子进程 PID。`None`：portable-pty 没拿到 PID
    /// （理论不该发生，留 None 兼容）。给 IPC 层做"是否有子进程在跑"
    /// 之类的查询用。
    pub fn shell_pid(&self) -> Option<u32> {
        self.shell_pid
    }

    /// 实时查 shell 进程的当前 cwd（用户在 PTY 里 cd 后会反映到这）。
    /// 没拿到 PID 或进程已退出 / 平台不支持时返回 None。
    pub fn current_cwd(&self) -> Option<PathBuf> {
        let pid = self.shell_pid?;
        let mut sys = System::new();
        let pid = Pid::from_u32(pid);
        // 只刷新这一个进程，避免扫整个进程表（~5ms vs ~50ms+）
        sys.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[pid]),
            true,
            ProcessRefreshKind::nothing().with_cwd(sysinfo::UpdateKind::Always),
        );
        sys.process(pid).and_then(|p| p.cwd().map(|c| c.to_path_buf()))
    }

    /// 向 PTY 写字节（用户键入 / IPC `session_write`）。
    pub async fn write(&self, data: &[u8]) -> Result<()> {
        let mut guard = self.writer.lock().await;
        guard.write_all(data).context("PTY 写入失败")?;
        guard.flush().context("PTY flush 失败")?;
        Ok(())
    }

    /// 调整 PTY 行列数。
    pub async fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        let guard = self.master.lock().await;
        guard
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("PTY resize 失败")?;
        Ok(())
    }

    /// 非阻塞接收一段 PTY 输出 chunk（如果有）。
    pub async fn try_recv(&self) -> Option<Vec<u8>> {
        let mut rx = self.rx.lock().await;
        rx.try_recv().ok()
    }

    /// 阻塞等待下一段 PTY 输出。给 IPC 后台 forward task 用。
    pub async fn recv(&self) -> Option<Vec<u8>> {
        let mut rx = self.rx.lock().await;
        rx.recv().await
    }

    /// 返回 ring buffer 的最近 N 行（utf8 lossy 解码后按 `\n` 切）。
    /// 不足 N 行则全部返回。`n == 0` 返回空串。
    pub fn recent_output(&self, lines: usize) -> String {
        let snapshot = snapshot_buffer(&self.buffer);
        let text = String::from_utf8_lossy(&snapshot);
        last_n_lines(&text, lines)
    }

    /// 在自己的 ring buffer 里搜包含 query 的行，最多返回 `max_results` 条。
    pub fn search_buffer(&self, query: &str, max_results: usize) -> Vec<String> {
        if query.is_empty() || max_results == 0 {
            return Vec::new();
        }
        let snapshot = snapshot_buffer(&self.buffer);
        let text = String::from_utf8_lossy(&snapshot);
        text.lines()
            .filter(|line| line.contains(query))
            .take(max_results)
            .map(|s| s.to_string())
            .collect()
    }

    /// 测试钩子：直接喂数据到 ring buffer，不经过真实 PTY。
    /// 跨线程调用 PTY 读线程时也走 [`push_to_buffer`]。
    #[cfg(test)]
    pub(crate) fn inject_for_test(&self, data: &[u8]) {
        push_to_buffer(&self.buffer, data);
    }
}

/// 把 data 追加到 ring buffer，超过 [`RING_BUFFER_CAPACITY`] 时从队首丢弃旧字节。
fn push_to_buffer(buf: &StdMutex<VecDeque<u8>>, data: &[u8]) {
    let mut guard = buf.lock().expect("ring buffer 锁中毒");
    guard.extend(data.iter().copied());
    let len = guard.len();
    if len > RING_BUFFER_CAPACITY {
        let drop_n = len - RING_BUFFER_CAPACITY;
        guard.drain(..drop_n);
    }
}

/// 拷贝 ring buffer 当前内容到一个 Vec（避免长时间持锁）。
fn snapshot_buffer(buf: &StdMutex<VecDeque<u8>>) -> Vec<u8> {
    let guard = buf.lock().expect("ring buffer 锁中毒");
    let (a, b) = guard.as_slices();
    let mut out = Vec::with_capacity(a.len() + b.len());
    out.extend_from_slice(a);
    out.extend_from_slice(b);
    out
}

/// 从 text 末尾倒数 N 行返回。`n == 0` 返回空串。
fn last_n_lines(text: &str, n: usize) -> String {
    if n == 0 {
        return String::new();
    }
    let total: Vec<&str> = text.lines().collect();
    let start = total.len().saturating_sub(n);
    total[start..].join("\n")
}

#[cfg(test)]
mod ring_buffer_tests {
    use super::*;

    fn fresh_buf() -> Arc<StdMutex<VecDeque<u8>>> {
        Arc::new(StdMutex::new(VecDeque::with_capacity(RING_BUFFER_CAPACITY)))
    }

    #[test]
    fn ring_buffer_超_64kb_drain_front() {
        let buf = fresh_buf();
        let chunk = vec![b'A'; 1024];
        for _ in 0..70 {
            push_to_buffer(&buf, &chunk);
        }
        assert_eq!(
            buf.lock().unwrap().len(),
            RING_BUFFER_CAPACITY,
            "应被截到 64KB"
        );
    }

    #[test]
    fn ring_buffer_保留最新尾部数据() {
        let buf = fresh_buf();
        push_to_buffer(&buf, &vec![b'X'; RING_BUFFER_CAPACITY]);
        push_to_buffer(&buf, b"END_MARKER");
        let bytes = snapshot_buffer(&buf);
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.ends_with("END_MARKER"));
        assert_eq!(bytes.len(), RING_BUFFER_CAPACITY);
    }

    #[test]
    fn last_n_lines_返回尾部_n_行() {
        let text = "line1\nline2\nline3\nline4\nline5";
        assert_eq!(last_n_lines(text, 2), "line4\nline5");
        assert_eq!(
            last_n_lines(text, 100),
            "line1\nline2\nline3\nline4\nline5"
        );
        assert_eq!(last_n_lines(text, 0), "");
    }

    #[test]
    fn last_n_lines_忽略尾部空行() {
        // text.lines() 不会产生末尾空字符串，所以 5 行带尾换行也是 5 行
        let text = "a\nb\nc\nd\ne\n";
        assert_eq!(last_n_lines(text, 2), "d\ne");
    }
}

#[cfg(all(test, unix))]
mod zsh_zdotdir_tests {
    use super::*;

    #[test]
    fn is_zsh_basename_检测() {
        assert!(is_zsh("/bin/zsh"));
        assert!(is_zsh("/usr/local/bin/zsh"));
        assert!(is_zsh("zsh"));
        assert!(!is_zsh("/bin/bash"));
        assert!(!is_zsh("/usr/local/bin/fish"));
        assert!(!is_zsh("/bin/sh"));
        // 真假识别防误判：zshrc 不是 zsh，含 zsh 子串但 basename 不等
        assert!(!is_zsh("/bin/zshrc"));
        assert!(!is_zsh("/bin/myzsh"));
    }

    #[test]
    fn prepare_zsh_zdotdir_写入_zshrc_含_prompt_eol_mark() {
        let mut cmd = CommandBuilder::new("/bin/zsh");
        let tmp = prepare_zsh_zdotdir(&mut cmd).unwrap();

        let zshrc = fs::read_to_string(tmp.path().join(".zshrc")).unwrap();
        assert!(zshrc.contains("PROMPT_EOL_MARK=\"\""), "实际 zshrc:\n{zshrc}");
        // 确认 wrapper source 了用户原 .zshrc
        assert!(zshrc.contains("source"), "实际 zshrc:\n{zshrc}");
        assert!(zshrc.contains(".zshrc"), "实际 zshrc:\n{zshrc}");

        // .zshenv 也要存在以保证 zsh 启动时透传环境变量
        let zshenv = fs::read_to_string(tmp.path().join(".zshenv")).unwrap();
        assert!(zshenv.contains(".zshenv"));
    }
}

#[cfg(test)]
mod utf8_locale_tests {
    use super::*;
    use std::collections::HashMap;

    /// 临时改 env 后退出作用域自动还原，避免影响其它测试。
    /// SAFETY：调用前已持 ENV_LOCK，单线程修改 env，符合 set_var 安全前提。
    struct EnvGuard {
        key: &'static str,
        prev: Option<String>,
    }

    impl EnvGuard {
        fn set(key: &'static str, value: &str) -> Self {
            let prev = std::env::var(key).ok();
            // SAFETY: ENV_LOCK 串行 + 单线程
            unsafe { std::env::set_var(key, value) };
            Self { key, prev }
        }

        fn unset(key: &'static str) -> Self {
            let prev = std::env::var(key).ok();
            // SAFETY: ENV_LOCK 串行 + 单线程
            unsafe { std::env::remove_var(key) };
            Self { key, prev }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            // SAFETY: ENV_LOCK 串行 + 单线程
            unsafe {
                match self.prev.take() {
                    Some(v) => std::env::set_var(self.key, v),
                    None => std::env::remove_var(self.key),
                }
            }
        }
    }

    /// 抓 cmd 上**显式**通过 `cmd.env(...)` 设过的 env（不含 portable-pty
    /// 自动从父进程继承的 base env）。判"是否主动写入"只能用这个。
    fn extra_env(cmd: &CommandBuilder) -> HashMap<String, String> {
        cmd.iter_extra_env_as_str()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn lang_已设非空_不覆盖() {
        let _guard = crate::test_env_lock::ENV_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let _lang = EnvGuard::set("LANG", "zh_CN.UTF-8");
        let _ctype = EnvGuard::unset("LC_CTYPE");

        let mut cmd = CommandBuilder::new("/bin/zsh");
        ensure_utf8_locale(&mut cmd);

        let extras = extra_env(&cmd);
        // LANG 已设非空 → 不主动写入（让用户偏好生效）
        assert!(!extras.contains_key("LANG"), "已设 LANG 不应被覆盖");
        // LC_CTYPE 未设 → fallback
        assert_eq!(extras.get("LC_CTYPE").map(String::as_str), Some("UTF-8"));
    }

    #[test]
    fn lang_空_fallback_到_en_us_utf8() {
        let _guard = crate::test_env_lock::ENV_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let _lang = EnvGuard::set("LANG", "");
        let _ctype = EnvGuard::set("LC_CTYPE", "");

        let mut cmd = CommandBuilder::new("/bin/zsh");
        ensure_utf8_locale(&mut cmd);

        let extras = extra_env(&cmd);
        assert_eq!(
            extras.get("LANG").map(String::as_str),
            Some("en_US.UTF-8"),
            "空 LANG 应 fallback"
        );
        assert_eq!(
            extras.get("LC_CTYPE").map(String::as_str),
            Some("UTF-8"),
            "空 LC_CTYPE 应 fallback"
        );
    }

    #[test]
    fn lang_缺失_fallback_到_en_us_utf8() {
        let _guard = crate::test_env_lock::ENV_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let _lang = EnvGuard::unset("LANG");
        let _ctype = EnvGuard::unset("LC_CTYPE");

        let mut cmd = CommandBuilder::new("/bin/zsh");
        ensure_utf8_locale(&mut cmd);

        let extras = extra_env(&cmd);
        assert_eq!(
            extras.get("LANG").map(String::as_str),
            Some("en_US.UTF-8")
        );
        assert_eq!(extras.get("LC_CTYPE").map(String::as_str), Some("UTF-8"));
    }

    #[test]
    fn lc_ctype_已设非空_不覆盖() {
        let _guard = crate::test_env_lock::ENV_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let _lang = EnvGuard::unset("LANG");
        let _ctype = EnvGuard::set("LC_CTYPE", "zh_CN.UTF-8");

        let mut cmd = CommandBuilder::new("/bin/zsh");
        ensure_utf8_locale(&mut cmd);

        let extras = extra_env(&cmd);
        // LANG 缺 → fallback
        assert_eq!(
            extras.get("LANG").map(String::as_str),
            Some("en_US.UTF-8")
        );
        // LC_CTYPE 已设非空 → 不主动写入
        assert!(
            !extras.contains_key("LC_CTYPE"),
            "已设 LC_CTYPE 不应被覆盖"
        );
    }

    #[test]
    fn 不主动设_lc_all() {
        let _guard = crate::test_env_lock::ENV_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let _lang = EnvGuard::unset("LANG");
        let _ctype = EnvGuard::unset("LC_CTYPE");

        let mut cmd = CommandBuilder::new("/bin/zsh");
        ensure_utf8_locale(&mut cmd);

        let extras = extra_env(&cmd);
        // LC_ALL 永远不主动写（避免覆盖 LC_NUMERIC 等用户偏好）
        assert!(
            !extras.contains_key("LC_ALL"),
            "LC_ALL 不应被主动写入，extras: {extras:?}"
        );
    }
}

/// v0.9.1 HR3-1：last_cwd 路径解析单测。
#[cfg(test)]
mod resolve_initial_cwd_tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn cwd_none_fallback_到_home_或_none() {
        // cfg.cwd 没给 → fallback 到 HOME（CI/本地通常都有 HOME）
        // 极端 case HOME 也拿不到时返 None，PTY 走 portable-pty 自己的默认
        let r = resolve_initial_cwd(None);
        if let Some(home) = dirs::home_dir() {
            assert_eq!(r, Some(home));
        } else {
            assert!(r.is_none());
        }
    }

    #[test]
    fn cwd_存在的目录_保留() {
        let tmp = TempDir::new().unwrap();
        let path_str = tmp.path().to_string_lossy().to_string();
        let r = resolve_initial_cwd(Some(&path_str));
        assert_eq!(r.as_deref(), Some(tmp.path()));
    }

    #[test]
    fn cwd_不存在的路径_fallback_到_home() {
        let tmp = TempDir::new().unwrap();
        // tmp drop 前路径有效；这里手动构造一个保证不存在的子路径
        let ghost = tmp.path().join("nope-this-dir-does-not-exist");
        let ghost_str = ghost.to_string_lossy().to_string();
        let r = resolve_initial_cwd(Some(&ghost_str));
        // 不存在 → 不应是 ghost，应当 fallback（HOME 或 None）
        assert_ne!(r.as_deref(), Some(ghost.as_path()));
        if let Some(home) = dirs::home_dir() {
            assert_eq!(r, Some(home));
        }
    }

    #[test]
    fn cwd_指向文件_fallback_到_home() {
        let tmp = TempDir::new().unwrap();
        let file = tmp.path().join("a.txt");
        std::fs::write(&file, "x").unwrap();
        let file_str = file.to_string_lossy().to_string();
        let r = resolve_initial_cwd(Some(&file_str));
        // 是文件不是目录 → 不应保留，应 fallback
        assert_ne!(r.as_deref(), Some(file.as_path()));
        if let Some(home) = dirs::home_dir() {
            assert_eq!(r, Some(home));
        }
    }

    #[test]
    fn cwd_空字符串_fallback_到_home() {
        // 前端给 "" 时 Path::new("") .is_dir() → false → fallback
        let r = resolve_initial_cwd(Some(""));
        if let Some(home) = dirs::home_dir() {
            assert_eq!(r, Some(home));
        } else {
            assert!(r.is_none());
        }
    }
}

/// 端到端 ring buffer + 公共 API 测试（基于真实 PTY）。
/// hardcode `/bin/sh` — Unix-only 测试集，Windows target 跳过。
#[cfg(all(test, unix))]
mod e2e_tests {
    use super::*;
    use crate::session::manager::SessionManager;
    use std::time::Duration;

    /// 起一个真实 sh 子进程，跑命令产出输出，验证 ring buffer 抓得到。
    #[tokio::test]
    async fn 真实_pty_输出落入_ring_buffer() {
        let mgr = SessionManager::new();
        let cfg = SessionConfig {
            shell: Some("/bin/sh".to_string()),
            cols: 80,
            rows: 24,
            ..Default::default()
        };
        let id = mgr.open(cfg).await.unwrap();
        mgr.write(id, b"echo aitm-ring-buffer-marker\n").await.unwrap();
        mgr.write(id, b"exit\n").await.unwrap();

        // 给 PTY 时间生产输出 + 读线程把数据塞 buffer
        let timeout = tokio::time::Instant::now() + Duration::from_secs(3);
        let mut found = false;
        while tokio::time::Instant::now() < timeout {
            // 把 channel 里的数据消费掉，触发 buffer 写入路径
            let _ = mgr.try_recv(id).await;
            let session = mgr.get(id).await.unwrap();
            if session
                .recent_output(50)
                .contains("aitm-ring-buffer-marker")
            {
                found = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(found, "ring buffer 应记录 echo 输出");
    }

    /// v0.9.1 HR3-1：cfg.cwd 指向真实目录 → PTY 启动后 pwd 输出该目录路径。
    #[tokio::test]
    async fn pty_启动后_pwd_反映_cfg_cwd() {
        let tmp = TempDir::new().unwrap();
        // canonicalize 是因为 macOS 上 /tmp 是 /private/tmp 的 symlink，
        // 子 shell 报告的 pwd 是物理路径。
        let tmp_canon = tmp.path().canonicalize().unwrap();
        let mgr = SessionManager::new();
        let cfg = SessionConfig {
            shell: Some("/bin/sh".to_string()),
            cwd: Some(tmp_canon.to_string_lossy().to_string()),
            cols: 80,
            rows: 24,
        };
        let id = mgr.open(cfg).await.unwrap();
        mgr.write(id, b"pwd\n").await.unwrap();
        mgr.write(id, b"exit\n").await.unwrap();

        let timeout = tokio::time::Instant::now() + Duration::from_secs(3);
        let mut received = Vec::new();
        while tokio::time::Instant::now() < timeout {
            if let Some(bytes) = mgr.try_recv(id).await {
                received.extend_from_slice(&bytes);
            } else {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
        let text = String::from_utf8_lossy(&received);
        let expected = tmp_canon.to_string_lossy();
        assert!(
            text.contains(expected.as_ref()),
            "期望 pwd 输出包含 {expected:?}，实际收到：{text:?}"
        );
    }

    #[tokio::test]
    async fn search_buffer_命中关键字() {
        let mgr = SessionManager::new();
        let cfg = SessionConfig {
            shell: Some("/bin/sh".to_string()),
            cols: 80,
            rows: 24,
            ..Default::default()
        };
        let id = mgr.open(cfg).await.unwrap();
        mgr.write(id, b"echo banana-keyword-1234\n").await.unwrap();
        mgr.write(id, b"exit\n").await.unwrap();

        let timeout = tokio::time::Instant::now() + Duration::from_secs(3);
        let mut hits = Vec::new();
        while tokio::time::Instant::now() < timeout {
            let _ = mgr.try_recv(id).await;
            let session = mgr.get(id).await.unwrap();
            hits = session.search_buffer("banana-keyword-1234", 10);
            if !hits.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(!hits.is_empty(), "search 应找到 echo 出来的关键字");
    }
}
