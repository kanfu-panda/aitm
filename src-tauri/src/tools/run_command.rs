//! run_command 工具：在指定终端 tab 执行命令。
//!
//! 风险等级 = High（永远要用户确认）。1E-1 不接 L2 启发式，所以 sudo / git
//! push --force 这类灰色命令也是 High（弹默认聚焦"取消"的对话框）。
//! 1E-2 引入 L2 风险评分后，部分 High 会升 Destructive。

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};

use super::ansi::strip_for_llm;
use super::{RiskClass, Tool, ToolContext, ToolError, ToolResult};

/// 命令写入后等待输出收敛的总时间（粗暴等待，1E-1 简化）。
const WAIT_TOTAL: std::time::Duration = std::time::Duration::from_secs(5);
/// 输出截断上限（避免 LLM 上下文爆炸）。
const MAX_OUTPUT_BYTES: usize = 2_000;
/// 拍快照时拉的最大行数（recent_output 上限语义为"最近 N 行"，
/// 用一个足够大的值近似"全部"，避免传 usize::MAX 让人误读）。
const SNAPSHOT_LINES: usize = 10_000;

pub struct RunCommandTool;

#[derive(Deserialize)]
struct Args {
    /// LLM 可选传 UUID；不传 / 传 "current" / "default" / "" → 用 ctx.active_session_id
    #[serde(default)]
    session_id: Option<String>,
    cmd: String,
}

/// 把 LLM 传的 session_id 解析成真实 UUID 字符串。
/// 兜底规则：缺 / "current" / "default" / "" 都视为"用当前活跃 tab"。
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

#[async_trait]
impl Tool for RunCommandTool {
    fn name(&self) -> &str {
        "run_command"
    }

