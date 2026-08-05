//! edit_file 工具：对已有文件做精确字符串替换（受 cwd 沙盒约束，High 风险）。
//!
//! 语义同 Claude Code 的 Edit 工具：`old_string` 必须在文件中**唯一**匹配
//! （除非 `replace_all=true`），否则返回 `is_error=true` 的 ToolResult 让
//! LLM 看到错误自行扩大上下文重试——不是 Err（Err 是工具本身执行失败，
//! 这里是「LLM 给的匹配条件有歧义/不存在」，应该让模型有机会纠正）。

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

use super::{RiskClass, Tool, ToolContext, ToolError, ToolPreview, ToolResult};

pub struct EditFileTool;

#[derive(Deserialize)]
struct Args {
    path: String,
    old_string: String,
    new_string: String,
    #[serde(default)]
    replace_all: Option<bool>,
}

#[async_trait]
impl Tool for EditFileTool {
    fn name(&self) -> &str {
        "edit_file"
    }

    fn description(&self) -> &str {
        "对已有文件做精确字符串替换。old_string 必须在文件中唯一匹配（除非传 replace_all=true）。仅限工作目录内。"
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "文件路径。相对路径基于工作目录。文件必须已存在。"
                },
                "old_string": {
                    "type": "string",
                    "description": "要被替换的原文本。必须在文件中唯一出现，否则请扩大上下文或传 replace_all。"
                },
                "new_string": {
                    "type": "string",
                    "description": "替换后的文本。"
                },
                "replace_all": {
                    "type": "boolean",
                    "description": "为 true 时替换文件中所有匹配；默认 false，要求唯一匹配。"
                }
            },
            "required": ["path", "old_string", "new_string"]
        })
    }

    fn risk_class(&self, _args: &Value) -> RiskClass {
        RiskClass::High
    }

    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<ToolResult, ToolError> {
        let parsed: Args = serde_json::from_value(args)
            .map_err(|e| ToolError::InvalidArgs(format!("edit_file 参数: {e}")))?;

        let target = resolve_sandboxed_existing(&parsed.path, &ctx.cwd)?;

        let original = tokio::fs::read_to_string(&target)
            .await
            .map_err(|e| ToolError::Exec(format!("读文件失败: {e}")))?;

        let replace_all = parsed.replace_all.unwrap_or(false);
        let count = original.matches(parsed.old_string.as_str()).count();

        if count == 0 {
            return Ok(ToolResult {
                content: "未找到匹配：old_string 未在文件中出现".into(),
                is_error: true,
            });
        }
        if count > 1 && !replace_all {
            return Ok(ToolResult {
                content: format!(
                    "old_string 不唯一（出现 {count} 次），请扩大上下文或传 replace_all=true"
                ),
                is_error: true,
            });
        }

        let updated = if replace_all {
            original.replace(&parsed.old_string, &parsed.new_string)
        } else {
            original.replacen(&parsed.old_string, &parsed.new_string, 1)
        };

        tokio::fs::write(&target, &updated)
            .await
            .map_err(|e| ToolError::Exec(format!("写文件失败: {e}")))?;

        Ok(ToolResult {
            content: format!("已在 {} 替换 {count} 处", target.display()),
            is_error: false,
        })
    }

    async fn preview(&self, args: &Value, ctx: &ToolContext) -> Option<ToolPreview> {
        let parsed: Args = serde_json::from_value(args.clone()).ok()?;
        let target = resolve_sandboxed_existing(&parsed.path, &ctx.cwd).ok()?;
        let original = tokio::fs::read_to_string(&target).await.ok()?;

        let replace_all = parsed.replace_all.unwrap_or(false);
        let updated = if replace_all {
            original.replace(&parsed.old_string, &parsed.new_string)
        } else {
            original.replacen(&parsed.old_string, &parsed.new_string, 1)
        };

        Some(ToolPreview {
            kind: "diff".into(),
            path: parsed.path,
            old_text: original,
            new_text: updated,
        })
    }
}

