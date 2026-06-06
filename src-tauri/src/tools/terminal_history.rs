//! get_terminal_history + search_history 工具：从 PTY ring buffer 读历史。
//!
//! ring buffer 的写入路径在 [`crate::session::pty_session::Session::spawn`] 里，
//! 每次 PTY read 拿到 chunk 都会同步 push 一份到 buffer。本模块只负责 *读*。

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};

use super::ansi::strip_for_llm;
use super::{RiskClass, Tool, ToolContext, ToolError, ToolResult};

/// get_terminal_history 单次能拉的最大行数（防 LLM 灌爆上下文）。
const MAX_LINES: u32 = 500;
/// search_history 单次最多返回的命中条数。
const MAX_RESULTS: u32 = 50;

// ========== get_terminal_history ==========

pub struct GetTerminalHistoryTool;

#[derive(Deserialize)]
struct GetArgs {
    /// 留空 / "current" / "default" / "" 时回退到 ctx.active_session_id
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default = "default_lines")]
    lines: u32,
}

/// 与 run_command 共享的 session_id 兜底逻辑。
fn resolve_session_id(arg: Option<&str>, ctx: &ToolContext) -> Result<String, ToolError> {
    let trimmed = arg.unwrap_or("").trim();
    let needs_fallback = matches!(trimmed, "" | "current" | "default" | "active" | "main");
    if needs_fallback {
        return ctx
            .active_session_id
            .clone()
            .ok_or_else(|| ToolError::SessionNotFound(
                "无活跃 tab —— 用户需要先打开一个终端 tab".into(),
            ));
    }
    Ok(trimmed.to_string())
}

fn default_lines() -> u32 {
    50
}

#[async_trait]
impl Tool for GetTerminalHistoryTool {
    fn name(&self) -> &str {
        "get_terminal_history"
    }

    fn description(&self) -> &str {
        "获取指定终端 tab 最近 N 行输出（包括命令和回显）。"
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "session_id": {
                    "type": "string",
                    "description": "终端 tab 的 session UUID。**绝大多数情况留空**，系统会自动用当前活跃 tab。"
                },
                "lines": {
                    "type": "integer",
                    "default": 50,
                    "maximum": 500
                }
            },
            "required": []
        })
    }

    fn risk_class(&self, _args: &Value) -> RiskClass {
        RiskClass::Low
    }

    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<ToolResult, ToolError> {
        let parsed: GetArgs = serde_json::from_value(args)
            .map_err(|e| ToolError::InvalidArgs(format!("get_terminal_history: {e}")))?;
        let lines = parsed.lines.min(MAX_LINES) as usize;
        let session_id = resolve_session_id(parsed.session_id.as_deref(), ctx)?;

        match ctx.session_state.recent_output(&session_id, lines).await {
            Some(content) => {
                let stripped = strip_for_llm(&content);
                // v0.5.0-B：prepend Tab 元信息（分支 / cwd / 监听端口）作为 AI 隐式上下文。
                // metadata 全空时不 prepend（节省 token + 不暗示有信息）。
                let prefix = prepend_metadata(ctx, &session_id);
                let body = if prefix.is_empty() {
                    stripped
                } else {
                    format!("{prefix}\n\n=== 终端历史 ===\n{stripped}")
                };
                Ok(ToolResult {
                    content: body,
                    is_error: false,
                })
            }
            None => Err(ToolError::SessionNotFound(session_id)),
        }
    }
}

/// v0.5.0-B helper：从 SessionMetadataCache 查 session 元信息，转成中文摘要前缀。
/// metadata 全空时返空字符串（caller 判空决定是否 prepend）。
fn prepend_metadata(ctx: &ToolContext, session_id: &str) -> String {
    let Ok(uuid) = uuid::Uuid::parse_str(session_id) else {
        return String::new();
    };
    let sid = crate::session::SessionId(uuid);
    let Some(meta) = ctx.session_state.metadata.try_get(sid) else {
        return String::new();
    };
    let summary = meta.to_ai_summary();
    if summary.is_empty() {
        String::new()
    } else {
        format!("=== 当前 tab 元信息 ===\n{summary}")
    }
}

