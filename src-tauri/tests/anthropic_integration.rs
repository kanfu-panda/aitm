//! Anthropic provider 集成测试（wiremock 模拟 API）。

use aitm_lib::providers::anthropic::{AnthropicClient, AnthropicConfig};
use aitm_lib::providers::types::*;
use aitm_lib::providers::LlmProvider;
use futures::StreamExt;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[tokio::test]
async fn anthropic_流式_hello_world() {
    let mock = MockServer::start().await;

    // SSE 响应：text_delta "Hi" + " there"
    let sse = "\
event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"x\",\"usage\":{\"input_tokens\":10,\"output_tokens\":0}}}\n\n\
event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n\
event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hi\"}}\n\n\
event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\" there\"}}\n\n\
event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n\
event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":5}}\n\n\
event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n\
";

    Mock::given(method("POST"))
        .and(path("/messages"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_string(sse)
                .insert_header("content-type", "text/event-stream"),
        )
        .mount(&mock)
        .await;

    let mut cfg = AnthropicConfig::new("test", "sk-x");
    cfg.base_url = mock.uri();
    let client = AnthropicClient::new(cfg);

    let req = ChatRequest {
        model: "claude-opus-4-7".into(),
        messages: vec![Message {
            role: Role::User,
            content: MessageContent::Text("hi".into()),
        }],
        tools: vec![],
        system: None,
        max_tokens: 100,
        temperature: 1.0,
    };

    let stream = client.stream_chat(req).await.unwrap();
    let chunks: Vec<ChatChunk> = stream.collect().await;

    // 抽取 text 部分
    let text: String = chunks
        .iter()
        .filter_map(|c| match c {
            ChatChunk::TextDelta { text } => Some(text.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(text, "Hi there");

    // 应有一个 Done 事件
    let has_done = chunks.iter().any(|c| matches!(c, ChatChunk::Done { .. }));
    assert!(has_done, "应有 Done");
}

#[tokio::test]
async fn anthropic_tool_use_流式() {
    let mock = MockServer::start().await;

    let sse = "\
event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_42\",\"name\":\"echo\"}}\n\n\
event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"a\"}}\n\n\
event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"\\\":1}\"}}\n\n\
event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n\
event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":3}}\n\n\
event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n\
";

    Mock::given(method("POST"))
        .and(path("/messages"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_string(sse)
                .insert_header("content-type", "text/event-stream"),
        )
        .mount(&mock)
        .await;

    let mut cfg = AnthropicConfig::new("test", "sk-x");
    cfg.base_url = mock.uri();
    let client = AnthropicClient::new(cfg);

    let req = ChatRequest {
        model: "claude-opus-4-7".into(),
        messages: vec![],
        tools: vec![ToolDef {
            name: "echo".into(),
            description: "".into(),
            input_schema: serde_json::json!({}),
        }],
        system: None,
        max_tokens: 100,
        temperature: 1.0,
    };

    let stream = client.stream_chat(req).await.unwrap();
    let chunks: Vec<ChatChunk> = stream.collect().await;

    // 应有 ToolUseStart, 多个 ArgsDelta, ToolUseEnd
    assert!(chunks.iter().any(|c| matches!(c, ChatChunk::ToolUseStart { name, .. } if name == "echo")));
    let args: String = chunks
        .iter()
        .filter_map(|c| match c {
            ChatChunk::ToolUseArgsDelta { json_partial, .. } => Some(json_partial.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(args, r#"{"a":1}"#);
    assert!(chunks.iter().any(|c| matches!(c, ChatChunk::ToolUseEnd { .. })));
    assert!(chunks
        .iter()
        .any(|c| matches!(c, ChatChunk::Done { stop_reason: StopReason::ToolUse })));
}

#[tokio::test]
async fn anthropic_401_鉴权失败() {
    let mock = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/messages"))
        .respond_with(ResponseTemplate::new(401))
        .mount(&mock)
        .await;

    let mut cfg = AnthropicConfig::new("test", "bad-key");
    cfg.base_url = mock.uri();
    let client = AnthropicClient::new(cfg);

    let req = ChatRequest {
        model: "x".into(),
        messages: vec![],
        tools: vec![],
        system: None,
        max_tokens: 100,
        temperature: 1.0,
    };

    let result = client.stream_chat(req).await;
    assert!(matches!(result, Err(ProviderError::Unauthorized)));
}
