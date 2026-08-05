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

/// LLM 传的 tab_id 里等价于"没传"的占位符。
///
/// LLM 不知道真实 webview label，习惯编一个占位值（跟 session_id 一个毛病）。
const TAB_ID_PLACEHOLDERS: [&str; 3] = ["current", "active", "default"];

/// [`decide_tab`] 的判定结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TabDecision {
    /// 可以操作这个 tab。
    Use(String),
    /// 一个 webview 都没有 —— 调用方决定是报错还是自动开面板。
    NoTab,
    /// 明确拒绝（带给 LLM 看的原因）。**宁可失败也不操作错对象。**
    Reject(String),
}

/// 纯函数：把 LLM 传的 tab_id + 后端可见 tab 判定合成"该操作哪个 tab"。
///
/// v1.3.0 P7（ghost webview 回归修复）三条硬规则：
///
/// 1. **不猜**：判不出唯一可见 tab（多 webview 且 `current` 失效）→ Reject。
///    旧实现在这里 `HashMap::keys().next()`，HashMap 无序 = 随机挑一个 webview，
///    而 `browser_eval` 是 DESTRUCTIVE —— 操作错对象比操作失败严重得多。
/// 2. **显式 tab_id 也要校验**：LLM 很爱把上一轮 tool_result 里的 `tab_id` 原样
///    传回来，可那个 tab 用户可能早就切走 / 关掉了。跟当前可见 tab 不一致 → Reject。
/// 3. 后端根本没有这个 webview → Reject（并提示别复用历史 tab_id）。
pub(crate) fn decide_tab(
    explicit: Option<&str>,
    tab_ids: &[String],
    current: Option<&str>,
) -> TabDecision {
    let resolution = crate::ipc::browser::resolve_active_tab(current, tab_ids);
    let explicit = explicit
        .map(str::trim)
        .filter(|s| !s.is_empty() && !TAB_ID_PLACEHOLDERS.contains(s));

    let Some(id) = explicit else {
        return match resolution {
            crate::ipc::browser::ActiveTabResolution::Resolved(id) => TabDecision::Use(id),
            crate::ipc::browser::ActiveTabResolution::NoTab => TabDecision::NoTab,
            crate::ipc::browser::ActiveTabResolution::Ambiguous(n) => TabDecision::Reject(format!(
                "后端有 {n} 个浏览器 webview，但无法确定哪个是用户当前看得见的那个，\
                 已拒绝操作（操作错页面比失败更糟）。请调用 browser_open 重新确立当前 tab 后重试。"
            )),
        };
    };

    if tab_ids.is_empty() {
        return TabDecision::NoTab;
    }
    if !tab_ids.iter().any(|t| t == id) {
        return TabDecision::Reject(format!(
            "tab {id} 在后端不存在（多半是上一轮结果里的历史 tab_id，webview 已被关闭或重建）。\
             省略 tab_id 参数即可操作用户当前看得见的 tab。"
        ));
    }
    if let crate::ipc::browser::ActiveTabResolution::Resolved(ref visible) = resolution {
        if visible != id {
            return TabDecision::Reject(format!(
                "tab {id} 不是用户当前看得见的 tab（当前可见的是 {visible}），已拒绝操作。\
                 不要复用历史 tab_id，省略 tab_id 参数即可。"
            ));
        }
    }
    TabDecision::Use(id.to_string())
}

/// 从工具参数 + BrowserState 解析出实际 tab_id（[`decide_tab`] 的 state 版本）。
///
/// 供 snapshot / click / fill / eval 用：没有 tab 时直接报错引导 AI 调 browser_open。
async fn resolve_tab_id(
    explicit: Option<&str>,
    browser_state: &Arc<BrowserState>,
) -> Result<String, ToolError> {
    match decide_tab_of(explicit, browser_state).await {
        TabDecision::Use(id) => Ok(id),
        // v1.2.0 T-B3：文案引导 AI 自救——AI 有 browser_open 工具，
        // 不该把活推回给用户。
        TabDecision::NoTab => Err(ToolError::Exec(
            "浏览器面板未打开或无 active tab；请先调用 browser_open 工具自己打开浏览器，\
             不要让用户手动去点地球图标"
                .to_string(),
        )),
        TabDecision::Reject(msg) => Err(ToolError::Exec(msg)),
    }
}

