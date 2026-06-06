//! T8 wiremock 集成测试：providers 配置 → registry 重建 → 流式聊天端到端。
//!
//! 目的：在不起 Tauri Builder / AppHandle 的前提下，验证 T2/T3/T4 的关键路径：
//! - `rebuild_registry` 把 `AppSettings.providers` 解析成 provider 实例
//! - `enabled = false` 不进 registry
//! - 401 走到 `ProviderError::Unauthorized` + `classify_for_user` 中文映射
//! - Qwen 流式响应里的 usage chunk 能被解析（T3 stream_options.include_usage）
//!
//! 设计：
//! - 不调 `providers_test_connection` 命令本体（依赖 Tauri State），改为
//!   验证底层 provider trait + classify_for_user
//! - HOME 切临时目录 + 清空 6 家 provider 的 env vars，防止真机
//!   `~/.aitm/.env` 或 shell env 污染三源合并
//! - 用本地 `Mutex<()>` 串行 env 修改（这个 integration test binary
//!   独立于 unit tests，不需要跟 ENV_LOCK 互斥）

use std::sync::Arc;

use aitm_lib::ipc::providers::classify_for_user;
use aitm_lib::providers::registry::{rebuild_registry, ProviderRegistry, SharedRegistry};
use aitm_lib::providers::types::*;
use aitm_lib::settings::{AppSettings, ProviderConfig};
use futures::StreamExt;
use tempfile::TempDir;
use tokio::sync::Mutex;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// 串行锁：本 binary 内的测试改 std::env，必须串行。
///
/// 用 `tokio::sync::Mutex` 而不是 `std::sync::Mutex`：guard 实现 `Send`，
/// 可以跨 await 持锁（rebuild_registry 内部要 .await）。
///
/// 注意不需要跟 src/ 里的 unit test ENV_LOCK 互斥 —— `cargo test` 会把
/// integration test 放在独立进程跑，env 天然隔离。
static ENV_LOCK: Mutex<()> = Mutex::const_new(());

/// 6 家 provider 的 env keys（含 _API_KEY 和 _BASE_URL）。
const ENV_KEYS: &[&str] = &[
    "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL",
    "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL",
    "QWEN_API_KEY", "QWEN_BASE_URL",
    "ZHIPU_API_KEY", "ZHIPU_BASE_URL",
    "MOONSHOT_API_KEY", "MOONSHOT_BASE_URL",
    "OPENAI_API_KEY", "OPENAI_BASE_URL",
];

/// 把 HOME 切临时目录 + 清空 provider env vars，跨 await 跑闭包，结束后还原。
///
/// 全程持有 `ENV_LOCK`，保证本 binary 内并行的 #[tokio::test] 不会同时改 env。
/// 用 `tokio::sync::Mutex` 因为 std Mutex guard 不是 Send。
async fn with_isolated_env<F, Fut>(settings_setup: impl FnOnce() -> AppSettings, f: F)
where
    F: FnOnce(AppSettings) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    let _guard = ENV_LOCK.lock().await;

    let settings = settings_setup();
    let _tmp = TempDir::new().unwrap();
    let original_home = std::env::var("HOME").ok();
    let originals: Vec<(String, Option<String>)> = ENV_KEYS
        .iter()
        .map(|k| (k.to_string(), std::env::var(k).ok()))
        .collect();

    // SAFETY: ENV_LOCK 串行 + 单线程进程内 set_var；写 env 安全前提满足。
    unsafe {
        std::env::set_var("HOME", _tmp.path());
        for k in ENV_KEYS {
            std::env::remove_var(k);
        }
    }

    f(settings).await;

    unsafe {
        if let Some(h) = original_home {
            std::env::set_var("HOME", h);
        } else {
            std::env::remove_var("HOME");
        }
        for (k, v) in originals {
            if let Some(val) = v {
                std::env::set_var(&k, val);
            } else {
                std::env::remove_var(&k);
            }
        }
    }
}

