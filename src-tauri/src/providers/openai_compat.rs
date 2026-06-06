//! OpenAI 兼容 chat/completions API 适配器。
//!
//! 覆盖：OpenAI 自家、DeepSeek、Qwen DashScope、智谱 GLM、Moonshot Kimi。
//! 协议参考：<https://platform.openai.com/docs/api-reference/chat-streaming>

use async_trait::async_trait;
use futures::stream::{BoxStream, StreamExt};
use reqwest::Client;
use serde::Deserialize;
use serde_json::json;

use super::sse::sse_from_response;
use super::types::*;
use super::{Capabilities, LlmProvider, ModelInfo};

/// 配置：可任意 base_url + 模型列表。
pub struct OpenAICompatConfig {
    pub id: String,
    pub display_name: String,
    pub base_url: String,
    pub api_key: String,
    pub models: Vec<ModelInfo>,
}

pub struct OpenAICompatClient {
    cfg: OpenAICompatConfig,
    http: Client,
}

impl OpenAICompatClient {
    pub fn new(cfg: OpenAICompatConfig) -> Self {
        Self {
            cfg,
            http: Client::builder()
                .timeout(std::time::Duration::from_secs(120))
                .build()
                .expect("reqwest client"),
        }
    }
}

#[derive(Debug, Deserialize)]
struct OpenAIChunk {
    #[serde(default)]
    choices: Vec<OpenAIChoice>,
    #[serde(default)]
    usage: Option<OpenAIUsage>,
}

#[derive(Debug, Deserialize)]
struct OpenAIChoice {
    #[serde(default)]
    delta: OpenAIDelta,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct OpenAIDelta {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Vec<OpenAIToolCallDelta>,
}

#[derive(Debug, Deserialize)]
struct OpenAIToolCallDelta {
    #[serde(default)]
    index: u32,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    function: Option<OpenAIFunctionDelta>,
}

#[derive(Debug, Deserialize)]
struct OpenAIFunctionDelta {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct OpenAIUsage {
    #[serde(default)]
    prompt_tokens: u32,
    #[serde(default)]
    completion_tokens: u32,
}

#[async_trait]
impl LlmProvider for OpenAICompatClient {
    fn id(&self) -> &str {
        &self.cfg.id
    }

    fn display_name(&self) -> &str {
        &self.cfg.display_name
    }

    fn list_models(&self) -> Vec<ModelInfo> {
        self.cfg.models.clone()
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            supports_tools: true,
            supports_streaming_tools: true,
            needs_args_concat: true,
        }
    }

    async fn stream_chat(
        &self,
        req: ChatRequest,
    ) -> Result<BoxStream<'static, ChatChunk>, ProviderError> {
        let body = build_request_body(&req);
        let url = format!("{}/chat/completions", self.cfg.base_url);
        let resp = self
            .http
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.cfg.api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(ProviderError::Http)?;

        let status = resp.status();
        if !status.is_success() {
            return Err(match status.as_u16() {
                401 | 403 => ProviderError::Unauthorized,
                429 => ProviderError::RateLimited,
                _ => {
                    let body = resp.text().await.unwrap_or_default();
                    ProviderError::Other(format!("HTTP {status}: {body}"))
                }
            });
        }

        let sse = sse_from_response(resp);
        // 状态：tool_call index → call_id（OpenAI 流式 tool_calls 第一次出现 id，后续只给 index）
        let mut tool_index_to_id: std::collections::HashMap<u32, String> = Default::default();
        let mut tool_index_seen_start: std::collections::HashSet<u32> = Default::default();
        let mut last_finish_reason: Option<String> = None;

