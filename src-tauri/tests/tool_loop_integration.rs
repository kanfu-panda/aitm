//! 工具调用循环端到端集成测试。
//!
//! 用 FakeProvider 模拟 LLM 流；其余全部走真：
//! - `ToolRegistry::with_defaults()` 真实注册 5 个工具
//! - `read_file` / `list_files` 落到 tempdir 真文件系统
//! - L1 黑名单走真实 `safety::blacklist::is_blacklisted`
//!
//! 不起 Tauri AppHandle（太重），用 `MockSink` 替代 `TauriSink`，验证 emit 序列。
//! T8 单测已覆盖 happy / 拒绝 / max_steps；这里只补真实工具组合的端到端。

use std::sync::{Arc, Mutex as StdMutex};

use aitm_lib::ipc::session::SessionState;
use aitm_lib::orchestrator::tool_loop::{
    AiDoneEvent, AiErrorEvent, AiTokenEvent, AiToolFinishedEvent, AiToolRequestEvent,
    AiToolStartedEvent, EventSink, ToolLoopHandle, run_tool_loop,
};
use aitm_lib::providers::types::*;
use aitm_lib::providers::{Capabilities, LlmProvider, ModelInfo};
use aitm_lib::tools::ToolContext;
use aitm_lib::tools::registry::ToolRegistry;
use async_trait::async_trait;
use futures::stream::BoxStream;
use tempfile::TempDir;

/// 把 emit 全部存进 Vec 供断言。
#[derive(Default)]
struct MockSink {
    tokens: StdMutex<Vec<AiTokenEvent>>,
    tool_requests: StdMutex<Vec<AiToolRequestEvent>>,
    tool_starteds: StdMutex<Vec<AiToolStartedEvent>>,
    tool_finisheds: StdMutex<Vec<AiToolFinishedEvent>>,
    dones: StdMutex<Vec<AiDoneEvent>>,
    errors: StdMutex<Vec<AiErrorEvent>>,
    notifications: StdMutex<Vec<aitm_lib::notifications::NotificationEvent>>,
}

impl EventSink for MockSink {
    fn emit_token(&self, e: &AiTokenEvent) {
        self.tokens.lock().unwrap().push(e.clone());
    }
    fn emit_tool_request(&self, e: &AiToolRequestEvent) {
        self.tool_requests.lock().unwrap().push(e.clone());
    }
    fn emit_tool_started(&self, e: &AiToolStartedEvent) {
        self.tool_starteds.lock().unwrap().push(e.clone());
    }
    fn emit_tool_finished(&self, e: &AiToolFinishedEvent) {
        self.tool_finisheds.lock().unwrap().push(e.clone());
    }
    fn emit_done(&self, e: &AiDoneEvent) {
        self.dones.lock().unwrap().push(e.clone());
    }
    fn emit_error(&self, e: &AiErrorEvent) {
        self.errors.lock().unwrap().push(e.clone());
    }
    fn emit_notification(&self, e: &aitm_lib::notifications::NotificationEvent) {
        self.notifications.lock().unwrap().push(e.clone());
    }
}

/// FakeProvider：每次 `stream_chat` 从队列里 pop 出一组 chunks。
struct FakeProvider {
    rounds: StdMutex<Vec<Vec<ChatChunk>>>,
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
            let mut r = self.rounds.lock().unwrap();
            if r.is_empty() {
                vec![ChatChunk::Done {
                    stop_reason: StopReason::EndTurn,
                }]
            } else {
                r.remove(0)
            }
        };
        Ok(Box::pin(futures::stream::iter(chunks)))
    }
}

