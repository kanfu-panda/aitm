//! v0.5.0-E：5 个浏览器 AI 工具。让 aitm 内置 AI 工具循环驱动内嵌浏览器。
//!
//! - browser_snapshot (LOW)：抓 a11y 树 → 返 JSON 给 LLM 看
//! - browser_navigate (LOW)：导航到 URL
//! - browser_click (HIGH)：点击元素 ref（snapshot 抓的）
//! - browser_fill (HIGH)：填表单
//! - browser_eval (DESTRUCTIVE)：任意 JS eval
//!
//! 风险分级（plan §0.3）：HIGH → ConfirmDialog 弹审批；DESTRUCTIVE → 用户输入"确认"才能批准。
//!
//! 元素引用机制：snapshot 抓时给元素打 `data-aitm-ref="rN"`，后续 click/fill
//! 用 `document.querySelector('[data-aitm-ref="rN"]')` 找回。同一 snapshot 内 ref 稳定。

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{Value, json};
use tauri::{Emitter, Manager};

use crate::ipc::browser::BrowserState;
use std::sync::Arc;

use super::{RiskClass, Tool, ToolContext, ToolError, ToolResult};

// ============================================================
// 共享 helper：resolve active tab id
// ============================================================

/// 从工具参数 + BrowserState 解析出实际 tab_id。
///
/// LLM 通常不知道具体 tab_id（webview label）；它可以传 "current"/"active" 或
/// 完全不传 → 优先用 BrowserState.current_active_id（前端
/// [`browser_set_active`] 同步），fallback 到 HashMap 第一条。
///
/// v0.5.7：之前只用 `keys().next()`，HashMap 无序导致 AI 操作 hidden ghost
/// webview，跟用户视觉看到的 tab 不一致 — 维护者 真机反馈过的 bug。
async fn resolve_tab_id(
    explicit: Option<&str>,
    browser_state: &Arc<BrowserState>,
) -> Result<String, ToolError> {
    if let Some(s) = explicit {
        let trimmed = s.trim();
        if !trimmed.is_empty()
            && trimmed != "current"
            && trimmed != "active"
            && trimmed != "default"
        {
            // LLM 传了具体 id → 直接用
            return Ok(trimmed.to_string());
        }
    }
    // v0.5.7 优先：前端同步过来的"用户当前看到的 tab"
    if let Some(id) = browser_state.current_active_id.lock().await.clone() {
        // 校验仍存在于 active map（前端 set 后可能被 close）
        let map = browser_state.active.lock().await;
        if map.contains_key(&id) {
            return Ok(id);
        }
    }
    // Fallback：取 BrowserState 内第一个 active tab（HashMap 无序，作为最后兜底）
    let map = browser_state.active.lock().await;
    if let Some(tab_id) = map.keys().next().cloned() {
        Ok(tab_id)
    } else {
        Err(ToolError::Exec(
            "浏览器面板未打开或无 active tab；用户需先打开浏览器".to_string(),
        ))
    }
}

/// 从 BrowserState 拿 Webview handle（含 ref 校验）。
async fn get_webview(
    tab_id: &str,
    browser_state: &Arc<BrowserState>,
) -> Result<tauri::Webview, ToolError> {
    let map = browser_state.active.lock().await;
    map.get(tab_id)
        .cloned()
        .ok_or_else(|| ToolError::Exec(format!("tab {tab_id} 不存在或已 suspend")))
}

// ============================================================
// 1. browser_snapshot (LOW)
// ============================================================

pub struct BrowserSnapshotTool;

#[derive(Deserialize)]
struct SnapshotArgs {
    #[serde(default)]
    tab_id: Option<String>,
}

#[async_trait]
impl Tool for BrowserSnapshotTool {
    fn name(&self) -> &str {
        "browser_snapshot"
    }

