//! Tool calling 主循环。
//!
//! 流程：把 [`ChatRequest`] 喂给 provider，流式收 chunk → 拼出每轮 tool_calls →
//! 走安全门（L1 黑名单 / L4 用户确认）→ 调 [`Tool::execute`] → 把 ToolResult 作为
//! Tool 角色消息拼回会话进下一轮，直到 LLM 不再调工具或达 [`MAX_STEPS`]。
//!
//! 全程通过 [`EventSink`] 把进度 emit 给前端（生产用 [`TauriSink`]，测试用 mock）。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::FutureExt;
use futures::stream::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::{Mutex, oneshot};

use crate::orchestrator::context_budget;
use crate::orchestrator::halluc::{self, HallucinationWarning};
use crate::providers::LlmProvider;
use crate::providers::types::*;
use crate::safety::{blacklist, risk, whitelist};
use crate::tools::{RiskClass, Tool, ToolContext, ToolPreview, ToolResult, registry::ToolRegistry};

/// 工具调用最大轮数（防止 LLM 无限循环调工具）。
pub const MAX_STEPS: u32 = 10;
/// 高风险工具用户确认超时；超时视为拒绝。
pub const APPROVAL_TIMEOUT: Duration = Duration::from_secs(300);

/// C2：流建立失败的重试退避策略。
///
/// 只在 `stream_chat` **建立阶段**失败时重试（此时还没 emit 任何 token，重试不会
/// 产生重复输出）；流中途 `ChatChunk::Error` 不重试（已 emit 的 token 无法回滚）。
#[derive(Debug, Clone, Copy)]
pub struct RetryPolicy {
    /// 最多重试次数（不含首次尝试）。
    pub max_retries: u32,
    /// 首次退避基准（毫秒）；第 n 次退避 = base << n（1s / 2s ...）。
    pub base_delay_ms: u64,
}

impl RetryPolicy {
    /// 生产默认：最多重试 2 次，退避 1s / 2s。
    pub const fn production() -> Self {
        Self {
            max_retries: 2,
            base_delay_ms: 1000,
        }
    }

    /// 第 `attempt` 次重试前的退避时长（attempt 从 0 计）。
    fn backoff(&self, attempt: u32) -> Duration {
        Duration::from_millis(self.base_delay_ms << attempt)
    }
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self::production()
    }
}

/// C2：判断 provider 错误是否可重试。
///
/// 可重试：网络 `Http` / 限流 `RateLimited` / 超时 `Timeout`（含 5xx 网络抖动）。
/// 不可重试：鉴权 `Unauthorized`（401/403）/ 参数 `Protocol`（400 类）/ `Config` /
/// `Other`（含流中途上报的未知错误——不该盲目重放）。
pub fn is_retryable(e: &ProviderError) -> bool {
    matches!(
        e,
        ProviderError::Http(_) | ProviderError::RateLimited | ProviderError::Timeout
    )
}

// ============================================================
// 事件 payload（emit 给前端）
// ============================================================

#[derive(Serialize, Clone)]
pub struct AiTokenEvent {
    pub conversation_id: String,
    pub text: String,
}

#[derive(Serialize, Clone)]
pub struct AiToolRequestEvent {
    pub conversation_id: String,
    pub call_id: String,
    pub name: String,
    pub args_preview: String,
    pub risk: RiskClass,
    /// L2 启发式给出的归类原因（"sudo 提权" / "默认（无明显风险信号）"）。
    /// 前端 ConfirmDialog 展示给用户校准用。仅 run_command 走 L2 时填；
    /// 其他工具走静态 risk_class 留 None。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub risk_reason: Option<String>,
    /// T-B3a：工具「将要做的改动」的结构化 diff 预览（write_file / edit_file 有值，
    /// 其余工具 None）。前端 ConfirmDialog 用它渲染 diff 取代纯文本 args_preview。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<ToolPreview>,
}

#[derive(Serialize, Clone)]
pub struct AiToolStartedEvent {
    pub conversation_id: String,
    pub call_id: String,
    pub name: String,
}

#[derive(Serialize, Clone)]
pub struct AiToolFinishedEvent {
    pub conversation_id: String,
    pub call_id: String,
    pub content: String,
    pub is_error: bool,
    /// T-A3：工具执行耗时（毫秒）。仅真正执行工具（`execute_tool`）时为真实耗时；
    /// L1 黑名单拦截 / 用户拒绝 / 未知工具等未执行路径恒为 0。前端 ToolCallBubble
    /// 状态行展示（如 `1.2s`，<1s 显示 ms）。
    pub elapsed_ms: u64,
    /// 如果工具是被自动批准的（L2 LOW 或 L3 白名单命中），在这里写明原因；
    /// 走过 ask_user 弹窗批准的留 None。前端在 ToolCallBubble 上展示徽章。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_approved_reason: Option<String>,
    /// T-B3a：同 [`AiToolRequestEvent::preview`]，历史气泡回看 diff 用。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<ToolPreview>,
}

#[derive(Serialize, Clone)]
pub struct AiDoneEvent {
    pub conversation_id: String,
    pub stop_reason: StopReason,
    pub usage: Option<UsageInfo>,
    /// v1.3.0 反幻觉：本轮回复声称做了某类操作、但该类工具**零调用**时带上，
    /// 前端在这条 assistant 气泡上渲染警告条。无异常时不序列化该字段。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hallucination: Option<HallucinationWarning>,
}

#[derive(Serialize, Clone, Default)]
pub struct UsageInfo {
    pub input_tokens: u32,
    pub output_tokens: u32,
}

#[derive(Serialize, Clone)]
pub struct AiErrorEvent {
    pub conversation_id: String,
    pub message: String,
}

// ============================================================
// EventSink：emit 副作用抽象，让 run_tool_loop 单测可控
// ============================================================

/// 事件下沉接口。生产用 [`TauriSink`]（包 `AppHandle`），测试用 `MockSink`。
pub trait EventSink: Send + Sync {
    fn emit_token(&self, e: &AiTokenEvent);
    fn emit_tool_request(&self, e: &AiToolRequestEvent);
    fn emit_tool_started(&self, e: &AiToolStartedEvent);
    fn emit_tool_finished(&self, e: &AiToolFinishedEvent);
    fn emit_done(&self, e: &AiDoneEvent);
    fn emit_error(&self, e: &AiErrorEvent);
    /// v0.5.0-A：emit 一条通知给前端 zustand store + 触发 tab 状态环 / 系统通知。
    fn emit_notification(&self, e: &crate::notifications::NotificationEvent);
}

/// 生产环境的 EventSink：把事件 emit 到 Tauri 前端。
pub struct TauriSink(pub AppHandle);

impl EventSink for TauriSink {
    fn emit_token(&self, e: &AiTokenEvent) {
        let _ = self.0.emit("ai:token", e);
    }
    fn emit_tool_request(&self, e: &AiToolRequestEvent) {
        let _ = self.0.emit("ai:tool_request", e);
    }
    fn emit_tool_started(&self, e: &AiToolStartedEvent) {
        let _ = self.0.emit("ai:tool_started", e);
    }
    fn emit_tool_finished(&self, e: &AiToolFinishedEvent) {
        let _ = self.0.emit("ai:tool_finished", e);
    }
    fn emit_done(&self, e: &AiDoneEvent) {
        let _ = self.0.emit("ai:done", e);
    }
    fn emit_error(&self, e: &AiErrorEvent) {
        let _ = self.0.emit("ai:error", e);
    }
    fn emit_notification(&self, e: &crate::notifications::NotificationEvent) {
        let _ = self.0.emit("notification:received", e);
    }
}

// ============================================================
// 用户审批通道
// ============================================================

/// v1.3.0 A1：自动放行原因文案——本会话已被用户授权过该工具。
/// 前端 [`ToolCallBubble`] 复用既有的 `auto_approved_reason` 徽章展示它，
/// 保证用户**始终看得见**哪些调用是自动放行的。
pub const SESSION_GRANT_REASON: &str = "本会话已授权";

/// 一条待审批的工具调用。
///
/// 除了回执通道，还记着「哪个会话、哪个工具、什么风险」——
/// A1 的「本会话都允许」要靠这三样把授权记到正确的会话桶里，
/// 且能在后端独立判定 DESTRUCTIVE 不得记账（不信前端传来的 remember）。
struct PendingApproval {
    tx: oneshot::Sender<bool>,
    /// 该调用所属会话（conversation_id）。授权集按它隔离。
    cid: String,
    tool_name: String,
    risk: RiskClass,
}

/// Tool loop 的运行时状态：用户审批通道 + 会话内工具授权集。
///
/// 高风险工具调用阻塞在 oneshot 上等用户决定；前端 IPC 命令通过
/// [`resolve_approval`] 把 (call_id, approved, remember) 喂回去。
pub struct ToolLoopHandle {
    /// call_id → 等待用户决定的待审批记录。
    pending: Mutex<HashMap<String, PendingApproval>>,
    /// v1.3.0 A1：会话内 always-allow 授权集，conversation_id → 已授权工具名集合。
    ///
    /// **只存内存**：进程重启即清空。这是「这次干活期间」的信任，不是永久配置
    /// （要永久放行走 Settings 白名单，那是另一套且只管命令字符串）。
    /// 粒度固定为**工具级 + 会话级**，不提供「全部工具都允许」这种大开关。
    grants: Mutex<HashMap<String, std::collections::HashSet<String>>>,
}

impl ToolLoopHandle {
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
            grants: Mutex::new(HashMap::new()),
        }
    }

    /// A1：该会话是否已授权这个工具（工具名精确匹配）。
    async fn is_granted(&self, cid: &str, tool_name: &str) -> bool {
        self.grants
            .lock()
            .await
            .get(cid)
            .is_some_and(|s| s.contains(tool_name))
    }

    /// A1：把工具名写进该会话的授权集。
    async fn grant(&self, cid: &str, tool_name: &str) {
        self.grants
            .lock()
            .await
            .entry(cid.to_string())
            .or_default()
            .insert(tool_name.to_string());
    }
}

impl Default for ToolLoopHandle {
    fn default() -> Self {
        Self::new()
    }
}

/// 给 IPC 用：解析待审批 call_id，发送批准/拒绝。
///
/// `remember = true`（用户点了「本会话都允许」）时，把该工具名写进**当前会话**的
/// 授权集，后续同会话同工具的调用自动放行。
///
/// 🔴 **DESTRUCTIVE 红线**：只有 [`RiskClass::High`] 允许记账。哪怕前端传了
/// `remember = true`，destructive 调用也绝不写授权集——安全判定不依赖前端。
///
/// 🔴 **`run_command` 红线**（维护者 2026-07-27 拍板）：会话授权是**工具级**粒度，
/// 对 `run_command` 太粗——一个工具名覆盖无限多命令，授权一次 `npm test` 会让之后
/// 任何被判 High 的命令（`git push --force`、`mv` 掉重要文件…）都静默执行。而
/// `run_command` 本就有更合适的**命令级** glob 白名单（设置面板，带元字符防注入），
/// 工具级授权与它重复且更危险。故此处永不为 run_command 记账。
///
/// 找不到 call_id（已超时或不存在）静默忽略。
pub async fn resolve_approval(
    handle: &ToolLoopHandle,
    call_id: &str,
    approved: bool,
    remember: bool,
) {
    let pending = handle.pending.lock().await.remove(call_id);
    let Some(p) = pending else { return };
    if approved && remember && p.risk == RiskClass::High && grantable_tool(&p.tool_name) {
        handle.grant(&p.cid, &p.tool_name).await;
    }
    let _ = p.tx.send(approved);
}

/// 该工具是否允许「本会话都允许」。
///
/// 见 [`resolve_approval`] 的 run_command 红线说明。放行路径与记账路径都查它
/// （纵深防御：即便授权集里因故有了脏数据，也不会被用上）。
fn grantable_tool(tool_name: &str) -> bool {
    tool_name != "run_command"
}

// ============================================================
// 内部数据结构
// ============================================================

/// 一个工具调用（从 ChatChunk::ToolUseStart/Args/End 拼装出来）。
#[derive(Debug, Clone)]
struct ToolCall {
    id: String,
    name: String,
    /// 拼接后的 args JSON（已解析）
    input: serde_json::Value,
}

/// 一轮 stream_chat 的累积结果。
struct OneTurn {
    /// 累积的纯文本（用于 assistant ContentBlock::Text）
    text: String,
    /// 流里收到的 tool_use（id+name+input）
    tool_calls: Vec<ToolCall>,
    usage_in: u32,
    usage_out: u32,
    stop_reason: StopReason,
}

// ============================================================
// 主循环
// ============================================================

