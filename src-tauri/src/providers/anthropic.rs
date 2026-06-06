//! Anthropic Messages API 适配器。
//!
//! 协议参考：<https://docs.anthropic.com/en/api/messages-streaming>

use async_trait::async_trait;
use futures::stream::{BoxStream, StreamExt};
use reqwest::Client;
use serde::Deserialize;
use serde_json::json;

use super::sse::sse_from_response;
use super::types::*;
use super::{Capabilities, LlmProvider, ModelInfo};

/// 默认 Anthropic API base url（用户可覆盖走代理）。
pub const DEFAULT_BASE_URL: &str = "https://api.anthropic.com/v1";

/// 默认 anthropic-version header。
pub const DEFAULT_API_VERSION: &str = "2023-06-01";

/// AnthropicClient 配置。
pub struct AnthropicConfig {
    pub id: String,
    pub display_name: String,
    pub base_url: String,
    pub api_key: String,
    pub api_version: String,
    pub models: Vec<ModelInfo>,
}

impl AnthropicConfig {
    /// 用最少参数构造默认配置。
    pub fn new(id: impl Into<String>, api_key: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            display_name: "Claude (Anthropic)".into(),
            base_url: DEFAULT_BASE_URL.into(),
            api_key: api_key.into(),
            api_version: DEFAULT_API_VERSION.into(),
            models: vec![
                ModelInfo {
                    id: "claude-opus-4-7".into(),
                    display_name: "Claude Opus 4.7".into(),
                    context_window: 1_000_000,
                },
                ModelInfo {
                    id: "claude-sonnet-4-6".into(),
                    display_name: "Claude Sonnet 4.6".into(),
                    context_window: 1_000_000,
                },
            ],
        }
    }
}

pub struct AnthropicClient {
    cfg: AnthropicConfig,
    http: Client,
}

impl AnthropicClient {
    pub fn new(cfg: AnthropicConfig) -> Self {
        Self {
            cfg,
            http: Client::builder()
                .timeout(std::time::Duration::from_secs(120))
                .build()
                .expect("reqwest client"),
        }
    }
}

/// Anthropic 自家流式事件类型（reqwest body 解析后的 JSON）。
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum AnthropicEvent {
    #[serde(rename = "message_start")]
    MessageStart { message: AnthropicMessageStart },
    #[serde(rename = "content_block_start")]
    ContentBlockStart {
        index: u32,
        content_block: AnthropicContentBlock,
    },
    #[serde(rename = "content_block_delta")]
    ContentBlockDelta { index: u32, delta: AnthropicDelta },
    #[serde(rename = "content_block_stop")]
    ContentBlockStop { index: u32 },
    #[serde(rename = "message_delta")]
    MessageDelta { delta: AnthropicMessageDelta, usage: AnthropicUsage },
    #[serde(rename = "message_stop")]
    MessageStop,
    #[serde(rename = "ping")]
    Ping,
    #[serde(rename = "error")]
    Error { error: AnthropicErrorData },
}