/// 沙盒校验：目标文件必须已存在（edit 语义上就是改已有文件），
/// 同 read_file 的 canonicalize + starts_with 范式。只读，无副作用。
fn resolve_sandboxed_existing(raw_path: &str, cwd: &Path) -> Result<PathBuf, ToolError> {
    let resolved = resolve_path(raw_path, cwd);
    let canonical_cwd = cwd
        .canonicalize()
        .map_err(|e| ToolError::Exec(format!("cwd 不存在: {e}")))?;
    let canonical_target = resolved
        .canonicalize()
        .map_err(|e| ToolError::Exec(format!("文件不存在: {e}")))?;

    if !canonical_target.starts_with(&canonical_cwd) {
        return Err(ToolError::Blocked {
            reason: format!("路径越界沙盒（不在 {} 内）", canonical_cwd.display()),
        });
    }
    Ok(canonical_target)
}

fn resolve_path(p: &str, cwd: &Path) -> PathBuf {
    let path = Path::new(p);
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
    async fn 唯一匹配_替换成功() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("a.txt"), "hello world").unwrap();
        let ctx = make_ctx(dir.path().to_path_buf());

        let r = EditFileTool
            .execute(
                json!({ "path": "a.txt", "old_string": "world", "new_string": "rust" }),
                &ctx,
            )
            .await
            .unwrap();
        assert!(!r.is_error);
        assert!(r.content.contains("1 处"));
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.txt")).unwrap(),
            "hello rust"
        );
    }

    #[tokio::test]
    async fn old_string_不唯一_is_error() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("a.txt"), "foo foo foo").unwrap();
        let ctx = make_ctx(dir.path().to_path_buf());

        let r = EditFileTool
            .execute(
                json!({ "path": "a.txt", "old_string": "foo", "new_string": "bar" }),
                &ctx,
            )
            .await
            .unwrap();
        assert!(r.is_error);
        assert!(r.content.contains("不唯一"));
        // 未替换，文件应保持原样
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.txt")).unwrap(),
            "foo foo foo"
        );
    }

    #[tokio::test]
    async fn old_string_找不到_is_error() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("a.txt"), "hello world").unwrap();
        let ctx = make_ctx(dir.path().to_path_buf());

        let r = EditFileTool
            .execute(
                json!({ "path": "a.txt", "old_string": "nope", "new_string": "x" }),
                &ctx,
            )
            .await
            .unwrap();
        assert!(r.is_error);
        assert!(r.content.contains("未找到匹配"));
    }

    #[tokio::test]
    async fn replace_all_替换多处() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("a.txt"), "foo foo foo").unwrap();
        let ctx = make_ctx(dir.path().to_path_buf());

        let r = EditFileTool
            .execute(
                json!({
                    "path": "a.txt",
                    "old_string": "foo",
                    "new_string": "bar",
                    "replace_all": true
                }),
                &ctx,
            )
            .await
            .unwrap();
        assert!(!r.is_error);
        assert!(r.content.contains("3 处"));
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.txt")).unwrap(),
            "bar bar bar"
        );
    }

    #[tokio::test]
    async fn 沙盒越界_blocked() {
        let dir = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "top secret").unwrap();
        let ctx = make_ctx(dir.path().to_path_buf());

        let abs_outside = outside.path().join("secret.txt");
        let r = EditFileTool
            .execute(
                json!({
                    "path": abs_outside.to_string_lossy(),
                    "old_string": "top",
                    "new_string": "leaked"
                }),
                &ctx,
            )
            .await;
        assert!(matches!(r, Err(ToolError::Blocked { .. })));
        // 未被改动
        assert_eq!(
            std::fs::read_to_string(&abs_outside).unwrap(),
            "top secret"
        );
    }

    #[tokio::test]
    async fn preview_无副作用_文件不变() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("a.txt"), "hello world").unwrap();
        let ctx = make_ctx(dir.path().to_path_buf());

        let preview = EditFileTool
            .preview(
                &json!({ "path": "a.txt", "old_string": "world", "new_string": "rust" }),
                &ctx,
            )
            .await
            .expect("应返回 diff 预览");
        assert_eq!(preview.kind, "diff");
        assert_eq!(preview.old_text, "hello world");
        assert_eq!(preview.new_text, "hello rust");

        // 关键断言：preview 调用后文件内容未变
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.txt")).unwrap(),
            "hello world"
        );
    }
}