/// 跑工具调用主循环。
///
/// 失败模式：任何 provider stream 错误都会 emit `ai:error` 然后返回；
/// 达 [`MAX_STEPS`] 会调用 [`summarize_and_done`] 让 LLM 总结收尾。
#[allow(clippy::too_many_arguments)] // C1 加 context_window；包 struct 不值得
pub async fn run_tool_loop(
    initial: ChatRequest,
    provider: Arc<dyn LlmProvider>,
    tools: Arc<ToolRegistry>,
    ctx: ToolContext,
    sink: Arc<dyn EventSink>,
    cid: String,
    handle: Arc<ToolLoopHandle>,
    // C1：当前 model 的上下文窗口（token）；None → 用保守默认。ai.rs 从
    // provider.list_models() 按 model id 查得后透传。
    context_window: Option<u32>,
) {
    let mut conv = initial.messages.clone();
    let mut total_in: u32 = 0;
    let mut total_out: u32 = 0;
    let mut last_stop;
    // v1.3.0 反幻觉：本轮（= 这一次用户提问触发的整个 loop）真实发生过的工具名。
    // 只记「调没调」不看成败——工具调了但失败是真实失败（已有错误气泡），不是幻觉。
    let mut called_tools: Vec<String> = Vec::new();

    // C1：token 预算 + 累计已省略条数（用于 system 末尾的省略提示）
    let budget = context_budget::budget_tokens(context_window);
    let retry = RetryPolicy::production();
    let mut total_dropped: usize = 0;

    // v0.5.0-A T6 差异化核心：tool loop 入口 emit Running → tab 状态环 sky
    // 表示 AI 正在干活。出口（emit_done / emit_error 之前）会再发对应状态。
    notify_ai_loop(
        sink.as_ref(),
        ctx.active_session_id.as_deref(),
        crate::notifications::NotificationLevel::Running,
        String::new(),
    );

    for _step in 0..MAX_STEPS {
        // C1：每轮**前**裁剪，防止 conv 只增不减撑爆上下文窗口。system 单独计入预算。
        let system_tokens = initial
            .system
            .as_deref()
            .map(context_budget::estimate_text_tokens)
            .unwrap_or(0);
        let plan = context_budget::plan_trim(
            &conv,
            system_tokens,
            budget,
            context_budget::KEEP_RECENT_GROUPS,
        );
        if plan.dropped > 0 {
            conv = plan.kept;
            total_dropped += plan.dropped;
        }

        let req = ChatRequest {
            model: initial.model.clone(),
            messages: conv.clone(),
            tools: tools.to_tool_defs(),
            system: effective_system(&initial.system, total_dropped),
            max_tokens: initial.max_tokens,
            temperature: initial.temperature,
        };

        let turn = match collect_one_turn(provider.as_ref(), req, sink.as_ref(), &cid, retry).await {
            Ok(t) => t,
            Err(e) => {
                let msg = e.to_string();
                notify_ai_loop(
                    sink.as_ref(),
                    ctx.active_session_id.as_deref(),
                    crate::notifications::NotificationLevel::Error,
                    format!("AI 出错：{msg}"),
                );
                sink.emit_error(&AiErrorEvent {
                    conversation_id: cid.clone(),
                    message: msg,
                });
                return;
            }
        };

        total_in = total_in.max(turn.usage_in);
        total_out += turn.usage_out;
        last_stop = turn.stop_reason;

        // 构造 assistant 消息（含 text + 任何 tool_use blocks）
        let assistant_msg = build_assistant_message(&turn);
        conv.push(assistant_msg);

        // 没工具调用 → 自然结束
        if turn.tool_calls.is_empty() {
            notify_ai_loop(
                sink.as_ref(),
                ctx.active_session_id.as_deref(),
                crate::notifications::NotificationLevel::Done,
                "AI 完成".to_string(),
            );
            sink.emit_done(&AiDoneEvent {
                conversation_id: cid.clone(),
                stop_reason: last_stop,
                usage: Some(UsageInfo {
                    input_tokens: total_in,
                    output_tokens: total_out,
                }),
                hallucination: halluc::detect_hallucination(&turn.text, &called_tools),
            });
            return;
        }
        called_tools.extend(turn.tool_calls.iter().map(|tc| tc.name.clone()));

        // 处理本轮所有 tool_call（A3：只读工具并发，其余串行；结果按原顺序回填）
        let results = execute_tool_calls(
            &turn.tool_calls,
            tools.as_ref(),
            &ctx,
            handle.as_ref(),
            sink.as_ref(),
            &cid,
        )
        .await;
        let tool_results: Vec<ContentBlock> = turn
            .tool_calls
            .iter()
            .zip(results)
            .map(|(tc, r)| ContentBlock::ToolResult {
                tool_use_id: tc.id.clone(),
                content: r.content,
                is_error: r.is_error,
            })
            .collect();

        // 把 tool_results 作为 Tool 角色消息加入会话进下一轮
        conv.push(Message {
            role: Role::Tool,
            content: MessageContent::Blocks(tool_results),
        });
    }

    // 超过 MAX_STEPS：让 LLM 总结收尾（先裁剪再收尾，避免最需收尾时重发全量历史溢出）
    summarize_and_done(
        provider.as_ref(),
        conv,
        &initial,
        sink.as_ref(),
        &cid,
        total_in,
        total_out,
        ctx.active_session_id.as_deref(),
        budget,
        retry,
        &called_tools,
    )
    .await;
}

/// C1：把裁剪省略提示追加到 system 末尾（`dropped == 0` 时原样返回）。
fn effective_system(base: &Option<String>, dropped: usize) -> Option<String> {
    if dropped == 0 {
        return base.clone();
    }
    let note = context_budget::elision_note(dropped);
    match base {
        Some(s) => Some(format!("{s}\n\n{note}")),
        None => Some(note),
    }
}

/// 跑一轮 stream_chat，收齐 chunks，返回拼好的 OneTurn。
/// 同时把 TextDelta emit 成 ai:token 给前端。
///
/// C2：`stream_chat` 建立失败且错误可重试时，按 `retry` 指数退避重试；
/// 只重试建立阶段（尚未 emit token），流中途错误直接返回不重试。
async fn collect_one_turn(
    provider: &dyn LlmProvider,
    req: ChatRequest,
    sink: &dyn EventSink,
    cid: &str,
    retry: RetryPolicy,
) -> Result<OneTurn, ProviderError> {
    let mut stream = {
        let mut attempt: u32 = 0;
        loop {
            match provider.stream_chat(req.clone()).await {
                Ok(s) => break s,
                Err(e) => {
                    if is_retryable(&e) && attempt < retry.max_retries {
                        tokio::time::sleep(retry.backoff(attempt)).await;
                        attempt += 1;
                        continue;
                    }
                    return Err(e);
                }
            }
        }
    };
    let mut text = String::new();
    // call_id → (name, args_partial)
    let mut tool_inflight: HashMap<String, (String, String)> = HashMap::new();
    // 顺序：保留 call_id 出现顺序
    let mut order: Vec<String> = Vec::new();
    let mut tool_calls: Vec<ToolCall> = Vec::new();
    let mut usage_in: u32 = 0;
    let mut usage_out: u32 = 0;
    let mut stop_reason = StopReason::EndTurn;

    while let Some(chunk) = stream.next().await {
        match chunk {
            ChatChunk::TextDelta { text: t } => {
                text.push_str(&t);
                sink.emit_token(&AiTokenEvent {
                    conversation_id: cid.to_string(),
                    text: t,
                });
            }
            ChatChunk::ToolUseStart { call_id, name } => {
                tool_inflight.insert(call_id.clone(), (name, String::new()));
                order.push(call_id);
            }
            ChatChunk::ToolUseArgsDelta {
                call_id,
                json_partial,
            } => {
                if let Some((_, args)) = tool_inflight.get_mut(&call_id) {
                    args.push_str(&json_partial);
                }
            }
            ChatChunk::ToolUseEnd { call_id } => {
                if let Some((name, args_str)) = tool_inflight.remove(&call_id) {
                    let input = parse_args(&args_str);
                    tool_calls.push(ToolCall {
                        id: call_id,
                        name,
                        input,
                    });
                }
            }
            ChatChunk::Usage {
                input_tokens,
                output_tokens,
            } => {
                usage_in = usage_in.max(input_tokens);
                usage_out += output_tokens;
            }
            ChatChunk::Done { stop_reason: sr } => {
                stop_reason = sr;
            }
            ChatChunk::Error { message } => {
                return Err(ProviderError::Other(message));
            }
        }
    }

    // 兜底：tool_inflight 还有未关闭的 ToolUseEnd → 用拼到的 args
    for call_id in order {
        if let Some((name, args_str)) = tool_inflight.remove(&call_id) {
            let input = parse_args(&args_str);
            tool_calls.push(ToolCall {
                id: call_id,
                name,
                input,
            });
        }
    }

    Ok(OneTurn {
        text,
        tool_calls,
        usage_in,
        usage_out,
        stop_reason,
    })
}

fn parse_args(s: &str) -> serde_json::Value {
    if s.trim().is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str(s).unwrap_or_else(|_| serde_json::json!({}))
    }
}

fn build_assistant_message(turn: &OneTurn) -> Message {
    let mut blocks: Vec<ContentBlock> = Vec::new();
    if !turn.text.is_empty() {
        blocks.push(ContentBlock::Text {
            text: turn.text.clone(),
        });
    }
    for tc in &turn.tool_calls {
        blocks.push(ContentBlock::ToolUse {
            id: tc.id.clone(),
            name: tc.name.clone(),
            input: tc.input.clone(),
        });
    }
    Message {
        role: Role::Assistant,
        content: MessageContent::Blocks(blocks),
    }
}

// ============================================================
// 单 tool 调用：L1 黑名单 → L2 评分 → L3 白名单 → L4 用户确认 → 执行
// ============================================================
//
// 决策流程（仅 run_command 走完整 4 层；其他工具走 tool.risk_class 单层）：
//
//   ┌──────────────┐
//   │ L1 黑名单    │── hit ─→ reject (is_error=true)
//   └──────┬───────┘
//          ▼
//   ┌──────────────┐
//   │ L2 启发式    │── DESTRUCTIVE ─→ ask_user(destructive)（白名单不覆盖）
//   └──────┬───────┘
//          ▼ Low / High
//   ┌──────────────┐
//   │ L3 白名单    │── hit ─→ 自动批 (auto_approved_reason="白名单：...")
//   └──────┬───────┘
//          ▼ miss
//   ┌──────────────┐
//   │ L2 == Low?   │── yes ─→ 自动批 (auto_approved_reason="L2：<reason>")
//   └──────┬───────┘
//          ▼ no
//   High → ask_user(high, risk_reason="L2：<reason>")
//
// 白名单不能覆盖 DESTRUCTIVE：防止用户配 `git *` 误把 `git push --force` 也放过。

/// v1.3.0 A3：可并发执行的**只读**工具白名单。
///
/// 入选条件：`Low` 风险 **且无副作用**（纯读）。有副作用的（write_file /
/// edit_file / run_command / browser_navigate 等）一律不进，哪怕 A1 的会话授权
/// 让它们不再需要等审批——「不用等人」不等于「可以乱序并发」。
const PARALLEL_READONLY_TOOLS: &[&str] = &[
    "read_file",
    "list_files",
    "get_terminal_history",
    "search_history",
    "browser_snapshot",
    "load_skill",
];

/// v1.3.0 A3：只读工具并发上限。防 AI 一次要读 50 个文件打爆 fd。
pub const MAX_PARALLEL_TOOLS: usize = 8;

/// A3：该 tool_call 能否进并发批次。
///
/// 名字在白名单里**且**运行时 `risk_class` 仍判 Low 才算（双保险：将来某个
/// 工具按参数升级风险时，不会因为名字在表里就被并发放行）。
fn is_parallel_readonly(tools: &ToolRegistry, tc: &ToolCall) -> bool {
    if !PARALLEL_READONLY_TOOLS.contains(&tc.name.as_str()) {
        return false;
    }
    tools
        .get(&tc.name)
        .is_some_and(|t| t.risk_class(&tc.input) == RiskClass::Low)
}

/// A3：执行一轮里的全部 tool_call，返回**与入参等长、顺序一致**的结果数组。
///
/// 分区规则：
/// - **连续**的只读调用攒成一个批次，`buffer_unordered(MAX_PARALLEL_TOOLS)` 并发跑
/// - 遇到非只读（需审批 / 有副作用）调用先把当前批次跑完，再串行执行它
///
/// 之所以按「连续段」而不是「全局两分区」：LLM 一轮里可能先 `write_file(a)`
/// 再 `read_file(a)`，全局分区会把读提到写前面，读到旧内容。按段切分保证了
/// 有副作用工具与其前后只读调用的相对顺序不变。
///
/// 🔴 **结果必须按原 tool_call 顺序回填**：tool_result 与 tool_use 顺序错位会让
/// provider 报 400（项目 CLAUDE.md 协议备忘里的老雷区）。这里用「按索引写回
/// 定长数组」保证，与完成先后无关。
async fn execute_tool_calls(
    calls: &[ToolCall],
    tools: &ToolRegistry,
    ctx: &ToolContext,
    handle: &ToolLoopHandle,
    sink: &dyn EventSink,
    cid: &str,
) -> Vec<ToolResult> {
    let mut slots: Vec<Option<ToolResult>> = (0..calls.len()).map(|_| None).collect();
    let mut batch: Vec<usize> = Vec::new();

    for (i, tc) in calls.iter().enumerate() {
        if is_parallel_readonly(tools, tc) {
            batch.push(i);
            continue;
        }
        // 先把攒着的只读批次跑完，保证「只读 → 有副作用」的先后关系
        run_readonly_batch(&mut batch, calls, tools, ctx, handle, sink, cid, &mut slots).await;
        slots[i] = Some(handle_one_tool_call(tc, tools, ctx, handle, sink, cid).await);
    }
    run_readonly_batch(&mut batch, calls, tools, ctx, handle, sink, cid, &mut slots).await;

    slots
        .into_iter()
        .map(|r| {
            r.unwrap_or_else(|| ToolResult {
                content: "工具未执行".into(),
                is_error: true,
            })
        })
        .collect()
}

