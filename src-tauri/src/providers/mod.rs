//! LLM Provider 抽象层。
//!
//! 所有 provider 实现 [`LlmProvider`] trait 即可被 [`registry::ProviderRegistry`] 管理。
//! 通过 trait 而非具体类型，前端调用永远是统一接口，底层换 provider 不影响 UI。

use async_trait::async_trait;
use futures::stream::BoxStream;

pub mod types;
pub mod sse;
pub mod anthropic;
pub mod openai_compat;
pub mod presets;
pub mod env;
pub mod registry;

pub use types::*;

/// 单个模型的元数据（list 出来给 UI 显示）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ModelInfo {
    pub id: String,
    pub display_name: String,
    /// 上下文窗口 token 上限（仅参考，运行时用 ChatRequest.max_tokens）。
    pub context_window: u32,
}

/// LLM Provider 抽象。
///
/// 实现这个 trait 的类型可以注册到 ProviderRegistry。
#[async_trait]
pub trait LlmProvider: Send + Sync {
    /// 唯一标识（用作配置文件 id）。
    fn id(&self) -> &str;

    /// 给 UI 显示的友好名（"Claude" / "DeepSeek"）。
    fn display_name(&self) -> &str;

    /// 当前 provider 支持的模型列表。
    fn list_models(&self) -> Vec<ModelInfo>;

    /// 此 provider 的能力标志。
    fn capabilities(&self) -> Capabilities;

    /// 流式 chat。返回的 stream 在错误时会 emit `ChatChunk::Error` 然后结束。
    async fn stream_chat(
        &self,
        req: ChatRequest,
    ) -> Result<BoxStream<'static, ChatChunk>, ProviderError>;
}
