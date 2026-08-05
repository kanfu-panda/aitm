//! 上下文预算估算 + 会话裁剪（C1）。
//!
//! 纯函数模块（不碰 IO / provider），便于单测。[`run_tool_loop`] 每轮**前**调用，
//! 防止 `conv` 只增不减把 provider 上下文窗口撑爆。
//!
//! ## token 估算
//!
//! v1 用**字符数 / 4** 近似（各家 tokenizer 不同，近似做护栏足够；不引 tiktoken-rs
//! ——重且不通用）。中文按 char 计更保守，正好符合"宁可裁多留余量"。
//!
//! ## 裁剪策略
//!
//! - 会话按「消息组」切分：一次 `assistant(含 tool_use)` + 紧跟的 `tool(结果)` 视为
//!   **一组**，其余消息各自成组。这样丢弃时**整组丢**，保证 tool_use ↔ tool_result
//!   配对不被拆散（踩坑备忘：OpenAI / Anthropic 都要求二者配对，拆散会 400）。
//! - 永远保留：第 0 组（含首条 user 消息） + 最近 [`KEEP_RECENT_GROUPS`] 组。
//! - 超预算时从**最旧的非保留组**整组丢弃，直到降到预算下或无可丢弃组。
//! - system 消息不在 `conv` 里（provider 单独字段），其 token 数作为参数计入预算；
//!   丢弃后由调用方在 system 末尾追加一条 [`elision_note`]，让模型知道有省略。

use crate::providers::types::{ContentBlock, Message, MessageContent, Role};

/// 默认上下文窗口（provider 没报 context_window 时的保守兜底）。
pub const DEFAULT_CONTEXT_WINDOW: u32 = 32_768;
/// 预算占上下文窗口比例（留 30% 给输出 + 估算误差）。
pub const BUDGET_RATIO: f64 = 0.7;
/// 裁剪时永远保留的「最近消息组」数量（一次 assistant+tool 交互算一组）。
pub const KEEP_RECENT_GROUPS: usize = 6;

/// 由 context_window 算 token 预算。缺省用 [`DEFAULT_CONTEXT_WINDOW`]。
pub fn budget_tokens(context_window: Option<u32>) -> usize {
    let cw = context_window.unwrap_or(DEFAULT_CONTEXT_WINDOW);
    (cw as f64 * BUDGET_RATIO) as usize
}

/// 估算一段文本 token 数（字符数 / 4，至少 1）。
pub fn estimate_text_tokens(text: &str) -> usize {
    (text.chars().count() / 4).max(1)
}

fn estimate_block_tokens(b: &ContentBlock) -> usize {
    match b {
        ContentBlock::Text { text } => estimate_text_tokens(text),
        ContentBlock::ToolUse { name, input, .. } => {
            estimate_text_tokens(name) + estimate_text_tokens(&input.to_string())
        }
        ContentBlock::ToolResult { content, .. } => estimate_text_tokens(content),
    }
}

/// 估算单条消息 token 数。
pub fn estimate_message_tokens(m: &Message) -> usize {
    match &m.content {
        MessageContent::Text(t) => estimate_text_tokens(t),
        MessageContent::Blocks(blocks) => {
            blocks.iter().map(estimate_block_tokens).sum::<usize>().max(1)
        }
    }
}

/// 估算整段会话（不含 system） token 数。
pub fn estimate_messages_tokens(msgs: &[Message]) -> usize {
    msgs.iter().map(estimate_message_tokens).sum()
}

/// 裁剪结果。
pub struct TrimPlan {
    /// 裁剪后保留的消息（顺序不变）。
    pub kept: Vec<Message>,
    /// 被丢弃的消息条数（0 = 未裁剪）。
    pub dropped: usize,
}

/// 把消息切成「组」：`assistant(含 tool_use)` + 紧跟 `tool` 合成一组（2 条），
/// 其余消息各自成一组（1 条）。返回每组的 `[start, end)` 索引区间。
fn split_groups(msgs: &[Message]) -> Vec<(usize, usize)> {
    let mut groups: Vec<(usize, usize)> = Vec::new();
    let mut i = 0;
    while i < msgs.len() {
        let m = &msgs[i];
        let is_tool_use_assistant = m.role == Role::Assistant
            && matches!(
                &m.content,
                MessageContent::Blocks(bs)
                    if bs.iter().any(|b| matches!(b, ContentBlock::ToolUse { .. }))
            );
        if is_tool_use_assistant && i + 1 < msgs.len() && msgs[i + 1].role == Role::Tool {
            // assistant(tool_use) + tool(result) 绑成一组，绝不拆散
            groups.push((i, i + 2));
            i += 2;
        } else {
            groups.push((i, i + 1));
            i += 1;
        }
    }
    groups
}

