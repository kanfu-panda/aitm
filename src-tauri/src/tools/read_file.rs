//! read_file 工具：读文件内容（受 cwd 沙盒约束）。

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{Value, json};

use super::{RiskClass, Tool, ToolContext, ToolError, ToolResult};

const MAX_BYTES: usize = 1_000_000; // 1 MB
const TRUNCATED_NOTE: &str = "\n\n[文件过大已截断到前 1MB]";

pub struct ReadFileTool;

#[derive(Deserialize)]
struct Args {
    path: String,
}

#[async_trait]
impl Tool for ReadFileTool {
    fn name(&self) -> &str {
        "read_file"
    }

    fn description(&self) -> &str {
        "读取文本文件内容。仅限工作目录内的文件。"
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "文件路径。相对路径基于工作目录。"
                }
            },
            "required": ["path"]
        })
    }

    fn risk_class(&self, _args: &Value) -> RiskClass {
        RiskClass::Low
    }

    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<ToolResult, ToolError> {
        let parsed: Args = serde_json::from_value(args)
            .map_err(|e| ToolError::InvalidArgs(format!("read_file 参数: {e}")))?;

        let resolved = resolve_path(&parsed.path, &ctx.cwd);
        let canonical_cwd = ctx
            .cwd
            .canonicalize()
            .map_err(|e| ToolError::Exec(format!("cwd 不存在: {e}")))?;
        let canonical_target = resolved
            .canonicalize()
            .map_err(|e| ToolError::Exec(format!("文件不存在: {e}")))?;

        // 沙盒检查：解析后的目标必须在 cwd 内
        if !canonical_target.starts_with(&canonical_cwd) {
            return Err(ToolError::Blocked {
                reason: format!("路径越界沙盒（不在 {} 内）", canonical_cwd.display()),
            });
        }

        let bytes = tokio::fs::read(&canonical_target)
            .await
            .map_err(|e| ToolError::Exec(format!("读文件失败: {e}")))?;

        let (content, truncated) = if bytes.len() > MAX_BYTES {
            (
                String::from_utf8_lossy(&bytes[..MAX_BYTES]).into_owned(),
                true,
            )
        } else {
            (String::from_utf8_lossy(&bytes).into_owned(), false)
        };

        let final_content = if truncated {
            format!("{content}{TRUNCATED_NOTE}")
        } else {
            content
        };

        Ok(ToolResult {
            content: final_content,
            is_error: false,
        })
    }
}

fn resolve_path(p: &str, cwd: &std::path::Path) -> std::path::PathBuf {
    let path = std::path::Path::new(p);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tempfile::TempDir;

    fn make_ctx(cwd: std::path::PathBuf) -> ToolContext {
        let session_state = Arc::new(crate::ipc::session::SessionState::new());
        ToolContext {
            session_state,
            cwd,
            active_session_id: None,
            whitelist: Arc::new(crate::safety::whitelist::CompiledWhitelist::empty()),
            browser_state: Arc::new(crate::ipc::browser::BrowserState::default()),
        }
    }

    #[tokio::test]
    async fn happy_path_读文件() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("a.txt"), "hello world").unwrap();
        let ctx = make_ctx(dir.path().to_path_buf());
        let r = ReadFileTool
            .execute(json!({ "path": "a.txt" }), &ctx)
            .await
            .unwrap();
        assert_eq!(r.content, "hello world");
        assert!(!r.is_error);
    }

    #[tokio::test]
    async fn 沙盒越界_blocked() {
        let dir = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "should not read").unwrap();
        let ctx = make_ctx(dir.path().to_path_buf());

        let abs_outside = outside.path().join("secret.txt");
        let r = ReadFileTool
            .execute(json!({ "path": abs_outside.to_string_lossy() }), &ctx)
            .await;
        assert!(matches!(r, Err(ToolError::Blocked { .. })));
    }

    #[tokio::test]
    async fn 不存在的文件_exec_错() {
        let dir = TempDir::new().unwrap();
        let ctx = make_ctx(dir.path().to_path_buf());
        let r = ReadFileTool
            .execute(json!({ "path": "nope.txt" }), &ctx)
            .await;
        assert!(matches!(r, Err(ToolError::Exec(_))));
    }

    #[tokio::test]
    async fn 大文件_截断到_1mb() {
        let dir = TempDir::new().unwrap();
        let big = vec![b'A'; MAX_BYTES + 100];
        std::fs::write(dir.path().join("big.txt"), &big).unwrap();
        let ctx = make_ctx(dir.path().to_path_buf());

        let r = ReadFileTool
            .execute(json!({ "path": "big.txt" }), &ctx)
            .await
            .unwrap();
        assert!(r.content.contains("已截断"), "应有截断提示");
        // 内容长度大约 1MB + TRUNCATED_NOTE
        assert!(r.content.len() <= MAX_BYTES + TRUNCATED_NOTE.len() + 10);
    }

    #[tokio::test]
    async fn 缺_path_参数_invalid() {
        let dir = TempDir::new().unwrap();
        let ctx = make_ctx(dir.path().to_path_buf());
        let r = ReadFileTool.execute(json!({}), &ctx).await;
        assert!(matches!(r, Err(ToolError::InvalidArgs(_))));
    }
}
