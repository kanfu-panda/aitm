//! list_files 工具：列出目录内容（受 cwd 沙盒约束）。
//!
//! 自动跳过常见的"巨型"目录（.git / node_modules / target 等），避免上下文爆炸。

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{Value, json};

use super::{RiskClass, Tool, ToolContext, ToolError, ToolResult};

const MAX_ENTRIES: usize = 500;
const IGNORE_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    ".next",
    "dist",
    "build",
    ".cache",
    ".idea",
    ".vscode",
    "__pycache__",
    ".venv",
    "venv",
];

pub struct ListFilesTool;

#[derive(Deserialize)]
struct Args {
    dir: String,
    #[serde(default = "default_max_depth")]
    max_depth: u32,
}

fn default_max_depth() -> u32 {
    1
}

#[async_trait]
impl Tool for ListFilesTool {
    fn name(&self) -> &str {
        "list_files"
    }

    fn description(&self) -> &str {
        "列出目录内容。仅限工作目录内。自动跳过 .git/node_modules/target 等大目录。"
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "dir": {
                    "type": "string",
                    "description": "目录路径（相对工作目录）。'.' 表示工作目录根"
                },
                "max_depth": {
                    "type": "integer",
                    "default": 1,
                    "description": "递归深度。1 = 只列直接子项，2 = 含一层子目录"
                }
            },
            "required": ["dir"]
        })
    }

    fn risk_class(&self, _args: &Value) -> RiskClass {
        RiskClass::Low
    }

    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<ToolResult, ToolError> {
        let parsed: Args = serde_json::from_value(args)
            .map_err(|e| ToolError::InvalidArgs(format!("list_files 参数: {e}")))?;

        let target = if parsed.dir == "." || parsed.dir.is_empty() {
            ctx.cwd.clone()
        } else {
            let p = std::path::Path::new(&parsed.dir);
            if p.is_absolute() {
                p.to_path_buf()
            } else {
                ctx.cwd.join(p)
            }
        };

        let canonical_cwd = ctx
            .cwd
            .canonicalize()
            .map_err(|e| ToolError::Exec(format!("cwd 不存在: {e}")))?;
        let canonical_target = target
            .canonicalize()
            .map_err(|e| ToolError::Exec(format!("目录不存在: {e}")))?;

        if !canonical_target.starts_with(&canonical_cwd) {
            return Err(ToolError::Blocked {
                reason: format!("路径越界沙盒（不在 {} 内）", canonical_cwd.display()),
            });
        }

        let mut entries: Vec<String> = Vec::new();
        walk(
            &canonical_target,
            &canonical_target,
            parsed.max_depth,
            &mut entries,
        );

        let truncated = entries.len() > MAX_ENTRIES;
        if truncated {
            entries.truncate(MAX_ENTRIES);
        }

        let mut content = entries.join("\n");
        if truncated {
            content.push_str(&format!("\n[已截断到前 {MAX_ENTRIES} 项]"));
        }

        Ok(ToolResult {
            content,
            is_error: false,
        })
    }
}

/// 收集上限 = MAX_ENTRIES + 1，便于上层判断是否截断。
const COLLECT_CAP: usize = MAX_ENTRIES + 1;

fn walk(
    path: &std::path::Path,
    base: &std::path::Path,
    max_depth: u32,
    out: &mut Vec<String>,
) {
    if max_depth == 0 || out.len() >= COLLECT_CAP {
        return;
    }
    let Ok(rd) = std::fs::read_dir(path) else {
        return;
    };

    let mut items: Vec<_> = rd.filter_map(|e| e.ok()).collect();
    items.sort_by_key(|e| e.file_name());

    for entry in items {
        if out.len() >= COLLECT_CAP {
            return;
        }
        let name = entry.file_name();
        let name_str = name.to_string_lossy();

        // 跳过 ignore 列表里的大目录
        if IGNORE_DIRS.contains(&name_str.as_ref()) {
            continue;
        }

        let full = entry.path();
        let rel = full.strip_prefix(base).unwrap_or(&full);
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let suffix = if is_dir { "/" } else { "" };
        out.push(format!("{}{}", rel.display(), suffix));

        if is_dir {
            walk(&full, base, max_depth - 1, out);
        }
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
    async fn happy_path_列直接子项() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("a.txt"), "").unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();

        let ctx = make_ctx(dir.path().to_path_buf());
        let r = ListFilesTool
            .execute(json!({ "dir": "." }), &ctx)
            .await
            .unwrap();
        assert!(r.content.contains("a.txt"));
        assert!(r.content.contains("sub/"));
    }

    #[tokio::test]
    async fn ignore_大目录_node_modules() {
        let dir = TempDir::new().unwrap();
        std::fs::create_dir(dir.path().join("node_modules")).unwrap();
        std::fs::write(dir.path().join("node_modules").join("hidden.js"), "").unwrap();
        std::fs::write(dir.path().join("a.txt"), "").unwrap();

        let ctx = make_ctx(dir.path().to_path_buf());
        let r = ListFilesTool
            .execute(json!({ "dir": ".", "max_depth": 5 }), &ctx)
            .await
            .unwrap();
        assert!(r.content.contains("a.txt"));
        assert!(!r.content.contains("node_modules"));
        assert!(!r.content.contains("hidden.js"));
    }

    #[tokio::test]
    async fn max_depth_2_递归一层() {
        let dir = TempDir::new().unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        std::fs::write(dir.path().join("sub").join("inner.txt"), "").unwrap();
        std::fs::create_dir(dir.path().join("sub").join("deep")).unwrap();
        std::fs::write(dir.path().join("sub").join("deep").join("deeper.txt"), "").unwrap();

        let ctx = make_ctx(dir.path().to_path_buf());
        let r = ListFilesTool
            .execute(json!({ "dir": ".", "max_depth": 2 }), &ctx)
            .await
            .unwrap();
        assert!(r.content.contains("sub/inner.txt") || r.content.contains("sub\\inner.txt"));
        // depth=2 不应进 deep/deeper.txt
        assert!(!r.content.contains("deeper.txt"));
    }

    #[tokio::test]
    async fn 沙盒越界_blocked() {
        let dir = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let ctx = make_ctx(dir.path().to_path_buf());

        let r = ListFilesTool
            .execute(
                json!({ "dir": outside.path().to_string_lossy() }),
                &ctx,
            )
            .await;
        assert!(matches!(r, Err(ToolError::Blocked { .. })));
    }

    #[tokio::test]
    async fn 大量文件_max_500_截断() {
        let dir = TempDir::new().unwrap();
        for i in 0..600 {
            std::fs::write(dir.path().join(format!("f{i}.txt")), "").unwrap();
        }
        let ctx = make_ctx(dir.path().to_path_buf());
        let r = ListFilesTool
            .execute(json!({ "dir": "." }), &ctx)
            .await
            .unwrap();
        assert!(r.content.contains("已截断"));
    }
}
