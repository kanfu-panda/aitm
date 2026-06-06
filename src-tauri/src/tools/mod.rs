//! AI 工具抽象层。
//!
//! 每个工具实现 [`Tool`] trait，向 LLM 暴露 name + description + input_schema，
//! 由 orchestrator 在 LLM 返回 tool_use 时调度执行。
//!
//! 1E-1 只接 L1（黑名单）+ L4（用户确认）安全门；L2 风险评分启发式 + L3 白名单
//! 由 1E-2 引入。

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

pub mod ansi;
pub mod browser;
pub mod list_files;
pub mod read_file;
pub mod registry;
pub mod run_command;
pub mod terminal_history;

/// 风险等级。1E-1 只静态分级（read_file → Low、run_command → High）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RiskClass {
    Low,
    High,
    Destructive,
}

/// 工具执行结果。
#[derive(Debug, Clone, Serialize)]
pub struct ToolResult {
    /// 给 LLM 看的内容（成功输出 / 错误描述）。
    pub content: String,
    /// 是否是错误（影响 LLM 下一步决策）。
    pub is_error: bool,
}

/// 工具执行错误。
#[derive(Debug, Error)]
pub enum ToolError {
    #[error("参数无效: {0}")]
    InvalidArgs(String),
    #[error("拒绝执行：{reason}")]
    Blocked { reason: String },
    #[error("执行失败: {0}")]
    Exec(String),
    #[error("会话不存在: {0}")]
    SessionNotFound(String),
}

impl From<ToolError> for ToolResult {
    /// 把 ToolError 翻成 is_error=true 的 ToolResult，统一喂给 LLM。
    fn from(e: ToolError) -> Self {
        Self {
            content: e.to_string(),
            is_error: true,
        }
    }
}

/// 工具执行上下文。
pub struct ToolContext {
    /// PTY session 状态（run_command / terminal_history 用）。
    pub session_state: Arc<crate::ipc::session::SessionState>,
    /// 文件操作沙盒根（read_file / list_files 不允许越界）。
    pub cwd: PathBuf,
    /// 当前活跃的终端 tab session id；LLM 没传 session_id 或传了
    /// "current" / "default" / 空 / 不存在 ID 时用此兜底。
    pub active_session_id: Option<String>,
    /// L3 白名单（编译后的 GlobSet）。orchestrator 在 run_command 命中
    /// 时把 HIGH 降为 LOW（自动批准），但**不能覆盖 DESTRUCTIVE**。
    /// 测试用 `CompiledWhitelist::empty()` 兜底即可。
    pub whitelist: Arc<crate::safety::whitelist::CompiledWhitelist>,
    /// v0.5.0-E：浏览器 state（browser_snapshot / click / fill / eval 工具用）。
    /// 给单测用 `Arc::new(BrowserState::default())` 兜底。
    pub browser_state: Arc<crate::ipc::browser::BrowserState>,
}

/// 工具抽象。
#[async_trait]
pub trait Tool: Send + Sync {
    /// LLM 看到的工具名（snake_case，如 "read_file"）。
    fn name(&self) -> &str;

    /// 一行短句描述。LLM 据此判断何时调。
    fn description(&self) -> &str;

    /// 参数 JSON Schema。OpenAI / Anthropic 都吃这个子集。
    fn input_schema(&self) -> Value;

    /// 执行前的风险分级。args 已通过 schema 校验。
    fn risk_class(&self, _args: &Value) -> RiskClass;

    /// 执行工具。返回的 ToolResult 会作为 ContentBlock::ToolResult 喂回 LLM。
    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<ToolResult, ToolError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_error_to_result_是_error() {
        let r: ToolResult = ToolError::InvalidArgs("缺 path".into()).into();
        assert!(r.is_error);
        assert!(r.content.contains("path"));
    }

    #[test]
    fn risk_class_serde_kebab_case() {
        assert_eq!(serde_json::to_string(&RiskClass::Low).unwrap(), "\"low\"");
        let r: RiskClass = serde_json::from_str("\"high\"").unwrap();
        assert_eq!(r, RiskClass::High);
        let r: RiskClass = serde_json::from_str("\"destructive\"").unwrap();
        assert_eq!(r, RiskClass::Destructive);
    }

    #[test]
    fn tool_result_serialize_含_is_error_字段() {
        let r = ToolResult { content: "ok".into(), is_error: false };
        let j = serde_json::to_value(&r).unwrap();
        assert_eq!(j["is_error"], false);
        assert_eq!(j["content"], "ok");
    }

    #[test]
    fn blocked_error_含_reason() {
        let e = ToolError::Blocked { reason: "越界".into() };
        let r: ToolResult = e.into();
        assert!(r.content.contains("越界"));
    }
}