        let chunks = sse.flat_map(move |item| {
            let mut out: Vec<ChatChunk> = Vec::new();
            match item {
                Err(e) => out.push(ChatChunk::Error { message: format!("{e}") }),
                Ok(event) => {
                    let data = event.data;
                    if data == "[DONE]" {
                        // 把当前还活着的 tool_use 关闭
                        for (_, call_id) in tool_index_to_id.drain() {
                            out.push(ChatChunk::ToolUseEnd { call_id });
                        }
                        // emit Done
                        let stop = last_finish_reason
                            .as_deref()
                            .map(parse_finish_reason)
                            .unwrap_or(StopReason::EndTurn);
                        out.push(ChatChunk::Done { stop_reason: stop });
                    } else if !data.is_empty() {
                        match serde_json::from_str::<OpenAIChunk>(&data) {
                            Ok(parsed) => {
                                if let Some(usage) = parsed.usage {
                                    out.push(ChatChunk::Usage {
                                        input_tokens: usage.prompt_tokens,
                                        output_tokens: usage.completion_tokens,
                                    });
                                }
                                for choice in parsed.choices {
                                    if let Some(text) = choice.delta.content {
                                        if !text.is_empty() {
                                            out.push(ChatChunk::TextDelta { text });
                                        }
                                    }
                                    for tc in choice.delta.tool_calls {
                                        let idx = tc.index;
                                        // Qwen DashScope 在第一个 chunk 给出真实 id，后续
                                        // chunks 把 id 字段填成空字符串 ""（不是 null）。serde
                                        // 反序列化为 Some("")，如果不判空会把第一个 chunk 拿到的
                                        // 真 id 覆盖成空串，后续 args delta 都 emit 给空 call_id，
                                        // orchestrator 找不到 inflight 槽位 → args 全丢，工具收
                                        // 到空 input → "missing field" 报错。
                                        if let Some(id) = tc.id.clone() {
                                            if !id.is_empty() {
                                                tool_index_to_id.insert(idx, id);
                                            }
                                        }
                                        let call_id = tool_index_to_id.get(&idx).cloned();
                                        if let Some(cid) = call_id {
                                            // 第一次出现时 emit Start
                                            if !tool_index_seen_start.contains(&idx) {
                                                if let Some(name) = tc
                                                    .function
                                                    .as_ref()
                                                    .and_then(|f| f.name.clone())
                                                {
                                                    out.push(ChatChunk::ToolUseStart {
                                                        call_id: cid.clone(),
                                                        name,
                                                    });
                                                    tool_index_seen_start.insert(idx);
                                                }
                                            }
                                            if let Some(args) =
                                                tc.function.and_then(|f| f.arguments)
                                            {
                                                if !args.is_empty() {
                                                    out.push(ChatChunk::ToolUseArgsDelta {
                                                        call_id: cid,
                                                        json_partial: args,
                                                    });
                                                }
                                            }
                                        }
                                    }
                                    if let Some(reason) = choice.finish_reason {
                                        last_finish_reason = Some(reason);
                                    }
                                }
                            }
                            Err(e) => out.push(ChatChunk::Error {
                                message: format!("解析 OpenAI chunk: {e}; data={data}"),
                            }),
                        }
                    }
                }
            }
            futures::stream::iter(out)
        });

        Ok(Box::pin(chunks))
    }
}

fn build_request_body(req: &ChatRequest) -> serde_json::Value {
    let mut messages: Vec<serde_json::Value> = Vec::with_capacity(req.messages.len() + 1);
    if let Some(s) = &req.system {
        messages.push(json!({"role":"system","content":s}));
    }
    for m in &req.messages {
        append_message(&mut messages, m);
    }

    let mut body = json!({
        "model": req.model,
        "messages": messages,
        "max_tokens": req.max_tokens,
        "stream": true,
        "stream_options": { "include_usage": true },
        "temperature": req.temperature,
    });
    if !req.tools.is_empty() {
        body["tools"] = json!(req.tools.iter().map(|t| json!({
            "type": "function",
            "function": {
                "name": t.name,
                "description": t.description,
                "parameters": t.input_schema,
            }
        })).collect::<Vec<_>>());
    }
    body
}

