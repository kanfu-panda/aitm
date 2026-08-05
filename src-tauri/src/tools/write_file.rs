//! write_file 工具：写入/新建文件（受 cwd 沙盒约束，High 风险）。
//!
//! 与 read_file 不同，目标文件在写入前**可能不存在**，无法直接
//! `canonicalize()`。沙盒校验分两步：
//! 1. 词法归一化（处理 `.` / `..`，不碰文件系统），先挡纯路径穿越攻击；
//! 2. 找「最近存在的祖先目录」并 canonicalize，挡符号链接逃逸——要求该
//!    祖先落在 canonicalize 后的 cwd 内。
//!
//! `preview()` 复用同一校验逻辑但**绝不创建目录/写文件**（审批前调用，
//! 无副作用是硬约束）；真正的 `create_dir_all` 只发生在 `execute()`。

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

use super::{RiskClass, Tool, ToolContext, ToolError, ToolPreview, ToolResult};

pub struct WriteFileTool;

#[derive(Deserialize)]
struct Args {
    path: String,
    content: String,
}

#[async_trait]
impl Tool for WriteFileTool {
    fn name(&self) -> &str {
        "write_file"
    }

    fn description(&self) -> &str {
        "写入文件内容（文件不存在则新建，存在则整体覆盖）。仅限工作目录内。"
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "文件路径。相对路径基于工作目录。"
                },
                "content": {
                    "type": "string",
                    "description": "要写入的完整文件内容（覆盖式写入，不是追加）。"
                }
            },
            "required": ["path", "content"]
        })
    }

    fn risk_class(&self, _args: &Value) -> RiskClass {
        RiskClass::High
    }

    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<ToolResult, ToolError> {
        let parsed: Args = serde_json::from_value(args)
            .map_err(|e| ToolError::InvalidArgs(format!("write_file 参数: {e}")))?;

        let canonical_cwd = ctx
            .cwd
            .canonicalize()
            .map_err(|e| ToolError::Exec(format!("cwd 不存在: {e}")))?;
        let target = sandboxed_target(&parsed.path, &canonical_cwd)?;

        if let Some(parent) = target.parent() {
            if !parent.exists() {
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(|e| ToolError::Exec(format!("创建目录失败: {e}")))?;
            }
        }

        tokio::fs::write(&target, &parsed.content)
            .await
            .map_err(|e| ToolError::Exec(format!("写文件失败: {e}")))?;

        let line_count = parsed.content.lines().count();
        Ok(ToolResult {
            content: format!("已写入 {line_count} 行到 {}", target.display()),
            is_error: false,
        })
    }

    async fn preview(&self, args: &Value, ctx: &ToolContext) -> Option<ToolPreview> {
        let parsed: Args = serde_json::from_value(args.clone()).ok()?;
        let canonical_cwd = ctx.cwd.canonicalize().ok()?;
        let target = sandboxed_target(&parsed.path, &canonical_cwd).ok()?;

        // 只读旧内容算 diff；不存在则视为空串（新建文件场景）。绝不写盘。
        let old_text = tokio::fs::read_to_string(&target)
            .await
            .unwrap_or_default();

        Some(ToolPreview {
            kind: "diff".into(),
            path: parsed.path,
            old_text,
            new_text: parsed.content,
        })
    }
}

/// 校验路径落在 cwd 沙盒内，返回沙盒校验后的目标绝对路径。
///
/// **只读、无副作用**：不创建任何目录/文件，可安全用于 `preview()`。
/// 目标文件本身允许不存在，但会向上找到「最近存在的祖先目录」并
/// canonicalize 校验，挡符号链接逃逸；再用词法归一化挡纯路径穿越
/// （`../../etc/passwd` 这类在祖先目录都不存在前就被拦下）。
fn sandboxed_target(raw_path: &str, canonical_cwd: &Path) -> Result<PathBuf, ToolError> {
    let resolved = resolve_path(raw_path, canonical_cwd);
    let normalized = lexical_normalize(&resolved);

    if !normalized.starts_with(canonical_cwd) {
        return Err(ToolError::Blocked {
            reason: format!("路径越界沙盒（不在 {} 内）", canonical_cwd.display()),
        });
    }

    // 从目标路径起向上找最近存在的祖先目录。
    let mut existing_ancestor = normalized.clone();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    while !existing_ancestor.exists() {
        let name = existing_ancestor
            .file_name()
            .ok_or_else(|| ToolError::InvalidArgs("路径无效".into()))?
            .to_os_string();
        tail.push(name);
        existing_ancestor = existing_ancestor
            .parent()
            .ok_or_else(|| ToolError::InvalidArgs("路径无效".into()))?
            .to_path_buf();
    }

    let canonical_ancestor = existing_ancestor
        .canonicalize()
        .map_err(|e| ToolError::Exec(format!("路径解析失败: {e}")))?;

    if !canonical_ancestor.starts_with(canonical_cwd) {
        return Err(ToolError::Blocked {
            reason: format!("路径越界沙盒（不在 {} 内）", canonical_cwd.display()),
        });
    }

    let mut target = canonical_ancestor;
    for comp in tail.into_iter().rev() {
        target.push(comp);
    }
    Ok(target)
}

