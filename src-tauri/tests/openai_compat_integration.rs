//! OpenAI 兼容 provider 集成测试。

use aitm_lib::providers::openai_compat::{OpenAICompatClient, OpenAICompatConfig};
use aitm_lib::providers::presets::Preset;
use aitm_lib::providers::types::*;
use aitm_lib::providers::LlmProvider;
use futures::StreamExt;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[tokio::test]
async fn openai_流式_hello_world() {
    let mock = MockServer::start().await;

    let sse = "\
data: {\"id\":\"x\",\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"Hi\"}}]}\n\n\
data: {\"id\":\"x\",\"choices\":[{\"delta\":{\"content\":\" there\"}}]}\n\n\
data: {\"id\":\"x\",\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":3}}\n\n\
data: [DONE]\n\n\
";

    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_string(sse)
                .insert_header("content-type", "text/event-stream"),
        )
        .mount(&mock)
        .await;

    let mut cfg = OpenAICompatConfig {
        id: "test".into(),
        display_name: "Test".into(),
        base_url: mock.uri(),
        api_key: "sk-x".into(),
        models: vec![],
    };
    let _ = &mut cfg;
    let client = OpenAICompatClient::new(cfg);

    let req = ChatRequest {
        model: "deepseek-chat".into(),
        messages: vec![Message { role: Role::User, content: MessageContent::Text("hi".into()) }],
        tools: vec![],
        system: None,
        max_tokens: 100,
        temperature: 1.0,
    };

    let stream = client.stream_chat(req).await.unwrap();
    let chunks: Vec<ChatChunk> = stream.collect().await;

    let text: String = chunks
        .iter()
        .filter_map(|c| match c {
            ChatChunk::TextDelta { text } => Some(text.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(text, "Hi there");
    assert!(chunks.iter().any(|c| matches!(c, ChatChunk::Done { stop_reason: StopReason::EndTurn })));
    assert!(chunks.iter().any(|c| matches!(c, ChatChunk::Usage { input_tokens: 5, output_tokens: 3 })));
}

#[tokio::test]
async fn openai_tool_calls_流式_args_拼接() {
    let mock = MockServer::start().await;

    let sse = "\
data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"echo\",\"arguments\":\"\"}}]}}]}\n\n\
data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"a\"}}]}}]}\n\n\
data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\":1}\"}}]}}]}\n\n\
data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n\
data: [DONE]\n\n\
";

    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_string(sse)
                .insert_header("content-type", "text/event-stream"),
        )
        .mount(&mock)
        .await;

    let cfg = OpenAICompatConfig {
        id: "test".into(),
        display_name: "T".into(),
        base_url: mock.uri(),
        api_key: "sk-x".into(),
        models: vec![],
    };
    let client = OpenAICompatClient::new(cfg);

    let req = ChatRequest {
        model: "deepseek-chat".into(),
        messages: vec![],
        tools: vec![ToolDef {
            name: "echo".into(),
            description: "".into(),
            input_schema: serde_json::json!({"type":"object"}),
        }],
        system: None,
        max_tokens: 100,
        temperature: 1.0,
    };

    let stream = client.stream_chat(req).await.unwrap();
    let chunks: Vec<ChatChunk> = stream.collect().await;

    assert!(chunks.iter().any(|c| matches!(c, ChatChunk::ToolUseStart { name, call_id } if name == "echo" && call_id == "call_1")));
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

/// Qwen DashScope 海外版的 streaming tool_calls 在第一个 chunk 给真实 id，
/// **后续 chunks 把 id 字段填成空字符串 ""**（不是 null），易把 tool_index→id
/// 映射覆盖成空串，导致后续 ArgsDelta emit 给空 call_id，args 全丢。
/// 本测试固定这个回归路径。
#[tokio::test]
async fn qwen_流式_后续_chunks_id_空字符串_args_仍正确拼接() {
    let mock = MockServer::start().await;

    // 真实 Qwen DashScope 抓包：第一个 chunk 含真 id，后面 4 个 chunks id="" 但 arguments 增量
    let sse = "\
data: {\"choices\":[{\"delta\":{\"content\":null,\"tool_calls\":[{\"index\":0,\"id\":\"call_real\",\"type\":\"function\",\"function\":{\"name\":\"list_files\",\"arguments\":\"\"}}]},\"finish_reason\":null}]}\n\n\
data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"\",\"type\":\"function\",\"function\":{\"arguments\":\"{\\\"dir\\\": \\\"\"}}]},\"finish_reason\":null}]}\n\n\
data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"\",\"type\":\"function\",\"function\":{\"arguments\":\".\"}}]},\"finish_reason\":null}]}\n\n\
data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"\",\"type\":\"function\",\"function\":{\"arguments\":\"\\\"}\"}}]},\"finish_reason\":null}]}\n\n\
data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n\
data: [DONE]\n\n\
";

    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_string(sse)
                .insert_header("content-type", "text/event-stream"),
        )
        .mount(&mock)
        .await;

    let cfg = OpenAICompatConfig {
        id: "qwen".into(),
        display_name: "Q".into(),
        base_url: mock.uri(),
        api_key: "sk-x".into(),
        models: vec![],
    };
    let client = OpenAICompatClient::new(cfg);

    let req = ChatRequest {
        model: "qwen3-coder-plus".into(),
        messages: vec![],
        tools: vec![ToolDef {
            name: "list_files".into(),
            description: "".into(),
            input_schema: serde_json::json!({"type":"object","properties":{"dir":{"type":"string"}},"required":["dir"]}),
        }],
        system: None,
        max_tokens: 100,
        temperature: 1.0,
    };

    let stream = client.stream_chat(req).await.unwrap();
    let chunks: Vec<ChatChunk> = stream.collect().await;

    // 真 call_id "call_real" 必须出现在 Start
    let start_call_id = chunks.iter().find_map(|c| match c {
        ChatChunk::ToolUseStart { call_id, .. } => Some(call_id.clone()),
        _ => None,
    });
    assert_eq!(start_call_id.as_deref(), Some("call_real"),
        "Start 事件必须用第一个 chunk 的真 id，不能被后续空字符串 id 覆盖");

    // 所有 ArgsDelta 必须 emit 给同一个真 call_id（不能是空串）
    let arg_call_ids: std::collections::HashSet<String> = chunks
        .iter()
        .filter_map(|c| match c {
            ChatChunk::ToolUseArgsDelta { call_id, .. } => Some(call_id.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(arg_call_ids.len(), 1, "所有 ArgsDelta 应共享同一 call_id，不能因后续空 id 而分裂");
    assert_eq!(arg_call_ids.iter().next().unwrap(), "call_real");

    // 拼接后的 args 必须是合法 JSON 且含 dir 字段
    let args: String = chunks
        .iter()
        .filter_map(|c| match c {
            ChatChunk::ToolUseArgsDelta { json_partial, .. } => Some(json_partial.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(args, r#"{"dir": "."}"#);
    let parsed: serde_json::Value = serde_json::from_str(&args).unwrap();
    assert_eq!(parsed["dir"], ".");

    // ToolUseEnd 也要用真 call_id 而不是空串
    let end_call_id = chunks.iter().find_map(|c| match c {
        ChatChunk::ToolUseEnd { call_id } => Some(call_id.clone()),
        _ => None,
    });
    assert_eq!(end_call_id.as_deref(), Some("call_real"));
}

#[tokio::test]
async fn 验证_4_家预设_base_url_独立() {
    let urls: Vec<&str> = [
        Preset::DeepSeek.base_url(),
        Preset::QwenDashScope.base_url(),
        Preset::Zhipu.base_url(),
        Preset::MoonshotKimi.base_url(),
        Preset::OpenAIOfficial.base_url(),
    ]
    .into_iter()
    .collect();
    let unique: std::collections::HashSet<_> = urls.iter().collect();
    assert_eq!(unique.len(), 5);
}

#[tokio::test]
async fn openai_429_限流() {
    let mock = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .respond_with(ResponseTemplate::new(429))
        .mount(&mock)
        .await;

    let cfg = OpenAICompatConfig {
        id: "x".into(), display_name: "x".into(),
        base_url: mock.uri(),
        api_key: "k".into(), models: vec![],
    };
    let client = OpenAICompatClient::new(cfg);
    let req = ChatRequest {
        model: "x".into(), messages: vec![], tools: vec![],
        system: None, max_tokens: 100, temperature: 1.0,
    };
    let r = client.stream_chat(req).await;
    assert!(matches!(r, Err(ProviderError::RateLimited)));
}