    fn description(&self) -> &str {
        "抓取内嵌浏览器当前页面的可交互元素（a11y 树）。返回 JSON 含 url / title / \
         elements 数组（每个 element 含 ref/tag/text/type/name/href）。LLM 看完后用 \
         ref 调 browser_click / browser_fill 操作元素。每次 snapshot 后 ref 才有效，\
         页面 DOM 变化后需重新 snapshot。"
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "tab_id": {
                    "type": "string",
                    "description": "可选；不传 / 传 'current' / 'active' 时用第一个 active 浏览器 tab"
                }
            }
        })
    }

    fn risk_class(&self, _args: &Value) -> RiskClass {
        RiskClass::Low
    }

    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<ToolResult, ToolError> {
        let parsed: SnapshotArgs = serde_json::from_value(args)
            .map_err(|e| ToolError::InvalidArgs(format!("browser_snapshot 参数: {e}")))?;
        let tab_id = resolve_tab_id(parsed.tab_id.as_deref(), &ctx.browser_state).await?;

        // 复用 ipc::browser::browser_inject_snapshot 的核心逻辑（注入 SCRIPT + 等 oneshot）。
        // 不直接调 IPC 命令（State 抽取需要 tauri runtime），自己复制一份逻辑。
        let wv = get_webview(&tab_id, &ctx.browser_state).await?;
        let req_id = format!("snap-{}", uuid::Uuid::new_v4());
        let (tx, rx) = tokio::sync::oneshot::channel::<String>();
        ctx.browser_state
            .pending_snapshots
            .lock()
            .await
            .insert(req_id.clone(), tx);

        let script = crate::ipc::browser::SNAPSHOT_INJECT_SCRIPT.replace("__REQ_ID__", &req_id);
        if let Err(e) = wv.eval(&script) {
            ctx.browser_state
                .pending_snapshots
                .lock()
                .await
                .remove(&req_id);
            return Err(ToolError::Exec(format!("注入 snapshot JS 失败: {e}")));
        }

        match tokio::time::timeout(std::time::Duration::from_secs(5), rx).await {
            Ok(Ok(json)) => Ok(ToolResult {
                content: json,
                is_error: false,
            }),
            Ok(Err(_)) => Err(ToolError::Exec(
                "snapshot oneshot 通道异常".to_string(),
            )),
            Err(_) => {
                ctx.browser_state
                    .pending_snapshots
                    .lock()
                    .await
                    .remove(&req_id);
                Err(ToolError::Exec("snapshot 等待超时（5s）".to_string()))
            }
        }
    }
}

// ============================================================
// 2. browser_navigate (LOW)
// ============================================================

pub struct BrowserNavigateTool;

#[derive(Deserialize)]
struct NavigateArgs {
    url: String,
    #[serde(default)]
    tab_id: Option<String>,
}

#[async_trait]
impl Tool for BrowserNavigateTool {
    fn name(&self) -> &str {
        "browser_navigate"
    }