/// A3：并发跑一批只读调用，结果按索引写回 `slots`（跑完清空 `batch`）。
#[allow(clippy::too_many_arguments)] // 参数都是主循环既有的共享引用；包 struct 不值得
async fn run_readonly_batch(
    batch: &mut Vec<usize>,
    calls: &[ToolCall],
    tools: &ToolRegistry,
    ctx: &ToolContext,
    handle: &ToolLoopHandle,
    sink: &dyn EventSink,
    cid: &str,
    slots: &mut [Option<ToolResult>],
) {
    if batch.is_empty() {
        return;
    }
    let done: Vec<(usize, ToolResult)> = futures::stream::iter(batch.iter().copied().map(|i| {
        async move {
            (
                i,
                handle_one_tool_call(&calls[i], tools, ctx, handle, sink, cid).await,
            )
        }
    }))
    .buffer_unordered(MAX_PARALLEL_TOOLS)
    .collect()
    .await;
    for (i, r) in done {
        slots[i] = Some(r);
    }
    batch.clear();
}

async fn handle_one_tool_call(
    tc: &ToolCall,
    tools: &ToolRegistry,
    ctx: &ToolContext,
    handle: &ToolLoopHandle,
    sink: &dyn EventSink,
    cid: &str,
) -> ToolResult {
    let tool: Arc<dyn Tool> = match tools.get(&tc.name) {
        Some(t) => t,
        None => {
            let r = ToolResult {
                content: format!("未知工具: {}", tc.name),
                is_error: true,
            };
            sink.emit_tool_finished(&AiToolFinishedEvent {
                conversation_id: cid.to_string(),
                call_id: tc.id.clone(),
                content: r.content.clone(),
                is_error: true,
                elapsed_ms: 0,
                auto_approved_reason: None,
                preview: None,
            });
            return r;
        }
    };

    // T-B3a：发审批事件前算 diff 预览（write_file/edit_file override，其余默认 None）。
    // 计算无害失败静默降级为 None，绝不影响主循环。
    let preview = compute_preview(tool.as_ref(), &tc.input, ctx).await;

    // ===== run_command 走 L1+L2+L3+L4 完整流程 =====
    if tc.name == "run_command" {
        return handle_run_command(tc, tool.as_ref(), ctx, handle, sink, cid, preview).await;
    }

    // ===== 其他工具：保留 1E-1 行为，只走静态 risk_class =====
    let risk = tool.risk_class(&tc.input);

    // A1：High 且本会话已授权 → 自动放行（带可见徽章）。
    // DESTRUCTIVE 不查授权集——红线，每次都必须弹窗确认。
    if risk == RiskClass::High && handle.is_granted(cid, &tc.name).await {
        return execute_tool(
            tc,
            tool.as_ref(),
            ctx,
            sink,
            cid,
            Some(SESSION_GRANT_REASON.to_string()),
            preview,
        )
        .await;
    }

    let approved = match risk {
        RiskClass::Low => true,
        RiskClass::High | RiskClass::Destructive => {
            ask_user(
                tc,
                risk,
                None,
                handle,
                sink,
                cid,
                ctx.active_session_id.as_deref(),
                preview.clone(),
            )
            .await
        }
    };

    if !approved {
        return reject_tool(tc, sink, cid, preview);
    }

    execute_tool(tc, tool.as_ref(), ctx, sink, cid, None, preview).await
}

/// T-B3a：算工具的 diff 预览。
///
/// 在发 `ai:tool_request` 审批事件前调，把结果塞进审批 / 完成事件。用
/// `catch_unwind` 兜底——preview 实现若意外 panic（无害失败），静默降级为 None，
/// **绝不**让主工具循环崩。
async fn compute_preview(
    tool: &dyn Tool,
    args: &serde_json::Value,
    ctx: &ToolContext,
) -> Option<ToolPreview> {
    match std::panic::AssertUnwindSafe(tool.preview(args, ctx))
        .catch_unwind()
        .await
    {
        Ok(p) => p,
        Err(_) => {
            tracing::warn!("工具 preview 计算 panic，降级为无 diff 预览");
            None
        }
    }
}

/// 专门给 run_command 走的 4 层安全门流程。
///
/// `preview` 是 T-B3a 预览（run_command 沿用默认 → 恒 None，仍透传保持事件一致）。
async fn handle_run_command(
    tc: &ToolCall,
    tool: &dyn Tool,
    ctx: &ToolContext,
    handle: &ToolLoopHandle,
    sink: &dyn EventSink,
    cid: &str,
    preview: Option<ToolPreview>,
) -> ToolResult {
    let cmd = tc.input.get("cmd").and_then(|v| v.as_str()).unwrap_or("");

    // L1 黑名单
    if let Some(label) = blacklist::is_blacklisted(cmd) {
        let r = ToolResult {
            content: format!("L1 黑名单拦截：{label}（命令 = {cmd}）"),
            is_error: true,
        };
        sink.emit_tool_finished(&AiToolFinishedEvent {
            conversation_id: cid.to_string(),
            call_id: tc.id.clone(),
            content: r.content.clone(),
            is_error: true,
            elapsed_ms: 0,
            auto_approved_reason: None,
            preview,
        });
        return r;
    }

    // L2 启发式评分
    let assessment = risk::classify(cmd);

    match assessment.risk {
        // DESTRUCTIVE：必须 ask_user，**白名单不能覆盖**
        RiskClass::Destructive => {
            let approved = ask_user(
                tc,
                RiskClass::Destructive,
                Some(format!("L2：{}", assessment.reason)),
                handle,
                sink,
                cid,
                ctx.active_session_id.as_deref(),
                preview.clone(),
            )
            .await;
            if !approved {
                return reject_tool(tc, sink, cid, preview);
            }
            execute_tool(tc, tool, ctx, sink, cid, None, preview).await
        }

        // LOW：自动批准（白名单 / L2 都给 LOW，emit reason 让 UI 标识）
        RiskClass::Low => {
            let reason = format!("L2：{}", assessment.reason);
            execute_tool(tc, tool, ctx, sink, cid, Some(reason), preview).await
        }

        // HIGH：先看 L3 白名单
        RiskClass::High => {
            if let Some(pattern) = whitelist::is_whitelisted(&ctx.whitelist, cmd) {
                // 白名单命中 → 降级 LOW 自动批
                let reason = format!("白名单：{pattern}");
                return execute_tool(tc, tool, ctx, sink, cid, Some(reason), preview).await;
            }
            // 🔴 run_command **不参与**会话级「本会话都允许」（维护者 2026-07-27 拍板）。
            // 工具级授权对它太粗：一个工具名覆盖无限多命令，授权一次 `npm test` 会让
            // 之后任何 L2 判 High 的命令（`git push --force` / `mv` 掉重要文件…）都静默
            // 执行。命令级放行请用 L3 glob 白名单（上面那段，设置面板可配、带元字符
            // 防注入）——粒度正好，且已有。详见 [`grantable_tool`]。
            //
            // 不命中白名单 → 弹普通 high 弹窗
            let approved = ask_user(
                tc,
                RiskClass::High,
                Some(format!("L2：{}", assessment.reason)),
                handle,
                sink,
                cid,
                ctx.active_session_id.as_deref(),
                preview.clone(),
            )
            .await;
            if !approved {
                return reject_tool(tc, sink, cid, preview);
            }
            execute_tool(tc, tool, ctx, sink, cid, None, preview).await
        }
    }
}

/// 用户拒绝时的统一返回 + emit。
fn reject_tool(
    tc: &ToolCall,
    sink: &dyn EventSink,
    cid: &str,
    preview: Option<ToolPreview>,
) -> ToolResult {
    let r = ToolResult {
        content: "用户拒绝执行此操作".into(),
        is_error: true,
    };
    sink.emit_tool_finished(&AiToolFinishedEvent {
        conversation_id: cid.to_string(),
        call_id: tc.id.clone(),
        content: r.content.clone(),
        is_error: true,
        elapsed_ms: 0,
        auto_approved_reason: None,
        preview,
    });
    r
}

/// 执行工具 + emit started/finished。
/// `auto_approved_reason` 不为 None 时表示这次执行没走过 ask_user 弹窗。
/// `preview` 随 finished 事件带出，供历史气泡回看 diff。
async fn execute_tool(
    tc: &ToolCall,
    tool: &dyn Tool,
    ctx: &ToolContext,
    sink: &dyn EventSink,
    cid: &str,
    auto_approved_reason: Option<String>,
    preview: Option<ToolPreview>,
) -> ToolResult {
    sink.emit_tool_started(&AiToolStartedEvent {
        conversation_id: cid.to_string(),
        call_id: tc.id.clone(),
        name: tc.name.clone(),
    });

    // T-A3：包住真正的 execute 计时；耗时随 finished 事件带给前端展示。
    let started = Instant::now();
    let r: ToolResult = match tool.execute(tc.input.clone(), ctx).await {
        Ok(r) => r,
        Err(e) => e.into(),
    };
    let elapsed_ms = started.elapsed().as_millis() as u64;

    sink.emit_tool_finished(&AiToolFinishedEvent {
        conversation_id: cid.to_string(),
        call_id: tc.id.clone(),
        content: r.content.clone(),
        is_error: r.is_error,
        elapsed_ms,
        auto_approved_reason,
        preview,
    });
    r
}

/// v0.5.0-A T6 helper：发 AI 工具循环通知（差异化核心，plan §4）。
///
/// session_id 是 None / 空字符串时跳过（前端通过 session_id → tabId 路由，
/// 空值找不到 tab）。timestamp 用 epoch ms。
fn notify_ai_loop(
    sink: &dyn EventSink,
    session_id: Option<&str>,
    level: crate::notifications::NotificationLevel,
    message: String,
) {
    let Some(sid) = session_id else { return };
    if sid.is_empty() {
        return;
    }
    let timestamp_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    sink.emit_notification(&crate::notifications::NotificationEvent {
        session_id: sid.to_string(),
        level,
        message,
        source: crate::notifications::NotificationSource::AiToolLoop,
        timestamp_ms,
    });
}

#[allow(clippy::too_many_arguments)] // T-B3a 加 preview 让参数 7→8；包 struct 不值得
async fn ask_user(
    tc: &ToolCall,
    risk: RiskClass,
    risk_reason: Option<String>,
    handle: &ToolLoopHandle,
    sink: &dyn EventSink,
    cid: &str,
    session_id: Option<&str>,
    preview: Option<ToolPreview>,
) -> bool {
    let (tx, rx) = oneshot::channel();
    handle.pending.lock().await.insert(
        tc.id.clone(),
        PendingApproval {
            tx,
            cid: cid.to_string(),
            tool_name: tc.name.clone(),
            risk,
        },
    );

    // v0.5.0-A T6 差异化核心：弹审批前先 emit Waiting 通知 → 用户在别的 tab 也能
    // 通过状态环 amber + 系统通知知道"AI 在等我审批"。
    notify_ai_loop(
        sink,
        session_id,
        crate::notifications::NotificationLevel::Waiting,
        format!("AI 等待审批：{}", tc.name),
    );

    let args_preview = serde_json::to_string_pretty(&tc.input).unwrap_or_default();
    sink.emit_tool_request(&AiToolRequestEvent {
        conversation_id: cid.to_string(),
        call_id: tc.id.clone(),
        name: tc.name.clone(),
        args_preview,
        risk,
        risk_reason,
        preview,
    });

    match tokio::time::timeout(APPROVAL_TIMEOUT, rx).await {
        Ok(Ok(approved)) => approved,
        _ => {
            // 超时 / 通道 drop → 视为拒绝
            handle.pending.lock().await.remove(&tc.id);
            false
        }
    }
}

// ============================================================
// 超 MAX_STEPS：让 LLM 不带工具收尾总结
// ============================================================