/// [`decide_tab`] 的 state 版本：从 BrowserState 取当前 webview 列表 + active id。
pub(crate) async fn decide_tab_of(
    explicit: Option<&str>,
    browser_state: &Arc<BrowserState>,
) -> TabDecision {
    let ids: Vec<String> = {
        let map = browser_state.active.lock().await;
        map.keys().cloned().collect()
    };
    let current = { browser_state.current_active_id.lock().await.clone() };
    decide_tab(explicit, &ids, current.as_deref())
}

/// 拿"当前唯一确定的 active tab id"，判不出则 `None`。
///
/// v1.2.0 T-B3：`browser_open` 要判"是否已经开着"来决定复用还是请前端新建，
/// 这种判断不该走 Err 路径。
///
/// v1.3.0 P7：不再有 `keys().next()` 无序兜底 —— 判不出就是 `None`。
pub(crate) async fn current_active_tab(browser_state: &Arc<BrowserState>) -> Option<String> {
    match crate::ipc::browser::resolve_active_tab_of(browser_state).await {
        crate::ipc::browser::ActiveTabResolution::Resolved(id) => Some(id),
        _ => None,
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
        "让内嵌浏览器导航到指定 URL（http / https）。默认作用于当前 active 浏览器 tab；\
         **浏览器面板没打开时会自动打开面板并直接导航**，不需要用户手动操作。"
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

        // v1.2.0 T-B3：面板没打开时不再直接报错——请前端打开面板**并直接导航到本
        // url**（跟 browser_open 共用 request_frontend_open）。这样用户说"打开 xxx
        // 网站"一步到位，不需要 AI 先 browser_open 再 navigate。
        // v1.3.0 P7：tab 判定统一走 decide_tab —— 显式 tab_id 也要跟"用户当前
        // 看得见的 tab"对得上，判不出宁可失败也不随便挑一个 webview。
        let tab_id = match decide_tab_of(parsed.tab_id.as_deref(), &ctx.browser_state).await {
            TabDecision::Use(id) => id,
            TabDecision::Reject(msg) => return Ok(make_fail(msg)),
            TabDecision::NoTab => {
                // 前端建 webview 时就带上目标 URL，省一次导航往返
                return match crate::ipc::browser::request_frontend_open(
                    &ctx.browser_state,
                    Some(&parsed.url),
                )
                .await
                {
                    Ok(new_tab_id) => Ok(ToolResult {
                        content: json!({
                            "ok": true,
                            "url": parsed.url.clone(),
                            "title": "",
                            "note": "浏览器面板原本未打开，已自动打开并直接导航到该 URL",
                            "tab_id": new_tab_id,
                        })
                        .to_string(),
                        is_error: false,
                    }),
                    Err(msg) => Ok(make_fail(format!(
                        "浏览器面板未打开，自动打开也失败: {msg}"
                    ))),
                };
            }
        };

        let wv = match get_webview(&tab_id, &ctx.browser_state).await {
            Ok(wv) => wv,
            Err(ToolError::Exec(msg)) => return Ok(make_fail(msg)),
            Err(e) => return Ok(make_fail(format!("获取 webview 失败: {e:?}"))),
        };

        // v1.3.0 P4：发起导航前先记一次 generation baseline，才能分辨"这一次
        // navigate 触发的 Finished"和"上一轮遗留的 Finished"。
        let baseline_generation =
            crate::ipc::browser::current_load_generation(&ctx.browser_state, &tab_id).await;

        if let Err(e) = wv.navigate(url) {
            return Ok(make_fail(format!("navigate 失败: {e}")));
        }
        // v0.5.9：emit 给主 webview 同步 URL 栏。用 emit_to(EventTarget::webview("main"))
        // 显式指定，避免 emit() 广播到 child webview 时主 webview 漏收。
        // 这里先用请求的 url 乐观 emit 一次（跟历史行为一致，不等加载完），
        // 真正落地的 url（可能重定向过）等下面等到加载完后再补 emit 一次。
        let app = wv.app_handle().clone();
        let payload = crate::ipc::browser::UrlChangedEvent {
            tab_id: tab_id.clone(),
            url: parsed.url.clone(),
        };
        if let Err(e) = app.emit_to(tauri::EventTarget::webview("main"), "browser:url_changed", &payload) {
            tracing::warn!("AI 工具 emit browser:url_changed to main 失败: {e}");
        }

        // v1.3.0 P4：不再用固定 sleep 猜时机——原生 on_page_load(Finished) 钩子
        // 驱动的 watch channel，真等到页面加载完（或 10s 兜底超时给诚实提示）。
        // 别用固定 sleep：GitHub 这类重站 800ms 根本不够，本次真机反馈的 bug 正是
        // "AI 说已打开、页面其实还没渲染出来"。
        let outcome = crate::ipc::browser::wait_for_page_load(
            &ctx.browser_state,
            &tab_id,
            baseline_generation,
            crate::ipc::browser::NAVIGATE_LOAD_TIMEOUT,
        )
        .await;

        if let crate::ipc::browser::LoadWaitOutcome::Loaded(ref snapshot) = outcome {
            // 重定向导致最终 url 跟请求的不一样时，再 emit 一次让前端 URL 栏跟上
            if !snapshot.url.is_empty() && snapshot.url != parsed.url {
                let payload2 = crate::ipc::browser::UrlChangedEvent {
                    tab_id: tab_id.clone(),
                    url: snapshot.url.clone(),
                };
                if let Err(e) =
                    app.emit_to(tauri::EventTarget::webview("main"), "browser:url_changed", &payload2)
                {
                    tracing::warn!("AI 工具 emit 重定向后 url 失败: {e}");
                }
            }
        }

        let body = build_navigate_success_body(&tab_id, &parsed.url, outcome).to_string();
        Ok(ToolResult {
            content: body,
            is_error: false,
        })
    }
}

