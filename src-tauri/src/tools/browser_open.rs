//! v1.2.0 T-B3：`browser_open` 工具 —— **让 AI 自己打开内嵌浏览器面板**。
//!
//! 真机 smoke 暴露的能力缺口：AI 只会回"请你在左侧活动栏点地球图标"，
//! 因为所有 browser_* 工具在没有 active tab 时直接报错。
//!
//! 为什么需要前端参与：`browser_open_tab` 要 bounds（webview 的屏幕位置 / 大小），
//! bounds 只有前端布局算得出（BrowserPanel 的 ResizeObserver 上报）。所以本工具
//! 走 [`crate::ipc::browser::request_frontend_open`]：emit `browser:open_requested`
//! → 前端走跟用户点地球图标**完全相同**的 store 路径建 tab → 调
//! `browser_open_result` 回报 tab_id → 本工具 await 到才返回成功。
//!
//! **防谎报**：拿不到真 tab_id 一律返 `{ok: false, reason}`，绝不说"已打开"。

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{Value, json};

use super::browser::{BrowserNavigateTool, current_active_tab};
use super::{RiskClass, Tool, ToolContext, ToolError, ToolResult};
use crate::ui_error::{plain, ui_err};

pub struct BrowserOpenTool;

#[derive(Deserialize)]
struct OpenArgs {
    /// 可选；打开后直接导航到这个 URL。不传 → 开空白页。
    #[serde(default)]
    url: Option<String>,
}

#[async_trait]
impl Tool for BrowserOpenTool {
    fn name(&self) -> &str {
        "browser_open"
    }

