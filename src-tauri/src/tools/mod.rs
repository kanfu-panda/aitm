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
pub mod browser_open;
pub mod edit_file;
pub mod list_files;
pub mod list_skills;
pub mod load_skill;
pub mod read_file;
pub mod registry;
pub mod run_command;
pub mod terminal_history;
pub mod write_file;

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

/// 工具「将要做的改动」的结构化预览，随审批事件 / 完成事件发给前端，
/// 用于审批弹窗和历史气泡里渲染 diff。
///
/// 设计成可扩展：`kind` 未来可能有别的类型（如 "rename" / "delete"），
/// v1.2.0（T-B3a）只产出 `kind = "diff"`（write_file / edit_file 用）。
/// serde 字段保持 snake_case（前端直接吃 `old_text` / `new_text`）。
#[derive(Debug, Clone, Serialize)]
pub struct ToolPreview {
    /// 预览类型标签；当前恒为 "diff"。
    pub kind: String,
    /// 目标文件路径（展示用，通常是相对沙盒根的路径）。
    pub path: String,
    /// 改动前的文本（新建文件时为空串）。
    pub old_text: String,
    /// 改动后的文本。
    pub new_text: String,
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

    /// 计算「将要做的改动」的 diff 预览，供审批弹窗 + 历史气泡渲染。
    ///
    /// 默认返回 None（大多数工具没有可预览的改动）。write_file / edit_file（B1/B2）
    /// override 之，返回改动前后文本让前端渲染 diff。
    ///
    /// 约定：本方法应**无副作用**且尽量**不 panic**——orchestrator 在发审批事件前
    /// 调它，返回 None 时静默降级（不影响主循环）。
    async fn preview(&self, _args: &Value, _ctx: &ToolContext) -> Option<ToolPreview> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;

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

    // ============================================================
    // T-B3a：ToolPreview + Tool::preview 默认实现
    // ============================================================

    #[test]
    fn tool_preview_serialize_snake_case_字段() {
        // 前端要吃 old_text / new_text，字段名必须 snake_case
        let p = ToolPreview {
            kind: "diff".into(),
            path: "a.txt".into(),
            old_text: "旧".into(),
            new_text: "新".into(),
        };
        let j = serde_json::to_value(&p).unwrap();
        assert_eq!(j["kind"], "diff");
        assert_eq!(j["path"], "a.txt");
        assert_eq!(j["old_text"], "旧");
        assert_eq!(j["new_text"], "新");
    }

    /// 构造最小 ToolContext（preview 默认实现忽略 ctx，仅需能编译 + 跑通）。
    fn dummy_ctx() -> ToolContext {
        ToolContext {
            session_state: Arc::new(crate::ipc::session::SessionState::new()),
            cwd: PathBuf::from("/tmp"),
            active_session_id: None,
            whitelist: Arc::new(crate::safety::whitelist::CompiledWhitelist::empty()),
            browser_state: Arc::new(crate::ipc::browser::BrowserState::default()),
        }
    }

    /// 沿用 trait 默认 preview（返回 None）的工具。
    struct DefaultPreviewTool;
    #[async_trait]
    impl Tool for DefaultPreviewTool {
        fn name(&self) -> &str {
            "default_preview_tool"
        }
        fn description(&self) -> &str {
            "默认 preview"
        }
        fn input_schema(&self) -> Value {
            serde_json::json!({"type":"object"})
        }
        fn risk_class(&self, _args: &Value) -> RiskClass {
            RiskClass::Low
        }
        async fn execute(&self, _args: Value, _ctx: &ToolContext) -> Result<ToolResult, ToolError> {
            Ok(ToolResult {
                content: "ok".into(),
                is_error: false,
            })
        }
    }

    /// override preview 返回 Some(diff) 的工具。
    struct OverridePreviewTool;
    #[async_trait]
    impl Tool for OverridePreviewTool {
        fn name(&self) -> &str {
            "override_preview_tool"
        }
        fn description(&self) -> &str {
            "带 diff 预览"
        }
        fn input_schema(&self) -> Value {
            serde_json::json!({"type":"object"})
        }
        fn risk_class(&self, _args: &Value) -> RiskClass {
            RiskClass::High
        }
        async fn execute(&self, _args: Value, _ctx: &ToolContext) -> Result<ToolResult, ToolError> {
            Ok(ToolResult {
                content: "ok".into(),
                is_error: false,
            })
        }
        async fn preview(&self, _args: &Value, _ctx: &ToolContext) -> Option<ToolPreview> {
            Some(ToolPreview {
                kind: "diff".into(),
                path: "hello.txt".into(),
                old_text: String::new(),
                new_text: "world".into(),
            })
        }
    }

    #[tokio::test]
    async fn tool_default_preview_返回_none() {
        let ctx = dummy_ctx();
        let got = DefaultPreviewTool.preview(&serde_json::json!({}), &ctx).await;
        assert!(got.is_none(), "沿用默认实现的工具 preview 应返回 None");
    }

    #[tokio::test]
    async fn tool_override_preview_返回_some_diff() {
        let ctx = dummy_ctx();
        let got = OverridePreviewTool
            .preview(&serde_json::json!({}), &ctx)
            .await
            .expect("override 应返回 Some");
        assert_eq!(got.kind, "diff");
        assert_eq!(got.path, "hello.txt");
        assert_eq!(got.old_text, "");
        assert_eq!(got.new_text, "world");
    }
}