/// 把统一 [`Message`] 转成 OpenAI 兼容协议的 messages 项（可能产出多条）。
///
/// 协议要点（与 Anthropic 不同）：
/// - assistant 含工具调用：放 `tool_calls: [{id, type:"function", function:{name, arguments: <JSON 字符串>}}]`
///   `arguments` **必须**是字符串而非对象。
/// - 工具结果：每个 ToolResult 单独一条 `{role:"tool", tool_call_id, content}`，
///   一条 assistant 调用 N 个工具就要 push N 条 tool 消息。
/// - OpenAI/Qwen 都不认 `{type:"tool_use"}` 或 `{type:"tool_result"}` 这种 Anthropic 风格的 content blocks。
fn append_message(out: &mut Vec<serde_json::Value>, m: &Message) {
    match m.role {
        Role::User => {
            out.push(json!({
                "role": "user",
                "content": flatten_text(&m.content),
            }));
        }
        Role::Assistant => {
            let (text, tool_uses) = split_assistant_content(&m.content);
            let mut msg = json!({"role": "assistant"});
            // OpenAI 接受 content 为字符串或 null；空文本时给空串避免有些后端拒绝
            msg["content"] = json!(text);
            if !tool_uses.is_empty() {
                msg["tool_calls"] = json!(tool_uses
                    .iter()
                    .map(|tu| {
                        let args_str = serde_json::to_string(&tu.input)
                            .unwrap_or_else(|_| "{}".to_string());
                        json!({
                            "id": tu.id,
                            "type": "function",
                            "function": {
                                "name": tu.name,
                                "arguments": args_str,
                            }
                        })
                    })
                    .collect::<Vec<_>>());
            }
            out.push(msg);
        }
        Role::Tool => {
            // Tool 角色消息只承载 ToolResult blocks；每个 ToolResult 拆一条 message
            match &m.content {
                MessageContent::Blocks(blocks) => {
                    for b in blocks {
                        if let ContentBlock::ToolResult { tool_use_id, content, .. } = b {
                            out.push(json!({
                                "role": "tool",
                                "tool_call_id": tool_use_id,
                                "content": content,
                            }));
                        }
                    }
                }
                MessageContent::Text(s) => {
                    // 兜底：Tool 角色但内容是裸文本，没有 tool_call_id 就不合协议；
                    // 大多数 OpenAI 兼容后端会拒绝，这里降级成 user 角色把内容透传，
                    // 比直接发不合法 message 强。
                    out.push(json!({"role":"user","content": s}));
                }
            }
        }
    }
}

