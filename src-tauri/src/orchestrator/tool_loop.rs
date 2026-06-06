//! Tool calling 主循环。
//!
//! 流程：把 [`ChatRequest`] 喂给 provider，流式收 chunk → 拼出每轮 tool_calls →
//! 走安全门（L1 黑名单 / L4 用户确认）→ 调 [`Tool::execute`] → 把 ToolResult 作为
//! Tool 角色消息拼回会话进下一轮，直到 LLM 不再调工具或达 [`MAX_STEPS`]。
//!
//! 全程通过 [`EventSink`] 把进度 emit 给前端（生产用 [`TauriSink`]，测试用 mock）。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use futures::stream::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::{Mutex, oneshot};

use crate::providers::LlmProvider;
use crate::providers::types::*;
use crate::safety::{blacklist, risk, whitelist};
use crate::tools::{RiskClass, Tool, ToolContext, ToolResult, registry::ToolRegistry};

/// 工具调用最大轮数（防止 LLM 无限循环调工具）。
pub const MAX_STEPS: u32 = 10;
/// 高风险工具用户确认超时；超时视为拒绝。
pub const APPROVAL_TIMEOUT: Duration = Duration::from_secs(300);

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
    /// 如果工具是被自动批准的（L2 LOW 或 L3 白名单命中），在这里写明原因；
    /// 走过 ask_user 弹窗批准的留 None。前端在 ToolCallBubble 上展示徽章。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_approved_reason: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct AiDoneEvent {
    pub conversation_id: String,
    pub stop_reason: StopReason,
    pub usage: Option<UsageInfo>,
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

/// Tool loop 的运行时状态：用户审批通道。
///
/// 高风险工具调用阻塞在 oneshot 上等用户决定；前端 IPC 命令通过
/// [`resolve_approval`] 把 (call_id, approved) 喂回去。
pub struct ToolLoopHandle {
    /// call_id → 等待用户决定的 oneshot sender。
    pub pending: Mutex<HashMap<String, oneshot::Sender<bool>>>,
}

impl ToolLoopHandle {
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
        }
    }
}

impl Default for ToolLoopHandle {
    fn default() -> Self {
        Self::new()
    }
}

/// 给 IPC 用：解析待审批 call_id，发送批准/拒绝。
///
/// 找不到 call_id（已超时或不存在）静默忽略。
pub async fn resolve_approval(handle: &ToolLoopHandle, call_id: &str, approved: bool) {
    if let Some(tx) = handle.pending.lock().await.remove(call_id) {
        let _ = tx.send(approved);
    }
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
pub async fn run_tool_loop(
    initial: ChatRequest,
    provider: Arc<dyn LlmProvider>,
    tools: Arc<ToolRegistry>,
    ctx: ToolContext,
    sink: Arc<dyn EventSink>,
    cid: String,
    handle: Arc<ToolLoopHandle>,
) {
    let mut conv = initial.messages.clone();
    let mut total_in: u32 = 0;
    let mut total_out: u32 = 0;
    let mut last_stop;

    // v0.5.0-A T6 差异化核心：tool loop 入口 emit Running → tab 状态环 sky
    // 表示 AI 正在干活。出口（emit_done / emit_error 之前）会再发对应状态。
    notify_ai_loop(
        sink.as_ref(),
        ctx.active_session_id.as_deref(),
        crate::notifications::NotificationLevel::Running,
        String::new(),
    );

    for _step in 0..MAX_STEPS {
        let req = ChatRequest {
            model: initial.model.clone(),
            messages: conv.clone(),
            tools: tools.to_tool_defs(),
            system: initial.system.clone(),
            max_tokens: initial.max_tokens,
            temperature: initial.temperature,
        };

        let turn = match collect_one_turn(provider.as_ref(), req, sink.as_ref(), &cid).await {
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
            });
            return;
        }

        // 处理每个 tool_call
        let mut tool_results: Vec<ContentBlock> = Vec::new();
        for tc in &turn.tool_calls {
            let result =
                handle_one_tool_call(tc, tools.as_ref(), &ctx, handle.as_ref(), sink.as_ref(), &cid)
                    .await;
            tool_results.push(ContentBlock::ToolResult {
                tool_use_id: tc.id.clone(),
                content: result.content,
                is_error: result.is_error,
            });
        }

        // 把 tool_results 作为 Tool 角色消息加入会话进下一轮
        conv.push(Message {
            role: Role::Tool,
            content: MessageContent::Blocks(tool_results),
        });
    }

    // 超过 MAX_STEPS：让 LLM 总结收尾
    summarize_and_done(
        provider.as_ref(),
        conv,
        &initial,
        sink.as_ref(),
        &cid,
        total_in,
        total_out,
        ctx.active_session_id.as_deref(),
    )
    .await;
}