    fn description(&self) -> &str {
        "让内嵌浏览器导航到指定 URL（http / https）。默认作用于第一个 active 浏览器 tab。"
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "完整 URL（含 http:// 或 https://）"},
                "tab_id": {"type": "string", "description": "可选；缺省用 active"}
            },
            "required": ["url"]
        })
    }

    fn risk_class(&self, _args: &Value) -> RiskClass {
        RiskClass::Low
    }

    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<ToolResult, ToolError> {
        // v0.9.2 HR5-4：失败时**仍返 Ok(ToolResult)** 包结构化 JSON
        //   { ok: false, attempted_url, reason }
        // 让 LLM 在 tool_result 内容里看到 ok=false 信号，不能瞎说"已跳转"。
        // 只有 InvalidArgs（连 url 字段都 deserialize 不出）才返 Err。

        let parsed: NavigateArgs = match serde_json::from_value::<NavigateArgs>(args) {
            Ok(p) => p,
            Err(e) => {
                // 连 url 都没解析出 → 无 attempted_url 可填，returns Err
                return Err(ToolError::InvalidArgs(format!("browser_navigate 参数: {e}")));
            }
        };
        let attempted_url = parsed.url.clone();

        // 辅助：构造失败 ToolResult
        let make_fail = |reason: String| -> ToolResult {
            let body = json!({
                "ok": false,
                "attempted_url": attempted_url,
                "reason": reason,
            })
            .to_string();
            ToolResult {
                content: body,
                is_error: true,
            }
        };

        // v0.9.2 HR5-4：URL 校验放在 resolve_tab_id 前，确保不论浏览器是否打开
        // 都能给 LLM 一个明确的"URL 本身就不合法 / scheme 不对"信号。
        let url: tauri::Url = match parsed.url.parse() {
            Ok(u) => u,
            Err(e) => return Ok(make_fail(format!("URL 解析失败: {e}"))),
        };
        if !matches!(url.scheme(), "http" | "https") {
            return Ok(make_fail(format!(
                "不允许的 URL scheme: {}（仅 http/https）",
                url.scheme()
            )));
        }

        let tab_id = match resolve_tab_id(parsed.tab_id.as_deref(), &ctx.browser_state).await {
            Ok(id) => id,
            Err(ToolError::Exec(msg)) => return Ok(make_fail(msg)),
            Err(e) => return Ok(make_fail(format!("解析 tab_id 失败: {e:?}"))),
        };

        let wv = match get_webview(&tab_id, &ctx.browser_state).await {
            Ok(wv) => wv,
            Err(ToolError::Exec(msg)) => return Ok(make_fail(msg)),
            Err(e) => return Ok(make_fail(format!("获取 webview 失败: {e:?}"))),
        };

        if let Err(e) = wv.navigate(url) {
            return Ok(make_fail(format!("navigate 失败: {e}")));
        }
        // v0.5.9：emit 给主 webview 同步 URL 栏。用 emit_to(EventTarget::webview("main"))
        // 显式指定，避免 emit() 广播到 child webview 时主 webview 漏收。
        let app = wv.app_handle().clone();
        let payload = crate::ipc::browser::UrlChangedEvent {
            tab_id: tab_id.clone(),
            url: parsed.url.clone(),
        };
        if let Err(e) = app.emit_to(tauri::EventTarget::webview("main"), "browser:url_changed", &payload) {
            tracing::warn!("AI 工具 emit browser:url_changed to main 失败: {e}");
        }
        // v0.5.8：navigate 是异步触发，wv.navigate 立即 return 但 WKWebView 切页
        // 还在加载——AI 紧跟 snapshot 会拿到 transitional state（body 为 null）。
        // 简单 sleep 800ms 缓解 race；不是完美但是无 native load 事件桥的情况下
        // 最实用方案。仍可能不够（慢站），AI 提示拿到 null body 时再 sleep 后重试。
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;

        // v0.9.2 HR5-4：成功也用结构化 JSON（含 ok=true + url），方便前端 / LLM
        // 都用同一套字段判断。title 当前后端没拉（要再发一次 eval 查 document.title），
        // 留空字符串占位；后续可补。
        let body = json!({
            "ok": true,
            "url": parsed.url.clone(),
            "title": "",
            "note": "已等 800ms 加载，若内容仍未就绪可再次 snapshot",
            "tab_id": tab_id,
        })
        .to_string();
        Ok(ToolResult {
            content: body,
            is_error: false,
        })
    }
}

// ============================================================
// 3. browser_click (HIGH)
// ============================================================

pub struct BrowserClickTool;

#[derive(Deserialize)]
struct ClickArgs {
    /// 必须是 snapshot 抓时打的 ref（如 "r5"）
    r#ref: String,
    #[serde(default)]
    tab_id: Option<String>,
}

#[async_trait]
impl Tool for BrowserClickTool {
    fn name(&self) -> &str {
        "browser_click"
    }

    fn description(&self) -> &str {
        "点击 browser_snapshot 抓到的元素（按 ref 引用，如 'r5'）。需先 snapshot 拿 ref。"
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "ref": {"type": "string", "description": "snapshot 抓的元素引用 'rN'"},
                "tab_id": {"type": "string", "description": "可选；缺省用 active"}
            },
            "required": ["ref"]
        })
    }

    fn risk_class(&self, _args: &Value) -> RiskClass {
        RiskClass::High
    }

    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<ToolResult, ToolError> {
        let parsed: ClickArgs = serde_json::from_value(args)
            .map_err(|e| ToolError::InvalidArgs(format!("browser_click 参数: {e}")))?;
        let tab_id = resolve_tab_id(parsed.tab_id.as_deref(), &ctx.browser_state).await?;
        let wv = get_webview(&tab_id, &ctx.browser_state).await?;

        let ref_id = json_escape(&parsed.r#ref);
        let script = format!(
            r#"(function(){{
              var el = document.querySelector('[data-aitm-ref="{ref_id}"]');
              if (el) {{ el.click(); }}
            }})();"#
        );
        wv.eval(&script)
            .map_err(|e| ToolError::Exec(format!("click eval 失败: {e}")))?;

        Ok(ToolResult {
            content: format!("已点击 ref={} (tab {tab_id})", parsed.r#ref),
            is_error: false,
        })
    }
}

