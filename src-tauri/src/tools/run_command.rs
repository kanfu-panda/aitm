//! run_command 工具：在指定终端 tab 执行命令。
//!
//! 风险等级 = High（永远要用户确认）。1E-1 不接 L2 启发式，所以 sudo / git
//! push --force 这类灰色命令也是 High（弹默认聚焦"取消"的对话框）。
//! 1E-2 引入 L2 风险评分后，部分 High 会升 Destructive。
//!
//! ## v1.3.0 T1：真实的命令结束检测 + 退出码
//!
//! 旧实现写完命令**固定盲等 5 秒**就返回（源码注释里"1E-2 改 prompt 检测"的 TODO
//! 从未兑现）：`pip install` / `python -m venv` 这类长命令根本没跑完，AI 拿到半截
//! 输出、且完全不知道成功与否 → 误判、重复执行、基于错误前提继续干活。
//!
//! 现在改用 [`crate::session::sentinel`] 的私有 OSC 标记法：命令跑完由 shell 自己
//! `printf` 一个带 `$?` 的私有 OSC 序列，后端轮询 ring buffer 扫到它 = 命令真结束，
//! 同时拿到**真实退出码**，明确写进给 LLM 的内容（`[退出码: N]`）。
//!
//! ## v1.3.0 P1：改用 shell 钩子，消除命令回显
//!
//! T1 的标记法靠**包装命令**（`eval '<原命令>'; printf '<OSC>'`）来发标记 ——
//! OSC 本身用户看不见，但**包装后的命令行会被终端原样回显**，满屏
//! `eval '...'; printf '\033]6969;...'`；包装后的整行还会进 shell history。
//!
//! P1 起默认走 `ExecMode::Hook`：命令**一个字都不改**写进 PTY，由启动时注入的
//! shell integration 钩子（见 [`crate::session::shell_hook`]）在每条命令开始 / 结束
//! 时自动发标记。三条路径按 `decide_mode` 选：
//!
//! | 模式 | 适用 | 回显噪音 | 退出码 |
//! |---|---|---|---|
//! | `ExecMode::Hook` | zsh / bash 且钩子生效 | 无 | 有 |
//! | `ExecMode::Wrap` | 其它 POSIX shell / 钩子失效 | 有 | 有 |
//! | `ExecMode::Blind` | fish / cmd.exe | 无 | 未知 |
//!
//! **fallback 链**：钩子模式下等不到命令开始标记（用户 rc 冲掉了钩子等），最多等
//! `HOOK_GRACE` 就降级并把该 session 标记为无钩子 —— 绝不允许劣化成"每条命令都
//! 熬到 `MAX_WAIT` 超时"。
//!
//! **执行顺序（安全红线）**：sentinel 包装（仅 Wrap 模式）发生在本文件的 `execute` 内，
//! **晚于** `tool_loop` 的 L1 黑名单 / L2 风险分级 / L3 白名单 / L4 审批四层门 ——
//! 那四层看到的始终是 LLM 给的原始 `cmd`。顺序不能颠倒：包装串含 `;` `$` 等元字符，
//! 白名单的元字符防注入规则会让所有命令都不命中。

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};

use super::ansi::strip_for_llm;
use super::{RiskClass, Tool, ToolContext, ToolError, ToolResult};
use crate::session::sentinel;

/// 等命令结束的最长时间。超时不谎报失败，而是明确告诉 AI"仍在运行"。
///
/// 120s 的取舍：覆盖绝大多数 `pip install` / `cargo build` / `npm i`；再长的
/// （完整构建、大模型下载）交给 AI 之后用 `get_terminal_history` 复查。
const MAX_WAIT: std::time::Duration = std::time::Duration::from_secs(120);
/// 非 POSIX shell（cmd.exe / fish 等，不能安全注入 sentinel）的盲等时间。
/// 保持旧行为，只是把"退出码未知"如实说清楚。
const LEGACY_BLIND_WAIT: std::time::Duration = std::time::Duration::from_secs(5);
/// 钩子模式下等 `aitm-exec`（命令开始标记）的上限。
///
/// **fallback 链的关键常量**：钩子在提示符一出现就已经装好，`preexec` 是命令一开始
/// 就触发的，正常情况几十毫秒内就能看到。等满这个时间还没有 = 钩子没生效
/// （用户 rc 冲掉了钩子 / 前台还挂着别的程序），立刻降级，**绝不允许**拖到
/// [`MAX_WAIT`] —— 那会变成"每条命令都熬 120s"的静默劣化。
/// 取值与 [`LEGACY_BLIND_WAIT`] 齐平：最坏情况也不比旧的盲等慢。
const HOOK_GRACE: std::time::Duration = std::time::Duration::from_secs(5);
/// 扫 sentinel 的起始轮询间隔。短命令能在 ~50ms 内返回。
const POLL_MIN: std::time::Duration = std::time::Duration::from_millis(50);
/// 轮询间隔退避上限。长命令期间降到 500ms 一次，避免反复拷 64KB ring buffer。
const POLL_MAX: std::time::Duration = std::time::Duration::from_millis(500);
/// 输出截断上限（避免 LLM 上下文爆炸）。
const MAX_OUTPUT_BYTES: usize = 2_000;
/// 拍快照时拉的最大行数（recent_output 上限语义为"最近 N 行"，
/// 用一个足够大的值近似"全部"，避免传 usize::MAX 让人误读）。
const SNAPSHOT_LINES: usize = 10_000;

pub struct RunCommandTool;

#[derive(Deserialize)]
struct Args {
    /// LLM 可选传 UUID；不传 / 传 "current" / "default" / "" → 用 ctx.active_session_id
    #[serde(default)]
    session_id: Option<String>,
    cmd: String,
}