/// 跑一轮 stream_chat，收齐 chunks，返回拼好的 OneTurn。
/// 同时把 TextDelta emit 成 ai:token 给前端。
async fn collect_one_turn(
    provider: &dyn LlmProvider,
    req: ChatRequest,
    sink: &dyn EventSink,
    cid: &str,
) -> Result<OneTurn, ProviderError> {
    let mut stream = provider.stream_chat(req).await?;
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
                auto_approved_reason: None,
            });
            return r;
        }
    };

    // ===== run_command 走 L1+L2+L3+L4 完整流程 =====
    if tc.name == "run_command" {
        return handle_run_command(tc, tool.as_ref(), ctx, handle, sink, cid).await;
    }

    // ===== 其他工具：保留 1E-1 行为，只走静态 risk_class =====
    let risk = tool.risk_class(&tc.input);
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
            )
            .await
        }
    };

    if !approved {
        return reject_tool(tc, sink, cid);
    }

    execute_tool(tc, tool.as_ref(), ctx, sink, cid, None).await
}

/// 专门给 run_command 走的 4 层安全门流程。
async fn handle_run_command(
    tc: &ToolCall,
    tool: &dyn Tool,
    ctx: &ToolContext,
    handle: &ToolLoopHandle,
    sink: &dyn EventSink,
    cid: &str,
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
            auto_approved_reason: None,
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
            )
            .await;
            if !approved {
                return reject_tool(tc, sink, cid);
            }
            execute_tool(tc, tool, ctx, sink, cid, None).await
        }

        // LOW：自动批准（白名单 / L2 都给 LOW，emit reason 让 UI 标识）
        RiskClass::Low => {
            let reason = format!("L2：{}", assessment.reason);
            execute_tool(tc, tool, ctx, sink, cid, Some(reason)).await
        }

        // HIGH：先看 L3 白名单
        RiskClass::High => {
            if let Some(pattern) = whitelist::is_whitelisted(&ctx.whitelist, cmd) {
                // 白名单命中 → 降级 LOW 自动批
                let reason = format!("白名单：{pattern}");
                return execute_tool(tc, tool, ctx, sink, cid, Some(reason)).await;
            }
            // 不命中 → 弹普通 high 弹窗
            let approved = ask_user(
                tc,
                RiskClass::High,
                Some(format!("L2：{}", assessment.reason)),
                handle,
                sink,
                cid,
                ctx.active_session_id.as_deref(),
            )
            .await;
            if !approved {
                return reject_tool(tc, sink, cid);
            }
            execute_tool(tc, tool, ctx, sink, cid, None).await
        }
    }
}

/// 用户拒绝时的统一返回 + emit。
fn reject_tool(tc: &ToolCall, sink: &dyn EventSink, cid: &str) -> ToolResult {
    let r = ToolResult {
        content: "用户拒绝执行此操作".into(),
        is_error: true,
    };
    sink.emit_tool_finished(&AiToolFinishedEvent {
        conversation_id: cid.to_string(),
        call_id: tc.id.clone(),
        content: r.content.clone(),
        is_error: true,
        auto_approved_reason: None,
    });
    r
}