// ============================================================
// 4. browser_fill (HIGH)
// ============================================================

pub struct BrowserFillTool;

#[derive(Deserialize)]
struct FillArgs {
    r#ref: String,
    value: String,
    #[serde(default)]
    tab_id: Option<String>,
}

#[async_trait]
impl Tool for BrowserFillTool {
    fn name(&self) -> &str {
        "browser_fill"
    }

    fn description(&self) -> &str {
        "给 browser_snapshot 抓到的 input/textarea 填值。需先 snapshot 拿 ref。"
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "ref": {"type": "string", "description": "snapshot 抓的元素引用 'rN'"},
                "value": {"type": "string", "description": "要填的值"},
                "tab_id": {"type": "string"}
            },
            "required": ["ref", "value"]
        })
    }

    fn risk_class(&self, _args: &Value) -> RiskClass {
        RiskClass::High
    }

    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<ToolResult, ToolError> {
        let parsed: FillArgs = serde_json::from_value(args)
            .map_err(|e| ToolError::InvalidArgs(format!("browser_fill 参数: {e}")))?;
        let tab_id = resolve_tab_id(parsed.tab_id.as_deref(), &ctx.browser_state).await?;
        let wv = get_webview(&tab_id, &ctx.browser_state).await?;

        let ref_id = json_escape(&parsed.r#ref);
        let value_escaped = json_escape(&parsed.value);
        let script = format!(
            r#"(function(){{
              var el = document.querySelector('[data-aitm-ref="{ref_id}"]');
              if (el) {{
                el.value = "{value_escaped}";
                el.dispatchEvent(new Event('input', {{ bubbles: true }}));
                el.dispatchEvent(new Event('change', {{ bubbles: true }}));
              }}
            }})();"#
        );
        wv.eval(&script)
            .map_err(|e| ToolError::Exec(format!("fill eval 失败: {e}")))?;

        Ok(ToolResult {
            content: format!("已填 ref={} value=<{}字符> (tab {tab_id})", parsed.r#ref, parsed.value.chars().count()),
            is_error: false,
        })
    }
}

// ============================================================
// 5. browser_eval (DESTRUCTIVE)
// ============================================================

pub struct BrowserEvalTool;

#[derive(Deserialize)]
struct EvalArgs {
    script: String,
    #[serde(default)]
    tab_id: Option<String>,
}

#[async_trait]
impl Tool for BrowserEvalTool {
    fn name(&self) -> &str {
        "browser_eval"
    }

    fn description(&self) -> &str {
        "在内嵌浏览器内 eval 任意 JS（DESTRUCTIVE：可能修改任何 DOM / 发起任何请求 / \
         读敏感数据）。仅在必要时用，绝大多数操作走 browser_click / browser_fill 即可。"
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "script": {"type": "string", "description": "JavaScript 代码（同步 / 异步皆可，但返回值丢弃）"},
                "tab_id": {"type": "string"}
            },
            "required": ["script"]
        })
    }

    fn risk_class(&self, _args: &Value) -> RiskClass {
        RiskClass::Destructive
    }

    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<ToolResult, ToolError> {
        let parsed: EvalArgs = serde_json::from_value(args)
            .map_err(|e| ToolError::InvalidArgs(format!("browser_eval 参数: {e}")))?;
        let tab_id = resolve_tab_id(parsed.tab_id.as_deref(), &ctx.browser_state).await?;
        let wv = get_webview(&tab_id, &ctx.browser_state).await?;

        wv.eval(&parsed.script)
            .map_err(|e| ToolError::Exec(format!("eval 失败: {e}")))?;

        Ok(ToolResult {
            content: format!("已 eval JS（{} 字符，tab {tab_id}）", parsed.script.chars().count()),
            is_error: false,
        })
    }
}