/// 起一个 wiremock server，挂上 `/v1/chat/completions` 的 SSE 响应。
async fn mock_with_sse(server: &MockServer, sse: &'static str) {
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_string(sse)
                .insert_header("content-type", "text/event-stream"),
        )
        .mount(server)
        .await;
}

/// 起一个 wiremock server，挂上 `/v1/chat/completions` 的 401 响应。
async fn mock_with_401(server: &MockServer) {
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(401))
        .mount(server)
        .await;
}

#[tokio::test]
async fn save_config_后_新_provider_可用_且_能_stream_chat() {
    let mock = MockServer::start().await;
    let sse = "\
data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"hello\"}}]}\n\n\
data: {\"choices\":[{\"delta\":{\"content\":\" world\"}}]}\n\n\
data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n\
data: [DONE]\n\n\
";
    mock_with_sse(&mock, sse).await;

    let mock_uri = mock.uri();
    with_isolated_env(
        || {
            let mut s = AppSettings::default();
            s.providers.map.insert(
                "qwen".into(),
                ProviderConfig {
                    enabled: true,
                    api_key: "sk-test".into(),
                    base_url: format!("{mock_uri}/v1"),
                },
            );
            s
        },
        |settings| async move {
            let shared: SharedRegistry =
                Arc::new(tokio::sync::RwLock::new(ProviderRegistry::new()));
            rebuild_registry(&shared, &settings).await.unwrap();

            // 1. registry 里有 qwen
            let provider = shared.read().await.get("qwen");
            assert!(provider.is_some(), "rebuild 后 qwen 应进 registry");
            let provider = provider.unwrap();

            // 2. stream_chat 能跑通
            let req = ChatRequest {
                model: "qwen-max".into(),
                messages: vec![Message {
                    role: Role::User,
                    content: MessageContent::Text("hi".into()),
                }],
                tools: vec![],
                system: None,
                max_tokens: 100,
                temperature: 1.0,
            };
            let stream = provider.stream_chat(req).await.expect("stream_chat ok");
            let chunks: Vec<ChatChunk> = stream.collect().await;

            let text: String = chunks
                .iter()
                .filter_map(|c| match c {
                    ChatChunk::TextDelta { text } => Some(text.clone()),
                    _ => None,
                })
                .collect();
            assert_eq!(text, "hello world");
            assert!(
                chunks
                    .iter()
                    .any(|c| matches!(c, ChatChunk::Done { stop_reason: StopReason::EndTurn })),
                "应有 Done 且 stop_reason=EndTurn"
            );
        },
    )
    .await;
}

#[tokio::test]
async fn disabled_provider_不进_registry() {
    with_isolated_env(
        || {
            let mut s = AppSettings::default();
            s.providers.map.insert(
                "qwen".into(),
                ProviderConfig {
                    enabled: false,
                    api_key: "sk-test".into(),
                    base_url: "https://example.com/v1".into(),
                },
            );
            s
        },
        |settings| async move {
            let shared: SharedRegistry =
                Arc::new(tokio::sync::RwLock::new(ProviderRegistry::new()));
            rebuild_registry(&shared, &settings).await.unwrap();
            assert!(
                shared.read().await.get("qwen").is_none(),
                "enabled=false 不应进 registry"
            );
        },
    )
    .await;
}