#[allow(clippy::too_many_arguments)] // v0.5.0-A/C1 累加参数；包 struct 不值得
async fn summarize_and_done(
    provider: &dyn LlmProvider,
    conv: Vec<Message>,
    initial: &ChatRequest,
    sink: &dyn EventSink,
    cid: &str,
    total_in: u32,
    total_out: u32,
    session_id: Option<&str>,
    budget: usize,
    retry: RetryPolicy,
    // v1.3.0 反幻觉：整个 loop 里真实调过的工具名（收尾总结同样要过检测）。
    // 注意用普通 `//`——Rust 不允许在函数参数上写 `///` doc 注释。
    called_tools: &[String],
) {
    // C1：收尾同样先裁剪——这是最容易溢出的一步（重发全量历史 + 收尾指令）。
    let base_system =
        "已达工具调用上限（10 步）。请直接总结你做了什么、当前状态、是否完成用户任务。不要再调工具。";
    let system_tokens = context_budget::estimate_text_tokens(base_system);
    let plan = context_budget::plan_trim(
        &conv,
        system_tokens,
        budget,
        context_budget::KEEP_RECENT_GROUPS,
    );
    let system = if plan.dropped > 0 {
        format!("{base_system}\n\n{}", context_budget::elision_note(plan.dropped))
    } else {
        base_system.to_string()
    };
    let req = ChatRequest {
        model: initial.model.clone(),
        messages: plan.kept,
        tools: vec![], // 不再给工具
        system: Some(system),
        max_tokens: initial.max_tokens,
        temperature: initial.temperature,
    };

    let mut total_in = total_in;
    let mut total_out = total_out;
    match collect_one_turn(provider, req, sink, cid, retry).await {
        Ok(turn) => {
            total_in = total_in.max(turn.usage_in);
            total_out += turn.usage_out;
            notify_ai_loop(
                sink,
                session_id,
                crate::notifications::NotificationLevel::Done,
                "AI 完成（总结收尾）".to_string(),
            );
            sink.emit_done(&AiDoneEvent {
                conversation_id: cid.to_string(),
                stop_reason: turn.stop_reason,
                usage: Some(UsageInfo {
                    input_tokens: total_in,
                    output_tokens: total_out,
                }),
                hallucination: halluc::detect_hallucination(&turn.text, called_tools),
            });
        }
        Err(e) => {
            let msg = format!("总结阶段失败: {e}");
            notify_ai_loop(
                sink,
                session_id,
                crate::notifications::NotificationLevel::Error,
                msg.clone(),
            );
            sink.emit_error(&AiErrorEvent {
                conversation_id: cid.to_string(),
                message: msg,
            });
        }
    }
}