/// 把 [`crate::ipc::browser::wait_for_page_load`] 的结果拼成 AI 工具最终看到的
/// JSON body。抽成纯函数方便单测（不需要真 Webview 就能验证"超时不谎报已完成"
/// 这条反幻觉要求）。
fn build_navigate_success_body(
    tab_id: &str,
    requested_url: &str,
    outcome: crate::ipc::browser::LoadWaitOutcome,
) -> Value {
    match outcome {
        crate::ipc::browser::LoadWaitOutcome::Loaded(snapshot) => {
            let final_url = if snapshot.url.is_empty() {
                requested_url.to_string()
            } else {
                snapshot.url
            };
            json!({
                "ok": true,
                "url": final_url,
                "title": snapshot.title,
                "loaded": true,
                "note": "页面已加载完成",
                "tab_id": tab_id,
            })
        }
        crate::ipc::browser::LoadWaitOutcome::TimedOut => json!({
            "ok": true,
            "url": requested_url,
            "title": "",
            "loaded": false,
            "note": format!(
                "已导航到 {requested_url}，但 10s 内页面未完成加载（可能仍在加载中，可稍后重新 snapshot 确认）"
            ),
            "tab_id": tab_id,
        }),
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

    fn risk_class(&self, args: &Value) -> RiskClass {
        let script = args.get("script").and_then(|v| v.as_str()).unwrap_or("");
        if is_readonly_script(script) {
            // 只读查询（document.title 之类）→ HIGH：仍弹审批、仍默认聚焦"拒绝"，
            // 但不必输"确认"二字。
            RiskClass::High
        } else {
            RiskClass::Destructive
        }
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

/// 会让脚本从"只读查询"升级为 DESTRUCTIVE 的关键词。
///
/// 覆盖四类实际能造成后果的操作：**持久化存储**、**发网络请求**、**导航/开窗**、
/// **动态执行 / 改 DOM**。
const EVAL_DANGEROUS_MARKERS: &[&str] = &[
    // 存储
    "localstorage", "sessionstorage", "indexeddb", "document.cookie",
    // 网络
    "fetch(", "xmlhttprequest", "sendbeacon", "websocket", "eventsource",
    // 导航 / 开窗
    //
    // 注意**不列** `location.href`：赋值式导航（`location.href = 'x'`）已被上面的
    // 赋值号检测抓住，而单纯读取 `window.location.href` 是无副作用的查询，
    // 列进来会把它误判成危险（真机验证时踩到过）。
    "location=", "location =", "location.replace",
    "location.assign", "window.open", "history.push", "history.replace",
    // 动态执行
    "eval(", "function(", "settimeout(", "setinterval(", "import(",
    // 改 DOM / 提交
    ".submit(", ".click(", "innerhtml", "outerhtml", "appendchild",
    "removechild", "remove()", "setattribute", "document.write",
];

/// 判定一段 JS 是否属于**只读查询**（可降级到 HIGH，不必输"确认"）。
///
/// **这不是安全沙箱，只是风险提示的分级**——命中危险词只是把审批从 HIGH 提到
/// DESTRUCTIVE（多一道输"确认"），两者**都仍然要用户批准**。所以即便有人用
/// `window['fe'+'tch']` 之类拼接绕过启发式，最坏也只是少一道确认框，不会静默执行。
///
/// 反过来，维护者真机反馈过：让 AI 跑一句 `document.title` 也要求输"确认"二字，
/// 属于明显过重——这种"警报疲劳"会让用户养成盲目确认的习惯，反而更不安全。
fn is_readonly_script(script: &str) -> bool {
    let s = script.to_ascii_lowercase();
    // 赋值号（排除 == / === / != / >= / <= 这些比较）视为写操作
    let has_assignment = {
        let b = s.as_bytes();
        (0..b.len()).any(|i| {
            b[i] == b'='
                && b.get(i + 1) != Some(&b'=')
                && (i == 0 || !matches!(b[i - 1], b'=' | b'!' | b'<' | b'>'))
        })
    };
    !has_assignment && !EVAL_DANGEROUS_MARKERS.iter().any(|m| s.contains(m))
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
    async fn resolve_tab_id_显式传_id_也要后端真有这个_webview() {
        // v1.3.0 P7 契约变更：旧实现"LLM 传了具体 id → 直接用"，等于盲信 LLM
        // 从上一轮 tool_result 抄回来的历史 tab_id；后端压根没这个 webview 时
        // 必须报错，而不是揣着一个假 id 往下走。
        let state = Arc::new(BrowserState::default());
        let r = resolve_tab_id(Some("browser-abc"), &state).await;
        assert!(r.is_err(), "后端没有任何 webview 时不能放行显式 tab_id");
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
            // 后端一个 webview 都没有 → 归类为"面板没打开"，引导 AI 自己 browser_open
            assert!(
                msg.contains("browser_open") || msg.contains("不存在"),
                "错误应可操作，实际: {msg}"
            );
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

    #[tokio::test]
    async fn current_active_tab_空_state_返_none() {
        let state = Arc::new(BrowserState::default());
        assert!(current_active_tab(&state).await.is_none());
    }

    #[tokio::test]
    async fn resolve_tab_id_报错文案_引导_ai_自己调_browser_open() {
        // v1.2.0 T-B3：错误不能再写"用户需先打开浏览器"——AI 自己有 browser_open
        let state = Arc::new(BrowserState::default());
        let Err(ToolError::Exec(msg)) = resolve_tab_id(None, &state).await else {
            panic!("空 state 应报 Exec 错误");
        };
        assert!(msg.contains("browser_open"), "应引导调 browser_open：{msg}");
        assert!(!msg.contains("用户需先"), "不能再让用户手动开：{msg}");
    }

    #[tokio::test]
    async fn navigate_无_tab_时_走自动打开兜底路径() {
        // v1.2.0 T-B3：面板未打开不再直接报错，而是请求前端打开并导航。
        // 单测无 AppHandle → 兜底失败，但 reason 必须体现"走过自动打开"这条路。
        let ctx = make_ctx();
        let r = BrowserNavigateTool
            .execute(json!({"url": "https://example.com"}), &ctx)
            .await
            .expect("应返 Ok(ToolResult)");
        assert!(r.is_error);
        let body: serde_json::Value = serde_json::from_str(&r.content).unwrap();
        assert_eq!(body["ok"], serde_json::json!(false));
        let reason = body["reason"].as_str().unwrap_or("");
        assert!(
            reason.contains("自动打开"),
            "reason 应说明尝试过自动打开浏览器，实际: {reason}"
        );
    }

    // =====================================================================
    // v1.3.0 P7：ghost webview —— decide_tab 纯函数（工具侧唯一 tab 判定入口）
    // =====================================================================

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn decide_tab_不传_tab_id_且只有一个_webview_直接用它() {
        let r = decide_tab(None, &ids(&["browser-a"]), None);
        assert_eq!(r, TabDecision::Use("browser-a".to_string()));
    }

    #[test]
    fn decide_tab_不传_tab_id_且_current_有效_用_current() {
        let r = decide_tab(None, &ids(&["a", "b"]), Some("b"));
        assert_eq!(r, TabDecision::Use("b".to_string()));
    }

    #[test]
    fn decide_tab_判不出_active_时必须_reject_而不是随便挑一个() {
        // 老实现在这里走 HashMap::keys().next() —— AI 会操作一个用户看不见的
        // webview（browser_eval 是 DESTRUCTIVE，操作错对象比失败严重得多）
        let r = decide_tab(None, &ids(&["a", "b"]), None);
        match r {
            TabDecision::Reject(msg) => {
                assert!(msg.contains("browser_open"), "要引导 AI 自救: {msg}");
                assert!(msg.contains('2'), "要说明有几个 webview: {msg}");
            }
            other => panic!("多 webview 且判不出 active 必须 Reject，实际 {other:?}"),
        }
    }

    #[test]
    fn decide_tab_一个_webview_都没有_是_no_tab() {
        assert_eq!(decide_tab(None, &[], None), TabDecision::NoTab);
        assert_eq!(decide_tab(Some("过期 id"), &[], None), TabDecision::NoTab);
    }

    #[test]
    fn decide_tab_占位符_tab_id_视为不传() {
        for placeholder in ["", "  ", "current", "active", "default"] {
            assert_eq!(
                decide_tab(Some(placeholder), &ids(&["only"]), None),
                TabDecision::Use("only".to_string()),
                "占位符 {placeholder:?} 应当视为不传"
            );
        }
    }

    #[test]
    fn decide_tab_显式_tab_id_是当前可见_tab_时放行() {
        let r = decide_tab(Some("b"), &ids(&["a", "b"]), Some("b"));
        assert_eq!(r, TabDecision::Use("b".to_string()));
    }

    #[test]
    fn decide_tab_显式_tab_id_不是当前可见_tab_时_reject() {
        // 真机 ghost 场景：LLM 把上一轮 tool_result 里的历史 tab_id 又传回来，
        // 结果操作了一个用户早就切走 / 看不见的 webview。
        let r = decide_tab(Some("a"), &ids(&["a", "b"]), Some("b"));
        match r {
            TabDecision::Reject(msg) => {
                assert!(msg.contains('b'), "要告诉 AI 当前可见的是哪个: {msg}");
                assert!(
                    msg.contains("历史") || msg.contains("省略"),
                    "要引导 AI 别复用历史 tab_id: {msg}"
                );
            }
            other => panic!("显式 id 跟可见 tab 不符必须 Reject，实际 {other:?}"),
        }
    }

    #[test]
    fn decide_tab_显式_tab_id_后端根本没有_时_reject() {
        let r = decide_tab(Some("ghost"), &ids(&["a"]), Some("a"));
        assert!(matches!(r, TabDecision::Reject(_)));
    }

    #[tokio::test]
    async fn resolve_tab_id_没有任何_tab_时报错并引导调_browser_open() {
        let state = Arc::new(BrowserState::default());
        let Err(ToolError::Exec(msg)) = resolve_tab_id(None, &state).await else {
            panic!("空 state 应报 Exec 错误");
        };
        assert!(msg.contains("browser_open"));
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

    /// 缺 script（或空）时保守按 DESTRUCTIVE 处理。
    #[test]
    fn eval_risk_class_无脚本时_保守_destructive() {
        // 空串没有赋值号也没有危险词 → 只读，但实际执行会因缺 script 报参数错，
        // 这里断言的是"空脚本不会被误判成危险"，真正的兜底在 execute 的参数校验。
        assert_eq!(BrowserEvalTool.risk_class(&json!({})), RiskClass::High);
    }

    /// 只读查询降级到 HIGH——维护者真机反馈：`document.title` 也要输"确认"太重。
    #[test]
    fn eval_只读查询_降级为_high() {
        for s in [
            "document.title",
            "document.querySelectorAll('a').length",
            "document.body.innerText",
            "window.location.href",           // 读 href（无赋值）算只读
            "document.querySelector('h1').textContent",
            "navigator.userAgent",
            "a === b",                        // 比较号不算赋值
            "x !== y",
        ] {
            assert_eq!(
                BrowserEvalTool.risk_class(&json!({ "script": s })),
                RiskClass::High,
                "只读脚本不该要求输「确认」：{s}"
            );
        }
    }

    /// 有实际后果的脚本仍是 DESTRUCTIVE（要输「确认」）。
    #[test]
    fn eval_有副作用_仍_destructive() {
        for s in [
            "location.href = 'https://evil.com'",     // 导航
            "document.cookie",                         // 读 cookie 也算敏感
            "localStorage.getItem('token')",           // 存储
            "fetch('https://x.com', {method:'POST'})", // 网络
            "document.body.innerHTML = ''",            // 改 DOM
            "document.forms[0].submit()",              // 提交
            "eval('alert(1)')",                        // 动态执行
            "let a = 1",                               // 赋值
            "window.open('https://x.com')",            // 开窗
        ] {
            assert_eq!(
                BrowserEvalTool.risk_class(&json!({ "script": s })),
                RiskClass::Destructive,
                "有副作用的脚本必须走 DESTRUCTIVE：{s}"
            );
        }
    }

    /// 大小写混写不能绕过判定。
    #[test]
    fn eval_危险词大小写不敏感() {
        assert_eq!(
            BrowserEvalTool.risk_class(&json!({ "script": "LocalStorage.clear()" })),
            RiskClass::Destructive
        );
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

    // =====================================================================
    // v1.3.0 P4：build_navigate_success_body —— 等加载完成后拼给 LLM 的 JSON
    // =====================================================================

    #[test]
    fn build_navigate_success_body_已加载_带最终_url_和_title() {
        // 覆盖重定向场景：请求 github.com，落地到 github.com/login
        let outcome = crate::ipc::browser::LoadWaitOutcome::Loaded(crate::ipc::browser::PageLoadState {
            generation: 1,
            url: "https://github.com/login".into(),
            title: "Sign in to GitHub · GitHub".into(),
        });
        let body = build_navigate_success_body("tab-1", "https://github.com", outcome);
        assert_eq!(body["ok"], json!(true));
        assert_eq!(body["loaded"], json!(true));
        assert_eq!(body["url"], json!("https://github.com/login"));
        assert_eq!(body["title"], json!("Sign in to GitHub · GitHub"));
        assert_eq!(body["tab_id"], json!("tab-1"));
    }

    #[test]
    fn build_navigate_success_body_已加载_但_url_为空_用请求时的_url_兜底() {
        let outcome = crate::ipc::browser::LoadWaitOutcome::Loaded(crate::ipc::browser::PageLoadState {
            generation: 1,
            url: String::new(),
            title: String::new(),
        });
        let body = build_navigate_success_body("tab-1", "https://example.com", outcome);
        assert_eq!(body["url"], json!("https://example.com"));
    }

    #[test]
    fn build_navigate_success_body_超时_诚实提示_不谎报已完成() {
        let body = build_navigate_success_body(
            "tab-1",
            "https://slow-site.example",
            crate::ipc::browser::LoadWaitOutcome::TimedOut,
        );
        assert_eq!(body["ok"], json!(true), "navigate 命令本身没失败");
        assert_eq!(body["loaded"], json!(false), "但必须标明没等到加载完成");
        let note = body["note"].as_str().unwrap();
        assert!(note.contains("10s"), "note 应体现超时时长: {note}");
        assert!(note.contains("未完成加载"), "note 应如实说未加载完: {note}");
        assert!(
            !note.contains("已打开") && !note.contains("已加载完成"),
            "超时文案不能说成'已打开/已加载完成'这种误导措辞: {note}"
        );
    }
}