    fn description(&self) -> &str {
        "在指定终端 tab 执行命令并返回输出。会询问用户确认（除非命中信任白名单）。"
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "session_id": {
                    "type": "string",
                    "description": "目标终端 tab 的 session UUID。**绝大多数情况留空或省略**，系统会自动用当前活跃 tab。"
                },
                "cmd": {
                    "type": "string",
                    "description": "要执行的 shell 命令，**不要**附换行（系统会自动加）"
                }
            },
            "required": ["cmd"]
        })
    }

    fn risk_class(&self, args: &Value) -> RiskClass {
        // 1E-2：委托给 safety::risk::classify 做静态启发式分级。
        // 注意：tool_loop 的主路径会单独走 safety::risk::classify 拿到 reason 字段
        // 喂给 EventSink；这里返回的值给"非 run_command 路径"或测试用，保持语义一致
        // （没解析到 cmd 时降级 High，保守不失败）。
        let cmd = args.get("cmd").and_then(|v| v.as_str()).unwrap_or("");
        if cmd.is_empty() {
            return RiskClass::High;
        }
        crate::safety::risk::classify(cmd).risk
    }

    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<ToolResult, ToolError> {
        let parsed: Args = serde_json::from_value(args)
            .map_err(|e| ToolError::InvalidArgs(format!("run_command 参数: {e}")))?;

        // 命令不能含换行符（一行一条）
        if parsed.cmd.contains('\n') {
            return Err(ToolError::InvalidArgs(
                "cmd 不能含换行符（一次只能跑一条命令）".into(),
            ));
        }

        // 解析 session_id：LLM 可能传 "default"/"current" 等占位符，统一兜底到 active tab
        let session_id = resolve_session_id(parsed.session_id.as_deref(), ctx)?;

        // 拍快照：执行前的 ring buffer 内容，用来 diff 出新增部分
        let before = ctx
            .session_state
            .recent_output(&session_id, SNAPSHOT_LINES)
            .await
            .ok_or_else(|| ToolError::SessionNotFound(session_id.clone()))?;
        let before_len = before.len();

        // 写命令 + 换行到 PTY stdin
        let payload = format!("{}\n", parsed.cmd);
        ctx.session_state
            .write_input(&session_id, payload.as_bytes())
            .await
            .map_err(|e| ToolError::Exec(format!("写入 PTY 失败: {e}")))?;

        // 简化策略：直接等总时间，1E-2 改 prompt 检测
        tokio::time::sleep(WAIT_TOTAL).await;

        let after = ctx
            .session_state
            .recent_output(&session_id, SNAPSHOT_LINES)
            .await
            .ok_or_else(|| ToolError::SessionNotFound(session_id.clone()))?;

        // diff：取 before 之后新增的部分
        let raw_new: String = if after.len() > before_len && after.starts_with(&before) {
            after[before_len..].to_string()
        } else {
            // ring buffer 可能 drain 过 → 没法精确 diff，返回最近 50 行做兜底
            ctx.session_state
                .recent_output(&session_id, 50)
                .await
                .unwrap_or_default()
        };

        // 关键：剥 ANSI 转义 + 控制字符 + 折叠空行，否则 LLM 看不懂 PTY 噪音
        let new_output = strip_for_llm(&raw_new);

        // 截断 + 注释
        let (final_output, truncated) = if new_output.len() > MAX_OUTPUT_BYTES {
            let cut = new_output
                .char_indices()
                .nth(MAX_OUTPUT_BYTES)
                .map(|(i, _)| i)
                .unwrap_or(MAX_OUTPUT_BYTES);
            (new_output[..cut].to_string(), true)
        } else {
            (new_output, false)
        };

        let content = if truncated {
            format!(
                "{final_output}\n\n[输出过长已截断到前 {MAX_OUTPUT_BYTES} 字节；输出可能未完整]"
            )
        } else if final_output.is_empty() {
            "[5 秒内无输出 —— 命令可能仍在执行，可稍后再调 get_terminal_history 查看]".into()
        } else {
            final_output
        };

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
    async fn 不存在的_session_返回_session_not_found() {
        let ctx = make_ctx();
        let r = RunCommandTool
            .execute(
                json!({ "session_id": "00000000-0000-0000-0000-000000000000", "cmd": "ls" }),
                &ctx,
            )
            .await;
        assert!(matches!(r, Err(ToolError::SessionNotFound(_))));
    }

    #[tokio::test]
    async fn cmd_含换行_invalid_args() {
        let ctx = make_ctx();
        let r = RunCommandTool
            .execute(
                json!({ "session_id": "00000000-0000-0000-0000-000000000000", "cmd": "ls\nrm -rf /" }),
                &ctx,
            )
            .await;
        assert!(matches!(r, Err(ToolError::InvalidArgs(_))));
    }

    /// session_id 不传时回退到 ctx.active_session_id；ctx 也没有 → SessionNotFound。
    #[tokio::test]
    async fn 缺_session_id_无_active_则_session_not_found() {
        let ctx = make_ctx();  // active_session_id = None
        let r = RunCommandTool.execute(json!({ "cmd": "ls" }), &ctx).await;
        assert!(
            matches!(r, Err(ToolError::SessionNotFound(_))),
            "无 active 时应是 SessionNotFound 而不是 InvalidArgs，实际：{r:?}"
        );
    }

    /// session_id 为占位符 "current"/"default"/"" 时也走 active 兜底。
    #[tokio::test]
    async fn session_id_占位符_default_走_active_兜底() {
        let ctx = make_ctx();
        for placeholder in &["", "current", "default", "active", "main"] {
            let r = RunCommandTool
                .execute(json!({ "session_id": placeholder, "cmd": "ls" }), &ctx)
                .await;
            assert!(
                matches!(r, Err(ToolError::SessionNotFound(_))),
                "占位符 {placeholder} 应走 active 兜底 → SessionNotFound（active=None）"
            );
        }
    }

    /// 1E-2：risk_class 委托给 safety::risk::classify。
    /// `ls` → Low / `sudo ...` → Destructive / 普通命令 → High。
    #[test]
    fn risk_class_委托_safety_risk() {
        assert_eq!(
            RunCommandTool.risk_class(&json!({"cmd": "ls"})),
            RiskClass::Low
        );
        assert_eq!(
            RunCommandTool.risk_class(&json!({"cmd": "git status"})),
            RiskClass::Low
        );
        assert_eq!(
            RunCommandTool.risk_class(&json!({"cmd": "sudo rm -rf /tmp"})),
            RiskClass::Destructive
        );
        assert_eq!(
            RunCommandTool.risk_class(&json!({"cmd": "git push --force"})),
            RiskClass::Destructive
        );
        // 默认未知命令 → High
        assert_eq!(
            RunCommandTool.risk_class(&json!({"cmd": "mv a b"})),
            RiskClass::High
        );
    }

    /// 缺 cmd 字段时降级 High 不 panic。
    #[test]
    fn risk_class_缺_cmd_默认_high() {
        assert_eq!(RunCommandTool.risk_class(&json!({})), RiskClass::High);
        assert_eq!(RunCommandTool.risk_class(&json!({"cmd": ""})), RiskClass::High);
    }

    /// session_id 改为 optional 后只 cmd 是 required。
    #[test]
    fn input_schema_required_只含_cmd() {
        let s = RunCommandTool.input_schema();
        let req = s["required"].as_array().unwrap();
        assert!(req.iter().any(|v| v == "cmd"));
        assert!(
            !req.iter().any(|v| v == "session_id"),
            "session_id 不应再 required，必须留给 active 兜底"
        );
    }
}