/// 计算裁剪方案：给定会话、system token 数、预算、保留最近组数。
///
/// 保留第 0 组（含首 user） + 最近 `keep_recent` 组；从最旧的中间组整组丢弃，
/// 直到总量降到预算下或无可丢弃组。可丢弃组为空 / 单组超预算时原样返回。
pub fn plan_trim(
    msgs: &[Message],
    system_tokens: usize,
    budget: usize,
    keep_recent: usize,
) -> TrimPlan {
    let total = system_tokens + estimate_messages_tokens(msgs);
    if total <= budget {
        return TrimPlan {
            kept: msgs.to_vec(),
            dropped: 0,
        };
    }

    let groups = split_groups(msgs);
    // 可丢弃区间：[1, groups.len() - keep_recent)（第 0 组和最近 keep_recent 组保留）
    if groups.len() <= keep_recent + 1 {
        // 全是保留组，无可裁——哪怕超预算也原样返回（宁可超也不动关键上下文）
        return TrimPlan {
            kept: msgs.to_vec(),
            dropped: 0,
        };
    }
    let last_droppable = groups.len() - keep_recent; // exclusive

    let mut dropped_groups: std::collections::HashSet<usize> = std::collections::HashSet::new();
    let mut running = total;
    for (gi, &(s, e)) in groups.iter().enumerate().take(last_droppable).skip(1) {
        if running <= budget {
            break;
        }
        let group_tokens: usize = msgs[s..e].iter().map(estimate_message_tokens).sum();
        running = running.saturating_sub(group_tokens);
        dropped_groups.insert(gi);
    }

    if dropped_groups.is_empty() {
        return TrimPlan {
            kept: msgs.to_vec(),
            dropped: 0,
        };
    }

    let mut kept: Vec<Message> = Vec::new();
    let mut dropped = 0usize;
    for (gi, &(s, e)) in groups.iter().enumerate() {
        if dropped_groups.contains(&gi) {
            dropped += e - s;
        } else {
            kept.extend_from_slice(&msgs[s..e]);
        }
    }
    TrimPlan { kept, dropped }
}