    fn description(&self) -> &str {
        "打开 aitm 的内嵌浏览器面板。需要浏览器时**你自己调这个工具**，\
         绝不要让用户手动去点活动栏的地球图标。可选 url：给了就直接导航过去，\
         不给就开空白页。浏览器已经打开时复用当前 tab（不会重复开）。"
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "可选；打开后直接导航到的完整 URL（含 http:// 或 https://）。不传则开空白页"
                }
            }
        })
    }

    /// 打开面板本身无破坏性（不改文件 / 不执行命令），走 Low 免审批——
    /// 否则每次都弹确认框会打断"AI 自己干活"的体验。
    fn risk_class(&self, _args: &Value) -> RiskClass {
        RiskClass::Low
    }

    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<ToolResult, ToolError> {
        let parsed: OpenArgs = serde_json::from_value(args)
            .map_err(|e| super::browser::invalid_args("browser_open", &e))?;
        let url = parsed
            .url
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());

        // 跟 browser_navigate 一致的结构化失败（v0.9.2 HR5-4 反幻觉约定）：
        // 失败也返 Ok(ToolResult) 但 content 里 ok=false，让 LLM 看得见失败信号。
        // reason 传入时可能是编码：界面显示翻译，模型看到的 JSON 里仍是中文原文
        let make_fail = |reason: String| -> ToolResult {
            let body = json!({ "ok": false, "reason": plain(&reason) }).to_string();
            ToolResult {
                content: ui_err("tool.browser.openFailed", &[("reason", reason)], body),
                is_error: true,
            }
        };

        // URL 校验前置：不论浏览器开没开，非法 scheme 都给明确信号
        if let Some(u) = url.as_deref() {
            match u.parse::<tauri::Url>() {
                Ok(parsed_url) => {
                    if !matches!(parsed_url.scheme(), "http" | "https") {
                        return Ok(make_fail(ui_err(
                            "tool.browser.schemeNotAllowed",
                            &[("scheme", parsed_url.scheme().to_string())],
                            format!(
                                "不允许的 URL scheme: {}（仅 http/https）",
                                parsed_url.scheme()
                            ),
                        )));
                    }
                }
                Err(e) => {
                    return Ok(make_fail(ui_err(
                        "tool.browser.urlParseFailed",
                        &[("error", e.to_string())],
                        format!("URL 解析失败: {e}"),
                    )));
                }
            }
        }

        // v1.3.0 P7：后端有多个 webview 却判不出哪个可见（前后端失步）时，
        // **绝不**再新开一个 tab（那只会多出一个 ghost），而是先请前端把它自己的
        // activeKey 重新 set_active 一遍——前端才是"用户看到什么"的唯一真相源。
        // 不带 url 是刻意的：这一步只修状态，导航交给下面的复用分支统一处理。
        if let crate::ipc::browser::ActiveTabResolution::Ambiguous(_) =
            crate::ipc::browser::resolve_active_tab_of(&ctx.browser_state).await
        {
            if let Err(msg) =
                crate::ipc::browser::request_frontend_open(&ctx.browser_state, None).await
            {
                return Ok(make_fail(ui_err(
                    "tool.browser.tabStateInconsistent",
                    &[("error", msg.clone())],
                    format!("浏览器当前 tab 状态不一致，尝试让前端重新确立失败: {msg}"),
                )));
            }
        }

        // 已经有 active tab → 复用，不重复开面板
        if let Some(tab_id) = current_active_tab(&ctx.browser_state).await {
            return match url {
                // 带 url：委托 browser_navigate 走完整导航路径（URL 校验 +
                // emit url_changed 同步 URL 栏 + v1.3.0 P4 等页面真加载完），
                // 零重复实现
                Some(u) => {
                    BrowserNavigateTool
                        .execute(json!({ "url": u, "tab_id": tab_id }), ctx)
                        .await
                }
                None => Ok(ToolResult {
                    content: already_open_content(&tab_id),
                    is_error: false,
                }),
            };
        }

        // 没有 active tab → 请前端打开（前端建 webview 时直接带上 url）
        match crate::ipc::browser::request_frontend_open(&ctx.browser_state, url.as_deref()).await {
            Ok(tab_id) => {
                // v1.3.0 P4：带 url 时，webview 一创建就直接开始加载这个 url——
                // 跟 browser_navigate 是同一条"navigate 触发即返回"的时序坑，
                // 这里也补等页面真正加载完（或诚实报超时），不谎报"已打开"。
                // baseline 传 0：新建 tab 的 watch channel 从
                // `PageLoadState::default()`（generation=0）开始。
                let (final_url, final_title, loaded) = if url.is_some() {
                    match crate::ipc::browser::wait_for_page_load(
                        &ctx.browser_state,
                        &tab_id,
                        0,
                        crate::ipc::browser::NAVIGATE_LOAD_TIMEOUT,
                    )
                    .await
                    {
                        crate::ipc::browser::LoadWaitOutcome::Loaded(s) => (s.url, s.title, true),
                        crate::ipc::browser::LoadWaitOutcome::TimedOut => {
                            (String::new(), String::new(), false)
                        }
                    }
                } else {
                    // 空白页不涉及"加载完成"这件事
                    (String::new(), String::new(), true)
                };

                Ok(ToolResult {
                    content: build_open_success_content(
                        &tab_id,
                        url.as_deref(),
                        &final_url,
                        &final_title,
                        loaded,
                    ),
                    is_error: false,
                })
            }
            Err(msg) => Ok(make_fail(ui_err(
                "tool.browser.openBrowserFailed",
                &[("error", msg.clone())],
                format!("打开内嵌浏览器失败: {msg}"),
            ))),
        }
    }
}

/// 浏览器已开着、复用当前 tab 的 content（编码；`plain()` 还原为模型看到的中文 JSON）。
fn already_open_content(tab_id: &str) -> String {
    let body = json!({
        "ok": true,
        "already_open": true,
        "tab_id": tab_id,
        "note": "浏览器面板已经打开，复用当前 tab；要换页调 browser_navigate",
    })
    .to_string();
    ui_err("tool.browser.alreadyOpen", &[], body)
}