/// 把 LLM 传的 session_id 解析成真实 UUID 字符串。
/// 兜底规则：缺 / "current" / "default" / "" 都视为"用当前活跃 tab"。
fn resolve_session_id(arg: Option<&str>, ctx: &ToolContext) -> Result<String, ToolError> {
    let trimmed = arg.unwrap_or("").trim();
    let needs_fallback = matches!(trimmed, "" | "current" | "default" | "active" | "main");
    if needs_fallback {
        return ctx
            .active_session_id
            .clone()
            .ok_or_else(|| ToolError::SessionNotFound(
                "无活跃 tab —— 用户需要先打开一个终端 tab".into(),
            ));
    }
    Ok(trimmed.to_string())
}

/// 一次命令执行的结局。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CmdOutcome {
    /// 扫到 sentinel，命令真结束，带真实退出码。
    Finished(i32),
    /// 等到 [`MAX_WAIT`] 仍没等到 sentinel —— 命令**还在跑**（不是失败）。
    Timeout,
    /// 当前 shell 不支持 sentinel 注入（cmd.exe / fish 等），只能盲等，退出码未知。
    Unknown,
    /// 钩子模式下等不到命令开始标记 —— 钩子没生效。命令**已经写进 PTY 跑了**
    /// （没法撤回重来），所以本次只能如实说退出码未知；同时把该 session 的钩子
    /// 标记为失效，下一条命令自动退回包装法。
    HookLost,
}

/// 一次命令的执行方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExecMode {
    /// shell integration 钩子模式：命令**原样**写进 PTY（零回显噪音、history 干净），
    /// 退出码靠 shell 钩子在命令结束时自动发的私有 OSC 拿。
    Hook,
    /// sentinel 包装法：把命令包成 `eval '...'; printf '<OSC>'`。有回显噪音，
    /// 但对任意 POSIX shell 都能工作 —— 钩子不可用时的兜底。
    Wrap,
    /// 盲等：fish / cmd.exe 这类既没钩子也不能安全包装的 shell，等固定时间，
    /// 如实告诉 AI 退出码未知。
    Blind,
}

/// 选执行方式。钩子只给 zsh / bash 注入（都是 POSIX shell），所以两个条件
/// 同时成立才走钩子；非 POSIX shell 无论如何都不能被包装（会破坏用户命令）。
fn decide_mode(hook_ready: bool, posix_shell: bool) -> ExecMode {
    match (hook_ready, posix_shell) {
        (true, true) => ExecMode::Hook,
        (false, true) => ExecMode::Wrap,
        (_, false) => ExecMode::Blind,
    }
}

/// 组装给 LLM 的最终内容。
///
/// 三种结局的措辞都要让 AI **无歧义**地知道命令到底成没成：
/// - 结束 → `[退出码: N]`
/// - 超时 → "仍在运行中"，且**绝不**编造退出码
/// - 不支持 → 明说"退出码未知"
fn build_content(output: &str, outcome: CmdOutcome, truncated: bool) -> String {
    let mut parts: Vec<String> = Vec::new();

    if output.trim().is_empty() {
        parts.push("[命令无输出]".to_string());
    } else {
        parts.push(output.trim_end().to_string());
    }

    if truncated {
        parts.push(format!(
            "[输出过长已截断到前 {MAX_OUTPUT_BYTES} 字节；输出可能未完整]"
        ));
    }

    match outcome {
        CmdOutcome::Finished(code) => parts.push(format!("[退出码: {code}]")),
        CmdOutcome::Timeout => parts.push(format!(
            "[命令仍在运行中，已等待 {}s；输出可能不完整，可稍后再调 get_terminal_history 查看]",
            MAX_WAIT.as_secs()
        )),
        CmdOutcome::Unknown => parts.push(format!(
            "[当前 shell 不支持命令结束检测，已等待 {}s；退出码未知，输出可能不完整]",
            LEGACY_BLIND_WAIT.as_secs()
        )),
        CmdOutcome::HookLost => parts.push(format!(
            "[终端 shell 钩子未生效，本次退出码未知（已等待 {}s，输出可能不完整）；\
             已自动降级为兼容模式，下一条命令起会重新带回退出码]",
            HOOK_GRACE.as_secs()
        )),
    }

    parts.join("\n\n")
}

/// 轮询 ring buffer 等 sentinel 出现，拿到退出码。
///
/// 轮询而非事件订阅：ring buffer 存的就是 PTY 原始字节，`recent_output` 已是现成
/// 通道；走事件要给 forward task 加待匹配 ID 注册表 + oneshot 回调，为一个工具引入
/// 跨模块状态不划算（YAGNI）。间隔从 50ms 指数退避到 500ms，短命令低延迟、长命令低开销。
async fn wait_for_sentinel(
    ctx: &ToolContext,
    session_id: &str,
    req_id: &str,
) -> CmdOutcome {
    let deadline = std::time::Instant::now() + MAX_WAIT;
    let mut interval = POLL_MIN;
    loop {
        tokio::time::sleep(interval).await;

        if let Some(text) = ctx
            .session_state
            .recent_output(session_id, SNAPSHOT_LINES)
            .await
        {
            if let Some(code) = sentinel::scan_exit_code(&text, req_id) {
                return CmdOutcome::Finished(code);
            }
        }

        if std::time::Instant::now() >= deadline {
            return CmdOutcome::Timeout;
        }
        interval = interval.mul_f32(1.5).min(POLL_MAX);
    }
}