/// 执行工具 + emit started/finished。
/// `auto_approved_reason` 不为 None 时表示这次执行没走过 ask_user 弹窗。
async fn execute_tool(
    tc: &ToolCall,
    tool: &dyn Tool,
    ctx: &ToolContext,
    sink: &dyn EventSink,
    cid: &str,
    auto_approved_reason: Option<String>,
) -> ToolResult {
    sink.emit_tool_started(&AiToolStartedEvent {
        conversation_id: cid.to_string(),
        call_id: tc.id.clone(),
        name: tc.name.clone(),
    });

    let r: ToolResult = match tool.execute(tc.input.clone(), ctx).await {
        Ok(r) => r,
        Err(e) => e.into(),
    };

    sink.emit_tool_finished(&AiToolFinishedEvent {
        conversation_id: cid.to_string(),
        call_id: tc.id.clone(),
        content: r.content.clone(),
        is_error: r.is_error,
        auto_approved_reason,
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

async fn ask_user(
    tc: &ToolCall,
    risk: RiskClass,
    risk_reason: Option<String>,
    handle: &ToolLoopHandle,
    sink: &dyn EventSink,
    cid: &str,
    session_id: Option<&str>,
) -> bool {
    let (tx, rx) = oneshot::channel();
    handle.pending.lock().await.insert(tc.id.clone(), tx);

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

#[allow(clippy::too_many_arguments)] // v0.5.0-A T6 加 session_id 让参数 7→8；包 struct 不值得
async fn summarize_and_done(
    provider: &dyn LlmProvider,
    conv: Vec<Message>,
    initial: &ChatRequest,
    sink: &dyn EventSink,
    cid: &str,
    total_in: u32,
    total_out: u32,
    session_id: Option<&str>,
) {
    let req = ChatRequest {
        model: initial.model.clone(),
        messages: conv,
        tools: vec![], // 不再给工具
        system: Some(
            "已达工具调用上限（10 步）。请直接总结你做了什么、当前状态、是否完成用户任务。不要再调工具。".into(),
        ),
        max_tokens: initial.max_tokens,
        temperature: initial.temperature,
    };

    let mut total_in = total_in;
    let mut total_out = total_out;
    match collect_one_turn(provider, req, sink, cid).await {
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
    }

    impl FakeProvider {
        fn new(responses: Vec<Vec<ChatChunk>>) -> Self {
            Self {
                responses: StdMutex::new(responses),
            }
        }

        /// 重复同一个轮（用于"永不停"测试）。
        fn always(chunks: Vec<ChatChunk>) -> Self {
            // 用 100 个相同 round 兜底（实际只会消耗 MAX_STEPS+1 个）
            let many = (0..100).map(|_| chunks.clone()).collect();
            Self {
                responses: StdMutex::new(many),
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
            _req: ChatRequest,
        ) -> Result<BoxStream<'static, ChatChunk>, ProviderError> {
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
                    resolve_approval(&handle2, &r.call_id, false).await;
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
                    resolve_approval(&handle, &r.call_id, approved).await;
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
        )
        .await;

        let notifs = sink.notifications.lock().unwrap();
        assert!(notifs.is_empty(), "session_id 为 None 时不应 emit 通知");
        // 但 done 仍正常 emit（不影响主路径）
        assert_eq!(sink.done.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn notification_ask_user_emit_waiting() {
        // 调一个 high 风险工具 → ask_user 弹审批前应 emit Waiting
        // 用 list_files 默认 Low；改用 run_command 触发 high
        let provider = Arc::new(FakeProvider::new(vec![
            vec![
                ChatChunk::ToolUseStart {
                    call_id: "tc1".into(),
                    name: "run_command".into(),
                },
                ChatChunk::ToolUseArgsDelta {
                    call_id: "tc1".into(),
                    json_partial: r#"{"cmd":"echo hi"}"#.into(),
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
        // 让 FakeProvider 队列空（next stream_chat 会失败）→ collect_one_turn 返 Err
        let provider = Arc::new(FakeProvider::new(vec![]));
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
        )
        .await;

        let notifs = sink.notifications.lock().unwrap();
        let has_error = notifs
            .iter()
            .any(|n| n.level == crate::notifications::NotificationLevel::Error);
        assert!(has_error, "provider 失败应 emit Error");
        assert_eq!(sink.errors.lock().unwrap().len(), 1);
    }
}