#[derive(Debug, Deserialize)]
struct AnthropicMessageStart {
    #[allow(dead_code)]
    id: String,
    #[serde(default)]
    usage: Option<AnthropicUsage>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum AnthropicContentBlock {
    #[serde(rename = "text")]
    Text {
        #[allow(dead_code)]
        text: String,
    },
    #[serde(rename = "tool_use")]
    ToolUse { id: String, name: String },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum AnthropicDelta {
    #[serde(rename = "text_delta")]
    TextDelta { text: String },
    #[serde(rename = "input_json_delta")]
    InputJsonDelta { partial_json: String },
}

#[derive(Debug, Deserialize)]
struct AnthropicMessageDelta {
    #[serde(default)]
    stop_reason: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct AnthropicUsage {
    #[serde(default)]
    input_tokens: u32,
    #[serde(default)]
    output_tokens: u32,
}

#[derive(Debug, Deserialize)]
struct AnthropicErrorData {
    message: String,
}

#[async_trait]
impl LlmProvider for AnthropicClient {
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
        // 构造 Anthropic 请求体
        let body = build_request_body(&req);

        let url = format!("{}/messages", self.cfg.base_url);
        let resp = self
            .http
            .post(&url)
            .header("x-api-key", &self.cfg.api_key)
            .header("anthropic-version", &self.cfg.api_version)
            .header("content-type", "application/json")
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

        // 把 SSE 流翻成 ChatChunk
        let sse = sse_from_response(resp);
        let mut block_index_to_call_id: std::collections::HashMap<u32, String> = Default::default();

        let chunks = sse.flat_map(move |item| {
            let chunks: Vec<ChatChunk> = match item {
                Err(e) => vec![ChatChunk::Error { message: format!("{e}") }],
                Ok(event) => {
                    if event.event == "ping" || event.data.is_empty() {
                        vec![]
                    } else {
                        match serde_json::from_str::<AnthropicEvent>(&event.data) {
                            Ok(parsed) => translate_event(parsed, &mut block_index_to_call_id),
                            Err(e) => vec![ChatChunk::Error {
                                message: format!("解析 Anthropic event: {e}; data={}", event.data),
                            }],
                        }
                    }
                }
            };
            futures::stream::iter(chunks)
        });

        Ok(Box::pin(chunks))
    }
}

fn build_request_body(req: &ChatRequest) -> serde_json::Value {
    // Anthropic 不接受 system 在 messages 里，作为单独字段
    let messages: Vec<_> = req
        .messages
        .iter()
        .filter(|m| m.role != Role::Tool || matches!(&m.content, MessageContent::Blocks(_)))
        .map(|m| {
            json!({
                "role": match m.role {
                    Role::User | Role::Tool => "user",
                    Role::Assistant => "assistant",
                },
                "content": &m.content,
            })
        })
        .collect();

    let mut body = json!({
        "model": req.model,
        "max_tokens": req.max_tokens,
        "messages": messages,
        "stream": true,
        "temperature": req.temperature,
    });
    if let Some(s) = &req.system {
        body["system"] = json!(s);
    }
    if !req.tools.is_empty() {
        body["tools"] = json!(req.tools.iter().map(|t| json!({
            "name": t.name,
            "description": t.description,
            "input_schema": t.input_schema,
        })).collect::<Vec<_>>());
    }
    body
}

fn translate_event(
    ev: AnthropicEvent,
    block_index_to_call_id: &mut std::collections::HashMap<u32, String>,
) -> Vec<ChatChunk> {
    match ev {
        AnthropicEvent::MessageStart { message } => {
            if let Some(u) = message.usage {
                vec![ChatChunk::Usage {
                    input_tokens: u.input_tokens,
                    output_tokens: u.output_tokens,
                }]
            } else {
                vec![]
            }
        }
        AnthropicEvent::ContentBlockStart { index, content_block } => match content_block {
            AnthropicContentBlock::Text { .. } => vec![],
            AnthropicContentBlock::ToolUse { id, name } => {
                block_index_to_call_id.insert(index, id.clone());
                vec![ChatChunk::ToolUseStart { call_id: id, name }]
            }
        },
        AnthropicEvent::ContentBlockDelta { index, delta } => match delta {
            AnthropicDelta::TextDelta { text } => vec![ChatChunk::TextDelta { text }],
            AnthropicDelta::InputJsonDelta { partial_json } => {
                if let Some(call_id) = block_index_to_call_id.get(&index) {
                    vec![ChatChunk::ToolUseArgsDelta {
                        call_id: call_id.clone(),
                        json_partial: partial_json,
                    }]
                } else {
                    vec![]
                }
            }
        },
        AnthropicEvent::ContentBlockStop { index } => {
            if let Some(call_id) = block_index_to_call_id.remove(&index) {
                vec![ChatChunk::ToolUseEnd { call_id }]
            } else {
                vec![]
            }
        }
        AnthropicEvent::MessageDelta { delta, usage } => {
            let mut chunks = vec![ChatChunk::Usage {
                input_tokens: 0,
                output_tokens: usage.output_tokens,
            }];
            if let Some(reason) = delta.stop_reason {
                chunks.push(ChatChunk::Done {
                    stop_reason: parse_stop_reason(&reason),
                });
            }
            chunks
        }
        AnthropicEvent::MessageStop => vec![],
        AnthropicEvent::Ping => vec![],
        AnthropicEvent::Error { error } => {
            vec![ChatChunk::Error { message: error.message }]
        }
    }
}

fn parse_stop_reason(s: &str) -> StopReason {
    match s {
        "end_turn" => StopReason::EndTurn,
        "tool_use" => StopReason::ToolUse,
        "max_tokens" => StopReason::MaxTokens,
        "stop_sequence" => StopReason::StopSequence,
        _ => StopReason::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_stop_reason_映射() {
        assert_eq!(parse_stop_reason("end_turn"), StopReason::EndTurn);
        assert_eq!(parse_stop_reason("tool_use"), StopReason::ToolUse);
        assert_eq!(parse_stop_reason("max_tokens"), StopReason::MaxTokens);
        assert_eq!(parse_stop_reason("xxx"), StopReason::Other);
    }

    #[test]
    fn 默认配置含两个模型() {
        let cfg = AnthropicConfig::new("anth", "sk-x");
        assert_eq!(cfg.models.len(), 2);
        assert_eq!(cfg.models[0].id, "claude-opus-4-7");
    }

    #[test]
    fn build_request_body_含_stream_true() {
        let req = ChatRequest {
            model: "claude-opus-4-7".into(),
            messages: vec![],
            tools: vec![],
            system: Some("you are helpful".into()),
            max_tokens: 100,
            temperature: 0.7,
        };
        let body = build_request_body(&req);
        assert_eq!(body["stream"], true);
        assert_eq!(body["system"], "you are helpful");
        assert_eq!(body["max_tokens"], 100);
    }

    #[test]
    fn build_request_body_有_tools_时_注入() {
        let req = ChatRequest {
            model: "claude".into(),
            messages: vec![],
            tools: vec![ToolDef {
                name: "run".into(),
                description: "run command".into(),
                input_schema: serde_json::json!({"type":"object"}),
            }],
            system: None,
            max_tokens: 100,
            temperature: 1.0,
        };
        let body = build_request_body(&req);
        assert!(body["tools"].is_array());
        assert_eq!(body["tools"][0]["name"], "run");
    }
}