/// 钩子模式的等待：两阶段。
///
/// **阶段 1（防串台 + fallback 探测）**：等 `preexec` 发的 `aitm-exec` 标记，且
/// **命令行原文要对得上**我们刚写进去的那条。钩子在每个提示符都会触发（用户手动敲的
/// 命令也会发），只按"下一个标记"配对会串到别人的退出码上；按命令行比对才安全。
/// 等满 [`HOOK_GRACE`] 还没有 → 钩子没生效，返回 [`CmdOutcome::HookLost`] 交给
/// 调用方降级（**不会**拖到 [`MAX_WAIT`]）。
///
/// **阶段 2**：等同序号的 `aitm-end` 标记拿退出码。序号在一个 shell 会话内单调
/// 递增且唯一，所以扫全缓冲区也不会串台。这一阶段才允许等到 [`MAX_WAIT`]
/// （长命令是正常现象）。
async fn wait_for_hook(
    ctx: &ToolContext,
    session_id: &str,
    cmd: &str,
    base_seq: u64,
) -> CmdOutcome {
    let grace_deadline = std::time::Instant::now() + HOOK_GRACE;
    let mut interval = POLL_MIN;
    let mut matched_seq = None;
    loop {
        tokio::time::sleep(interval).await;
        if let Some(text) = ctx
            .session_state
            .recent_output(session_id, SNAPSHOT_LINES)
            .await
        {
            if let Some(seq) = sentinel::scan_exec_seq(&text, cmd, base_seq) {
                matched_seq = Some(seq);
                break;
            }
        }
        if std::time::Instant::now() >= grace_deadline {
            break;
        }
        interval = interval.mul_f32(1.5).min(POLL_MAX);
    }
    let Some(seq) = matched_seq else {
        return CmdOutcome::HookLost;
    };

    let deadline = std::time::Instant::now() + MAX_WAIT;
    let mut interval = POLL_MIN;
    loop {
        if let Some(text) = ctx
            .session_state
            .recent_output(session_id, SNAPSHOT_LINES)
            .await
        {
            if let Some(code) = sentinel::scan_end_code(&text, seq) {
                return CmdOutcome::Finished(code);
            }
        }
        if std::time::Instant::now() >= deadline {
            return CmdOutcome::Timeout;
        }
        tokio::time::sleep(interval).await;
        interval = interval.mul_f32(1.5).min(POLL_MAX);
    }
}

#[async_trait]
impl Tool for RunCommandTool {
    fn name(&self) -> &str {
        "run_command"
    }