fn resolve_path(p: &str, cwd: &Path) -> PathBuf {
    let path = Path::new(p);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    }
}

/// 纯词法归一化：处理 `.` / `..`，不触碰文件系统（用于路径穿越预筛）。
fn lexical_normalize(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
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
    async fn happy_path_新建文件() {
        let dir = TempDir::new().unwrap();
        let ctx = make_ctx(dir.path().to_path_buf());
        let r = WriteFileTool
            .execute(json!({ "path": "hello.txt", "content": "line1\nline2" }), &ctx)
            .await
            .unwrap();
        assert!(!r.is_error);
        assert!(r.content.contains("2 行"));
        assert_eq!(
            std::fs::read_to_string(dir.path().join("hello.txt")).unwrap(),
            "line1\nline2"
        );
    }

    #[tokio::test]
    async fn 覆盖已存在文件() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("a.txt"), "old content").unwrap();
        let ctx = make_ctx(dir.path().to_path_buf());
        let r = WriteFileTool
            .execute(json!({ "path": "a.txt", "content": "new content" }), &ctx)
            .await
            .unwrap();
        assert!(!r.is_error);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.txt")).unwrap(),
            "new content"
        );
    }

    #[tokio::test]
    async fn 沙盒越界_绝对路径指向_cwd_外_blocked() {
        let dir = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let ctx = make_ctx(dir.path().to_path_buf());

        let abs_outside = outside.path().join("evil.txt");
        let r = WriteFileTool
            .execute(
                json!({ "path": abs_outside.to_string_lossy(), "content": "x" }),
                &ctx,
            )
            .await;
        assert!(matches!(r, Err(ToolError::Blocked { .. })));
        assert!(!abs_outside.exists(), "越界写入不应真的落盘");
    }

    #[tokio::test]
    async fn 父目录不存在_自动创建() {
        let dir = TempDir::new().unwrap();
        let ctx = make_ctx(dir.path().to_path_buf());
        let r = WriteFileTool
            .execute(
                json!({ "path": "a/b/c.txt", "content": "nested" }),
                &ctx,
            )
            .await
            .unwrap();
        assert!(!r.is_error);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a/b/c.txt")).unwrap(),
            "nested"
        );
    }

    #[tokio::test]
    async fn preview_无副作用_文件不变() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("a.txt"), "old").unwrap();
        let ctx = make_ctx(dir.path().to_path_buf());

        let preview = WriteFileTool
            .preview(&json!({ "path": "a.txt", "content": "new" }), &ctx)
            .await
            .expect("应返回 diff 预览");
        assert_eq!(preview.kind, "diff");
        assert_eq!(preview.old_text, "old");
        assert_eq!(preview.new_text, "new");

        // 关键断言：preview 调用后文件内容未变、新文件也没被创建
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.txt")).unwrap(),
            "old"
        );
    }

    #[tokio::test]
    async fn preview_新文件_旧内容为空串且不创建文件() {
        let dir = TempDir::new().unwrap();
        let ctx = make_ctx(dir.path().to_path_buf());

        let preview = WriteFileTool
            .preview(&json!({ "path": "new.txt", "content": "hi" }), &ctx)
            .await
            .expect("应返回 diff 预览");
        assert_eq!(preview.old_text, "");
        assert_eq!(preview.new_text, "hi");
        assert!(!dir.path().join("new.txt").exists(), "preview 不应创建文件");
    }

    #[tokio::test]
    async fn 缺参数_invalid_args() {
        let dir = TempDir::new().unwrap();
        let ctx = make_ctx(dir.path().to_path_buf());
        let r = WriteFileTool.execute(json!({ "path": "a.txt" }), &ctx).await;
        assert!(matches!(r, Err(ToolError::InvalidArgs(_))));
    }
}
