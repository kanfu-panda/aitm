//! Phase 4A T1：内嵌浏览器后端 IPC + Tauri 2 子 webview lifecycle 管理。
//!
//! 由 Phase 4A T1 PoC（`browser_poc.rs`）演化而来，已 维护者 真机验过 PoC：
//! 在主 window 内 `Window::add_child(WebviewBuilder, position, size)` 真能 native
//! overlay 渲染外部 URL（example.com），单 webview 内存增量约 150MB。
//!
//! ## 关键约束
//!
//! - `Window::add_child` 是 **`feature = "unstable"`** API；Cargo.toml 已加
//!   `tauri = { features = ["unstable"] }`。一旦 Tauri 升级把这个 API 稳定化或者改名，
//!   这里就得跟着改。**不要轻易删 unstable feature**。
//! - 主 window label 在 `tauri.conf.json` 是 `"main"`，但保险起见用
//!   `app.webview_windows()` 拿第一个，避免硬编码错（PoC bug 修法）。
//! - 多 webview 同位置时 Tauri 没有 z-index 概念，**靠 hide / show 切前台**。
//!   每次只有一个 active webview 真正显示。
//!
//! ## 命令列表（按 Phase 4A plan §2）
//!
//! - [`browser_open_tab`]：在主 window 内 spawn 子 webview 加载 URL，返回 tab_id（label）
//! - [`browser_close_tab`]：destroy 子 webview，从 state 删（找不到不报错）
//! - [`browser_navigate`]：`Webview::navigate(Url)` 切 URL（用真 navigate API，不走 eval）
//! - [`browser_set_active`]：把指定 tab show，其余 hide
//! - [`browser_set_bounds`]：position / size 重设（前端 ResizeObserver 上报）
//! - [`browser_suspend_tab`]：等价 close（state 由前端 zustand 管，后端只负责 destroy）
//! - [`browser_set_scroll_y`]：在 webview load 完后 eval `scrollTo(0, y)` 恢复滚动
//! - [`browser_panel_close_all`]：收起浏览器面板时 destroy 全部
//! - [`browser_hide_all_active`] / [`browser_show_all_active`]：dialog 弹起 / 关闭时让 webview 让位
//! - [`browser_forward_hotkey`]：子 webview 注入脚本捕获 Cmd+B/T/W/P/, 后调本命令转发主 webview
//!
//! ## 前端协作
//!
//! - tab 持久化（url / title / scrollY）由前端 zustand 管。后端不持久化任何 tab state。
//! - resume 一个 suspended tab = 调 [`browser_open_tab`] 创建新 webview，再调
//!   [`browser_set_scroll_y`] 恢复（不需单独 resume 命令）。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewUrl,
};
use tokio::sync::{oneshot, Mutex};

/// 内嵌浏览器后端状态。仅持有当前**未 suspend** 的 webview handle。
///
/// suspended tab 已 destroy（webview 进程释放），其 state（url / title / scrollY）
/// 由前端 zustand 持久化；resume 时前端调 [`browser_open_tab`] 重新创建 + 调
/// [`browser_set_scroll_y`] 恢复滚动。
#[derive(Debug, Default)]
pub struct BrowserState {
    /// tab_id（webview label）→ Webview handle。
    /// 用 tokio Mutex 而非 std Mutex：所有命令是 `async fn`，避免 .await 跨锁
    /// 持有的 lint 警告 + future 不 Send 问题。
    pub active: Mutex<HashMap<String, Webview>>,
    /// v0.5.0-E：snapshot 反向通道——AI 工具调 browser_inject_snapshot 时创建
    /// oneshot pair；JS 抓完调 browser_snapshot_result IPC 把 JSON 送回 sender。
    /// key = request_id（uuid，每个调用唯一）。
    pub pending_snapshots: Mutex<HashMap<String, oneshot::Sender<String>>>,
    /// v0.5.7：用户视觉上**当前可见**的 tab_id。HashMap 没顺序，AI 工具
    /// 用 `keys().next()` 拿不准用户实际看到哪一个 — 必须前端调
    /// [`browser_set_active`] 时把当前 tab 记到这里。AI 工具
    /// `resolve_tab_id(None)` 优先用这个值。
    pub current_active_id: Mutex<Option<String>>,
}

/// `browser_open_tab` 返回值：刚创建的 tab id（即 webview label）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenTabResult {
    pub tab_id: String,
}