#[tokio::test]
async fn test_connection_对_401_返回_unauthorized() {
    let mock = MockServer::start().await;
    mock_with_401(&mock).await;

    let mock_uri = mock.uri();
    with_isolated_env(
        || {
            let mut s = AppSettings::default();
            s.providers.map.insert(
                "qwen".into(),
                ProviderConfig {
                    enabled: true,
                    api_key: "sk-bad".into(),
                    base_url: format!("{mock_uri}/v1"),
                },
            );
            s
        },
        |settings| async move {
            let shared: SharedRegistry =
                Arc::new(tokio::sync::RwLock::new(ProviderRegistry::new()));
            rebuild_registry(&shared, &settings).await.unwrap();

            let provider = shared
                .read()
                .await
                .get("qwen")
                .expect("rebuild 后 qwen 应在 registry");
            let req = ChatRequest {
                model: "qwen-max".into(),
                messages: vec![Message {
                    role: Role::User,
                    content: MessageContent::Text("ping".into()),
                }],
                tools: vec![],
                system: None,
                max_tokens: 1,
                temperature: 0.0,
            };
            let result = provider.stream_chat(req).await;
            assert!(
                matches!(result, Err(ProviderError::Unauthorized)),
                "401 应映射为 ProviderError::Unauthorized，实际：{:?}",
                result.err()
            );
            // classify_for_user 把 Unauthorized 翻成中文，含 "无效"
            let msg = classify_for_user(&ProviderError::Unauthorized);
            assert!(msg.contains("无效"), "提示语应含 \"无效\"，实际：{msg}");
        },
    )
    .await;
}

#[tokio::test]
async fn qwen_流式响应_含_usage_chunk_累计正确() {
    let mock = MockServer::start().await;
    // SSE 格式：每条 `data: ...\n\n`，最后 [DONE]。
    // 倒数第二条把 finish_reason + usage 一起带回（Qwen / OpenAI 兼容
    // stream_options.include_usage=true 行为）。
    let sse = "\
data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\n\
data: {\"choices\":[{\"delta\":{\"content\":\" world\"}}]}\n\n\
data: {\"choices\":[{\"finish_reason\":\"stop\",\"delta\":{}}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5}}\n\n\
data: [DONE]\n\n\
";
    mock_with_sse(&mock, sse).await;

    let mock_uri = mock.uri();
    with_isolated_env(
        || {
            let mut s = AppSettings::default();
            s.providers.map.insert(
                "qwen".into(),
                ProviderConfig {
                    enabled: true,
                    api_key: "sk-test".into(),
                    base_url: format!("{mock_uri}/v1"),
                },
            );
            s
        },
        |settings| async move {
            let shared: SharedRegistry =
                Arc::new(tokio::sync::RwLock::new(ProviderRegistry::new()));
            rebuild_registry(&shared, &settings).await.unwrap();

            let provider = shared.read().await.get("qwen").unwrap();
            let req = ChatRequest {
                model: "qwen-max".into(),
                messages: vec![Message {
                    role: Role::User,
                    content: MessageContent::Text("hi".into()),
                }],
                tools: vec![],
                system: None,
                max_tokens: 100,
                temperature: 1.0,
            };
            let stream = provider.stream_chat(req).await.unwrap();
            let chunks: Vec<ChatChunk> = stream.collect().await;

            // ≥ 2 个 TextDelta，拼出 "hello world"
            let texts: Vec<&String> = chunks
                .iter()
                .filter_map(|c| match c {
                    ChatChunk::TextDelta { text } => Some(text),
                    _ => None,
                })
                .collect();
            assert!(texts.len() >= 2, "应有 ≥2 个 TextDelta，实际 {}", texts.len());
            assert_eq!(
                texts.iter().map(|s| s.as_str()).collect::<String>(),
                "hello world"
            );

            // 1 个 Usage，input=10、output=5
            let usage = chunks.iter().find_map(|c| match c {
                ChatChunk::Usage { input_tokens, output_tokens } => {
                    Some((*input_tokens, *output_tokens))
                }
                _ => None,
            });
            assert_eq!(usage, Some((10, 5)), "Usage chunk 解析错");

            // 1 个 Done，stop_reason=EndTurn
            assert!(
                chunks.iter().any(|c| matches!(
                    c,
                    ChatChunk::Done { stop_reason: StopReason::EndTurn }
                )),
                "应有 Done 且 stop_reason=EndTurn"
            );
        },
    )
    .await;
}