/// 新开浏览器成功后的 content。`url` 是请求的地址（`None` 即空白页），
/// `final_url` / `final_title` 是加载完成后的落地信息（可能为空）。
fn build_open_success_content(
    tab_id: &str,
    url: Option<&str>,
    final_url: &str,
    final_title: &str,
    loaded: bool,
) -> String {
    let requested_url = url.unwrap_or("about:blank");
    let display_url = if final_url.is_empty() {
        requested_url
    } else {
        final_url
    };
    // 编码必须写成字面量（测试会扫描源码核对语言包），所以每个分支各自调 ui_err
    let body = |note: &str| {
        json!({
            "ok": true,
            "already_open": false,
            "tab_id": tab_id,
            "url": display_url,
            "title": final_title,
            "loaded": loaded,
            "note": note,
        })
        .to_string()
    };
    match (url, loaded) {
        (Some(_), true) => ui_err(
            "tool.browser.openedLoaded",
            &[("url", display_url.to_string())],
            body(&format!("已打开内嵌浏览器并加载完成: {display_url}")),
        ),
        (Some(u), false) => ui_err(
            "tool.browser.openedLoadTimeout",
            &[("url", u.to_string())],
            body(&format!(
                "已打开内嵌浏览器并导航到 {u}，但 10s 内页面未完成加载（可能仍在加载中，可稍后重新 snapshot 确认）"
            )),
        ),
        (None, _) => ui_err(
            "tool.browser.openedBlank",
            &[],
            body("已打开内嵌浏览器（空白页）"),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::browser::BrowserState;
    use std::sync::Arc;

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
    fn risk_class_是_low_不弹审批() {
        assert_eq!(BrowserOpenTool.risk_class(&json!({})), RiskClass::Low);
    }

    #[test]
    fn name_schema_正确_且_description_禁止推给用户() {
        assert_eq!(BrowserOpenTool.name(), "browser_open");
        let schema = BrowserOpenTool.input_schema();
        assert_eq!(schema["type"], "object");
        assert!(schema["properties"]["url"].is_object());
        // url 是可选的 → 不能有 required
        assert!(schema.get("required").is_none());
        let desc = BrowserOpenTool.description();
        assert!(desc.contains("地球图标"), "描述要明确禁止推给用户: {desc}");
    }

    #[tokio::test]
    async fn 无_app_handle_时_返结构化失败_不谎报已打开() {
        // 单测环境没有 Tauri app → 必须 ok=false，绝不能说"已打开"
        let ctx = make_ctx();
        let r = BrowserOpenTool
            .execute(json!({}), &ctx)
            .await
            .expect("失败也应返 Ok(ToolResult)");
        assert!(r.is_error);
        let body: Value = serde_json::from_str(&plain(&r.content)).unwrap();
        assert_eq!(body["ok"], json!(false));
        assert!(!r.content.contains("已打开内嵌浏览器"));
        // pending 不残留
        assert_eq!(ctx.browser_state.pending_opens.lock().await.len(), 0);
    }

    #[tokio::test]
    async fn 非_http_scheme_直接拒绝_不走前端通道() {
        let ctx = make_ctx();
        let r = BrowserOpenTool
            .execute(json!({"url": "file:///etc/passwd"}), &ctx)
            .await
            .unwrap();
        assert!(r.is_error);
        let body: Value = serde_json::from_str(&plain(&r.content)).unwrap();
        assert_eq!(body["ok"], json!(false));
        assert!(
            body["reason"].as_str().unwrap_or("").contains("scheme"),
            "reason 应提 scheme: {}",
            body["reason"]
        );
    }

    #[tokio::test]
    async fn 空字符串_url_视为不传() {
        // LLM 常传空串占位；不能当非法 URL 报 parse 错
        let ctx = make_ctx();
        let r = BrowserOpenTool
            .execute(json!({"url": "   "}), &ctx)
            .await
            .unwrap();
        let body: Value = serde_json::from_str(&plain(&r.content)).unwrap();
        // 无 AppHandle 仍会失败，但 reason 必须是"打开失败"而非"URL 解析失败"
        assert_eq!(body["ok"], json!(false));
        let reason = body["reason"].as_str().unwrap_or("");
        assert!(
            !reason.contains("URL 解析失败"),
            "空串不该报 URL 错: {reason}"
        );
    }

    #[tokio::test]
    async fn 已有_active_tab_时_复用_不请求前端新开() {
        // current_active_id 指向 active map 里存在的 tab 才算"已打开"；
        // 单测构造不出真 Webview，所以这里验的是"没有 active tab 就必须走
        // 请求前端"这条互补分支（复用分支的真机行为由 smoke 覆盖）。
        let ctx = make_ctx();
        assert!(current_active_tab(&ctx.browser_state).await.is_none());
        let r = BrowserOpenTool.execute(json!({}), &ctx).await.unwrap();
        // 走了请求前端的路径（无 AppHandle → 失败），而不是"复用"分支
        assert!(r.content.contains("打开内嵌浏览器失败"));
        assert!(!r.content.contains("already_open\":true"));
    }

    #[tokio::test]
    async fn url_字段类型不对_返_invalidargs() {
        let ctx = make_ctx();
        let r = BrowserOpenTool.execute(json!({"url": 123}), &ctx).await;
        match r {
            Err(ToolError::InvalidArgs(msg)) => assert!(msg.contains("browser_open")),
            other => panic!("应是 InvalidArgs，实际 {other:?}"),
        }
    }

    // =====================================================================
    // 结果编码化：界面按语言显示，交给模型时 plain() 还原中文
    // =====================================================================

    fn coded(s: &str) -> Value {
        serde_json::from_str(s).unwrap_or_else(|e| panic!("应是编码字符串: {e}: {s}"))
    }

    #[tokio::test]
    async fn 应该_当_scheme_不允许时_失败结果带编码且模型看到原_json() {
        let ctx = make_ctx();
        let r = BrowserOpenTool
            .execute(json!({"url": "ftp://x.test"}), &ctx)
            .await
            .unwrap();
        let v = coded(&r.content);
        assert_eq!(v["code"], "tool.browser.openFailed");
        assert_eq!(
            coded(v["params"]["reason"].as_str().unwrap())["code"],
            "tool.browser.schemeNotAllowed"
        );
        let body: Value = serde_json::from_str(&crate::ui_error::plain(&r.content)).unwrap();
        assert_eq!(body["ok"], json!(false));
        assert_eq!(
            body["reason"],
            json!("不允许的 URL scheme: ftp（仅 http/https）")
        );
    }

    #[tokio::test]
    async fn 应该_当前端打不开浏览器时_reason_带打开失败编码() {
        let ctx = make_ctx();
        let r = BrowserOpenTool.execute(json!({}), &ctx).await.unwrap();
        let v = coded(&r.content);
        assert_eq!(v["code"], "tool.browser.openFailed");
        let reason = coded(v["params"]["reason"].as_str().unwrap());
        assert_eq!(reason["code"], "tool.browser.openBrowserFailed");
        assert!(crate::ui_error::plain(&r.content).contains("打开内嵌浏览器失败: "));
    }

    #[tokio::test]
    async fn 应该_当参数类型不对时_报带工具名的编码参数错误() {
        let ctx = make_ctx();
        let Err(ToolError::InvalidArgs(msg)) =
            BrowserOpenTool.execute(json!({"url": 1}), &ctx).await
        else {
            panic!("应是 InvalidArgs");
        };
        let v = coded(&msg);
        assert_eq!(v["code"], "tool.browser.invalidArgs");
        assert_eq!(v["params"]["tool"], "browser_open");
    }

    #[test]
    fn 应该_当浏览器已打开时_复用结果带编码且原文提示不变() {
        let c = already_open_content("t1");
        assert_eq!(coded(&c)["code"], "tool.browser.alreadyOpen");
        let body: Value = serde_json::from_str(&crate::ui_error::plain(&c)).unwrap();
        assert_eq!(body["already_open"], json!(true));
        assert_eq!(
            body["note"],
            json!("浏览器面板已经打开，复用当前 tab；要换页调 browser_navigate")
        );
    }

    #[test]
    fn 应该_按加载情况为新开浏览器的结果选对编码和原文提示() {
        let cases: [(Option<&str>, bool, &str, &str); 3] = [
            (
                Some("https://a.test"),
                true,
                "tool.browser.openedLoaded",
                "已打开内嵌浏览器并加载完成: https://a.test/x",
            ),
            (
                Some("https://a.test"),
                false,
                "tool.browser.openedLoadTimeout",
                "已打开内嵌浏览器并导航到 https://a.test，但 10s 内页面未完成加载（可能仍在加载中，可稍后重新 snapshot 确认）",
            ),
            (
                None,
                true,
                "tool.browser.openedBlank",
                "已打开内嵌浏览器（空白页）",
            ),
        ];
        for (url, loaded, code, note) in cases {
            let c = build_open_success_content("t1", url, "https://a.test/x", "T", loaded);
            assert_eq!(coded(&c)["code"], code);
            let body: Value = serde_json::from_str(&crate::ui_error::plain(&c)).unwrap();
            assert_eq!(body["note"], json!(note));
            assert_eq!(body["tab_id"], json!("t1"));
        }
    }
}