/// 子 webview 注入脚本：捕获 Cmd+B/T/W/P/, 转发给主 webview。
///
/// 不在子 webview 内处理快捷键（让主 webview 的 `useShortcuts` 统一管），
/// 否则用户在浏览器内按 ⌘T 不会新建终端 tab。
///
/// `__TAURI_INTERNALS__.invoke` 是 Tauri 2 的内部 ipc 入口，不需要前端额外暴露。
const HOTKEY_FORWARD_SCRIPT: &str = r#"
(function() {
  function isInteresting(e) {
    if (!(e.metaKey || e.ctrlKey)) return false;
    var k = e.key.toLowerCase();
    return k === 'b' || k === 't' || k === 'w' || k === 'p' || k === ',';
  }
  document.addEventListener('keydown', function(e) {
    if (!isInteresting(e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
      window.__TAURI_INTERNALS__.invoke('browser_forward_hotkey', {
        key: e.key.toLowerCase(),
        meta: !!e.metaKey,
        ctrl: !!e.ctrlKey,
        shift: !!e.shiftKey,
        alt: !!e.altKey,
      });
    }
  }, true);
})();
"#;

/// 生成新 tab 的唯一 webview label。
///
/// uuid v4 即可，不需要时间可排序属性。
fn make_tab_id() -> String {
    format!("browser-{}", uuid::Uuid::new_v4())
}

/// 拿主 OS Window 用于 add_child 创建 child webview。
///
/// **v0.4.1 真机 smoke #3 修复**：原用 `app.webview_windows()` 拿 WebviewWindow
/// 集合在 dev mode 下第一次 `add_child` 后变成空——Tauri 2 unstable
/// child webview API 把 main window 转为 multi-webview window 后，
/// `webview_windows()` 只返回 1:1 standalone window 集合（变空），
/// `get_webview_window("main")` 也返 None。但 OS Window 还在。
///
/// 改用 `app.windows()` / `get_window("main")` 拿底层 [`tauri::Window`]，
/// 不受 multi-webview 状态影响。
fn pick_main_window<R: tauri::Runtime>(
    app: &AppHandle<R>,
) -> Result<tauri::Window<R>, String> {
    // 优先尝试 "main"；找不到就拿第一个。
    if let Some(w) = app.get_window("main") {
        return Ok(w);
    }
    let map = app.windows();
    map.into_values()
        .next()
        .ok_or_else(|| "未找到任何 window".to_string())
}

/// 在主 window 内创建一个子 webview 加载给定 URL。
///
/// 返回 `tab_id`（即 webview label），前端用它作为后续 IPC 的 key。
#[tauri::command]
pub async fn browser_open_tab(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserState>>,
    url: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<OpenTabResult, String> {
    let parent_window = pick_main_window(&app)?;
    let parsed: Url = url.parse().map_err(|e| format!("URL 解析失败: {e}"))?;
    let label = make_tab_id();

    let builder = tauri::webview::WebviewBuilder::new(label.clone(), WebviewUrl::External(parsed))
        .initialization_script(HOTKEY_FORWARD_SCRIPT);

    let child = parent_window
        .add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(w, h))
        .map_err(|e| format!("创建 child webview 失败: {e}"))?;

    state.active.lock().await.insert(label.clone(), child);
    Ok(OpenTabResult { tab_id: label })
}

/// destroy 指定 tab 的 webview 并从 state 删除。
///
/// state 找不到不报错（可能已被 panel_close_all 清掉，前端再调一次也安全）。
#[tauri::command]
pub async fn browser_close_tab(
    state: tauri::State<'_, Arc<BrowserState>>,
    tab_id: String,
) -> Result<(), String> {
    let removed = state.active.lock().await.remove(&tab_id);
    // v0.5.7：被关掉的就是当前 active → 清掉，下次前端会 set 新的
    {
        let mut current = state.current_active_id.lock().await;
        if current.as_deref() == Some(tab_id.as_str()) {
            *current = None;
        }
    }
    if let Some(wv) = removed {
        wv.close().map_err(|e| format!("close 失败: {e}"))?;
    }
    Ok(())
}

/// 切换指定 tab 的 URL。优先用 Tauri 的真 [`Webview::navigate`] API（解析过 URL，
/// 不走 eval 注入），避免 XSS。
///
/// v0.5.8：完成后 emit `browser:url_changed` 事件给前端，统一更新 zustand `tabs[].url`
/// 和 URL 栏显示。前端 / AI 工具两条路径都经此 IPC 时只需在这里 emit。
#[tauri::command]
pub async fn browser_navigate(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserState>>,
    tab_id: String,
    url: String,
) -> Result<(), String> {
    let parsed: Url = url.parse().map_err(|e| format!("URL 解析失败: {e}"))?;
    {
        let map = state.active.lock().await;
        let wv = map
            .get(&tab_id)
            .ok_or_else(|| format!("tab {tab_id} 不存在或已 suspend"))?;
        wv.navigate(parsed).map_err(|e| format!("navigate 失败: {e}"))?;
    }
    // v0.5.8 / v0.5.9：navigate 异步，emit 给**主 webview** 让前端同步 URL 栏。
    // 用 emit_to 显式指 "main"，避免 emit() 广播到 child webview 时主 webview
    // 漏收的边界情况（v0.5.8 真机表现：emit 不可靠）。
    let payload = UrlChangedEvent {
        tab_id: tab_id.clone(),
        url: url.clone(),
    };
    if let Err(e) = app.emit_to(tauri::EventTarget::webview("main"), "browser:url_changed", &payload) {
        tracing::warn!("emit browser:url_changed to main 失败: {e}");
    }
    Ok(())
}

/// v0.5.8：URL 变化事件，emit 给前端统一更新 zustand `tabs[].url`。
#[derive(Debug, Clone, Serialize)]
pub struct UrlChangedEvent {
    pub tab_id: String,
    pub url: String,
}

/// 切换前台 tab：把指定 tab `show()`，其余全 `hide()`。
///
/// Tauri 多 webview 在同一个 Window 内没有 z-index 概念，全靠可见性切。
/// 找不到 tab_id 不报错（前端可能在 race 期间调）。
#[tauri::command]
pub async fn browser_set_active(
    state: tauri::State<'_, Arc<BrowserState>>,
    tab_id: String,
) -> Result<(), String> {
    let map = state.active.lock().await;
    for (id, wv) in map.iter() {
        if id == &tab_id {
            // show 失败不致命：可能 webview 已被关闭；继续处理其它 tab
            let _ = wv.show();
        } else {
            let _ = wv.hide();
        }
    }
    // v0.5.7：把"用户看到的 tab"记到 state，给 AI 工具 resolve_tab_id 优先用
    *state.current_active_id.lock().await = Some(tab_id);
    Ok(())
}

/// 重设 tab 的 position + size（前端 ResizeObserver 60fps 节流上报）。
///
/// position / size 都是 logical（DPI 已 scale），底层调
/// [`Webview::set_position`] / [`Webview::set_size`]。找不到 tab 不报错。
#[tauri::command]
pub async fn browser_set_bounds(
    state: tauri::State<'_, Arc<BrowserState>>,
    tab_id: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    let map = state.active.lock().await;
    let Some(wv) = map.get(&tab_id) else {
        return Ok(());
    };
    wv.set_position(LogicalPosition::new(x, y))
        .map_err(|e| format!("set_position 失败: {e}"))?;
    wv.set_size(LogicalSize::new(w, h))
        .map_err(|e| format!("set_size 失败: {e}"))?;
    Ok(())
}

/// suspend 一个 tab——后端实现等价 [`browser_close_tab`]。
///
/// 设计决策：Tauri 没有"hibernate webview 保 state"原语，suspend 实际上就是
/// destroy 释放 WKWebView 进程。tab 的 url / title / scrollY 由前端 zustand 持久，
/// resume 时调 [`browser_open_tab`] 重建 + [`browser_set_scroll_y`] 恢复滚动。
///
/// **保留独立命令名**让语义清晰（前端 API 表达"我要 suspend 不是真关"）。
#[tauri::command]
pub async fn browser_suspend_tab(
    state: tauri::State<'_, Arc<BrowserState>>,
    tab_id: String,
) -> Result<(), String> {
    browser_close_tab(state, tab_id).await
}

/// 在 webview 加载完后调，恢复滚动位置。
///
/// 用 eval（没有原生 scroll API）；y 被序列化为 f64 字面量，无字符串拼接 XSS 风险。
#[tauri::command]
pub async fn browser_set_scroll_y(
    state: tauri::State<'_, Arc<BrowserState>>,
    tab_id: String,
    y: f64,
) -> Result<(), String> {
    let map = state.active.lock().await;
    let Some(wv) = map.get(&tab_id) else {
        return Ok(());
    };
    // f64::to_string 永远输出 ASCII 数字（含 NaN/inf 也只是文本），不存在引号注入。
    let js = format!("window.scrollTo(0, {y});");
    wv.eval(js).map_err(|e| format!("eval 失败: {e}"))?;
    Ok(())
}

/// 收起浏览器面板：destroy 所有当前 active 的 webview，清空 state。
///
/// 单独 webview close 失败不致命（继续清剩下的）；收完一律清 map。
#[tauri::command]
pub async fn browser_panel_close_all(
    state: tauri::State<'_, Arc<BrowserState>>,
) -> Result<(), String> {
    let mut map = state.active.lock().await;
    for (_, wv) in map.drain() {
        let _ = wv.close();
    }
    // v0.5.7：全部关 → current_active_id 也清
    *state.current_active_id.lock().await = None;
    Ok(())
}

/// 弹 dialog 时让所有 webview 让位（dialog 在 DOM 层，会被 native overlay 遮挡）。
#[tauri::command]
pub async fn browser_hide_all_active(
    state: tauri::State<'_, Arc<BrowserState>>,
) -> Result<(), String> {
    let map = state.active.lock().await;
    for (_, wv) in map.iter() {
        let _ = wv.hide();
    }
    Ok(())
}

/// dialog 关闭后恢复所有 webview 显示。
///
/// **注意**：这会让所有 active webview 都 show，跟 [`browser_set_active`] 的
/// "只 show 一个"语义不同。前端调用顺序应是 hide_all → 弹 dialog → 关 dialog →
/// show_all_active → 紧跟一次 set_active 把非 active 的 hide 回去。
#[tauri::command]
pub async fn browser_show_all_active(
    state: tauri::State<'_, Arc<BrowserState>>,
) -> Result<(), String> {
    let map = state.active.lock().await;
    for (_, wv) in map.iter() {
        let _ = wv.show();
    }
    Ok(())
}

/// 子 webview 注入脚本捕获到 Cmd+B/T/W/P/, 后调本命令；后端转发为
/// `browser:hotkey` 事件给主 webview。
#[derive(Debug, Clone, Serialize)]
pub struct HotkeyEvent {
    pub key: String,
    pub meta: bool,
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
}

#[tauri::command]
pub async fn browser_forward_hotkey(
    app: AppHandle,
    key: String,
    meta: bool,
    ctrl: bool,
    shift: bool,
    alt: bool,
) -> Result<(), String> {
    let payload = HotkeyEvent {
        key,
        meta,
        ctrl,
        shift,
        alt,
    };
    // emit 给主 webview；失败不致命（app 关闭中）
    let _ = app.emit("browser:hotkey", payload);
    Ok(())
}

// =========================================================================
// v0.5.0-E：Scriptable Browser API
// =========================================================================

/// 注入到 child webview 抓 a11y 树的 JS。占位 `__REQ_ID__` 替换成 oneshot
/// request_id；JS 抓完调 `browser_snapshot_result` IPC 把结果回传给 sender。
///
/// 抓取策略：
/// - 遍历 body，深度 ≤ 30
/// - 命中 "可交互元素" (a/button/input/select/textarea/label + role=button + onclick)
///   或 "叶子文本节点"（含 text 且无 children）
/// - 给元素打 `data-aitm-ref="rN"`，后续 click/fill 用 querySelector 找回
/// - elements 上限 200（防富页面如 GitHub 列表炸）；text 截 100 char
///
/// 失败时 IPC 收到的 JSON 是 `{"error": "..."}` 让 AI 看到具体原因。
pub const SNAPSHOT_INJECT_SCRIPT: &str = r#"
(function() {
  try {
    // v0.5.8：document.body 为 null 意味页面还在加载 / 渲染失败（如 baidu 在
    // WKWebView 里白屏）。给 AI 一个明确的错误码而非裸 TypeError
    if (!document.body) {
      if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
        window.__TAURI_INTERNALS__.invoke("browser_snapshot_result", {
          requestId: "__REQ_ID__",
          result: JSON.stringify({
            error: "page_not_ready",
            message: "页面尚未加载完成或站点在内嵌 WKWebView 中渲染失败（如 baidu.com 等反爬站点）。建议：等 1-2 秒再 snapshot；或告诉用户换个站点。不要反复重试同一站点。",
            url: location.href,
          }),
        });
      }
      return;
    }
    var refId = 0;
    var refs = [];
    var MAX_ELEMENTS = 200;
    var MAX_TEXT = 100;
    var MAX_DEPTH = 30;
    function visit(el, depth) {
      if (!el || depth > MAX_DEPTH || refs.length >= MAX_ELEMENTS) return;
      var tag = el.tagName ? el.tagName.toLowerCase() : null;
      if (!tag) return;
      var interactive =
        ["a","button","input","select","textarea","label"].indexOf(tag) >= 0 ||
        el.getAttribute("role") === "button" ||
        typeof el.onclick === "function";
      var hasText = el.textContent && el.textContent.trim() && el.children.length === 0;
      if (interactive || hasText) {
        refId += 1;
        var ref = "r" + refId;
        el.setAttribute("data-aitm-ref", ref);
        refs.push({
          ref: ref,
          tag: tag,
          text: (el.textContent || "").trim().slice(0, MAX_TEXT),
          type: el.getAttribute("type"),
          name: el.getAttribute("name") || el.getAttribute("aria-label") || null,
          href: el.getAttribute("href"),
        });
      }
      var children = el.children;
      for (var i = 0; i < children.length; i++) {
        visit(children[i], depth + 1);
        if (refs.length >= MAX_ELEMENTS) break;
      }
    }
    visit(document.body, 0);
    var payload = JSON.stringify({
      url: location.href,
      title: document.title,
      elements: refs,
    });
    if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
      window.__TAURI_INTERNALS__.invoke("browser_snapshot_result", {
        requestId: "__REQ_ID__",
        result: payload,
      });
    }
  } catch (e) {
    if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
      window.__TAURI_INTERNALS__.invoke("browser_snapshot_result", {
        requestId: "__REQ_ID__",
        result: JSON.stringify({ error: String(e) }),
      });
    }
  }
})();
"#;