// ========== search_history ==========

pub struct SearchHistoryTool;

#[derive(Deserialize)]
struct SearchArgs {
    query: String,
    #[serde(default = "default_max_results")]
    max_results: u32,
}

fn default_max_results() -> u32 {
    10
}

#[async_trait]
impl Tool for SearchHistoryTool {
    fn name(&self) -> &str {
        "search_history"
    }

    fn description(&self) -> &str {
        "在所有终端 tab 的输出中搜索包含关键字的行。"
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "query": { "type": "string" },
                "max_results": {
                    "type": "integer",
                    "default": 10
                }
            },
            "required": ["query"]
        })
    }

    fn risk_class(&self, _args: &Value) -> RiskClass {
        RiskClass::Low
    }

    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<ToolResult, ToolError> {
        let parsed: SearchArgs = serde_json::from_value(args)
            .map_err(|e| ToolError::InvalidArgs(format!("search_history: {e}")))?;
        let max = parsed.max_results.min(MAX_RESULTS) as usize;

        let hits = ctx.session_state.search_recent(&parsed.query, max).await;
        if hits.is_empty() {
            return Ok(ToolResult {
                content: format!("未找到包含 '{}' 的输出", parsed.query),
                is_error: false,
            });
        }
        let content = hits
            .into_iter()
            .map(|(sid, line)| {
                let prefix_len = 8.min(sid.len());
                format!("[{}] {}", &sid[..prefix_len], strip_for_llm(&line).trim())
            })
            .collect::<Vec<_>>()
            .join("\n");
        Ok(ToolResult {
            content,
            is_error: false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn make_ctx() -> ToolContext {
        let session_state = Arc::new(crate::ipc::session::SessionState::new());
        ToolContext {
            session_state,
            cwd: std::env::temp_dir(),
            active_session_id: None,
            whitelist: Arc::new(crate::safety::whitelist::CompiledWhitelist::empty()),
            browser_state: Arc::new(crate::ipc::browser::BrowserState::default()),
        }
    }

    #[tokio::test]
    async fn 不存在的_session_id_返回_session_not_found() {
        let ctx = make_ctx();
        // 合法 UUID 但 manager 里没注册
        let r = GetTerminalHistoryTool
            .execute(
                json!({
                    "session_id": "00000000-0000-0000-0000-000000000000",
                    "lines": 10
                }),
                &ctx,
            )
            .await;
        assert!(matches!(r, Err(ToolError::SessionNotFound(_))));
    }

    #[tokio::test]
    async fn 非法_session_id_也返回_session_not_found() {
        let ctx = make_ctx();
        let r = GetTerminalHistoryTool
            .execute(json!({ "session_id": "not-a-uuid", "lines": 10 }), &ctx)
            .await;
        assert!(matches!(r, Err(ToolError::SessionNotFound(_))));
    }

    /// session_id 改为 optional 后，缺时回退到 active；ctx 也无 active → SessionNotFound。
    #[tokio::test]
    async fn get_terminal_history_缺_session_id_无_active_则_session_not_found() {
        let ctx = make_ctx();  // active_session_id = None
        let r = GetTerminalHistoryTool
            .execute(json!({ "lines": 10 }), &ctx)
            .await;
        assert!(
            matches!(r, Err(ToolError::SessionNotFound(_))),
            "无 active 时应返回 SessionNotFound 而非 InvalidArgs"
        );
    }

    // v0.5.0-B：prepend_metadata 单测
    #[tokio::test]
    async fn prepend_metadata_无_cache_条目_返空() {
        let ctx = make_ctx();
        let s = prepend_metadata(&ctx, "00000000-0000-0000-0000-000000000000");
        assert_eq!(s, "");
    }

    #[tokio::test]
    async fn prepend_metadata_有_cache_含_branch_返摘要() {
        let ctx = make_ctx();
        let id = crate::session::SessionId::new();
        ctx.session_state
            .metadata
            .set(
                id,
                crate::session::metadata::TabMetadata {
                    git_branch: Some("main".into()),
                    git_dirty: true,
                    git_unpushed_count: Some(2),
                    cwd: Some("/p".into()),
                    listening_ports: vec![3000],
                },
            )
            .await;
        let s = prepend_metadata(&ctx, &id.0.to_string());
        assert!(s.contains("=== 当前 tab 元信息 ==="));
        assert!(s.contains("分支: main"));
        assert!(s.contains("dirty"));
        assert!(s.contains("2 commits 未推送"));
        assert!(s.contains("3000"));
    }

    #[tokio::test]
    async fn prepend_metadata_全空_cache_返空() {
        let ctx = make_ctx();
        let id = crate::session::SessionId::new();
        ctx.session_state
            .metadata
            .set(id, crate::session::metadata::TabMetadata::default())
            .await;
        let s = prepend_metadata(&ctx, &id.0.to_string());
        assert_eq!(s, "");
    }

    #[tokio::test]
    async fn prepend_metadata_非法_uuid_返空() {
        let ctx = make_ctx();
        let s = prepend_metadata(&ctx, "not-a-uuid");
        assert_eq!(s, "");
    }

    #[tokio::test]
    async fn get_terminal_history_lines_默认值生效() {
        // 仅校验 schema 参数解析；不实际跑 PTY
        let ctx = make_ctx();
        let r = GetTerminalHistoryTool
            .execute(
                json!({ "session_id": "00000000-0000-0000-0000-000000000000" }),
                &ctx,
            )
            .await;
        // session 不存在但参数合法 → SessionNotFound（说明默认 lines 没炸）
        assert!(matches!(r, Err(ToolError::SessionNotFound(_))));
    }

    #[tokio::test]
    async fn search_空结果_不报错() {
        let ctx = make_ctx();
        let r = SearchHistoryTool
            .execute(json!({ "query": "doesnotexist" }), &ctx)
            .await
            .unwrap();
        assert!(!r.is_error);
        assert!(r.content.contains("未找到"));
    }

    #[tokio::test]
    async fn search_history_缺_query_invalid_args() {
        let ctx = make_ctx();
        let r = SearchHistoryTool.execute(json!({}), &ctx).await;
        assert!(matches!(r, Err(ToolError::InvalidArgs(_))));
    }

    #[tokio::test]
    async fn search_history_max_results_可选() {
        // 只验证默认值不炸（结果是空的）
        let ctx = make_ctx();
        let r = SearchHistoryTool
            .execute(json!({ "query": "xyz" }), &ctx)
            .await
            .unwrap();
        assert!(!r.is_error);
    }

    /// get_terminal_history 的 session_id 改为 optional 后 required 应为空，
    /// search_history 仍然 require query。
    #[test]
    fn schema_required_符合新行为() {
        let s = GetTerminalHistoryTool.input_schema();
        let req = s["required"].as_array().unwrap();
        assert!(
            !req.iter().any(|v| v == "session_id"),
            "session_id 不应再 required，需要让 LLM 留空走 active 兜底"
        );

        let s2 = SearchHistoryTool.input_schema();
        assert_eq!(s2["required"][0], "query");
    }

    #[test]
    fn 风险等级都是_low() {
        let v = json!({});
        assert_eq!(GetTerminalHistoryTool.risk_class(&v), RiskClass::Low);
        assert_eq!(SearchHistoryTool.risk_class(&v), RiskClass::Low);
    }

    // 真实 ring buffer 写入 + 读取的端到端测试需要起 PTY，
    // session/pty_session.rs::e2e_tests 已覆盖；这里只测 trait 层的参数解析 + 错误路径。
}