    fn description(&self) -> &str {
        "在指定终端 tab 执行命令，等命令**真正结束**后返回输出 + 退出码。\
         **退出码由系统自动附在结果末尾**（`[退出码: 0]` = 成功，非 0 = 失败），\
         务必据此判断而不要臆测。因此**不要**在命令里自己拼 `; echo $?` / \
         `echo \"---exit: $?\"` 之类来问退出码 —— 系统已经给你了，自己再 echo 只会污染输出。\
         命令超过 120 秒未结束时会返回「仍在运行中」标注（此时不代表失败）。\
         会询问用户确认（除非命中信任白名单）。"
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "session_id": {
                    "type": "string",
                    "description": "目标终端 tab 的 session UUID。**绝大多数情况留空或省略**，系统会自动用当前活跃 tab。"
                },
                "cmd": {
                    "type": "string",
                    "description": "要执行的 shell 命令，**不要**附换行（系统会自动加）；\
                        也**不要**追加 `; echo $?` / `echo \"---exit: $?\"` 这类退出码回显 —— \
                        系统会自动在结果末尾附上 `[退出码: N]`，自己 echo 只会污染输出"
                }
            },
            "required": ["cmd"]
        })
    }

    fn risk_class(&self, args: &Value) -> RiskClass {
        // 1E-2：委托给 safety::risk::classify 做静态启发式分级。
        // 注意：tool_loop 的主路径会单独走 safety::risk::classify 拿到 reason 字段
        // 喂给 EventSink；这里返回的值给"非 run_command 路径"或测试用，保持语义一致
        // （没解析到 cmd 时降级 High，保守不失败）。
        let cmd = args.get("cmd").and_then(|v| v.as_str()).unwrap_or("");
        if cmd.is_empty() {
            return RiskClass::High;
        }
        crate::safety::risk::classify(cmd).risk
    }

    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<ToolResult, ToolError> {
        let parsed: Args = serde_json::from_value(args)
            .map_err(|e| ToolError::InvalidArgs(format!("run_command 参数: {e}")))?;

        // 命令不能含换行符（一行一条）
        if parsed.cmd.contains('\n') {
            return Err(ToolError::InvalidArgs(
                "cmd 不能含换行符（一次只能跑一条命令）".into(),
            ));
        }

        // 解析 session_id：LLM 可能传 "default"/"current" 等占位符，统一兜底到 active tab
        let session_id = resolve_session_id(parsed.session_id.as_deref(), ctx)?;

        // 拍快照：执行前的 ring buffer 内容，用来 diff 出新增部分
        let before = ctx
            .session_state
            .recent_output(&session_id, SNAPSHOT_LINES)
            .await
            .ok_or_else(|| ToolError::SessionNotFound(session_id.clone()))?;
        let before_len = before.len();

        // 决定执行方式（详见 [`ExecMode`]）：
        // - 钩子模式：命令原样写进去，零回显噪音（v1.3.0 P1 的目标）
        // - 包装法：只有 POSIX 系 shell 认 `eval` + `$?` + `printf`
        // - 盲等：cmd.exe 把 `;` 当参数分隔符、fish 不认 `$?` —— 包了会让用户命令
        //   **根本跑不起来**，宁可退回盲等也不能破坏原命令（红线）
        let shell = ctx
            .session_state
            .shell_of(&session_id)
            .await
            .unwrap_or_default();
        let posix_shell = sentinel::is_posix_shell(&shell);

        // 写命令**之前**先记下已出现过的最大钩子序号：之后只认序号更大的标记，
        // ring buffer 里残留的历史标记（包括 AI 上一次跑同一条命令留下的）不会串台。
        let base_seq = sentinel::scan_max_seq(&before);
        // 钩子状态：被降级过、但缓冲区里仍有钩子标记 → 说明上次只是被前台程序挡了一下，
        // 重新启用，避免整个会话被永久钉死在有回显噪音的包装法上。
        let hook_ready = if ctx.session_state.hook_active(&session_id).await {
            true
        } else if base_seq > 0 {
            ctx.session_state.enable_hook(&session_id).await;
            true
        } else {
            false
        };
        let mode = decide_mode(hook_ready, posix_shell);
        let req_id = sentinel::new_request_id();

        // 写命令 + 换行到 PTY stdin。⚠️ 包装（仅 Wrap 模式）在这里发生 —— 四层安全门
        // 早已在 tool_loop 里对**原始 cmd** 判完（详见模块文档）。
        let line = match mode {
            ExecMode::Wrap => sentinel::wrap_command(&parsed.cmd, &req_id),
            // 钩子模式 / 盲等模式：命令一个字都不改
            ExecMode::Hook | ExecMode::Blind => parsed.cmd.clone(),
        };
        let payload = format!("{line}\n");
        ctx.session_state
            .write_input(&session_id, payload.as_bytes())
            .await
            .map_err(|e| ToolError::Exec(format!("写入 PTY 失败: {e}")))?;

        let outcome = match mode {
            ExecMode::Hook => {
                let o = wait_for_hook(ctx, &session_id, &parsed.cmd, base_seq).await;
                if o == CmdOutcome::HookLost {
                    // fallback 链：本次已无法补救（命令已经跑了），但把钩子标记为失效，
                    // 下一条命令自动走包装法 —— 绝不会每条命令都熬到 120s。
                    ctx.session_state.disable_hook(&session_id).await;
                }
                o
            }
            ExecMode::Wrap => wait_for_sentinel(ctx, &session_id, &req_id).await,
            ExecMode::Blind => {
                tokio::time::sleep(LEGACY_BLIND_WAIT).await;
                CmdOutcome::Unknown
            }
        };

        let after = ctx
            .session_state
            .recent_output(&session_id, SNAPSHOT_LINES)
            .await
            .ok_or_else(|| ToolError::SessionNotFound(session_id.clone()))?;

        // diff：取 before 之后新增的部分
        let raw_new: String = if after.len() > before_len && after.starts_with(&before) {
            after[before_len..].to_string()
        } else {
            // ring buffer 可能 drain 过 → 没法精确 diff，返回最近 50 行做兜底
            ctx.session_state
                .recent_output(&session_id, 50)
                .await
                .unwrap_or_default()
        };

        // 关键：剥 ANSI 转义 + 控制字符 + 折叠空行，否则 LLM 看不懂 PTY 噪音。
        // sentinel 本体是标准 OSC 序列，被这里的 OSC 规则一并剥掉。
        let stripped = strip_for_llm(&raw_new);
        // 包装法下终端把我们写进 stdin 的整行命令**原样回显**了，其中
        // `printf '\033]6969;…'` 是字面文本（不是真 ESC 字节），剥 ANSI 剥不掉
        // → 按 req_id 删掉那一行。钩子模式没有这段噪音（回显的就是命令原文），不用处理。
        let new_output = if mode == ExecMode::Wrap {
            sentinel::remove_echo_lines(&stripped, &req_id)
        } else {
            stripped
        };

        // 截断 + 注释
        let (final_output, truncated) = if new_output.len() > MAX_OUTPUT_BYTES {
            let cut = new_output
                .char_indices()
                .nth(MAX_OUTPUT_BYTES)
                .map(|(i, _)| i)
                .unwrap_or(MAX_OUTPUT_BYTES);
            (new_output[..cut].to_string(), true)
        } else {
            (new_output, false)
        };

        Ok(ToolResult {
            content: build_content(&final_output, outcome, truncated),
            // 命令失败（非 0 退出码）不算**工具**失败：AI 从 `[退出码: N]` 自己判断。
            // 比如 `grep` 没匹配到就是 1，标成 error 会误导。
            is_error: false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn make_ctx() -> ToolContext {
        let session_state = Arc::new(crate::ipc::session::SessionState::new());
        ToolContext {
            session_state,
            cwd: std::env::temp_dir(),
            active_session_id: None,
            whitelist: Arc::new(crate::safety::whitelist::CompiledWhitelist::empty()),
            browser_state: Arc::new(crate::ipc::browser::BrowserState::default()),
        }
    }

    #[tokio::test]
    async fn 不存在的_session_返回_session_not_found() {
        let ctx = make_ctx();
        let r = RunCommandTool
            .execute(
                json!({ "session_id": "00000000-0000-0000-0000-000000000000", "cmd": "ls" }),
                &ctx,
            )
            .await;
        assert!(matches!(r, Err(ToolError::SessionNotFound(_))));
    }

    #[tokio::test]
    async fn cmd_含换行_invalid_args() {
        let ctx = make_ctx();
        let r = RunCommandTool
            .execute(
                json!({ "session_id": "00000000-0000-0000-0000-000000000000", "cmd": "ls\nrm -rf /" }),
                &ctx,
            )
            .await;
        assert!(matches!(r, Err(ToolError::InvalidArgs(_))));
    }

    /// session_id 不传时回退到 ctx.active_session_id；ctx 也没有 → SessionNotFound。
    #[tokio::test]
    async fn 缺_session_id_无_active_则_session_not_found() {
        let ctx = make_ctx();  // active_session_id = None
        let r = RunCommandTool.execute(json!({ "cmd": "ls" }), &ctx).await;
        assert!(
            matches!(r, Err(ToolError::SessionNotFound(_))),
            "无 active 时应是 SessionNotFound 而不是 InvalidArgs，实际：{r:?}"
        );
    }

    /// session_id 为占位符 "current"/"default"/"" 时也走 active 兜底。
    #[tokio::test]
    async fn session_id_占位符_default_走_active_兜底() {
        let ctx = make_ctx();
        for placeholder in &["", "current", "default", "active", "main"] {
            let r = RunCommandTool
                .execute(json!({ "session_id": placeholder, "cmd": "ls" }), &ctx)
                .await;
            assert!(
                matches!(r, Err(ToolError::SessionNotFound(_))),
                "占位符 {placeholder} 应走 active 兜底 → SessionNotFound（active=None）"
            );
        }
    }

    /// 1E-2：risk_class 委托给 safety::risk::classify。
    /// `ls` → Low / `sudo ...` → Destructive / 普通命令 → High。
    #[test]
    fn risk_class_委托_safety_risk() {
        assert_eq!(
            RunCommandTool.risk_class(&json!({"cmd": "ls"})),
            RiskClass::Low
        );
        assert_eq!(
            RunCommandTool.risk_class(&json!({"cmd": "git status"})),
            RiskClass::Low
        );
        assert_eq!(
            RunCommandTool.risk_class(&json!({"cmd": "sudo rm -rf /tmp"})),
            RiskClass::Destructive
        );
        assert_eq!(
            RunCommandTool.risk_class(&json!({"cmd": "git push --force"})),
            RiskClass::Destructive
        );
        // 默认未知命令 → High
        assert_eq!(
            RunCommandTool.risk_class(&json!({"cmd": "mv a b"})),
            RiskClass::High
        );
    }

    /// 缺 cmd 字段时降级 High 不 panic。
    #[test]
    fn risk_class_缺_cmd_默认_high() {
        assert_eq!(RunCommandTool.risk_class(&json!({})), RiskClass::High);
        assert_eq!(RunCommandTool.risk_class(&json!({"cmd": ""})), RiskClass::High);
    }

    /// session_id 改为 optional 后只 cmd 是 required。
    #[test]
    fn input_schema_required_只含_cmd() {
        let s = RunCommandTool.input_schema();
        let req = s["required"].as_array().unwrap();
        assert!(req.iter().any(|v| v == "cmd"));
        assert!(
            !req.iter().any(|v| v == "session_id"),
            "session_id 不应再 required，必须留给 active 兜底"
        );
    }

    // ===== v1.3.0 P1：三种执行模式的选择 =====

    #[test]
    fn 有钩子就走钩子模式_命令一个字都不改() {
        assert_eq!(decide_mode(true, true), ExecMode::Hook);
    }

    #[test]
    fn 没钩子但是_posix_shell_退回包装法() {
        assert_eq!(decide_mode(false, true), ExecMode::Wrap);
    }

    /// fish / cmd.exe：既没钩子又不能包装 → 只能盲等，如实说退出码未知。
    #[test]
    fn 非_posix_shell_仍走盲等原路径() {
        assert_eq!(decide_mode(false, false), ExecMode::Blind);
        // 极端情况（判定不一致）也不能把包装串丢给 fish
        assert_eq!(decide_mode(true, false), ExecMode::Blind);
    }

    /// fallback 链的措辞：钩子没生效时**绝不编造退出码**，并说明已降级。
    #[test]
    fn 钩子失效的措辞_不编造退出码且说明已降级() {
        let c = build_content("out", CmdOutcome::HookLost, false);
        assert!(!c.contains("[退出码: "), "不能编造退出码：{c}");
        assert!(c.contains("退出码未知"), "实际：{c}");
        assert!(c.contains("降级"), "要告诉 AI 已自动降级：{c}");
        assert!(
            c.contains(&format!("{}s", HOOK_GRACE.as_secs())),
            "要告诉 AI 只等了 grace 而不是 120s：{c}"
        );
    }

    /// 红线：钩子没生效时的等待上限必须远小于 MAX_WAIT，
    /// 否则会静默劣化成"每条命令都熬到 120s 超时"。
    #[test]
    fn 钩子探测的等待上限远小于命令超时() {
        assert!(
            HOOK_GRACE < MAX_WAIT,
            "grace {HOOK_GRACE:?} 必须远小于 MAX_WAIT {MAX_WAIT:?}"
        );
        assert!(
            HOOK_GRACE <= LEGACY_BLIND_WAIT,
            "最坏情况不该比旧的盲等还慢"
        );
    }

    // ===== v1.3.0 P5：工具描述要说清退出码是自动附带的 =====

    /// 真机发现 AI 自己在命令里加 `echo "---exit: $?"`，说明它不知道系统已经
    /// 把退出码给它了。描述里必须明说，并明确禁止自己 echo。
    #[test]
    fn 描述里说清退出码自动附带且禁止自己_echo() {
        let d = RunCommandTool.description();
        assert!(d.contains("[退出码"), "要展示实际格式：{d}");
        assert!(d.contains("自动"), "要说明是系统自动附带的：{d}");
        assert!(d.contains("$?"), "要点名 AI 爱加的那个写法：{d}");
        assert!(
            d.contains("不要") || d.contains("不需要"),
            "要明确禁止自己 echo 退出码：{d}"
        );
    }

    #[test]
    fn cmd_参数描述也提醒不要自己_echo_退出码() {
        let s = RunCommandTool.input_schema();
        let desc = s["properties"]["cmd"]["description"].as_str().unwrap();
        assert!(desc.contains("$?"), "实际：{desc}");
        assert!(desc.contains("退出码"), "实际：{desc}");
    }

    // ===== v1.3.0 T1：结束检测 + 退出码 =====

    #[test]
    fn 退出码_0_明确写进给_llm_的内容() {
        let c = build_content("file.txt", CmdOutcome::Finished(0), false);
        assert!(c.contains("file.txt"));
        assert!(c.contains("[退出码: 0]"), "实际：{c}");
    }

    #[test]
    fn 非_0_退出码同样明确标出() {
        let c = build_content("ls: no such file", CmdOutcome::Finished(2), false);
        assert!(c.contains("[退出码: 2]"), "实际：{c}");
    }

    #[test]
    fn 无输出但有退出码_不再谎报_5_秒无输出() {
        let c = build_content("", CmdOutcome::Finished(0), false);
        assert!(c.contains("[退出码: 0]"), "实际：{c}");
        assert!(c.contains("无输出"), "实际：{c}");
        assert!(!c.contains("5 秒"), "已不是盲等 5 秒的语义：{c}");
    }

    #[test]
    fn 超时路径标注仍在运行而不是失败() {
        let c = build_content("Collecting numpy", CmdOutcome::Timeout, false);
        assert!(c.contains("Collecting numpy"));
        assert!(c.contains("仍在运行"), "实际：{c}");
        assert!(
            c.contains(&format!("{}s", MAX_WAIT.as_secs())),
            "要告诉 AI 等了多久：{c}"
        );
        assert!(!c.contains("[退出码"), "未完成不能编造退出码：{c}");
    }

    #[test]
    fn 不支持的_shell_明确说明退出码未知() {
        let c = build_content("out", CmdOutcome::Unknown, false);
        assert!(c.contains("退出码未知"), "实际：{c}");
        assert!(!c.contains("[退出码: "), "不能编造退出码：{c}");
    }

    #[test]
    fn 截断标注与退出码可以并存() {
        let c = build_content("xxx", CmdOutcome::Finished(1), true);
        assert!(c.contains("截断"), "实际：{c}");
        assert!(c.contains("[退出码: 1]"), "实际：{c}");
    }

    /// 红线验证：**安全检查必须作用于用户原始命令，不是 sentinel 包装后的命令**。
    ///
    /// 结构上保证：`tool_loop::handle_run_command` 拿 `tc.input["cmd"]` 依次跑
    /// L1 黑名单 / L2 风险分级 / L3 白名单 / L4 审批，通过后才 `tool.execute(tc.input)`；
    /// 包装发生在 `execute` 内部，晚于全部四层门。
    ///
    /// 这个测试从反面证明顺序不能颠倒：包装串含 `;` `$` 等元字符，白名单的元字符
    /// 防注入规则会直接判不命中 —— 若先包装再检查，用户配的白名单会全部失效
    /// （每条命令都退化成弹窗），风险分级也会因元字符从 Low 掉到 High。
    #[test]
    fn 安全检查作用于原始命令而非包装后() {
        use crate::safety::{risk, whitelist};

        let (wl, errs) = whitelist::compile(&["ls *".to_string()]);
        assert!(errs.is_empty());

        // 原始命令：命中白名单 + L2 判 Low
        assert_eq!(whitelist::is_whitelisted(&wl, "ls -la"), Some("ls *"));
        assert_eq!(risk::classify("ls -la").risk, RiskClass::Low);

        // 包装后：白名单不命中、风险升级 → 证明包装只能发生在检查之后
        let wrapped = crate::session::sentinel::wrap_command("ls -la", "abc12345");
        assert!(
            whitelist::is_whitelisted(&wl, &wrapped).is_none(),
            "包装串含元字符，白名单必然不命中：{wrapped}"
        );
        assert_ne!(
            risk::classify(&wrapped).risk,
            RiskClass::Low,
            "包装串含元字符会被 L2 判成非 Low"
        );

        // 黑名单同理：拦的是原始命令文本
        assert!(crate::safety::blacklist::is_blacklisted("rm -rf /").is_some());
    }
}

/// 真实 PTY 端到端：起一个 `/bin/sh` session，走完整 `execute` 路径。
/// hardcode `/bin/sh` → Unix-only。
#[cfg(all(test, unix))]
mod pty_e2e_tests {
    use super::*;
    use crate::session::SessionConfig;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    /// 起真实 sh session，返回 (ctx, session_id)。
    async fn sh_ctx() -> (ToolContext, String) {
        let session_state = Arc::new(crate::ipc::session::SessionState::new());
        let cfg = SessionConfig {
            shell: Some("/bin/sh".to_string()),
            // 拉宽终端，减少命令行回显被折行造成的噪音
            cols: 400,
            rows: 24,
            ..Default::default()
        };
        let id = session_state.mgr.open(cfg).await.unwrap();
        // 等 shell 起来打出第一个 prompt
        tokio::time::sleep(Duration::from_millis(300)).await;
        let ctx = ToolContext {
            session_state,
            cwd: std::env::temp_dir(),
            active_session_id: Some(id.to_string()),
            whitelist: Arc::new(crate::safety::whitelist::CompiledWhitelist::empty()),
            browser_state: Arc::new(crate::ipc::browser::BrowserState::default()),
        };
        (ctx, id.to_string())
    }

    #[tokio::test]
    async fn 成功命令_拿到输出和退出码_0_且远快于旧的_5_秒盲等() {
        let (ctx, _id) = sh_ctx().await;
        let started = Instant::now();
        let r = RunCommandTool
            .execute(json!({ "cmd": "echo aitm-t1-marker" }), &ctx)
            .await
            .expect("execute 不该失败");
        let elapsed = started.elapsed();

        assert!(
            r.content.contains("aitm-t1-marker"),
            "应含命令输出，实际：{}",
            r.content
        );
        assert!(
            r.content.contains("[退出码: 0]"),
            "应含退出码，实际：{}",
            r.content
        );
        assert!(
            elapsed < Duration::from_secs(4),
            "命令一结束就该返回，不再盲等 5 秒，实际耗时 {elapsed:?}"
        );
    }

    #[tokio::test]
    async fn 失败命令_退出码非_0() {
        let (ctx, _id) = sh_ctx().await;
        let r = RunCommandTool
            .execute(json!({ "cmd": "false" }), &ctx)
            .await
            .unwrap();
        assert!(
            r.content.contains("[退出码: 1]"),
            "实际：{}",
            r.content
        );
    }

    #[tokio::test]
    async fn 复合命令_退出码是整体结果() {
        let (ctx, _id) = sh_ctx().await;
        let r = RunCommandTool
            .execute(json!({ "cmd": "echo hi && false" }), &ctx)
            .await
            .unwrap();
        assert!(
            r.content.contains("[退出码: 1]"),
            "`echo hi && false` 整体应是 1，实际：{}",
            r.content
        );
    }

    // ===== v1.3.0 P1：shell 钩子模式（命令一个字都不改）=====

    /// 起一个真实 zsh / bash session。本机没有该 shell 时返回 None（跳过）。
    ///
    /// zsh 分支把 `ZDOTDIR` 指到空临时目录：wrapper 里 `source $ZDOTDIR/.zshrc`
    /// 找不到文件 → 起一个干净 zsh，不受开发者本机主题 / 插件（p10k instant prompt
    /// 之类）干扰，测的是我们注入的钩子本身。
    ///
    /// 持 `ENV_LOCK` 跨 await：env 是进程级的，只能靠这把锁与其它改 env 的测试串行；
    /// `#[tokio::test]` 是 current_thread runtime，不要求 future Send，锁在 spawn
    /// 完成后立刻释放（临界区里只有一次 PTY spawn，不会长时间阻塞别的测试）。
    #[allow(clippy::await_holding_lock)]
    async fn hook_ctx(shell: &str) -> Option<(ToolContext, String, tempfile::TempDir)> {
        hook_ctx_with_zshrc(shell, None).await
    }

    /// 同上，但可以给临时 ZDOTDIR 塞一份"用户自己的 .zshrc"，
    /// 用来验证钩子和用户既有配置共存时的行为。
    #[allow(clippy::await_holding_lock)]
    async fn hook_ctx_with_zshrc(
        shell: &str,
        user_zshrc: Option<&str>,
    ) -> Option<(ToolContext, String, tempfile::TempDir)> {
        if !std::path::Path::new(shell).exists() {
            return None;
        }
        let clean = tempfile::TempDir::new().ok()?;
        if let Some(rc) = user_zshrc {
            std::fs::write(clean.path().join(".zshrc"), rc).ok()?;
        }
        let _guard = crate::test_env_lock::ENV_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        // SAFETY: ENV_LOCK 串行 + 测试内单线程
        let prev = std::env::var("ZDOTDIR").ok();
        unsafe { std::env::set_var("ZDOTDIR", clean.path()) };

        let session_state = Arc::new(crate::ipc::session::SessionState::new());
        let cfg = SessionConfig {
            shell: Some(shell.to_string()),
            cols: 400,
            rows: 24,
            ..Default::default()
        };
        let id = session_state.mgr.open(cfg).await.unwrap();

        // SAFETY: 同上
        unsafe {
            match prev {
                Some(v) => std::env::set_var("ZDOTDIR", v),
                None => std::env::remove_var("ZDOTDIR"),
            }
        }
        drop(_guard);

        // 等 shell 起来跑完 rc + 打出第一个 prompt（bash 3.2 / zsh 都够）
        tokio::time::sleep(Duration::from_millis(800)).await;
        let ctx = ToolContext {
            session_state,
            cwd: std::env::temp_dir(),
            active_session_id: Some(id.to_string()),
            whitelist: Arc::new(crate::safety::whitelist::CompiledWhitelist::empty()),
            browser_state: Arc::new(crate::ipc::browser::BrowserState::default()),
        };
        Some((ctx, id.to_string(), clean))
    }

    /// P1 的核心诉求：钩子模式下**命令原文一个字都不改**，
    /// 终端回显里不该再出现 `eval '...'; printf '\033]6969;...'` 这种噪音。
    async fn 钩子模式_无回显噪音(shell: &str) {
        let Some((ctx, id, _tmp)) = hook_ctx(shell).await else {
            eprintln!("跳过：本机没有 {shell}");
            return;
        };
        assert!(
            ctx.session_state.hook_active(&id).await,
            "{shell} 启动时应装上钩子"
        );

        let r = RunCommandTool
            .execute(json!({ "cmd": "echo hook-mode-marker" }), &ctx)
            .await
            .expect("execute 不该失败");

        assert!(
            r.content.contains("hook-mode-marker"),
            "应含命令输出，实际：{}",
            r.content
        );
        assert!(
            r.content.contains("[退出码: 0]"),
            "钩子应带回真实退出码，实际：{}",
            r.content
        );
        // 回显里只应有命令原文，不该有包装法的痕迹
        assert!(
            !r.content.contains("eval '"),
            "钩子模式不该再包装命令：{}",
            r.content
        );
        assert!(
            !r.content.contains("printf"),
            "钩子模式不该有 printf 回显：{}",
            r.content
        );
        assert!(
            !r.content.contains("6969") && !r.content.contains("aitm-"),
            "私有 OSC 不得漏进 LLM 上下文：{}",
            r.content
        );
        assert!(
            ctx.session_state.hook_active(&id).await,
            "钩子正常时不该被降级"
        );
    }

    #[tokio::test]
    async fn zsh_钩子模式_命令不改写且拿到退出码() {
        钩子模式_无回显噪音("/bin/zsh").await;
    }

    #[tokio::test]
    async fn bash_钩子模式_命令不改写且拿到退出码() {
        钩子模式_无回显噪音("/bin/bash").await;
    }

    #[tokio::test]
    async fn zsh_钩子模式_失败命令与复合命令的退出码正确() {
        let Some((ctx, _id, _tmp)) = hook_ctx("/bin/zsh").await else {
            return;
        };
        let r = RunCommandTool
            .execute(json!({ "cmd": "false" }), &ctx)
            .await
            .unwrap();
        assert!(r.content.contains("[退出码: 1]"), "实际：{}", r.content);

        let r = RunCommandTool
            .execute(json!({ "cmd": "echo hi && false" }), &ctx)
            .await
            .unwrap();
        assert!(
            r.content.contains("[退出码: 1]"),
            "复合命令取整体结果，实际：{}",
            r.content
        );

        // 连着跑同一条命令：base_seq 必须把上一次的标记挡掉，不能拿旧退出码
        let r = RunCommandTool
            .execute(json!({ "cmd": "true" }), &ctx)
            .await
            .unwrap();
        assert!(
            r.content.contains("[退出码: 0]"),
            "同名命令重复执行不能串到上一次的退出码：{}",
            r.content
        );
    }

    /// 与用户既有 `precmd` 钩子共存：用户 .zshrc 里先注册了自己的 precmd（跑一条
    /// 退出码 0 的命令），我们的钩子仍要报出真实退出码 1，且用户钩子照常执行。
    ///
    /// 用户钩子会往临时文件写标记，测试断言该文件存在 —— 保证这个用例不是空转
    /// （否则 rc 解析失败也会"通过"）。
    #[tokio::test]
    async fn 与用户既有_precmd_钩子共存_退出码仍准确() {
        let marker_dir = tempfile::TempDir::new().unwrap();
        let marker = marker_dir.path().join("user-precmd-ran");
        let user_rc = format!(
            "__user_precmd() {{ : > {marker:?} }}\n\
             autoload -Uz add-zsh-hook\n\
             add-zsh-hook precmd __user_precmd\n"
        );
        let Some((ctx, _id, _tmp)) = hook_ctx_with_zshrc("/bin/zsh", Some(&user_rc)).await else {
            return;
        };
        let r = RunCommandTool
            .execute(json!({ "cmd": "false" }), &ctx)
            .await
            .unwrap();
        assert!(
            marker.exists(),
            "用户自己的 precmd 钩子必须照常执行（否则本用例是空转）"
        );
        assert!(
            r.content.contains("[退出码: 1]"),
            "用户钩子不该影响真实退出码，实际：{}",
            r.content
        );
    }

    /// **fallback 链的核心测试**：谎称一个 `/bin/sh` session 有钩子（它其实没有），
    /// 验证 run_command **不会**傻等到 120s，而是在 grace 内降级返回，
    /// 并把该 session 的钩子标记为失效 —— 下一条命令自动走包装法拿到退出码。
    #[tokio::test]
    async fn 钩子没生效_不会熬到超时_而是降级回包装法() {
        let (ctx, id) = sh_ctx().await;
        // /bin/sh 没有钩子机制，这里强行开启模拟"钩子被用户 rc 冲掉"
        ctx.session_state.enable_hook(&id).await;

        let started = Instant::now();
        let r = RunCommandTool
            .execute(json!({ "cmd": "echo fallback-probe" }), &ctx)
            .await
            .unwrap();
        let elapsed = started.elapsed();

        assert!(
            elapsed < MAX_WAIT / 4,
            "钩子没生效必须快速降级，绝不能熬到 120s，实际 {elapsed:?}"
        );
        assert!(
            r.content.contains("退出码未知") && r.content.contains("降级"),
            "要如实说明降级，实际：{}",
            r.content
        );
        assert!(
            !ctx.session_state.hook_active(&id).await,
            "失败后必须把钩子标记为失效"
        );

        // 下一条命令自动退回包装法 —— 退出码重新拿得到
        let r2 = RunCommandTool
            .execute(json!({ "cmd": "echo after-fallback" }), &ctx)
            .await
            .unwrap();
        assert!(
            r2.content.contains("[退出码: 0]"),
            "降级后应由包装法拿回退出码，实际：{}",
            r2.content
        );
        assert!(r2.content.contains("after-fallback"));
    }

    /// 降级只是保底：钩子后来又能用了（缓冲区里重新出现钩子标记）就自动恢复，
    /// 避免会话被永久钉死在有回显噪音的包装法上。
    #[tokio::test]
    async fn 缓冲区重新出现钩子标记时自动恢复钩子模式() {
        let Some((ctx, id, _tmp)) = hook_ctx("/bin/zsh").await else {
            return;
        };
        // 先跑一条正常命令，让缓冲区里留下钩子标记
        RunCommandTool
            .execute(json!({ "cmd": "echo warmup" }), &ctx)
            .await
            .unwrap();
        // 模拟一次误判降级
        ctx.session_state.disable_hook(&id).await;
        assert!(!ctx.session_state.hook_active(&id).await);

        let r = RunCommandTool
            .execute(json!({ "cmd": "echo recovered" }), &ctx)
            .await
            .unwrap();
        assert!(
            ctx.session_state.hook_active(&id).await,
            "看到钩子标记应自动恢复钩子模式"
        );
        assert!(r.content.contains("[退出码: 0]"), "实际：{}", r.content);
        assert!(
            !r.content.contains("eval '"),
            "恢复后不该再有包装噪音：{}",
            r.content
        );
    }

    #[tokio::test]
    async fn sentinel_不污染给_llm_的输出() {
        let (ctx, _id) = sh_ctx().await;
        let r = RunCommandTool
            .execute(json!({ "cmd": "echo clean-output-check" }), &ctx)
            .await
            .unwrap();
        assert!(r.content.contains("clean-output-check"));
        assert!(
            !r.content.contains("aitm-done"),
            "sentinel 标记不得出现在给 LLM 的内容里：{}",
            r.content
        );
        assert!(
            !r.content.contains("6969"),
            "私有 OSC 码不得出现在给 LLM 的内容里：{}",
            r.content
        );
        assert!(
            !r.content.contains("printf"),
            "包装用的 printf 回显不得出现在给 LLM 的内容里：{}",
            r.content
        );
        assert!(!r.content.contains('\x1b'), "不应有 ESC 残留");
    }
}