fn flatten_text(c: &MessageContent) -> String {
    match c {
        MessageContent::Text(s) => s.clone(),
        MessageContent::Blocks(bs) => bs
            .iter()
            .filter_map(|b| match b {
                ContentBlock::Text { text } => Some(text.clone()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join(""),
    }
}

struct ToolUseRef<'a> {
    id: &'a str,
    name: &'a str,
    input: &'a serde_json::Value,
}

fn split_assistant_content(c: &MessageContent) -> (String, Vec<ToolUseRef<'_>>) {
    match c {
        MessageContent::Text(s) => (s.clone(), vec![]),
        MessageContent::Blocks(bs) => {
            let mut text = String::new();
            let mut uses: Vec<ToolUseRef<'_>> = Vec::new();
            for b in bs {
                match b {
                    ContentBlock::Text { text: t } => text.push_str(t),
                    ContentBlock::ToolUse { id, name, input } => {
                        uses.push(ToolUseRef { id, name, input });
                    }
                    ContentBlock::ToolResult { .. } => {
                        // assistant 不应携带 ToolResult，忽略
                    }
                }
            }
            (text, uses)
        }
    }
}

fn parse_finish_reason(s: &str) -> StopReason {
    match s {
        "stop" => StopReason::EndTurn,
        "tool_calls" => StopReason::ToolUse,
        "length" => StopReason::MaxTokens,
        _ => StopReason::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_body_含_stream_true() {
        let req = ChatRequest {
            model: "deepseek-chat".into(),
            messages: vec![],
            tools: vec![],
            system: None,
            max_tokens: 100,
            temperature: 1.0,
        };
        let body = build_request_body(&req);
        assert_eq!(body["stream"], true);
    }

    #[test]
    fn build_body_系统消息进入_messages_数组() {
        let req = ChatRequest {
            model: "x".into(),
            messages: vec![],
            tools: vec![],
            system: Some("you are helpful".into()),
            max_tokens: 100,
            temperature: 1.0,
        };
        let body = build_request_body(&req);
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][0]["content"], "you are helpful");
    }

    #[test]
    fn build_body_tools_用_function_包装() {
        let req = ChatRequest {
            model: "x".into(),
            messages: vec![],
            tools: vec![ToolDef {
                name: "run".into(),
                description: "exec".into(),
                input_schema: serde_json::json!({"type":"object"}),
            }],
            system: None,
            max_tokens: 100,
            temperature: 1.0,
        };
        let body = build_request_body(&req);
        assert_eq!(body["tools"][0]["type"], "function");
        assert_eq!(body["tools"][0]["function"]["name"], "run");
    }

    #[test]
    fn parse_finish_reason_映射() {
        assert_eq!(parse_finish_reason("stop"), StopReason::EndTurn);
        assert_eq!(parse_finish_reason("tool_calls"), StopReason::ToolUse);
        assert_eq!(parse_finish_reason("length"), StopReason::MaxTokens);
    }

    #[test]
    fn build_body_含_stream_options_include_usage() {
        let req = ChatRequest {
            model: "qwen-max".into(),
            messages: vec![],
            tools: vec![],
            system: None,
            max_tokens: 100,
            temperature: 1.0,
        };
        let body = build_request_body(&req);
        assert_eq!(
            body["stream_options"]["include_usage"], true,
            "stream_options.include_usage 必须为 true，否则 Qwen 流式响应不返回 usage"
        );
    }

    /// assistant 含 tool_use → 必须翻成 OpenAI 协议的 tool_calls 字段，
    /// 且 arguments 必须是 JSON **字符串**而非对象（OpenAI 兼容协议硬性要求）。
    #[test]
    fn assistant_tool_use_翻成_tool_calls_arguments_是字符串() {
        let req = ChatRequest {
            model: "x".into(),
            messages: vec![Message {
                role: Role::Assistant,
                content: MessageContent::Blocks(vec![
                    ContentBlock::Text { text: "我来读文件".into() },
                    ContentBlock::ToolUse {
                        id: "call_1".into(),
                        name: "read_file".into(),
                        input: serde_json::json!({"path": "README.md"}),
                    },
                ]),
            }],
            tools: vec![],
            system: None,
            max_tokens: 100,
            temperature: 1.0,
        };
        let body = build_request_body(&req);
        let m = &body["messages"][0];
        assert_eq!(m["role"], "assistant");
        assert_eq!(m["content"], "我来读文件");
        assert_eq!(m["tool_calls"][0]["id"], "call_1");
        assert_eq!(m["tool_calls"][0]["type"], "function");
        assert_eq!(m["tool_calls"][0]["function"]["name"], "read_file");
        // 关键：arguments 是字符串而非对象（很多 OpenAI 兼容后端会因此拒绝）
        let args = m["tool_calls"][0]["function"]["arguments"].as_str()
            .expect("arguments 必须是字符串");
        let parsed: serde_json::Value = serde_json::from_str(args).unwrap();
        assert_eq!(parsed["path"], "README.md");
    }

    /// tool 角色含 N 个 ToolResult blocks → 必须拆成 N 条
    /// `{role:"tool", tool_call_id, content}` 消息。
    /// 不允许出现 `type:"tool_result"` 字段（Qwen / OpenAI 都会 400）。
    #[test]
    fn tool_角色_拆成_多条_tool_call_id_消息() {
        let req = ChatRequest {
            model: "x".into(),
            messages: vec![Message {
                role: Role::Tool,
                content: MessageContent::Blocks(vec![
                    ContentBlock::ToolResult {
                        tool_use_id: "call_1".into(),
                        content: "文件内容".into(),
                        is_error: false,
                    },
                    ContentBlock::ToolResult {
                        tool_use_id: "call_2".into(),
                        content: "另一个工具结果".into(),
                        is_error: false,
                    },
                ]),
            }],
            tools: vec![],
            system: None,
            max_tokens: 100,
            temperature: 1.0,
        };
        let body = build_request_body(&req);
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 2);

        assert_eq!(msgs[0]["role"], "tool");
        assert_eq!(msgs[0]["tool_call_id"], "call_1");
        assert_eq!(msgs[0]["content"], "文件内容");
        // 关键：不允许出现 type 字段（Anthropic 风格的 tool_result 会让 Qwen 400）
        assert!(msgs[0].get("type").is_none(),
            "OpenAI 协议下 tool 消息不应有 type 字段");

        assert_eq!(msgs[1]["tool_call_id"], "call_2");
        assert_eq!(msgs[1]["content"], "另一个工具结果");
    }

    /// user 角色 Blocks 形式（罕见但可能）→ 文本 flatten 成单字符串。
    #[test]
    fn user_角色_blocks_flatten_为字符串() {
        let req = ChatRequest {
            model: "x".into(),
            messages: vec![Message {
                role: Role::User,
                content: MessageContent::Blocks(vec![
                    ContentBlock::Text { text: "你好".into() },
                    ContentBlock::Text { text: "世界".into() },
                ]),
            }],
            tools: vec![],
            system: None,
            max_tokens: 100,
            temperature: 1.0,
        };
        let body = build_request_body(&req);
        assert_eq!(body["messages"][0]["role"], "user");
        assert_eq!(body["messages"][0]["content"], "你好世界");
    }
}