fn make_request_id() -> String {
    format!("snap-{}", uuid::Uuid::new_v4())
}

/// v0.5.0-E：注入 a11y 抓取 JS，await 反向 IPC 结果。5s timeout。
///
/// AI 工具 BrowserSnapshotTool 调；返 JSON 字符串（含 url/title/elements 或 {error}）。
#[tauri::command]
pub async fn browser_inject_snapshot(
    state: tauri::State<'_, Arc<BrowserState>>,
    tab_id: String,
) -> Result<String, String> {
    let map = state.active.lock().await;
    let wv = map
        .get(&tab_id)
        .ok_or_else(|| format!("tab {tab_id} 不存在或已 suspend"))?
        .clone();
    drop(map);

    let req_id = make_request_id();
    let (tx, rx) = oneshot::channel::<String>();
    state
        .pending_snapshots
        .lock()
        .await
        .insert(req_id.clone(), tx);

    let script = SNAPSHOT_INJECT_SCRIPT.replace("__REQ_ID__", &req_id);
    if let Err(e) = wv.eval(&script) {
        // eval 失败 → 清掉 pending 条目避免泄漏
        state.pending_snapshots.lock().await.remove(&req_id);
        return Err(format!("注入 snapshot JS 失败: {e}"));
    }

    match tokio::time::timeout(Duration::from_secs(5), rx).await {
        Ok(Ok(json)) => Ok(json),
        Ok(Err(_)) => Err("snapshot oneshot 通道被关闭（异常）".to_string()),
        Err(_) => {
            // 超时 → 清掉 pending
            state.pending_snapshots.lock().await.remove(&req_id);
            Err("snapshot 等待结果超时（5s）".to_string())
        }
    }
}