// ============================================================
// 单元测试
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use futures::stream::BoxStream;
    use std::sync::Mutex as StdMutex;

    use crate::ipc::session::SessionState;
    use crate::providers::{Capabilities, LlmProvider, ModelInfo};

    // -------- MockSink：把事件存到 Vec 里供断言 --------

    #[derive(Default)]
    struct MockSink {
        tokens: StdMutex<Vec<AiTokenEvent>>,
        tool_requests: StdMutex<Vec<AiToolRequestEvent>>,
        tool_started: StdMutex<Vec<AiToolStartedEvent>>,
        tool_finished: StdMutex<Vec<AiToolFinishedEvent>>,
        done: StdMutex<Vec<AiDoneEvent>>,
        errors: StdMutex<Vec<AiErrorEvent>>,
        notifications: StdMutex<Vec<crate::notifications::NotificationEvent>>,
    }

    impl EventSink for MockSink {
        fn emit_token(&self, e: &AiTokenEvent) {
            self.tokens.lock().unwrap().push(e.clone());
        }
        fn emit_tool_request(&self, e: &AiToolRequestEvent) {
            self.tool_requests.lock().unwrap().push(e.clone());
        }
        fn emit_tool_started(&self, e: &AiToolStartedEvent) {
            self.tool_started.lock().unwrap().push(e.clone());
        }
        fn emit_tool_finished(&self, e: &AiToolFinishedEvent) {
            self.tool_finished.lock().unwrap().push(e.clone());
        }
        fn emit_done(&self, e: &AiDoneEvent) {
            self.done.lock().unwrap().push(e.clone());
        }
        fn emit_error(&self, e: &AiErrorEvent) {
            self.errors.lock().unwrap().push(e.clone());
        }
        fn emit_notification(&self, e: &crate::notifications::NotificationEvent) {
            self.notifications.lock().unwrap().push(e.clone());
        }
    }

    // -------- FakeProvider：每轮按预设吐 chunks --------

    struct FakeProvider {
        responses: StdMutex<Vec<Vec<ChatChunk>>>,
        /// true → stream_chat 直接返回 Err（模拟 provider 失败，验证 emit Error）。
        fail: bool,
        /// T3-A3：记录每轮真正发出去的请求，用于断言 tool_result 回填顺序。
        requests: StdMutex<Vec<ChatRequest>>,
    }

    impl FakeProvider {
        fn new(responses: Vec<Vec<ChatChunk>>) -> Self {
            Self {
                responses: StdMutex::new(responses),
                fail: false,
                requests: StdMutex::new(Vec::new()),
            }
        }

        /// 重复同一个轮（用于"永不停"测试）。
        fn always(chunks: Vec<ChatChunk>) -> Self {
            // 用 100 个相同 round 兜底（实际只会消耗 MAX_STEPS+1 个）
            let many = (0..100).map(|_| chunks.clone()).collect();
            Self {
                responses: StdMutex::new(many),
                fail: false,
                requests: StdMutex::new(Vec::new()),
            }
        }

        /// stream_chat 必失败（用于验证 provider 错误 → emit Error 通知）。
        /// 不能用空 responses 模拟：空队列会兜底返回 Done(EndTurn) 而非报错。
        fn failing() -> Self {
            Self {
                responses: StdMutex::new(vec![]),
                fail: true,
                requests: StdMutex::new(Vec::new()),
            }
        }

        /// T3-A3：取第 `n` 轮（0 起）请求里最后一条消息的 tool_result 序列
        /// （tool_use_id, content, is_error），用于断言顺序回填。
        fn tool_results_of_round(&self, n: usize) -> Vec<(String, String, bool)> {
            let reqs = self.requests.lock().unwrap();
            let req = reqs.get(n).expect("该轮请求不存在");
            let last = req.messages.last().expect("请求应有消息");
            assert!(matches!(last.role, Role::Tool), "最后一条应是 Tool 角色");
            match &last.content {
                MessageContent::Blocks(blocks) => blocks
                    .iter()
                    .filter_map(|b| match b {
                        ContentBlock::ToolResult {
                            tool_use_id,
                            content,
                            is_error,
                        } => Some((tool_use_id.clone(), content.clone(), *is_error)),
                        _ => None,
                    })
                    .collect(),
                _ => panic!("Tool 消息应是 Blocks"),
            }
        }
    }

    #[async_trait]
    impl LlmProvider for FakeProvider {
        fn id(&self) -> &str {
            "fake"
        }
        fn display_name(&self) -> &str {
            "Fake"
        }
        fn list_models(&self) -> Vec<ModelInfo> {
            vec![]
        }
        fn capabilities(&self) -> Capabilities {
            Capabilities::default()
        }
        async fn stream_chat(
            &self,
            req: ChatRequest,
        ) -> Result<BoxStream<'static, ChatChunk>, ProviderError> {
            self.requests.lock().unwrap().push(req);
            if self.fail {
                return Err(ProviderError::Other("fake provider 注入失败".into()));
            }
            let chunks = {
                let mut g = self.responses.lock().unwrap();
                if g.is_empty() {
                    vec![ChatChunk::Done {
                        stop_reason: StopReason::EndTurn,
                    }]
                } else {
                    g.remove(0)
                }
            };
            Ok(Box::pin(futures::stream::iter(chunks)))
        }
    }

    fn make_ctx() -> ToolContext {
        make_ctx_with_whitelist(&[])
    }

    fn make_ctx_with_whitelist(patterns: &[&str]) -> ToolContext {
        let dir = tempfile::tempdir().unwrap();
        let owned: Vec<String> = patterns.iter().map(|s| s.to_string()).collect();
        let (wl, _failed) = crate::safety::whitelist::compile(&owned);
        ToolContext {
            session_state: Arc::new(SessionState::new()),
            cwd: dir.keep(),
            active_session_id: None,
            whitelist: Arc::new(wl),
            browser_state: Arc::new(crate::ipc::browser::BrowserState::default()),
        }
    }

    fn base_request() -> ChatRequest {
        ChatRequest {
            model: "fake".into(),
            messages: vec![Message {
                role: Role::User,
                content: MessageContent::Text("hi".into()),
            }],
            tools: vec![],
            system: None,
            max_tokens: 1024,
            temperature: 1.0,
        }
    }

    // ===== 1. happy: 无工具调用 → 直接 done =====
    #[tokio::test]
    async fn happy_无工具调用_直接_done() {
        let provider = Arc::new(FakeProvider::new(vec![vec![
            ChatChunk::TextDelta { text: "hi ".into() },
            ChatChunk::TextDelta {
                text: "there".into(),
            },
            ChatChunk::Usage {
                input_tokens: 10,
                output_tokens: 5,
            },
            ChatChunk::Done {
                stop_reason: StopReason::EndTurn,
            },
        ]]));
        let sink = Arc::new(MockSink::default());
        let tools = Arc::new(ToolRegistry::with_defaults());
        let handle = Arc::new(ToolLoopHandle::new());

        run_tool_loop(
            base_request(),
            provider,
            tools,
            make_ctx(),
            sink.clone(),
            "c1".into(),
            handle,
            None,
        )
        .await;

        assert_eq!(sink.tokens.lock().unwrap().len(), 2);
        assert!(sink.tool_requests.lock().unwrap().is_empty());
        assert!(sink.tool_started.lock().unwrap().is_empty());
        let done = sink.done.lock().unwrap();
        assert_eq!(done.len(), 1);
        assert_eq!(done[0].stop_reason, StopReason::EndTurn);
        let usage = done[0].usage.as_ref().unwrap();
        assert_eq!(usage.input_tokens, 10);
        assert_eq!(usage.output_tokens, 5);
    }

    // ===== 2. read_file: Low 风险自动批准 =====
    #[tokio::test]
    async fn read_file_自动批准() {
        // 在沙盒里建一个文件
        let ctx = make_ctx();
        let target = ctx.cwd.join("hello.txt");
        std::fs::write(&target, "world").unwrap();

        let provider = Arc::new(FakeProvider::new(vec![
            // 第一轮：调 read_file
            vec![
                ChatChunk::ToolUseStart {
                    call_id: "tu1".into(),
                    name: "read_file".into(),
                },
                ChatChunk::ToolUseArgsDelta {
                    call_id: "tu1".into(),
                    json_partial: r#"{"path":"hello.txt"}"#.into(),
                },
                ChatChunk::ToolUseEnd {
                    call_id: "tu1".into(),
                },
                ChatChunk::Done {
                    stop_reason: StopReason::ToolUse,
                },
            ],
            // 第二轮：纯文本结束
            vec![
                ChatChunk::TextDelta { text: "ok".into() },
                ChatChunk::Done {
                    stop_reason: StopReason::EndTurn,
                },
            ],
        ]));
        let sink = Arc::new(MockSink::default());
        let tools = Arc::new(ToolRegistry::with_defaults());
        let handle = Arc::new(ToolLoopHandle::new());

        run_tool_loop(
            base_request(),
            provider,
            tools,
            ctx,
            sink.clone(),
            "c1".into(),
            handle,
            None,
        )
        .await;

        // Low 风险不应触发 tool_request（用户审批）
        assert!(sink.tool_requests.lock().unwrap().is_empty());
        // 但应有 tool_started + tool_finished
        let started = sink.tool_started.lock().unwrap();
        assert_eq!(started.len(), 1);
        assert_eq!(started[0].name, "read_file");
        let finished = sink.tool_finished.lock().unwrap();
        assert_eq!(finished.len(), 1);
        assert!(!finished[0].is_error, "read_file 应成功: {}", finished[0].content);
        assert!(finished[0].content.contains("world"));
        // done 一次
        assert_eq!(sink.done.lock().unwrap().len(), 1);
    }

    // ===== 3. run_command: High 风险，用户拒绝 =====
    //
    // 1E-2 起 T6 把 risk_class 委托给 safety::risk::classify，"ls" 归 Low（自动批准），
    // 这里换成 "mv a b" 保持测试语义（默认未知命令 → High）。
    #[tokio::test]
    async fn run_command_high_用户拒绝() {
        let provider = Arc::new(FakeProvider::new(vec![
            vec![
                ChatChunk::ToolUseStart {
                    call_id: "tu1".into(),
                    name: "run_command".into(),
                },
                ChatChunk::ToolUseArgsDelta {
                    call_id: "tu1".into(),
                    json_partial: r#"{"session_id":"s","cmd":"mv a b"}"#.into(),
                },
                ChatChunk::ToolUseEnd {
                    call_id: "tu1".into(),
                },
                ChatChunk::Done {
                    stop_reason: StopReason::ToolUse,
                },
            ],
            // 第二轮：模型看到 tool_result（拒绝）后总结
            vec![
                ChatChunk::TextDelta {
                    text: "abort".into(),
                },
                ChatChunk::Done {
                    stop_reason: StopReason::EndTurn,
                },
            ],
        ]));
        let sink = Arc::new(MockSink::default());
        let tools = Arc::new(ToolRegistry::with_defaults());
        let handle = Arc::new(ToolLoopHandle::new());

        // spawn loop；同时另一个 task 监 tool_request 后调 resolve_approval(false)
        let sink2 = sink.clone();
        let handle2 = handle.clone();
        let approve_task = tokio::spawn(async move {
            // 轮询 sink 直到有 tool_request 出现
            loop {
                let req = sink2.tool_requests.lock().unwrap().clone();
                if let Some(r) = req.first() {
                    resolve_approval(&handle2, &r.call_id, false, false).await;
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        });

        run_tool_loop(
            base_request(),
            provider,
            tools,
            make_ctx(),
            sink.clone(),
            "c1".into(),
            handle,
            None,
        )
        .await;
        approve_task.await.unwrap();

        let reqs = sink.tool_requests.lock().unwrap();
        assert_eq!(reqs.len(), 1);
        assert!(matches!(reqs[0].risk, RiskClass::High | RiskClass::Destructive));
        // 用户拒绝 → tool_started 不应触发，tool_finished is_error=true
        assert!(sink.tool_started.lock().unwrap().is_empty());
        let fin = sink.tool_finished.lock().unwrap();
        assert_eq!(fin.len(), 1);
        assert!(fin[0].is_error);
        assert!(fin[0].content.contains("拒绝"));
    }

    // ===== 4. L1 黑名单：rm -rf / 拦截 =====
    #[tokio::test]
    async fn l1_黑名单_拦截_rm_rf_root() {
        let provider = Arc::new(FakeProvider::new(vec![
            vec![
                ChatChunk::ToolUseStart {
                    call_id: "tu1".into(),
                    name: "run_command".into(),
                },
                ChatChunk::ToolUseArgsDelta {
                    call_id: "tu1".into(),
                    json_partial: r#"{"session_id":"s","cmd":"rm -rf /"}"#.into(),
                },
                ChatChunk::ToolUseEnd {
                    call_id: "tu1".into(),
                },
                ChatChunk::Done {
                    stop_reason: StopReason::ToolUse,
                },
            ],
            vec![
                ChatChunk::TextDelta { text: "ok".into() },
                ChatChunk::Done {
                    stop_reason: StopReason::EndTurn,
                },
            ],
        ]));
        let sink = Arc::new(MockSink::default());
        let tools = Arc::new(ToolRegistry::with_defaults());
        let handle = Arc::new(ToolLoopHandle::new());

        run_tool_loop(
            base_request(),
            provider,
            tools,
            make_ctx(),
            sink.clone(),
            "c1".into(),
            handle,
            None,
        )
        .await;

        // L1 黑名单：不走 ask_user → tool_request 不应有
        assert!(sink.tool_requests.lock().unwrap().is_empty());
        // 不走执行 → tool_started 也不应有
        assert!(sink.tool_started.lock().unwrap().is_empty());
        // tool_finished is_error=true，内容含"L1 黑名单"
        let fin = sink.tool_finished.lock().unwrap();
        assert_eq!(fin.len(), 1);
        assert!(fin[0].is_error);
        assert!(
            fin[0].content.contains("L1 黑名单"),
            "内容应含 L1 黑名单：{}",
            fin[0].content
        );
    }

    // ============================================================
    // 1E-2 T5：L2 + L3 接入后的新场景
    // ============================================================

    /// 构造一轮"调 run_command 然后结束"的 FakeProvider 双轮响应。
    fn provider_for_run_cmd(cmd: &str) -> Arc<FakeProvider> {
        Arc::new(FakeProvider::new(vec![
            vec![
                ChatChunk::ToolUseStart {
                    call_id: "tu1".into(),
                    name: "run_command".into(),
                },
                ChatChunk::ToolUseArgsDelta {
                    call_id: "tu1".into(),
                    json_partial: format!(r#"{{"session_id":"s","cmd":{}}}"#, serde_json::Value::String(cmd.to_string())),
                },
                ChatChunk::ToolUseEnd {
                    call_id: "tu1".into(),
                },
                ChatChunk::Done {
                    stop_reason: StopReason::ToolUse,
                },
            ],
            vec![
                ChatChunk::TextDelta { text: "ok".into() },
                ChatChunk::Done {
                    stop_reason: StopReason::EndTurn,
                },
            ],
        ]))
    }

    /// 后台任务：监 sink 等到出现 tool_request 就调 resolve_approval(approved)。
    fn spawn_responder(
        sink: Arc<MockSink>,
        handle: Arc<ToolLoopHandle>,
        approved: bool,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            loop {
                let req = sink.tool_requests.lock().unwrap().clone();
                if let Some(r) = req.first() {
                    resolve_approval(&handle, &r.call_id, approved, false).await;
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
    }

    /// L2 destructive：sudo 命令应弹 destructive 弹窗（白名单覆盖也不行，
    /// 这里先不配白名单测最基础场景）；用户拒绝 → reject。
    #[tokio::test]
    async fn l2_destructive_sudo_弹_destructive_弹窗() {
        let provider = provider_for_run_cmd("sudo ls /");
        let sink = Arc::new(MockSink::default());
        let tools = Arc::new(ToolRegistry::with_defaults());
        let handle = Arc::new(ToolLoopHandle::new());
        let responder = spawn_responder(sink.clone(), handle.clone(), false);

        run_tool_loop(
            base_request(),
            provider,
            tools,
            make_ctx(),
            sink.clone(),
            "c1".into(),
            handle,
            None,
        )
        .await;
        responder.await.unwrap();

        let reqs = sink.tool_requests.lock().unwrap();
        assert_eq!(reqs.len(), 1);
        assert_eq!(reqs[0].risk, RiskClass::Destructive);
        let reason = reqs[0].risk_reason.as_deref().unwrap_or("");
        assert!(reason.contains("L2"), "risk_reason 应带 L2 前缀: {reason}");
        assert!(reason.contains("sudo"), "risk_reason 应说明 sudo: {reason}");
        // 拒绝 → tool_started 不该触发
        assert!(sink.tool_started.lock().unwrap().is_empty());
    }

    /// L2 LOW：ls 命令自动批准（不弹窗），auto_approved_reason 含 L2 前缀。
    /// run_command 实际执行时 session 不存在会失败，但不影响"自动批"这个事实。
    #[tokio::test]
    async fn l2_low_ls_自动批准_不弹窗() {
        let provider = provider_for_run_cmd("ls -la");
        let sink = Arc::new(MockSink::default());
        let tools = Arc::new(ToolRegistry::with_defaults());
        let handle = Arc::new(ToolLoopHandle::new());

        run_tool_loop(
            base_request(),
            provider,
            tools,
            make_ctx(),
            sink.clone(),
            "c1".into(),
            handle,
            None,
        )
        .await;

        // 不应有任何 tool_request（自动批）
        assert!(
            sink.tool_requests.lock().unwrap().is_empty(),
            "L2 LOW 不应弹窗"
        );
        let fin = sink.tool_finished.lock().unwrap();
        assert_eq!(fin.len(), 1);
        let reason = fin[0].auto_approved_reason.as_deref().unwrap_or("");
        assert!(
            reason.contains("L2") && reason.contains("ls"),
            "auto_approved_reason 应说明 L2 + ls: {reason}"
        );
    }

    /// L3 白名单命中：HIGH 命令（mv）配 mv * 白名单 → 自动批，原因 = "白名单：mv *"。
    #[tokio::test]
    async fn l3_白名单_命中_high_降级_自动批准() {
        let provider = provider_for_run_cmd("mv a b");
        let sink = Arc::new(MockSink::default());
        let tools = Arc::new(ToolRegistry::with_defaults());
        let handle = Arc::new(ToolLoopHandle::new());

        run_tool_loop(
            base_request(),
            provider,
            tools,
            make_ctx_with_whitelist(&["mv *"]),
            sink.clone(),
            "c1".into(),
            handle,
            None,
        )
        .await;

        assert!(
            sink.tool_requests.lock().unwrap().is_empty(),
            "白名单命中不应弹窗"
        );
        let fin = sink.tool_finished.lock().unwrap();
        assert_eq!(fin.len(), 1);
        let reason = fin[0].auto_approved_reason.as_deref().unwrap_or("");
        assert!(
            reason.contains("白名单") && reason.contains("mv *"),
            "auto_approved_reason 应说明白名单 + 模式: {reason}"
        );
    }

    /// L3 白名单**不能**覆盖 DESTRUCTIVE：哪怕配了 sudo *，sudo 命令仍弹 destructive 弹窗。
    #[tokio::test]
    async fn l3_白名单_不覆盖_destructive() {
        let provider = provider_for_run_cmd("sudo ls /");
        let sink = Arc::new(MockSink::default());
        let tools = Arc::new(ToolRegistry::with_defaults());
        let handle = Arc::new(ToolLoopHandle::new());
        let responder = spawn_responder(sink.clone(), handle.clone(), false);

        run_tool_loop(
            base_request(),
            provider,
            tools,
            make_ctx_with_whitelist(&["sudo *"]),
            sink.clone(),
            "c1".into(),
            handle,
            None,
        )
        .await;
        responder.await.unwrap();

        let reqs = sink.tool_requests.lock().unwrap();
        assert_eq!(reqs.len(), 1, "destructive 应弹窗");
        assert_eq!(
            reqs[0].risk,
            RiskClass::Destructive,
            "白名单不应能把 destructive 降级"
        );
    }

    /// L3 元字符防注入：cmd 含 ; 时 L2 把它升 HIGH（即使 ls 是 LOW）；
    /// 白名单 ls * 看到含元字符的 cmd 也不命中 → 弹普通 HIGH 弹窗。
    #[tokio::test]
    async fn l3_元字符_cmd_不命中_白名单_仍弹_high() {
        let provider = provider_for_run_cmd("ls; rm -rf .");
        let sink = Arc::new(MockSink::default());
        let tools = Arc::new(ToolRegistry::with_defaults());
        let handle = Arc::new(ToolLoopHandle::new());
        let responder = spawn_responder(sink.clone(), handle.clone(), false);

        run_tool_loop(
            base_request(),
            provider,
            tools,
            make_ctx_with_whitelist(&["ls *"]),
            sink.clone(),
            "c1".into(),
            handle,
            None,
        )
        .await;
        responder.await.unwrap();

        let reqs = sink.tool_requests.lock().unwrap();
        assert_eq!(reqs.len(), 1, "元字符 cmd 应弹窗（白名单不该命中）");
        assert_eq!(reqs[0].risk, RiskClass::High);
    }

    // ===== 5. 超 MAX_STEPS 触发 summarize =====
    #[tokio::test]
    async fn 超_max_steps_触发_summarize() {
        // 每轮都返回一个 read_file tool_use（永不停）
        let provider = Arc::new(FakeProvider::always(vec![
            ChatChunk::ToolUseStart {
                call_id: "tu1".into(),
                name: "read_file".into(),
            },
            ChatChunk::ToolUseArgsDelta {
                call_id: "tu1".into(),
                // 引用一个不存在文件 → tool 返回 is_error=true，不影响循环
                json_partial: r#"{"path":"nope.txt"}"#.into(),
            },
            ChatChunk::ToolUseEnd {
                call_id: "tu1".into(),
            },
            ChatChunk::Done {
                stop_reason: StopReason::ToolUse,
            },
        ]));
        let sink = Arc::new(MockSink::default());
        let tools = Arc::new(ToolRegistry::with_defaults());
        let handle = Arc::new(ToolLoopHandle::new());

        run_tool_loop(
            base_request(),
            provider,
            tools,
            make_ctx(),
            sink.clone(),
            "c1".into(),
            handle,
            None,
        )
        .await;

        // MAX_STEPS = 10，每轮一个 finished → 10 个；summarize 不再调工具
        let fin_count = sink.tool_finished.lock().unwrap().len();
        assert_eq!(fin_count, MAX_STEPS as usize);
        // summarize 走完应有一个 done
        let done = sink.done.lock().unwrap();
        assert_eq!(done.len(), 1);
        // 不应有 error
        assert!(sink.errors.lock().unwrap().is_empty());
    }

    // ============================================================
    // v0.5.0-A T6：AI 工具循环 5 触发点 notification 测试
    // ============================================================

    /// 带 active_session_id 的 ctx，触发点才会真 emit_notification
    fn make_ctx_with_session() -> ToolContext {
        let mut ctx = make_ctx();
        ctx.active_session_id = Some("test-session-id".to_string());
        ctx
    }

    #[tokio::test]
    async fn notification_loop_入口_emit_running_完成_emit_done() {
        // 纯文本一轮结束（无工具调用）→ 入口 Running + 出口 Done
        let provider = Arc::new(FakeProvider::new(vec![vec![
            ChatChunk::TextDelta { text: "hi".into() },
            ChatChunk::Done {
                stop_reason: StopReason::EndTurn,
            },
        ]]));
        let sink = Arc::new(MockSink::default());
        let tools = Arc::new(ToolRegistry::with_defaults());
        let handle = Arc::new(ToolLoopHandle::new());

        run_tool_loop(
            base_request(),
            provider,
            tools,
            make_ctx_with_session(),
            sink.clone(),
            "c1".into(),
            handle,
            None,
        )
        .await;

        let notifs = sink.notifications.lock().unwrap();
        assert_eq!(notifs.len(), 2, "应有 Running + Done 两条通知");
        assert_eq!(
            notifs[0].level,
            crate::notifications::NotificationLevel::Running
        );
        assert_eq!(
            notifs[1].level,
            crate::notifications::NotificationLevel::Done
        );
        assert_eq!(notifs[0].session_id, "test-session-id");
        assert_eq!(
            notifs[0].source,
            crate::notifications::NotificationSource::AiToolLoop
        );
    }

    #[tokio::test]
    async fn notification_active_session_id_为_none_时_不_emit() {
        // 无 active_session_id → notify_ai_loop 应 noop（前端 routing 不到 tab）
        let provider = Arc::new(FakeProvider::new(vec![vec![
            ChatChunk::TextDelta { text: "hi".into() },
            ChatChunk::Done {
                stop_reason: StopReason::EndTurn,
            },
        ]]));
        let sink = Arc::new(MockSink::default());
        let tools = Arc::new(ToolRegistry::with_defaults());
        let handle = Arc::new(ToolLoopHandle::new());

        run_tool_loop(
            base_request(),
            provider,
            tools,
            make_ctx(), // active_session_id = None
            sink.clone(),
            "c1".into(),
            handle,
            None,
        )
        .await;

        let notifs = sink.notifications.lock().unwrap();
        assert!(notifs.is_empty(), "session_id 为 None 时不应 emit 通知");
        // 但 done 仍正常 emit（不影响主路径）
        assert_eq!(sink.done.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn notification_ask_user_emit_waiting() {
        // 调一个 high 风险工具 → ask_user 弹审批前应 emit Waiting。
        // ⚠️ cmd 必须是 High 风险：safety::risk::classify 把 echo/ls 等只读命令
        // 判 Low 自动批准（不弹审批 → 不 emit tool_request），那样 spawn_responder
        // 会永久空转等不到请求导致测试 hang。用 npm run build（非 low 前缀、
        // 非 destructive）→ 默认 High，真走 ask_user 审批路径。
        let provider = Arc::new(FakeProvider::new(vec![
            vec![
                ChatChunk::ToolUseStart {
                    call_id: "tc1".into(),
                    name: "run_command".into(),
                },
                ChatChunk::ToolUseArgsDelta {
                    call_id: "tc1".into(),
                    json_partial: r#"{"cmd":"npm run build"}"#.into(),
                },
                ChatChunk::ToolUseEnd {
                    call_id: "tc1".into(),
                },
                ChatChunk::Done {
                    stop_reason: StopReason::ToolUse,
                },
            ],
            vec![
                ChatChunk::TextDelta {
                    text: "done".into(),
                },
                ChatChunk::Done {
                    stop_reason: StopReason::EndTurn,
                },
            ],
        ]));
        let sink = Arc::new(MockSink::default());
        let tools = Arc::new(ToolRegistry::with_defaults());
        let handle = Arc::new(ToolLoopHandle::new());
        let responder = spawn_responder(sink.clone(), handle.clone(), true);

        run_tool_loop(
            base_request(),
            provider,
            tools,
            make_ctx_with_session(),
            sink.clone(),
            "c1".into(),
            handle,
            None,
        )
        .await;
        responder.await.unwrap();

        let notifs = sink.notifications.lock().unwrap();
        // 至少 Running 入口 + Waiting (ask_user) + Done 收尾
        let has_running = notifs
            .iter()
            .any(|n| n.level == crate::notifications::NotificationLevel::Running);
        let has_waiting = notifs
            .iter()
            .any(|n| n.level == crate::notifications::NotificationLevel::Waiting);
        let has_done = notifs
            .iter()
            .any(|n| n.level == crate::notifications::NotificationLevel::Done);
        assert!(has_running, "应 emit Running 入口");
        assert!(has_waiting, "高风险工具应 emit Waiting 等审批");
        assert!(has_done, "结束应 emit Done");

        // Waiting 通知的 message 应包含工具名
        let waiting = notifs
            .iter()
            .find(|n| n.level == crate::notifications::NotificationLevel::Waiting)
            .unwrap();
        assert!(
            waiting.message.contains("run_command"),
            "Waiting 通知 message 应含工具名"
        );
    }

    #[tokio::test]
    async fn notification_provider_失败_emit_error() {
        // FakeProvider 注入失败（stream_chat 返 Err）→ collect_one_turn 返 Err
        // → 应 emit Error 通知。注意不能用空 responses：空队列会兜底返回
        // Done(EndTurn) 而非报错（这正是本测试此前一直 FAILED 的原因）。
        let provider = Arc::new(FakeProvider::failing());
        let sink = Arc::new(MockSink::default());
        let tools = Arc::new(ToolRegistry::with_defaults());
        let handle = Arc::new(ToolLoopHandle::new());

        run_tool_loop(
            base_request(),
            provider,
            tools,
            make_ctx_with_session(),
            sink.clone(),
            "c1".into(),
            handle,
            None,
        )
        .await;

        let notifs = sink.notifications.lock().unwrap();
        let has_error = notifs
            .iter()
            .any(|n| n.level == crate::notifications::NotificationLevel::Error);
        assert!(has_error, "provider 失败应 emit Error");
        assert_eq!(sink.errors.lock().unwrap().len(), 1);
    }

    // ============================================================
    // T-B3a：preview 塞进 ai:tool_request / ai:tool_finished 事件
    // ============================================================

    /// override preview 返回 Some(diff) 的测试工具（High 风险 → 走 ask_user 审批，
    /// emit tool_request）。
    struct PreviewHighTool;
    #[async_trait]
    impl Tool for PreviewHighTool {
        fn name(&self) -> &str {
            "preview_high"
        }
        fn description(&self) -> &str {
            "测试 diff 预览"
        }
        fn input_schema(&self) -> serde_json::Value {
            serde_json::json!({"type":"object"})
        }
        fn risk_class(&self, _a: &serde_json::Value) -> RiskClass {
            RiskClass::High
        }
        async fn execute(
            &self,
            _a: serde_json::Value,
            _c: &ToolContext,
        ) -> Result<ToolResult, crate::tools::ToolError> {
            Ok(ToolResult {
                content: "已改".into(),
                is_error: false,
            })
        }
        async fn preview(
            &self,
            _a: &serde_json::Value,
            _c: &ToolContext,
        ) -> Option<ToolPreview> {
            Some(ToolPreview {
                kind: "diff".into(),
                path: "hello.txt".into(),
                old_text: "old".into(),
                new_text: "new".into(),
            })
        }
    }

    /// preview 会 panic 的测试工具（Low 风险 → 自动批，验证 catch_unwind 降级 None
    /// 且不影响主循环）。
    struct PanicPreviewTool;
    #[async_trait]
    impl Tool for PanicPreviewTool {
        fn name(&self) -> &str {
            "panic_preview"
        }
        fn description(&self) -> &str {
            "preview 会 panic"
        }
        fn input_schema(&self) -> serde_json::Value {
            serde_json::json!({"type":"object"})
        }
        fn risk_class(&self, _a: &serde_json::Value) -> RiskClass {
            RiskClass::Low
        }
        async fn execute(
            &self,
            _a: serde_json::Value,
            _c: &ToolContext,
        ) -> Result<ToolResult, crate::tools::ToolError> {
            Ok(ToolResult {
                content: "ok".into(),
                is_error: false,
            })
        }
        async fn preview(
            &self,
            _a: &serde_json::Value,
            _c: &ToolContext,
        ) -> Option<ToolPreview> {
            panic!("preview 故意 panic");
        }
    }

    /// 构造只含单个自定义工具的 registry。
    fn registry_with(tool: Arc<dyn Tool>) -> Arc<ToolRegistry> {
        let mut r = ToolRegistry::new();
        r.register(tool);
        Arc::new(r)
    }

    /// FakeProvider：第一轮调 `name` 工具（空参），第二轮纯文本收尾。
    fn provider_calls(name: &str) -> Arc<FakeProvider> {
        Arc::new(FakeProvider::new(vec![
            vec![
                ChatChunk::ToolUseStart {
                    call_id: "tc1".into(),
                    name: name.into(),
                },
                ChatChunk::ToolUseArgsDelta {
                    call_id: "tc1".into(),
                    json_partial: "{}".into(),
                },
                ChatChunk::ToolUseEnd {
                    call_id: "tc1".into(),
                },
                ChatChunk::Done {
                    stop_reason: StopReason::ToolUse,
                },
            ],
            vec![
                ChatChunk::TextDelta {
                    text: "done".into(),
                },
                ChatChunk::Done {
                    stop_reason: StopReason::EndTurn,
                },
            ],
        ]))
    }

    #[tokio::test]
    async fn tool_request_和_finished_带上_preview() {
        let provider = provider_calls("preview_high");
        let sink = Arc::new(MockSink::default());
        let tools = registry_with(Arc::new(PreviewHighTool));
        let handle = Arc::new(ToolLoopHandle::new());
        let responder = spawn_responder(sink.clone(), handle.clone(), true);

        run_tool_loop(
            base_request(),
            provider,
            tools,
            make_ctx(),
            sink.clone(),
            "c1".into(),
            handle,
            None,
        )
        .await;
        responder.await.unwrap();

        // 审批事件带 preview
        let reqs = sink.tool_requests.lock().unwrap();
        assert_eq!(reqs.len(), 1);
        let p = reqs[0].preview.as_ref().expect("tool_request 应带 preview");
        assert_eq!(p.kind, "diff");
        assert_eq!(p.path, "hello.txt");
        assert_eq!(p.old_text, "old");
        assert_eq!(p.new_text, "new");

        // 完成事件同样带 preview（历史气泡回看）
        let fin = sink.tool_finished.lock().unwrap();
        assert_eq!(fin.len(), 1);
        let fp = fin[0].preview.as_ref().expect("tool_finished 应带 preview");
        assert_eq!(fp.new_text, "new");
        assert!(!fin[0].is_error, "工具应执行成功");
    }

    #[tokio::test]
    async fn preview_panic_降级_none_不影响循环() {
        let provider = provider_calls("panic_preview");
        let sink = Arc::new(MockSink::default());
        let tools = registry_with(Arc::new(PanicPreviewTool));
        let handle = Arc::new(ToolLoopHandle::new());

        // Low 风险 → 自动批准，无需 responder
        run_tool_loop(
            base_request(),
            provider,
            tools,
            make_ctx(),
            sink.clone(),
            "c1".into(),
            handle,
            None,
        )
        .await;

        // 主循环正常收尾，无 error
        assert!(
            sink.errors.lock().unwrap().is_empty(),
            "preview panic 不应产生 error"
        );
        assert_eq!(sink.done.lock().unwrap().len(), 1, "循环应正常 done");
        // 工具照常执行 + finished，preview 降级 None
        let fin = sink.tool_finished.lock().unwrap();
        assert_eq!(fin.len(), 1);
        assert!(fin[0].preview.is_none(), "preview 计算失败应降级 None");
        assert!(!fin[0].is_error, "工具本身应成功执行");
        // Low 自动批，无审批事件
        assert!(sink.tool_requests.lock().unwrap().is_empty());
    }

    // ============================================================
    // T-A3：工具耗时 elapsed_ms
    // ============================================================

    #[tokio::test]
    async fn a3_黑名单拦截_未执行_elapsed_ms_为_0() {
        // 未执行路径（L1 拦截）elapsed_ms 恒 0
        let provider = provider_for_run_cmd("rm -rf /");
        let sink = Arc::new(MockSink::default());
        let tools = Arc::new(ToolRegistry::with_defaults());
        let handle = Arc::new(ToolLoopHandle::new());

        run_tool_loop(
            base_request(),
            provider,
            tools,
            make_ctx(),
            sink.clone(),
            "c1".into(),
            handle,
            None,
        )
        .await;

        let fin = sink.tool_finished.lock().unwrap();
        assert_eq!(fin.len(), 1);
        assert!(fin[0].is_error);
        assert_eq!(fin[0].elapsed_ms, 0, "未执行路径 elapsed_ms 应为 0");
    }

    #[tokio::test]
    async fn a3_read_file_执行路径_finished_带_elapsed_ms() {
        // 真正执行工具 → finished 事件带 elapsed_ms 字段（u64，恒存在）
        let ctx = make_ctx();
        let target = ctx.cwd.join("hi.txt");
        std::fs::write(&target, "world").unwrap();
        let provider = Arc::new(FakeProvider::new(vec![
            vec![
                ChatChunk::ToolUseStart {
                    call_id: "tu1".into(),
                    name: "read_file".into(),
                },
                ChatChunk::ToolUseArgsDelta {
                    call_id: "tu1".into(),
                    json_partial: r#"{"path":"hi.txt"}"#.into(),
                },
                ChatChunk::ToolUseEnd {
                    call_id: "tu1".into(),
                },
                ChatChunk::Done {
                    stop_reason: StopReason::ToolUse,
                },
            ],
            vec![
                ChatChunk::TextDelta { text: "ok".into() },
                ChatChunk::Done {
                    stop_reason: StopReason::EndTurn,
                },
            ],
        ]));
        let sink = Arc::new(MockSink::default());
        let tools = Arc::new(ToolRegistry::with_defaults());
        let handle = Arc::new(ToolLoopHandle::new());

        run_tool_loop(
            base_request(),
            provider,
            tools,
            ctx,
            sink.clone(),
            "c1".into(),
            handle,
            None,
        )
        .await;

        let fin = sink.tool_finished.lock().unwrap();
        assert_eq!(fin.len(), 1);
        assert!(!fin[0].is_error, "read_file 应成功");
        // elapsed_ms 是 u64 字段，执行路径恒被赋值（真实耗时，通常极小）
        let _ = fin[0].elapsed_ms;
    }

    // ============================================================
    // T-C2：错误重试 / 退避（establishment 级）
    // ============================================================

    /// 建立阶段前 N 次返回错误、之后成功的 provider，记录调用总次数。
    struct RetryProvider {
        calls: std::sync::atomic::AtomicU32,
        fail_first_n: u32,
        retryable: bool,
    }
    impl RetryProvider {
        fn new(fail_first_n: u32, retryable: bool) -> Self {
            Self {
                calls: std::sync::atomic::AtomicU32::new(0),
                fail_first_n,
                retryable,
            }
        }
        fn call_count(&self) -> u32 {
            self.calls.load(std::sync::atomic::Ordering::SeqCst)
        }
    }
    #[async_trait]
    impl LlmProvider for RetryProvider {
        fn id(&self) -> &str {
            "retry"
        }
        fn display_name(&self) -> &str {
            "Retry"
        }
        fn list_models(&self) -> Vec<ModelInfo> {
            vec![]
        }
        fn capabilities(&self) -> Capabilities {
            Capabilities::default()
        }
        async fn stream_chat(
            &self,
            _req: ChatRequest,
        ) -> Result<BoxStream<'static, ChatChunk>, ProviderError> {
            let n = self
                .calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if n < self.fail_first_n {
                return Err(if self.retryable {
                    ProviderError::Timeout
                } else {
                    ProviderError::Unauthorized
                });
            }
            Ok(Box::pin(futures::stream::iter(vec![ChatChunk::Done {
                stop_reason: StopReason::EndTurn,
            }])))
        }
    }

    /// 测试用快退避策略（base 1ms，避免真 sleep 拖慢测试）。
    fn fast_retry() -> RetryPolicy {
        RetryPolicy {
            max_retries: 2,
            base_delay_ms: 1,
        }
    }

    #[test]
    fn c2_is_retryable_分类正确() {
        assert!(is_retryable(&ProviderError::RateLimited));
        assert!(is_retryable(&ProviderError::Timeout));
        // Http 需要一个 reqwest::Error 才能构造，这里只覆盖枚举可判性即可
        assert!(!is_retryable(&ProviderError::Unauthorized));
        assert!(!is_retryable(&ProviderError::Protocol("400 bad".into())));
        assert!(!is_retryable(&ProviderError::Config("x".into())));
        assert!(!is_retryable(&ProviderError::Other("x".into())));
    }

    #[tokio::test]
    async fn c2_可重试错误_退避后成功() {
        // 前 2 次 Timeout（可重试），第 3 次成功 → 共调 3 次
        let provider = RetryProvider::new(2, true);
        let sink = MockSink::default();
        let turn = collect_one_turn(&provider, base_request(), &sink, "c1", fast_retry()).await;
        assert!(turn.is_ok(), "重试后应成功");
        assert_eq!(provider.call_count(), 3, "1 次首发 + 2 次重试");
    }

    #[tokio::test]
    async fn c2_不可重试错误_不重试_立即失败() {
        // Unauthorized（401）→ 不重试，只调 1 次
        let provider = RetryProvider::new(1, false);
        let sink = MockSink::default();
        let turn = collect_one_turn(&provider, base_request(), &sink, "c1", fast_retry()).await;
        assert!(turn.is_err(), "不可重试应直接失败");
        assert_eq!(provider.call_count(), 1, "不可重试不应重试");
    }

    #[tokio::test]
    async fn c2_可重试但超次数上限_耗尽后失败() {
        // 一直失败（fail_first_n 很大）→ 首发 + max_retries 次后放弃
        let provider = RetryProvider::new(100, true);
        let sink = MockSink::default();
        let turn = collect_one_turn(&provider, base_request(), &sink, "c1", fast_retry()).await;
        assert!(turn.is_err(), "耗尽重试仍失败");
        assert_eq!(provider.call_count(), 3, "1 次首发 + 上限 2 次重试");
    }

    // ============================================================
    // v1.3.0 T3-A1：审批批量化（会话内 always-allow）
    // ============================================================

    /// A1 测试用 High 风险工具（每次调用都要审批，除非本会话已授权）。
    struct GrantHighTool;
    #[async_trait]
    impl Tool for GrantHighTool {
        fn name(&self) -> &str {
            "grant_high"
        }
        fn description(&self) -> &str {
            "A1 测试：High 风险工具"
        }
        fn input_schema(&self) -> serde_json::Value {
            serde_json::json!({"type":"object"})
        }
        fn risk_class(&self, _a: &serde_json::Value) -> RiskClass {
            RiskClass::High
        }
        async fn execute(
            &self,
            _a: serde_json::Value,
            _c: &ToolContext,
        ) -> Result<ToolResult, crate::tools::ToolError> {
            Ok(ToolResult {
                content: "已执行".into(),
                is_error: false,
            })
        }
    }

    /// A1 测试用 DESTRUCTIVE 工具（红线：remember 也绝不放行）。
    struct GrantDestructiveTool;
    #[async_trait]
    impl Tool for GrantDestructiveTool {
        fn name(&self) -> &str {
            "grant_destructive"
        }
        fn description(&self) -> &str {
            "A1 测试：Destructive 工具"
        }
        fn input_schema(&self) -> serde_json::Value {
            serde_json::json!({"type":"object"})
        }
        fn risk_class(&self, _a: &serde_json::Value) -> RiskClass {
            RiskClass::Destructive
        }
        async fn execute(
            &self,
            _a: serde_json::Value,
            _c: &ToolContext,
        ) -> Result<ToolResult, crate::tools::ToolError> {
            Ok(ToolResult {
                content: "已执行".into(),
                is_error: false,
            })
        }
    }

    /// 后台任务：持续应答**所有**审批请求（每个 call_id 只答一次），
    /// 直到被 abort。A1 多轮场景需要它（`spawn_responder` 只答第一条）。
    fn spawn_responder_all(
        sink: Arc<MockSink>,
        handle: Arc<ToolLoopHandle>,
        approved: bool,
        remember: bool,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let mut answered: std::collections::HashSet<String> = std::collections::HashSet::new();
            loop {
                let reqs = sink.tool_requests.lock().unwrap().clone();
                for r in reqs {
                    if answered.insert(r.call_id.clone()) {
                        resolve_approval(&handle, &r.call_id, approved, remember).await;
                    }
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
    }

    /// 构造「连续 N 轮各调一次 `name` 工具、最后一轮纯文本收尾」的 provider。
    fn provider_calls_n_rounds(name: &str, rounds: usize) -> Arc<FakeProvider> {
        let mut resp: Vec<Vec<ChatChunk>> = Vec::new();
        for i in 0..rounds {
            let cid = format!("tc{i}");
            resp.push(vec![
                ChatChunk::ToolUseStart {
                    call_id: cid.clone(),
                    name: name.into(),
                },
                ChatChunk::ToolUseArgsDelta {
                    call_id: cid.clone(),
                    json_partial: "{}".into(),
                },
                ChatChunk::ToolUseEnd { call_id: cid },
                ChatChunk::Done {
                    stop_reason: StopReason::ToolUse,
                },
            ]);
        }
        resp.push(vec![
            ChatChunk::TextDelta {
                text: "done".into(),
            },
            ChatChunk::Done {
                stop_reason: StopReason::EndTurn,
            },
        ]);
        Arc::new(FakeProvider::new(resp))
    }

    /// 🔴 红线（维护者 2026-07-27 拍板）：`run_command` **不参与**会话级授权。
    ///
    /// 工具级粒度对它太粗——一个工具名覆盖无限多命令，授权一次 `npm test` 会让之后
    /// 任何 L2 判 High 的命令静默执行。命令级放行走 L3 glob 白名单。
    /// 这条测试锁住行为，防止日后被"顺手统一"回去。
    #[tokio::test]
    async fn a1_run_command_不参与会话授权_remember_也每次审批() {
        // 两轮都调 run_command，cmd 走 L2 判 HIGH 且不命中空白名单
        let round = |i: usize| {
            let cid = format!("tc{i}");
            vec![
                ChatChunk::ToolUseStart {
                    call_id: cid.clone(),
                    name: "run_command".into(),
                },
                ChatChunk::ToolUseArgsDelta {
                    call_id: cid.clone(),
                    json_partial: r#"{"session_id":"s","cmd":"mv a b"}"#.into(),
                },
                ChatChunk::ToolUseEnd { call_id: cid },
                ChatChunk::Done {
                    stop_reason: StopReason::ToolUse,
                },
            ]
        };
        let provider = Arc::new(FakeProvider::new(vec![
            round(0),
            round(1),
            vec![
                ChatChunk::TextDelta {
                    text: "done".into(),
                },
                ChatChunk::Done {
                    stop_reason: StopReason::EndTurn,
                },
            ],
        ]));
        let sink = Arc::new(MockSink::default());
        let tools = Arc::new(ToolRegistry::with_defaults());
        let handle = Arc::new(ToolLoopHandle::new());
        // 每次都批准 **且** remember=true —— 即便如此也不该记账
        let responder = spawn_responder_all(sink.clone(), handle.clone(), true, true);

        run_tool_loop(
            base_request(),
            provider,
            tools,
            make_ctx(),
            sink.clone(),
            "c1".into(),
            handle.clone(),
            None,
        )
        .await;
        responder.abort();

        assert_eq!(
            sink.tool_requests.lock().unwrap().len(),
            2,
            "run_command 两轮都必须弹审批——会话授权不适用于它"
        );
        assert!(
            !handle.is_granted("c1", "run_command").await,
            "run_command 绝不该被写进会话授权集"
        );
    }

    #[tokio::test]
    async fn a1_remember_后同工具第二次不再审批_且带本会话已授权徽章() {
        let provider = provider_calls_n_rounds("grant_high", 2);
        let sink = Arc::new(MockSink::default());
        let tools = registry_with(Arc::new(GrantHighTool));
        let handle = Arc::new(ToolLoopHandle::new());
        let responder = spawn_responder_all(sink.clone(), handle.clone(), true, true);

        run_tool_loop(
            base_request(),
            provider,
            tools,
            make_ctx(),
            sink.clone(),
            "c1".into(),
            handle,
            None,
        )
        .await;
        responder.abort();

        // 只弹了 1 次审批（第二轮命中会话授权集）
        assert_eq!(
            sink.tool_requests.lock().unwrap().len(),
            1,
            "remember=true 后第二次调用不应再弹审批"
        );
        let fin = sink.tool_finished.lock().unwrap();
        assert_eq!(fin.len(), 2, "两次调用都应执行完成");
        // 第一次走弹窗批准 → 无自动批准徽章
        assert!(fin[0].auto_approved_reason.is_none());
        // 第二次自动放行 → 必须带可见徽章说明原因
        assert_eq!(
            fin[1].auto_approved_reason.as_deref(),
            Some("本会话已授权"),
            "自动放行必须带「本会话已授权」徽章"
        );
    }

    #[tokio::test]
    async fn a1_remember_false_时行为不变_每次都审批() {
        let provider = provider_calls_n_rounds("grant_high", 2);
        let sink = Arc::new(MockSink::default());
        let tools = registry_with(Arc::new(GrantHighTool));
        let handle = Arc::new(ToolLoopHandle::new());
        let responder = spawn_responder_all(sink.clone(), handle.clone(), true, false);

        run_tool_loop(
            base_request(),
            provider,
            tools,
            make_ctx(),
            sink.clone(),
            "c1".into(),
            handle,
            None,
        )
        .await;
        responder.abort();

        assert_eq!(
            sink.tool_requests.lock().unwrap().len(),
            2,
            "remember=false 应保持 v1.2.0 行为：每次都弹审批"
        );
        let fin = sink.tool_finished.lock().unwrap();
        assert!(
            fin.iter().all(|f| f.auto_approved_reason.is_none()),
            "都是弹窗批准，不应有自动批准徽章"
        );
    }

    #[tokio::test]
    async fn a1_destructive_即使_remember_仍每次审批() {
        let provider = provider_calls_n_rounds("grant_destructive", 2);
        let sink = Arc::new(MockSink::default());
        let tools = registry_with(Arc::new(GrantDestructiveTool));
        let handle = Arc::new(ToolLoopHandle::new());
        // 前端不该给 destructive 发 remember=true，这里故意发 → 后端必须兜底不记账
        let responder = spawn_responder_all(sink.clone(), handle.clone(), true, true);

        run_tool_loop(
            base_request(),
            provider,
            tools,
            make_ctx(),
            sink.clone(),
            "c1".into(),
            handle,
            None,
        )
        .await;
        responder.abort();

        let reqs = sink.tool_requests.lock().unwrap();
        assert_eq!(reqs.len(), 2, "🔴 DESTRUCTIVE 红线：每次都必须审批");
        assert!(reqs.iter().all(|r| r.risk == RiskClass::Destructive));
        let fin = sink.tool_finished.lock().unwrap();
        assert!(
            fin.iter().all(|f| f.auto_approved_reason.is_none()),
            "destructive 永远不该出现自动放行"
        );
    }

    #[tokio::test]
    async fn a1_授权按会话隔离_不串台() {
        let tools = registry_with(Arc::new(GrantHighTool));
        let handle = Arc::new(ToolLoopHandle::new());

        // 会话 A：批准并记住
        let sink_a = Arc::new(MockSink::default());
        let responder_a = spawn_responder_all(sink_a.clone(), handle.clone(), true, true);
        run_tool_loop(
            base_request(),
            provider_calls_n_rounds("grant_high", 2),
            tools.clone(),
            make_ctx(),
            sink_a.clone(),
            "conv-A".into(),
            handle.clone(),
            None,
        )
        .await;
        responder_a.abort();
        assert_eq!(sink_a.tool_requests.lock().unwrap().len(), 1);

        // 会话 B：共用同一个 handle，但**不应**继承 A 的授权
        let sink_b = Arc::new(MockSink::default());
        let responder_b = spawn_responder_all(sink_b.clone(), handle.clone(), true, false);
        run_tool_loop(
            base_request(),
            provider_calls_n_rounds("grant_high", 1),
            tools,
            make_ctx(),
            sink_b.clone(),
            "conv-B".into(),
            handle,
            None,
        )
        .await;
        responder_b.abort();

        assert_eq!(
            sink_b.tool_requests.lock().unwrap().len(),
            1,
            "会话 B 不应继承会话 A 的授权"
        );
    }

    // ============================================================
    // v1.3.0 T3-A3：只读工具并行执行
    // ============================================================

    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

    /// A3 测试用只读工具：**冒充 `read_file`**（并发白名单按工具名匹配），
    /// 记录并发峰值 + 执行完成顺序，用 sleep 模拟 IO 等待。
    /// 入参 `tag == "boom"` 时返回错误，用于「单个失败不影响其它」测试。
    struct SlowReadTool {
        live: Arc<AtomicUsize>,
        peak: Arc<AtomicUsize>,
        log: Arc<StdMutex<Vec<String>>>,
        delay_ms: u64,
    }

    #[async_trait]
    impl Tool for SlowReadTool {
        fn name(&self) -> &str {
            "read_file"
        }
        fn description(&self) -> &str {
            "A3 测试：慢只读工具"
        }
        fn input_schema(&self) -> serde_json::Value {
            serde_json::json!({"type":"object"})
        }
        fn risk_class(&self, _a: &serde_json::Value) -> RiskClass {
            RiskClass::Low
        }
        async fn execute(
            &self,
            a: serde_json::Value,
            _c: &ToolContext,
        ) -> Result<ToolResult, crate::tools::ToolError> {
            let tag = a
                .get("tag")
                .and_then(|v| v.as_str())
                .unwrap_or("?")
                .to_string();
            // 入参可覆盖睡眠时长，用于制造「完成顺序 != 原顺序」的场景
            let sleep_ms = a
                .get("sleep_ms")
                .and_then(|v| v.as_u64())
                .unwrap_or(self.delay_ms);
            let now = self.live.fetch_add(1, AtomicOrdering::SeqCst) + 1;
            self.peak.fetch_max(now, AtomicOrdering::SeqCst);
            tokio::time::sleep(Duration::from_millis(sleep_ms)).await;
            self.live.fetch_sub(1, AtomicOrdering::SeqCst);
            self.log.lock().unwrap().push(tag.clone());
            if tag == "boom" {
                return Err(crate::tools::ToolError::Exec("读取失败".into()));
            }
            Ok(ToolResult {
                content: format!("内容:{tag}"),
                is_error: false,
            })
        }
    }

    /// A3 测试用 High 风险工具（**冒充 `write_file`**，不在并发白名单里 → 串行 + 要审批）。
    struct SerialWriteTool {
        log: Arc<StdMutex<Vec<String>>>,
    }
    #[async_trait]
    impl Tool for SerialWriteTool {
        fn name(&self) -> &str {
            "write_file"
        }
        fn description(&self) -> &str {
            "A3 测试：串行写工具"
        }
        fn input_schema(&self) -> serde_json::Value {
            serde_json::json!({"type":"object"})
        }
        fn risk_class(&self, _a: &serde_json::Value) -> RiskClass {
            RiskClass::High
        }
        async fn execute(
            &self,
            a: serde_json::Value,
            _c: &ToolContext,
        ) -> Result<ToolResult, crate::tools::ToolError> {
            let tag = a
                .get("tag")
                .and_then(|v| v.as_str())
                .unwrap_or("?")
                .to_string();
            self.log.lock().unwrap().push(tag.clone());
            Ok(ToolResult {
                content: format!("已写:{tag}"),
                is_error: false,
            })
        }
    }

    /// 构造一轮里含多个 tool_call 的 provider：`calls = [(call_id, 工具名, 入参)]`。
    fn provider_batch(calls: &[(&str, &str, serde_json::Value)]) -> Arc<FakeProvider> {
        let mut round: Vec<ChatChunk> = Vec::new();
        for (id, name, args) in calls {
            round.push(ChatChunk::ToolUseStart {
                call_id: (*id).into(),
                name: (*name).into(),
            });
            round.push(ChatChunk::ToolUseArgsDelta {
                call_id: (*id).into(),
                json_partial: args.to_string(),
            });
            round.push(ChatChunk::ToolUseEnd {
                call_id: (*id).into(),
            });
        }
        round.push(ChatChunk::Done {
            stop_reason: StopReason::ToolUse,
        });
        Arc::new(FakeProvider::new(vec![
            round,
            vec![
                ChatChunk::TextDelta {
                    text: "done".into(),
                },
                ChatChunk::Done {
                    stop_reason: StopReason::EndTurn,
                },
            ],
        ]))
    }

    /// 只读工具 registry + 并发观测量。
    fn readonly_registry(delay_ms: u64) -> (Arc<ToolRegistry>, Arc<AtomicUsize>, Arc<StdMutex<Vec<String>>>) {
        let peak = Arc::new(AtomicUsize::new(0));
        let log = Arc::new(StdMutex::new(Vec::new()));
        let tool = SlowReadTool {
            live: Arc::new(AtomicUsize::new(0)),
            peak: peak.clone(),
            log: log.clone(),
            delay_ms,
        };
        (registry_with(Arc::new(tool)), peak, log)
    }

    #[tokio::test]
    async fn a3_多个只读工具真并发执行() {
        let provider = provider_batch(&[
            ("tu1", "read_file", serde_json::json!({"tag":"a"})),
            ("tu2", "read_file", serde_json::json!({"tag":"b"})),
            ("tu3", "read_file", serde_json::json!({"tag":"c"})),
        ]);
        let sink = Arc::new(MockSink::default());
        let (tools, peak, _log) = readonly_registry(80);
        let handle = Arc::new(ToolLoopHandle::new());

        let started = Instant::now();
        run_tool_loop(
            base_request(),
            provider,
            tools,
            make_ctx(),
            sink.clone(),
            "c1".into(),
            handle,
            None,
        )
        .await;
        let elapsed = started.elapsed();

        assert_eq!(peak.load(AtomicOrdering::SeqCst), 3, "3 个只读工具应同时在跑");
        assert!(
            elapsed < Duration::from_millis(200),
            "并发执行总耗时应远小于串行 240ms，实际 {elapsed:?}"
        );
        assert_eq!(sink.tool_finished.lock().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn a3_并发结果按原_tool_call_顺序回填() {
        // 🔴 老雷区：tool_result 顺序与 tool_use 不一致 → provider 400
        // 让先发的调用睡得更久，保证"完成顺序" != "原顺序"，这样顺序回填才被真检验。
        let provider = provider_batch(&[
            // 先发的睡最久 → 完成顺序 c,b,a，与原顺序完全相反
            ("tu1", "read_file", serde_json::json!({"tag":"a","sleep_ms":90})),
            ("tu2", "read_file", serde_json::json!({"tag":"b","sleep_ms":50})),
            ("tu3", "read_file", serde_json::json!({"tag":"c","sleep_ms":10})),
        ]);
        let sink = Arc::new(MockSink::default());
        let (tools, _peak, log) = readonly_registry(20);
        let handle = Arc::new(ToolLoopHandle::new());

        let provider_ref = provider.clone();
        run_tool_loop(
            base_request(),
            provider,
            tools,
            make_ctx(),
            sink.clone(),
            "c1".into(),
            handle,
            None,
        )
        .await;

        // 前提校验：完成顺序确实被打乱了（否则本测试等于没测顺序回填）
        assert_eq!(
            log.lock().unwrap().clone(),
            vec!["c", "b", "a"],
            "完成顺序应与原顺序相反"
        );

        // 第 2 轮请求（index 1）里最后一条 Tool 消息 = 本轮所有 tool_result
        let results = provider_ref.tool_results_of_round(1);
        let ids: Vec<&str> = results.iter().map(|(id, _, _)| id.as_str()).collect();
        assert_eq!(ids, vec!["tu1", "tu2", "tu3"], "tool_result 必须按原顺序");
        let contents: Vec<&str> = results.iter().map(|(_, c, _)| c.as_str()).collect();
        assert_eq!(
            contents,
            vec!["内容:a", "内容:b", "内容:c"],
            "每个 tool_result 必须配对到自己的 tool_use"
        );
    }

    #[tokio::test]
    async fn a3_混合只读与需审批工具_顺序与语义正确() {
        // 只读 a → 需审批 write → 只读 b：写工具前后的只读不能被提前/推后，
        // 否则「先写后读」会读到旧内容。
        let provider = provider_batch(&[
            ("tu1", "read_file", serde_json::json!({"tag":"a"})),
            ("tu2", "write_file", serde_json::json!({"tag":"W"})),
            ("tu3", "read_file", serde_json::json!({"tag":"b"})),
        ]);
        let sink = Arc::new(MockSink::default());
        let log = Arc::new(StdMutex::new(Vec::new()));
        let peak = Arc::new(AtomicUsize::new(0));
        let mut reg = ToolRegistry::new();
        reg.register(Arc::new(SlowReadTool {
            live: Arc::new(AtomicUsize::new(0)),
            peak: peak.clone(),
            log: log.clone(),
            delay_ms: 20,
        }));
        reg.register(Arc::new(SerialWriteTool { log: log.clone() }));
        let tools = Arc::new(reg);
        let handle = Arc::new(ToolLoopHandle::new());
        let responder = spawn_responder_all(sink.clone(), handle.clone(), true, false);

        let provider_ref = provider.clone();
        run_tool_loop(
            base_request(),
            provider,
            tools,
            make_ctx(),
            sink.clone(),
            "c1".into(),
            handle,
            None,
        )
        .await;
        responder.abort();

        // 执行顺序：只读 a 必须在写之前，只读 b 必须在写之后
        let got = log.lock().unwrap().clone();
        assert_eq!(got, vec!["a", "W", "b"], "有副作用工具前后的相对顺序不能乱");
        // 回填顺序同样按原 tool_call 顺序
        let results = provider_ref.tool_results_of_round(1);
        let ids: Vec<&str> = results.iter().map(|(id, _, _)| id.as_str()).collect();
        assert_eq!(ids, vec!["tu1", "tu2", "tu3"]);
        let contents: Vec<&str> = results.iter().map(|(_, c, _)| c.as_str()).collect();
        assert_eq!(contents, vec!["内容:a", "已写:W", "内容:b"]);
        // write_file 是 High → 走了审批弹窗
        assert_eq!(sink.tool_requests.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a3_并发上限生效() {
        // 12 个只读调用，并发上限 MAX_PARALLEL_TOOLS（8）
        let calls: Vec<(String, String, serde_json::Value)> = (0..12)
            .map(|i| {
                (
                    format!("tu{i}"),
                    "read_file".to_string(),
                    serde_json::json!({ "tag": format!("t{i}") }),
                )
            })
            .collect();
        let refs: Vec<(&str, &str, serde_json::Value)> = calls
            .iter()
            .map(|(a, b, c)| (a.as_str(), b.as_str(), c.clone()))
            .collect();
        let provider = provider_batch(&refs);
        let sink = Arc::new(MockSink::default());
        let (tools, peak, _log) = readonly_registry(40);
        let handle = Arc::new(ToolLoopHandle::new());

        run_tool_loop(
            base_request(),
            provider,
            tools,
            make_ctx(),
            sink.clone(),
            "c1".into(),
            handle,
            None,
        )
        .await;

        let p = peak.load(AtomicOrdering::SeqCst);
        assert!(p > 1, "应该真并发，实际峰值 {p}");
        assert!(
            p <= MAX_PARALLEL_TOOLS,
            "并发峰值 {p} 超过上限 {MAX_PARALLEL_TOOLS}"
        );
        assert_eq!(sink.tool_finished.lock().unwrap().len(), 12);
    }

    #[tokio::test]
    async fn a3_单个工具失败不影响其它且顺序不乱() {
        let provider = provider_batch(&[
            ("tu1", "read_file", serde_json::json!({"tag":"a"})),
            ("tu2", "read_file", serde_json::json!({"tag":"boom"})),
            ("tu3", "read_file", serde_json::json!({"tag":"c"})),
        ]);
        let sink = Arc::new(MockSink::default());
        let (tools, _peak, _log) = readonly_registry(10);
        let handle = Arc::new(ToolLoopHandle::new());

        let provider_ref = provider.clone();
        run_tool_loop(
            base_request(),
            provider,
            tools,
            make_ctx(),
            sink.clone(),
            "c1".into(),
            handle,
            None,
        )
        .await;

        let results = provider_ref.tool_results_of_round(1);
        let ids: Vec<&str> = results.iter().map(|(id, _, _)| id.as_str()).collect();
        assert_eq!(ids, vec!["tu1", "tu2", "tu3"]);
        assert!(!results[0].2, "tu1 应成功");
        assert!(results[1].2, "tu2 应失败");
        assert!(!results[2].2, "tu3 应成功");
        assert_eq!(results[0].1, "内容:a");
        assert_eq!(results[2].1, "内容:c");
        // 循环没被单个失败带崩
        assert!(sink.errors.lock().unwrap().is_empty());
        assert_eq!(sink.done.lock().unwrap().len(), 1);
    }
}