// ============================================================
// 共享：JS 字符串简单 escape（防注入 ref / value 含引号）
// ============================================================

fn json_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_ctx() -> ToolContext {
        ToolContext {
            session_state: Arc::new(crate::ipc::session::SessionState::new()),
            cwd: std::env::temp_dir(),
            active_session_id: None,
            whitelist: Arc::new(crate::safety::whitelist::CompiledWhitelist::empty()),
            browser_state: Arc::new(BrowserState::default()),
        }
    }

    #[test]
    fn json_escape_处理_引号_反斜杠_换行() {
        assert_eq!(json_escape("foo"), "foo");
        assert_eq!(json_escape(r#"he said "hi""#), r#"he said \"hi\""#);
        assert_eq!(json_escape("path\\file"), "path\\\\file");
        assert_eq!(json_escape("line1\nline2"), "line1\\nline2");
    }

    #[tokio::test]
    async fn resolve_tab_id_显式传_id_直接用() {
        let state = Arc::new(BrowserState::default());
        let r = resolve_tab_id(Some("browser-abc"), &state).await.unwrap();
        assert_eq!(r, "browser-abc");
    }

    #[tokio::test]
    async fn resolve_tab_id_current_作占位_fallback_active() {
        let state = Arc::new(BrowserState::default());
        // 空 state → 应该报错
        let r = resolve_tab_id(Some("current"), &state).await;
        assert!(r.is_err());
        if let Err(ToolError::Exec(msg)) = r {
            assert!(msg.contains("浏览器面板未打开"));
        }
    }

    #[tokio::test]
    async fn resolve_tab_id_不传_无_active_报错() {
        let state = Arc::new(BrowserState::default());
        let r = resolve_tab_id(None, &state).await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn resolve_tab_id_优先用_current_active_id_而非_keys_next() {
        // v0.5.7 回归：前端 set_active 同步后，AI 工具应拿用户可见 tab
        // 而不是 HashMap 第一条（无序）。
        let state = Arc::new(BrowserState::default());
        // 模拟 active map 里有 2 个 tab（不能真插 Webview——构造 dummy 不可行；
        // 只测 current_active_id 路径：插一个 marker key，set current_active_id
        // 指它，resolve 应回它）。
        // 因 Webview 不能构造，这里用一个变通：直接在 active 里塞**没有** value 也
        // 不行（HashMap<String, Webview>）。改成只验 current_active_id 设了但
        // active map 没该 entry → 应 fallback。
        *state.current_active_id.lock().await = Some("ghost-not-in-map".to_string());
        let r = resolve_tab_id(None, &state).await;
        // active 空 → 应报"未打开"
        assert!(r.is_err());
        if let Err(ToolError::Exec(msg)) = r {
            assert!(msg.contains("浏览器面板未打开"));
        }
    }

    #[tokio::test]
    async fn resolve_tab_id_current_active_id_已被_close_时_fallback() {
        // current_active_id 指向已 close 的 tab → 应 fallback（不返已 close 的 id）
        let state = Arc::new(BrowserState::default());
        *state.current_active_id.lock().await = Some("closed-tab".to_string());
        // active 空 fallback 也没 → 报错（不是返 closed-tab）
        let r = resolve_tab_id(None, &state).await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn snapshot_tab_id_不存在_报错() {
        let ctx = make_ctx();
        let r = BrowserSnapshotTool
            .execute(json!({"tab_id": "ghost"}), &ctx)
            .await;
        assert!(r.is_err());
        if let Err(ToolError::Exec(msg)) = r {
            assert!(msg.contains("ghost") || msg.contains("不存在"));
        }
    }

    #[tokio::test]
    async fn navigate_非_http_https_返结构化失败_ok_false() {
        // v0.9.2 HR5-4：scheme 非 http/https → 返 Ok(ToolResult) 含 ok:false
        let ctx = make_ctx();
        let r = BrowserNavigateTool
            .execute(json!({"url": "file:///etc/passwd"}), &ctx)
            .await
            .expect("应返 Ok(ToolResult) 而不是 Err");
        assert!(r.is_error, "scheme 拒绝应标 is_error=true");
        let body: serde_json::Value =
            serde_json::from_str(&r.content).expect("content 应是 JSON");
        assert_eq!(body["ok"], serde_json::json!(false), "ok 字段必须 false");
        assert_eq!(body["attempted_url"], serde_json::json!("file:///etc/passwd"));
        assert!(
            body["reason"]
                .as_str()
                .map(|s| s.contains("scheme"))
                .unwrap_or(false),
            "reason 应提到 scheme，实际: {:?}",
            body["reason"]
        );
    }

    #[tokio::test]
    async fn navigate_合法_url_但_tab_不存在_返结构化失败() {
        // v0.9.2 HR5-4：tab 不存在（浏览器未开） → 返 Ok(ToolResult) 含 ok:false
        let ctx = make_ctx();
        let r = BrowserNavigateTool
            .execute(json!({"url": "https://example.com"}), &ctx)
            .await
            .expect("应返 Ok(ToolResult) 而不是 Err");
        assert!(r.is_error);
        let body: serde_json::Value =
            serde_json::from_str(&r.content).expect("content 应是 JSON");
        assert_eq!(body["ok"], serde_json::json!(false));
        assert_eq!(body["attempted_url"], serde_json::json!("https://example.com"));
        let reason = body["reason"].as_str().unwrap_or("");
        assert!(
            reason.contains("浏览器面板未打开") || reason.contains("无 active"),
            "reason 应说明浏览器未打开，实际: {reason}"
        );
    }

    #[tokio::test]
    async fn navigate_invalid_url_返结构化失败() {
        // v0.9.2 HR5-4：URL parse 失败 → 返 Ok(ToolResult) 含 ok:false
        let ctx = make_ctx();
        let r = BrowserNavigateTool
            .execute(json!({"url": "not-a-valid-url"}), &ctx)
            .await
            .expect("应返 Ok(ToolResult) 而不是 Err");
        assert!(r.is_error);
        let body: serde_json::Value =
            serde_json::from_str(&r.content).expect("content 应是 JSON");
        assert_eq!(body["ok"], serde_json::json!(false));
        assert_eq!(body["attempted_url"], serde_json::json!("not-a-valid-url"));
        let reason = body["reason"].as_str().unwrap_or("");
        // 注意：`not-a-valid-url` 在 tauri::Url 解析时可能报"relative URL without a base"
        // 因此 reason 关键字只断言"失败"路径走到了
        assert!(
            !reason.is_empty(),
            "reason 不能空"
        );
    }

    #[tokio::test]
    async fn navigate_缺_url_字段_仍返_err_invalidargs() {
        // v0.9.2 HR5-4：连 url 字段都没（连 attempted_url 都填不出） → Err InvalidArgs
        let ctx = make_ctx();
        let r = BrowserNavigateTool
            .execute(json!({"tab_id": "x"}), &ctx)
            .await;
        assert!(r.is_err());
        match r {
            Err(ToolError::InvalidArgs(msg)) => assert!(msg.contains("browser_navigate")),
            other => panic!("应是 InvalidArgs，实际 {other:?}"),
        }
    }

    #[test]
    fn snapshot_risk_class_low() {
        assert_eq!(
            BrowserSnapshotTool.risk_class(&json!({})),
            RiskClass::Low
        );
        assert_eq!(
            BrowserNavigateTool.risk_class(&json!({})),
            RiskClass::Low
        );
    }

    #[test]
    fn click_fill_risk_class_high() {
        assert_eq!(BrowserClickTool.risk_class(&json!({})), RiskClass::High);
        assert_eq!(BrowserFillTool.risk_class(&json!({})), RiskClass::High);
    }

    #[test]
    fn eval_risk_class_destructive() {
        assert_eq!(BrowserEvalTool.risk_class(&json!({})), RiskClass::Destructive);
    }

    #[test]
    fn 所有工具_都有_name_description_schema() {
        let tools: Vec<Box<dyn Tool>> = vec![
            Box::new(BrowserSnapshotTool),
            Box::new(BrowserNavigateTool),
            Box::new(BrowserClickTool),
            Box::new(BrowserFillTool),
            Box::new(BrowserEvalTool),
        ];
        for t in &tools {
            assert!(!t.name().is_empty());
            assert!(!t.description().is_empty());
            assert!(t.input_schema().is_object());
        }
    }
}