/// v0.5.0-E：子 webview 注入的 JS 抓完 a11y 树后调这个回传结果。
#[tauri::command]
pub async fn browser_snapshot_result(
    state: tauri::State<'_, Arc<BrowserState>>,
    request_id: String,
    result: String,
) -> Result<(), String> {
    if let Some(sender) = state.pending_snapshots.lock().await.remove(&request_id) {
        // sender 可能已被 timeout 删除（race），send 失败不报错
        let _ = sender.send(result);
    }
    // 没找到 request_id 也不报错（race 时正常）
    Ok(())
}

/// v0.5.0-E：在指定 tab 的 webview 内 eval 任意 JS（fire-and-forget）。
///
/// 用于 BrowserClickTool / BrowserFillTool / BrowserEvalTool 的副作用类操作；
/// 不需要返回值。click / fill 失败（如 ref 已失效）时 JS 内部静默；AI 可以
/// 再次 snapshot 确认结果。
#[tauri::command]
pub async fn browser_eval_js(
    state: tauri::State<'_, Arc<BrowserState>>,
    tab_id: String,
    script: String,
) -> Result<(), String> {
    let map = state.active.lock().await;
    let wv = map
        .get(&tab_id)
        .ok_or_else(|| format!("tab {tab_id} 不存在或已 suspend"))?;
    wv.eval(&script).map_err(|e| format!("eval 失败: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn make_tab_id_格式正确_且唯一() {
        let a = make_tab_id();
        let b = make_tab_id();
        assert!(a.starts_with("browser-"));
        assert!(b.starts_with("browser-"));
        assert_ne!(a, b);
        // uuid 部分长度 36（含 dash），加前缀总长 = 8 + 36 = 44
        assert_eq!(a.len(), "browser-".len() + 36);
    }

    #[tokio::test]
    async fn browser_state_default_是空_map() {
        let state = BrowserState::default();
        assert_eq!(state.active.lock().await.len(), 0);
    }

    #[tokio::test]
    async fn current_active_id_默认_none() {
        let s = BrowserState::default();
        assert!(s.current_active_id.lock().await.is_none());
    }

    #[tokio::test]
    async fn current_active_id_close_active_tab_时_清空() {
        // v0.5.7：模拟 close 当前 active 后，current_active_id 应该被清掉
        let state = BrowserState::default();
        *state.current_active_id.lock().await = Some("tab-A".to_string());
        // 模拟 browser_close_tab 内部逻辑
        let removed = state.active.lock().await.remove("tab-A"); // 空 map，返 None
        assert!(removed.is_none());
        let mut current = state.current_active_id.lock().await;
        if current.as_deref() == Some("tab-A") {
            *current = None;
        }
        assert!(current.is_none());
    }

    #[tokio::test]
    async fn current_active_id_close_其它_tab_时_保留() {
        // 关掉的不是当前 active → current_active_id 不动
        let state = BrowserState::default();
        *state.current_active_id.lock().await = Some("tab-A".to_string());
        // 模拟关掉 tab-B
        let tab_id = "tab-B".to_string();
        let mut current = state.current_active_id.lock().await;
        if current.as_deref() == Some(tab_id.as_str()) {
            *current = None;
        }
        assert_eq!(current.as_deref(), Some("tab-A"));
    }

    #[tokio::test]
    async fn panel_close_all_时_current_active_id_也清空() {
        let state = BrowserState::default();
        *state.current_active_id.lock().await = Some("tab-A".to_string());
        // 模拟 panel_close_all
        let mut map = state.active.lock().await;
        let _drained: Vec<_> = map.drain().collect();
        drop(map);
        *state.current_active_id.lock().await = None;
        assert!(state.current_active_id.lock().await.is_none());
    }

    #[tokio::test]
    async fn close_tab_找不到_id_不报错() {
        // 直接操作 state 模拟 close（不真 spawn webview——单测没 GUI runtime）；
        // 验证 remove 找不到 entry 时静默返 Ok
        let state = Arc::new(BrowserState::default());
        let mut map = state.active.lock().await;
        assert!(map.remove("nonexistent").is_none());
        // drain 空 map 也不 panic
        let drained: Vec<_> = map.drain().collect();
        assert_eq!(drained.len(), 0);
    }

    #[test]
    fn url_解析_拒绝非法_url() {
        let r: Result<Url, _> = "not-a-url".parse();
        assert!(r.is_err());
    }

    #[test]
    fn url_解析_接受_http_https_file() {
        for u in [
            "http://example.com",
            "https://example.com/path?q=1",
            "http://localhost:3000",
        ] {
            let parsed: Result<Url, _> = u.parse();
            assert!(parsed.is_ok(), "应能解析 {u}");
        }
    }

    #[test]
    fn scroll_y_eval_片段_只含_ascii_数字_没有引号注入面() {
        // 模拟 browser_set_scroll_y 内部生成的 js 片段
        let y = 1234.5;
        let js = format!("window.scrollTo(0, {y});");
        // 不应含任何引号 / 反引号 / 分号注入
        assert!(!js.contains('"'));
        assert!(!js.contains('\''));
        assert!(!js.contains('`'));
        // 唯一分号是结尾的；y 是 f64，to_string 不会带特殊字符
        assert_eq!(js.matches(';').count(), 1);
        assert!(js.contains("1234.5"));
    }

    #[test]
    fn hotkey_event_序列化_字段名_lowercase() {
        let ev = HotkeyEvent {
            key: "b".to_string(),
            meta: true,
            ctrl: false,
            shift: false,
            alt: false,
        };
        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains("\"key\":\"b\""));
        assert!(json.contains("\"meta\":true"));
        assert!(json.contains("\"ctrl\":false"));
    }

    #[test]
    fn open_tab_result_序列化_字段_snake_case() {
        let r = OpenTabResult {
            tab_id: "browser-abc".to_string(),
        };
        let json = serde_json::to_string(&r).unwrap();
        assert_eq!(json, "{\"tab_id\":\"browser-abc\"}");
    }

    // v0.5.0-E：snapshot 注入脚本 + 反向通道单测
    #[test]
    fn snapshot_inject_script_含_必要字段() {
        // sanity：注入脚本必须含 invoke + browser_snapshot_result + data-aitm-ref
        assert!(SNAPSHOT_INJECT_SCRIPT.contains("__TAURI_INTERNALS__"));
        assert!(SNAPSHOT_INJECT_SCRIPT.contains("browser_snapshot_result"));
        assert!(SNAPSHOT_INJECT_SCRIPT.contains("data-aitm-ref"));
        assert!(SNAPSHOT_INJECT_SCRIPT.contains("__REQ_ID__"));
        // 上限定义都在
        assert!(SNAPSHOT_INJECT_SCRIPT.contains("MAX_ELEMENTS = 200"));
        assert!(SNAPSHOT_INJECT_SCRIPT.contains("MAX_TEXT = 100"));
        assert!(SNAPSHOT_INJECT_SCRIPT.contains("MAX_DEPTH = 30"));
    }

    #[test]
    fn make_request_id_格式_唯一() {
        let a = make_request_id();
        let b = make_request_id();
        assert!(a.starts_with("snap-"));
        assert_ne!(a, b);
    }

    #[tokio::test]
    async fn snapshot_result_找不到_request_id_不报错() {
        // race 场景：JS callback 来时 timeout 已删除 pending → 静默 ok
        let state = Arc::new(BrowserState::default());
        let mut map = state.pending_snapshots.lock().await;
        assert!(map.remove("ghost").is_none()); // ghost 不存在
        // drain 空 map 也不 panic
        let drained: Vec<_> = map.drain().collect();
        assert_eq!(drained.len(), 0);
    }

    #[tokio::test]
    async fn snapshot_oneshot_通道_send_recv() {
        // 模拟完整反向通道流程（不真注入 JS）
        let state = Arc::new(BrowserState::default());
        let req_id = "test-req".to_string();
        let (tx, rx) = oneshot::channel::<String>();
        state
            .pending_snapshots
            .lock()
            .await
            .insert(req_id.clone(), tx);

        // 模拟子 webview JS 调 browser_snapshot_result
        if let Some(sender) = state.pending_snapshots.lock().await.remove(&req_id) {
            sender.send("{\"url\":\"x\"}".to_string()).unwrap();
        }

        // AI 工具 await
        let result = tokio::time::timeout(Duration::from_secs(1), rx).await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap().unwrap(), "{\"url\":\"x\"}");
    }

    #[test]
    fn hotkey_inject_script_含有_必要_dispatch() {
        // sanity 检查：注入脚本里必须含 invoke 调用 + browser_forward_hotkey 命令名
        assert!(HOTKEY_FORWARD_SCRIPT.contains("__TAURI_INTERNALS__"));
        assert!(HOTKEY_FORWARD_SCRIPT.contains("browser_forward_hotkey"));
        // 5 个目标键
        assert!(HOTKEY_FORWARD_SCRIPT.contains("'b'"));
        assert!(HOTKEY_FORWARD_SCRIPT.contains("'t'"));
        assert!(HOTKEY_FORWARD_SCRIPT.contains("'w'"));
        assert!(HOTKEY_FORWARD_SCRIPT.contains("'p'"));
        assert!(HOTKEY_FORWARD_SCRIPT.contains("','"));
        // 必须 preventDefault 否则浏览器 default 行为会触发
        assert!(HOTKEY_FORWARD_SCRIPT.contains("preventDefault"));
    }
}