/// 裁剪后追加到 system 末尾的省略提示，让模型知道早期历史被裁掉了。
pub fn elision_note(dropped: usize) -> String {
    format!("[系统提示：为控制上下文长度，已省略较早的 {dropped} 条历史消息。]")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(t: &str) -> Message {
        Message {
            role: Role::User,
            content: MessageContent::Text(t.into()),
        }
    }
    fn assistant_text(t: &str) -> Message {
        Message {
            role: Role::Assistant,
            content: MessageContent::Text(t.into()),
        }
    }
    /// assistant 含 tool_use（附带一段文本便于放大 token）。
    fn assistant_tooluse(id: &str, filler: &str) -> Message {
        Message {
            role: Role::Assistant,
            content: MessageContent::Blocks(vec![
                ContentBlock::Text {
                    text: filler.into(),
                },
                ContentBlock::ToolUse {
                    id: id.into(),
                    name: "read_file".into(),
                    input: serde_json::json!({ "path": "x" }),
                },
            ]),
        }
    }
    fn tool_result(id: &str, content: &str) -> Message {
        Message {
            role: Role::Tool,
            content: MessageContent::Blocks(vec![ContentBlock::ToolResult {
                tool_use_id: id.into(),
                content: content.into(),
                is_error: false,
            }]),
        }
    }

    fn text_of(m: &Message) -> String {
        match &m.content {
            MessageContent::Text(t) => t.clone(),
            _ => String::new(),
        }
    }

    #[test]
    fn 空历史_不裁剪() {
        let plan = plan_trim(&[], 0, 100, KEEP_RECENT_GROUPS);
        assert_eq!(plan.dropped, 0);
        assert!(plan.kept.is_empty());
    }

    #[test]
    fn 正常_未超预算_不裁剪() {
        let msgs = vec![user("hi"), assistant_text("hello")];
        let plan = plan_trim(&msgs, 0, 1000, KEEP_RECENT_GROUPS);
        assert_eq!(plan.dropped, 0);
        assert_eq!(plan.kept.len(), 2);
    }

    #[test]
    fn 正好等于阈值_不裁剪() {
        // 单条 user，40 字符 → 10 tokens；system 0，预算恰 10 → total == budget，不裁
        let msgs = vec![user(&"a".repeat(40))];
        let plan = plan_trim(&msgs, 0, 10, KEEP_RECENT_GROUPS);
        assert_eq!(plan.dropped, 0);
        assert_eq!(plan.kept.len(), 1);
    }

    #[test]
    fn 单轮就超预算_无可丢弃组_原样返回() {
        // 只有 1 组（远超预算）→ 没有可丢弃的中间组，原样返回不崩
        let msgs = vec![user(&"a".repeat(4000))]; // 1000 tokens
        let plan = plan_trim(&msgs, 0, 10, KEEP_RECENT_GROUPS);
        assert_eq!(plan.dropped, 0);
        assert_eq!(plan.kept.len(), 1);
    }

    #[test]
    fn 超预算_裁掉最旧中间组_保留首user和最近_k_组() {
        // 首 user + 8 次工具交互（每次 assistant_tooluse + tool_result）。K=2。
        let filler = "x".repeat(400); // 每条 ~100 tokens
        let mut msgs = vec![user("首条问题请读很多文件")];
        for i in 0..8 {
            msgs.push(assistant_tooluse(&format!("id{i}"), &format!("第{i}次{filler}")));
            msgs.push(tool_result(&format!("id{i}"), &format!("结果{i}{filler}")));
        }
        let before = estimate_messages_tokens(&msgs);
        let budget = before / 2; // 强制超预算
        let plan = plan_trim(&msgs, 0, budget, 2);

        assert!(plan.dropped > 0, "应发生裁剪");
        // 首 user 保留
        assert!(
            plan.kept.iter().any(|m| text_of(m).starts_with("首条问题")),
            "首 user 应保留"
        );
        // 降到预算下
        assert!(
            estimate_messages_tokens(&plan.kept) <= budget,
            "裁剪后应降到预算内"
        );
        // 最近 2 组（id6/id7 交互）保留：检查 tool_result 内容含"结果7"
        let all: String = plan
            .kept
            .iter()
            .flat_map(|m| match &m.content {
                MessageContent::Blocks(bs) => bs
                    .iter()
                    .filter_map(|b| match b {
                        ContentBlock::ToolResult { content, .. } => Some(content.clone()),
                        _ => None,
                    })
                    .collect::<Vec<_>>(),
                _ => vec![],
            })
            .collect();
        assert!(all.contains("结果7"), "最近组应保留");
        assert!(!all.contains("结果0"), "最旧中间组应被丢");
    }

    #[test]
    fn 裁剪不拆散_tool_use_与_result_配对() {
        // 裁剪后：每个含 tool_use 的 assistant 后面必须紧跟一条 tool 消息
        let filler = "y".repeat(400);
        let mut msgs = vec![user("start")];
        for i in 0..10 {
            msgs.push(assistant_tooluse(&format!("id{i}"), &filler));
            msgs.push(tool_result(&format!("id{i}"), &filler));
        }
        let budget = estimate_messages_tokens(&msgs) / 3;
        let plan = plan_trim(&msgs, 0, budget, 2);
        assert!(plan.dropped > 0);

        for (idx, m) in plan.kept.iter().enumerate() {
            let has_tool_use = matches!(
                &m.content,
                MessageContent::Blocks(bs)
                    if bs.iter().any(|b| matches!(b, ContentBlock::ToolUse { .. }))
            );
            if has_tool_use {
                let next = plan.kept.get(idx + 1);
                assert!(
                    matches!(next, Some(n) if n.role == Role::Tool),
                    "含 tool_use 的 assistant 后必须紧跟 tool 结果（配对未被拆散）"
                );
            }
        }
    }

    #[test]
    fn system_token_计入预算_触发更早裁剪() {
        // 同样会话：system 很大时应更容易触发裁剪
        let filler = "z".repeat(400);
        let mut msgs = vec![user("start")];
        for i in 0..8 {
            msgs.push(assistant_tooluse(&format!("id{i}"), &filler));
            msgs.push(tool_result(&format!("id{i}"), &filler));
        }
        let body = estimate_messages_tokens(&msgs);
        // 预算略大于会话本体 → 不含 system 不裁
        let budget = body + 50;
        let no_sys = plan_trim(&msgs, 0, budget, 2);
        assert_eq!(no_sys.dropped, 0, "无 system 时预算够用不裁");
        // 加一大块 system token → 超预算触发裁剪
        let with_sys = plan_trim(&msgs, 500, budget, 2);
        assert!(with_sys.dropped > 0, "system 计入后应触发裁剪");
    }

    #[test]
    fn budget_tokens_缺省与比例() {
        assert_eq!(budget_tokens(None), (DEFAULT_CONTEXT_WINDOW as f64 * 0.7) as usize);
        assert_eq!(budget_tokens(Some(100_000)), 70_000);
    }

    #[test]
    fn elision_note_含条数() {
        let note = elision_note(7);
        assert!(note.contains('7'));
        assert!(note.contains("省略"));
    }
}