fn make_ctx(cwd: std::path::PathBuf) -> ToolContext {
    ToolContext {
        session_state: Arc::new(SessionState::new()),
        cwd,
        active_session_id: None,
        whitelist: Arc::new(aitm_lib::safety::whitelist::CompiledWhitelist::empty()),
        browser_state: Arc::new(aitm_lib::ipc::browser::BrowserState::default()),
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

// ============================================================
// 测试 1：read_file 端到端打通真实文件系统
// ============================================================
#[tokio::test]
async fn read_file_端到端_真实文件() {
    let dir = TempDir::new().unwrap();
    std::fs::write(dir.path().join("README.md"), "# aitm\n这是真实文件").unwrap();

    let provider = Arc::new(FakeProvider {
        rounds: StdMutex::new(vec![
            // 第一轮：调 read_file
            vec![
                ChatChunk::ToolUseStart {
                    call_id: "c1".into(),
                    name: "read_file".into(),
                },
                ChatChunk::ToolUseArgsDelta {
                    call_id: "c1".into(),
                    json_partial: r#"{"path":"README.md"}"#.into(),
                },
                ChatChunk::ToolUseEnd {
                    call_id: "c1".into(),
                },
                ChatChunk::Done {
                    stop_reason: StopReason::ToolUse,
                },
            ],
            // 第二轮：纯文本结束
            vec![
                ChatChunk::TextDelta {
                    text: "已读取".into(),
                },
                ChatChunk::Done {
                    stop_reason: StopReason::EndTurn,
                },
            ],
        ]),
    });
    let tools = Arc::new(ToolRegistry::with_defaults());
    let ctx = make_ctx(dir.path().to_path_buf());
    let sink: Arc<MockSink> = Arc::new(MockSink::default());
    let handle = Arc::new(ToolLoopHandle::new());

    run_tool_loop(
        base_request(),
        provider,
        tools,
        ctx,
        sink.clone(),
        "cid".into(),
        handle,
        None,
    )
    .await;

    // Low 风险：不应 emit tool_request；应有 started + finished
    assert!(sink.tool_requests.lock().unwrap().is_empty());
    assert_eq!(sink.tool_starteds.lock().unwrap().len(), 1);

    let finisheds = sink.tool_finisheds.lock().unwrap();
    assert_eq!(finisheds.len(), 1);
    assert!(
        !finisheds[0].is_error,
        "read_file 应成功：{}",
        finisheds[0].content
    );
    assert!(
        finisheds[0].content.contains("aitm"),
        "工具回执应含文件内容：{}",
        finisheds[0].content
    );
    assert!(finisheds[0].content.contains("真实文件"));

    // done 一次
    assert_eq!(sink.dones.lock().unwrap().len(), 1);
    assert!(sink.errors.lock().unwrap().is_empty());
}

// ============================================================
// 测试 2：list_files 端到端跳过 node_modules
// ============================================================
#[tokio::test]
async fn list_files_端到端_跳过_node_modules() {
    let dir = TempDir::new().unwrap();
    std::fs::write(dir.path().join("alpha.txt"), "").unwrap();
    std::fs::write(dir.path().join("beta.md"), "").unwrap();
    std::fs::create_dir(dir.path().join("node_modules")).unwrap();
    std::fs::write(dir.path().join("node_modules").join("hidden.js"), "").unwrap();

    let provider = Arc::new(FakeProvider {
        rounds: StdMutex::new(vec![
            vec![
                ChatChunk::ToolUseStart {
                    call_id: "c1".into(),
                    name: "list_files".into(),
                },
                ChatChunk::ToolUseArgsDelta {
                    call_id: "c1".into(),
                    json_partial: r#"{"dir":"."}"#.into(),
                },
                ChatChunk::ToolUseEnd {
                    call_id: "c1".into(),
                },
                ChatChunk::Done {
                    stop_reason: StopReason::ToolUse,
                },
            ],
            vec![ChatChunk::Done {
                stop_reason: StopReason::EndTurn,
            }],
        ]),
    });
    let tools = Arc::new(ToolRegistry::with_defaults());
    let sink: Arc<MockSink> = Arc::new(MockSink::default());
    let handle = Arc::new(ToolLoopHandle::new());
    let ctx = make_ctx(dir.path().to_path_buf());

    run_tool_loop(
        base_request(),
        provider,
        tools,
        ctx,
        sink.clone(),
        "cid".into(),
        handle,
        None,
    )
    .await;

    let finisheds = sink.tool_finisheds.lock().unwrap();
    assert_eq!(finisheds.len(), 1);
    assert!(!finisheds[0].is_error);
    let content = &finisheds[0].content;
    assert!(content.contains("alpha.txt"), "应列出 alpha.txt：{content}");
    assert!(content.contains("beta.md"), "应列出 beta.md：{content}");
    assert!(
        !content.contains("hidden.js"),
        "node_modules 内文件不应出现：{content}"
    );
    // node_modules 目录本身也应被忽略（不出现在列表）
    assert!(
        !content.contains("node_modules"),
        "node_modules 目录应被忽略：{content}"
    );
}

// ============================================================
// 测试 3：run_command 黑名单（真实 ToolRegistry，确认 L1 走通）
// ============================================================
#[tokio::test]
async fn run_command_黑名单_拦截_rm_rf_root() {
    let dir = TempDir::new().unwrap();

    let provider = Arc::new(FakeProvider {
        rounds: StdMutex::new(vec![
            vec![
                ChatChunk::ToolUseStart {
                    call_id: "c1".into(),
                    name: "run_command".into(),
                },
                ChatChunk::ToolUseArgsDelta {
                    call_id: "c1".into(),
                    json_partial: r#"{"session_id":"00000000-0000-0000-0000-000000000000","cmd":"rm -rf /"}"#
                        .into(),
                },
                ChatChunk::ToolUseEnd {
                    call_id: "c1".into(),
                },
                ChatChunk::Done {
                    stop_reason: StopReason::ToolUse,
                },
            ],
            // 模型看到 tool_result（L1 拦截）后总结收尾
            vec![
                ChatChunk::TextDelta {
                    text: "abort".into(),
                },
                ChatChunk::Done {
                    stop_reason: StopReason::EndTurn,
                },
            ],
        ]),
    });
    let tools = Arc::new(ToolRegistry::with_defaults());
    let sink: Arc<MockSink> = Arc::new(MockSink::default());
    let handle = Arc::new(ToolLoopHandle::new());
    let ctx = make_ctx(dir.path().to_path_buf());

    run_tool_loop(
        base_request(),
        provider,
        tools,
        ctx,
        sink.clone(),
        "cid".into(),
        handle,
        None,
    )
    .await;

    // L1 黑名单走的是 finished 直接 emit，不经 ask_user
    assert!(
        sink.tool_requests.lock().unwrap().is_empty(),
        "L1 黑名单不应触发 tool_request"
    );
    // 也不应执行（没 emit tool_started）
    assert!(
        sink.tool_starteds.lock().unwrap().is_empty(),
        "L1 黑名单不应执行工具"
    );

    let finisheds = sink.tool_finisheds.lock().unwrap();
    assert_eq!(finisheds.len(), 1);
    assert!(finisheds[0].is_error);
    assert!(
        finisheds[0].content.contains("L1 黑名单"),
        "拦截原因应说明：{}",
        finisheds[0].content
    );

    // 模型总结后正常 done
    assert_eq!(sink.dones.lock().unwrap().len(), 1);
}
