//! LLM Provider 抽象层类型定义。
//!
//! 所有 provider 实现必须把自家的 SSE 流翻译成统一的 [`ChatChunk`]，
//! 前端永远不需要知道底层是哪家 API。

use serde::{Deserialize, Serialize};

/// Provider 的能力标志，运行时可查。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Capabilities {
    pub supports_tools: bool,
    /// SSE 流式 tool use 是否完整支持（vs 全文返回后才能解析）。
    pub supports_streaming_tools: bool,
    /// args 在多个 chunk 间是否需要拼接（OpenAI 流式 tool_calls 是逐字符的）。
    pub needs_args_concat: bool,
}

/// 一次完整的 chat 请求。前端构造后递给 trait。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<Message>,
    #[serde(default)]
    pub tools: Vec<ToolDef>,
    #[serde(default)]
    pub system: Option<String>,
    pub max_tokens: u32,
    #[serde(default = "default_temperature")]
    pub temperature: f32,
}

fn default_temperature() -> f32 {
    1.0
}

/// 单条消息（对话历史）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub role: Role,
    pub content: MessageContent,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
    Tool,
}

/// 消息内容。
///
/// 文本最常见；tool use / tool result 由 assistant/tool 角色携带。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MessageContent {
    Text(String),
    /// 数组形式（assistant 消息可能含 text + tool_use 混合）。
    Blocks(Vec<ContentBlock>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    Text {
        text: String,
    },
    ToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
    },
    ToolResult {
        tool_use_id: String,
        content: String,
        #[serde(default)]
        is_error: bool,
    },
}

/// 工具定义（assistant 可调用的"工具"）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    /// JSON Schema 描述参数。
    pub input_schema: serde_json::Value,
}

/// 流式事件 —— 所有 provider 的输出统一翻译成这个。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChatChunk {
    /// 文本增量。
    TextDelta { text: String },
    /// 一次 tool 调用开始（拿到 id + name）。
    ToolUseStart { call_id: String, name: String },
    /// tool 调用 args 增量。所有 chunk 拼接后才能 JSON parse。
    ToolUseArgsDelta {
        call_id: String,
        json_partial: String,
    },
    /// 当前 tool 调用的 args 结束。
    ToolUseEnd { call_id: String },
    /// token 使用统计。
    Usage {
        input_tokens: u32,
        output_tokens: u32,
    },
    /// 流结束。
    Done { stop_reason: StopReason },
    /// 不可恢复错误。
    Error { message: String },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    /// 模型自然结束。
    EndTurn,
    /// 调用了 tool 等待 tool result。
    ToolUse,
    /// 达到 max_tokens。
    MaxTokens,
    /// 命中 stop sequence。
    StopSequence,
    /// 其他 / 未知。
    Other,
}

/// Provider 错误。HTTP 错误、协议错误、超时等都归这里。
#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("HTTP 失败: {0}")]
    Http(#[from] reqwest::Error),
    #[error("鉴权失败（401/403）：检查 API key")]
    Unauthorized,
    #[error("限流（429）：稍后重试")]
    RateLimited,
    #[error("协议解析失败: {0}")]
    Protocol(String),
    #[error("配置错误: {0}")]
    Config(String),
    #[error("超时")]
    Timeout,
    #[error("其他: {0}")]
    Other(String),
}

/// 构造 Provider 共用的 HTTP 客户端（120 秒超时）。
///
/// 构造失败（如 TLS 后端初始化失败）返回错误而不是 panic：这条路径在用户保存
/// Provider 设置时触发，panic 会让整个应用崩溃，返回错误则能在设置界面提示出来。
pub fn build_http_client() -> Result<reqwest::Client, ProviderError> {
    http_client_from(reqwest::Client::builder().timeout(std::time::Duration::from_secs(120)))
}

fn http_client_from(builder: reqwest::ClientBuilder) -> Result<reqwest::Client, ProviderError> {
    builder
        .build()
        .map_err(|e| ProviderError::Config(format!("创建 HTTP 客户端失败：{e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 应该_当_http_客户端构造失败时_返回配置错误而不是_panic() {
        // 传一个不认识的 TLS 配置对象，reqwest 在 build() 时报错——模拟 TLS 后端初始化失败
        let builder = reqwest::Client::builder().use_preconfigured_tls(0u8);

        let err = http_client_from(builder).unwrap_err();

        assert!(matches!(err, ProviderError::Config(ref m) if m.contains("HTTP 客户端")));
    }

    #[test]
    fn 应该_正常环境下_能构造出客户端() {
        assert!(build_http_client().is_ok());
    }

    #[test]
    fn role_序列化为_lowercase() {
        let json = serde_json::to_string(&Role::User).unwrap();
        assert_eq!(json, "\"user\"");
        let assistant: Role = serde_json::from_str("\"assistant\"").unwrap();
        assert_eq!(assistant, Role::Assistant);
    }

    #[test]
    fn message_content_text_反序列化() {
        let json = r#""hello""#;
        let m: MessageContent = serde_json::from_str(json).unwrap();
        match m {
            MessageContent::Text(s) => assert_eq!(s, "hello"),
            _ => panic!("应为 Text"),
        }
    }

    #[test]
    fn message_content_blocks_反序列化() {
        let json =
            r#"[{"type":"text","text":"hi"},{"type":"tool_use","id":"x","name":"foo","input":{}}]"#;
        let m: MessageContent = serde_json::from_str(json).unwrap();
        match m {
            MessageContent::Blocks(bs) => {
                assert_eq!(bs.len(), 2);
                matches!(bs[0], ContentBlock::Text { .. });
                matches!(bs[1], ContentBlock::ToolUse { .. });
            }
            _ => panic!("应为 Blocks"),
        }
    }

    #[test]
    fn chat_chunk_text_delta_序列化() {
        let c = ChatChunk::TextDelta { text: "hi".into() };
        let json = serde_json::to_string(&c).unwrap();
        assert_eq!(json, r#"{"type":"text_delta","text":"hi"}"#);
    }

    #[test]
    fn chat_chunk_tool_use_start_序列化() {
        let c = ChatChunk::ToolUseStart {
            call_id: "abc".into(),
            name: "run".into(),
        };
        let json = serde_json::to_string(&c).unwrap();
        assert_eq!(
            json,
            r#"{"type":"tool_use_start","call_id":"abc","name":"run"}"#
        );
    }

    #[test]
    fn stop_reason_序列化() {
        assert_eq!(
            serde_json::to_string(&StopReason::EndTurn).unwrap(),
            "\"end_turn\""
        );
        assert_eq!(
            serde_json::to_string(&StopReason::ToolUse).unwrap(),
            "\"tool_use\""
        );
    }

    #[test]
    fn capabilities_默认全_false() {
        let c = Capabilities::default();
        assert!(!c.supports_tools);
        assert!(!c.supports_streaming_tools);
        assert!(!c.needs_args_concat);
    }

    #[test]
    fn provider_error_unauthorized_显示() {
        let e = ProviderError::Unauthorized;
        assert!(e.to_string().contains("鉴权"));
    }
}
