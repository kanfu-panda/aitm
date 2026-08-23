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

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{
    webview::PageLoadEvent, AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url,
    Webview, WebviewUrl,
};
use tokio::sync::{oneshot, watch, Mutex};

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
    /// v1.2.0 T-B3：**AI 自己开浏览器**的反向通道（跟 `pending_snapshots` 同构）。
    ///
    /// 后端物理上建不了 tab —— `browser_open_tab` 需要 bounds（webview 的屏幕
    /// 位置 / 大小），而 bounds 只有前端布局算得出（BrowserPanel 的
    /// ResizeObserver 上报）。所以 AI 工具的做法是：emit
    /// `browser:open_requested` 请前端走**跟用户点地球图标完全相同的代码路径**，
    /// 前端建好后调 [`browser_open_result`] 把 tab_id 送回这里的 oneshot。
    ///
    /// key = request_id（每次调用唯一）；value 里 `Ok(tab_id)` / `Err(错误原因)`。
    pub pending_opens: Mutex<HashMap<String, oneshot::Sender<Result<String, String>>>>,
    /// v1.2.0 T-B3：主 AppHandle。emit `browser:open_requested` 那一刻**没有任何
    /// child webview** 可以借 `Webview::app_handle()`，所以启动期（lib.rs setup）
    /// 存一份在这里。单测环境为 None → 相关工具明确报错，绝不谎报成功。
    pub app: OnceLock<AppHandle>,
    /// v1.3.0 P4：tab_id → 页面加载状态 watch channel。由 `browser_open_tab` 注册的
    /// 原生 `on_page_load`（Finished）/ `on_document_title_changed` 钩子往里写；
    /// `browser_navigate` / `browser_open` 订阅后等新一轮 Finished 事件真发生了
    /// 再回，不再靠固定 sleep 猜时机。
    ///
    /// 为什么不用"eval 注入 + oneshot"这套（snapshot 那套）的思路：`wv.navigate()`
    /// 调用后页面还没提交（commit）新文档前，紧跟着的 `wv.eval()` 打的其实是
    /// **旧文档**（WKWebView `evaluateJavaScript` 只认当前已提交的文档），旧文档
    /// `readyState` 早已是 `complete`，会立刻假成功——跟这次要修的 bug 是同一个
    /// 时序坑。原生 `on_page_load` 钩子由 webview 引擎自己在文档真正提交/完成时
    /// 触发，不吃这个竞态。
    pub load_state: Mutex<HashMap<String, watch::Sender<PageLoadState>>>,
    /// v1.3.0 R3b：tab_id → 上一次**打过日志**的 bounds，仅用于给
    /// [`browser_set_bounds`] 的 `tracing::debug!` 去重，不参与任何实际行为。
    ///
    /// 为什么需要：前端 `report` 的触发源里有 `window.addEventListener("scroll",
    /// …, true)`——应用里任何地方滚动（终端输出、侧栏、文件树）都会触发一次
    /// 上报，值往往跟上次**完全一样**。不去重的话 dev log 每秒几十行同样的
    /// set_bounds，真要排"网页不随面板自适应"时根本读不出有用信息。
    pub last_logged_bounds: Mutex<HashMap<String, (f64, f64, f64, f64)>>,
    /// 已经收到过**真实** bounds 的 tab（2026-08-13 错位黑块 bug）。
    ///
    /// child webview 创建时只能给一个占位矩形（后端算不出前端布局），真值要等
    /// `BrowserPanel` 量完再 IPC 上报。旧实现创建即可见，于是"占位位置 + 已可见"
    /// 同时成立，只要纠正上报没跟上（或纠正的是另一个 tab），屏幕上就留下一块
    /// 挪不走的错位方块。
    ///
    /// 现在改成硬不变量：**没进这个集合的 tab 一律不 show**。位置未知就先别露脸，
    /// 这样"错位可见"从依赖时序运气变成结构上不可能。
    pub bounds_applied: Mutex<HashSet<String>>,
    /// 想 show、但还没拿到真实 bounds，因而被推迟的那个 tab。
    ///
    /// 只可能有一个：同一时刻用户只看得见一个 tab。真实 bounds 一到就放行
    /// （见 [`note_bounds_applied`]）。
    pub pending_show: Mutex<Option<String>>,
}

/// [`apply_set_active`] 的判定结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ActivateOutcome {
    /// 位置已知，可以立刻 show
    Show,
    /// tab 存在但还没有真实 bounds → 先别 show，等 bounds 到了再放行
    Defer,
    /// 后端根本没有这个 tab（前端拿着旧 id）
    Missing,
}

/// 纯判定：该不该现在把这个 tab show 出来。
///
/// 抽成无副作用函数是为了能单测——`apply_set_active` 需要真的 `Webview` handle，
/// 单测环境构造不出来。
pub(crate) fn decide_activate(tab_known: bool, bounds_ready: bool) -> ActivateOutcome {
    match (tab_known, bounds_ready) {
        (false, _) => ActivateOutcome::Missing,
        (true, false) => ActivateOutcome::Defer,
        (true, true) => ActivateOutcome::Show,
    }
}

/// 记下"这个 tab 已经有真实 bounds 了"，并回答：它是不是正等着被 show？
///
/// 返回 `true` 时调用方应立刻 `show()` 它 —— 这是被推迟的那次激活的兑现点。
pub(crate) async fn note_bounds_applied(state: &Arc<BrowserState>, tab_id: &str) -> bool {
    state.bounds_applied.lock().await.insert(tab_id.to_string());
    let mut pending = state.pending_show.lock().await;
    if pending.as_deref() == Some(tab_id) {
        *pending = None;
        true
    } else {
        false
    }
}

/// tab 关闭 / suspend 时清掉它的可见性记录。
///
/// `pending_show` 必须一起清：留着一个已销毁的 tab_id 在那儿，后面新 tab 的
/// bounds 上报就永远匹配不上，被推迟的 show 再也兑现不了。
pub(crate) async fn forget_tab_visibility(state: &Arc<BrowserState>, tab_id: &str) {
    state.bounds_applied.lock().await.remove(tab_id);
    let mut pending = state.pending_show.lock().await;
    if pending.as_deref() == Some(tab_id) {
        *pending = None;
    }
}

/// 单个 tab 的加载状态快照（[`BrowserState::load_state`] 的 value 类型）。
///
/// `generation` 每次 `on_page_load` 报 `Finished` 就 +1；等待方靠比较
/// "发起 navigate 前记的 generation" 和"当前 generation"判断是不是**这一次**
/// navigate 触发的新一轮加载完成了（而不是上一轮遗留的 Finished）。
#[derive(Debug, Clone, Default)]
pub struct PageLoadState {
    pub generation: u64,
    /// Finished 时 `payload.url()` 给的 url（重定向后的真实落地页 url）。
    pub url: String,
    /// `on_document_title_changed` 给的最新标题；可能比 Finished 早到或晚到，
    /// 尽力而为，不保证跟 Finished 那一刻精确同步。
    pub title: String,
}

impl BrowserState {
    /// lib.rs setup 里调一次；重复调忽略（[`OnceLock`] 语义）。
    pub fn set_app_handle(&self, app: AppHandle) {
        let _ = self.app.set(app);
    }
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
/// 页面缩放允许区间。下限再小就没法读了，上限再大一屏放不下几个字。
const MIN_ZOOM: f64 = 0.25;
const MAX_ZOOM: f64 = 3.0;

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

/// macOS child webview 用的 User-Agent（真机诊断后加，v1.2.0）。
///
/// **为什么必须显式设**：wry 在 macOS 上不设 UA 时，WKWebView 用的是"裸 UA"——
/// 形如 `Mozilla/5.0 (Macintosh; ...) AppleWebKit/605.1.15 (KHTML, like Gecko)`，
/// **尾部没有 `Version/x Safari/x`**。很多站点据此判定为爬虫 / 非标准客户端：
///
/// - 真机实测 `https://www.baidu.com`：裸 UA 只返回 **227 字节**，内容是
///   `location.replace(...https→http...)` 把请求降级到明文 http；WKWebView 跟着跳
///   明文 URL，再被 macOS ATS 拦掉 → **整页白屏**。同一请求换完整 Safari UA
///   返回 **902 KB** 正常页面。
/// - 这就是 STATUS 里长期记着的"baidu.com 在内嵌浏览器白屏、aitm 修不了"的真因，
///   并非反爬不可解——补 UA 即可。example.org / github.com 不看 UA，所以一直正常，
///   把问题掩盖了。
///
/// 维护提示：Safari 大版本升级后可同步更新此处版本号（非必需，站点一般只看
/// `Safari/` 标识存在与否）。Windows 走 WebView2（Chromium 内核），默认 UA 已完整，
/// 不需要覆盖。
#[cfg(target_os = "macos")]
const MAC_SAFARI_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
     AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15";

/// 请求"移动版站点"时用的 UA（iPhone Safari）。
///
/// 做 UA 嗅探的站点（新闻、门户、大部分登录页）看到它才会发移动版页面。
/// 窄面板下移动版比"PC 版缩小"好读得多——但代价是**必须重建 webview**：
/// UA 只能在创建时定，wry / WKWebView 都不支持运行时改。
///
/// **不加平台门控**：桌面版 UA 只有 macOS 需要覆盖（Windows 的 WebView2 默认 UA
/// 已完整），但"移动版"在哪个平台都得靠覆盖 UA 才能拿到。之前把这个常量圈在
/// macOS 里，Windows 上点开关会重新加载页面、图标也变成移动版、状态还存进快照，
/// 唯独页面仍是桌面版——假装成功比没反应更糟。
const IPHONE_SAFARI_USER_AGENT: &str = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) \
     AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1";

/// 在主 window 内创建一个子 webview 加载给定 URL。
///
/// 返回 `tab_id`（即 webview label），前端用它作为后续 IPC 的 key。
// Tauri command 的入参就是扁平的 IPC payload，把 x/y/w/h 收进结构体会让前端
// 多一层嵌套、也让既有调用点全部要改；这里保持扁平，单独放行这条 lint。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn browser_open_tab(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserState>>,
    url: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    // 请求移动版站点：用 iPhone UA 创建。缺省 / None = 桌面版
    mobile: Option<bool>,
) -> Result<OpenTabResult, String> {
    let parent_window = pick_main_window(&app)?;
    let parsed: Url = url.parse().map_err(|e| format!("URL 解析失败: {e}"))?;
    let label = make_tab_id();

    // v1.3.0 P4：注册加载状态 watch channel。两个原生钩子（下面）在这个 tab
    // **每一次**加载（含创建时的首屏、后续所有 navigate）都会触发，不是一次性的——
    // 跟 HOTKEY_FORWARD_SCRIPT 用 `initialization_script` 能在每次导航后继续
    // 生效是同一个道理（wry 对 webview 生命周期内的所有加载都重放这些钩子）。
    let (load_tx, _load_rx) = watch::channel(PageLoadState::default());
    let load_tx_for_page = load_tx.clone();
    let load_tx_for_title = load_tx.clone();
    let app_for_title = app.clone();
    let label_for_title = label.clone();

    let builder = tauri::webview::WebviewBuilder::new(label.clone(), WebviewUrl::External(parsed))
        .initialization_script(HOTKEY_FORWARD_SCRIPT)
        .on_page_load(move |_wv, payload| {
            if payload.event() == PageLoadEvent::Finished {
                let url = payload.url().to_string();
                load_tx_for_page.send_modify(|s| {
                    s.generation = s.generation.wrapping_add(1);
                    s.url = url;
                });
            }
        })
        .on_document_title_changed(move |_wv, title| {
            load_tx_for_title.send_modify(|s| {
                s.title = title.clone();
            });
            // 送给主 webview，前端据此把标签页文字从 URL 换成真实标题。
            // 用 emit_to 显式指 "main"：裸 emit 广播到 child webview 时主 webview
            // 会漏收（实测结论，同 url_changed）。
            let payload = TitleChangedEvent {
                tab_id: label_for_title.clone(),
                title,
            };
            if let Err(e) = app_for_title.emit_to(
                tauri::EventTarget::webview("main"),
                "browser:title_changed",
                &payload,
            ) {
                tracing::warn!("emit browser:title_changed 失败: {e}");
            }
        });

    // 打开原生缩放热键。**注意：这个开关在 macOS 上是空操作**——wry 的
    // `with_hotkeys_zoom` 文档写明 "macOS / Linux / Android / iOS: Unsupported"，
    // 实现里 `zoom_hotkeys_enabled` 只被 webview2（Windows）读取。
    //
    // 所以 macOS 下页面内按 Cmd+= / Cmd+- 不会有任何反应，缩放全靠前端那条路：
    // NSMenu 加速键 → `menu:font-action` → 按 lastSurface 路由到 browser store
    // 的 adjustZoom（见 App.tsx）。留着这一行是为了 Windows 能用原生热键。
    let builder = builder.zoom_hotkeys_enabled(true);

    // UA 覆盖分两种情况：
    // - **移动版**：所有平台都要覆盖，否则站点发的还是桌面版页面。
    // - **桌面版**：只有 macOS 需要补（见 MAC_SAFARI_USER_AGENT 的原因说明）；
    //   Windows 的 WebView2（Chromium）默认 UA 已完整，不动它。
    let builder = if mobile.unwrap_or(false) {
        builder.user_agent(IPHONE_SAFARI_USER_AGENT)
    } else {
        #[cfg(target_os = "macos")]
        {
            builder.user_agent(MAC_SAFARI_USER_AGENT)
        }
        #[cfg(not(target_os = "macos"))]
        {
            builder
        }
    };

    let child = parent_window
        .add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(w, h))
        .map_err(|e| format!("创建 child webview 失败: {e}"))?;

    // 立刻藏起来：入参 x/y/w/h 只是前端给的**占位**矩形（后端算不出前端布局），
    // 创建即可见的话，在真实 bounds 上报之前它就以错误位置露脸了——2026-08-13
    // 那块挪不走的黑块正是这么来的。由 `browser_set_bounds` 拿到真值后放行。
    child
        .hide()
        .map_err(|e| format!("新建 webview 隐藏失败: {e}"))?;

    state.active.lock().await.insert(label.clone(), child);
    state.load_state.lock().await.insert(label.clone(), load_tx);
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
    // v1.3.0 P4：tab 没了，对应的加载状态 channel 也没意义了，清掉避免泄漏
    state.load_state.lock().await.remove(&tab_id);
    // v1.3.0 R3b：日志去重表同步清理，别让已销毁的 tab_id 长期占着
    state.last_logged_bounds.lock().await.remove(&tab_id);
    // 可见性记录一并清（尤其 pending_show：挂着死 tab_id 会让后续的 show 永远兑现不了）
    forget_tab_visibility(state.inner(), &tab_id).await;
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

/// 页面标题变化事件，emit 给前端更新 zustand `tabs[].title`。
///
/// 之前 `on_document_title_changed` 只把标题写进 `load_state` 这个内部 watch
/// channel，**从没送到前端**，于是标签页永远显示原始 URL——又长又占地方，两三个
/// tab 就把标签栏挤到要横向滚动。
#[derive(Debug, Clone, Serialize)]
pub struct TitleChangedEvent {
    pub tab_id: String,
    pub title: String,
}

// =========================================================================
// v1.3.0 P4：等页面真正加载完再回，而不是 navigate 一发就回
// =========================================================================
//
// 真机反馈：`browser_navigate` 147ms 就返回成功，AI 立刻回复"已打开"，但
// WKWebView 实际还在转圈圈——这是"navigate() 异步触发，命令却同步返回"的
// 时序坑。原先 v0.5.8 的 fix 是固定 `sleep(800ms)`，对 GitHub 这类重站根本不够。
//
// 这里改用 webview 原生 `on_page_load`（[`PageLoadEvent::Finished`]）钩子驱动
// 一个按 tab 维护的 watch channel（见 [`BrowserState::load_state`]），
// `browser_navigate` / `browser_open` 发起导航前记一次 generation，导航后
// 等 generation 真的变了（= 引擎自己确认这一轮加载完成了）再回，10s 兜底超时。

/// `browser_navigate` / `browser_open` 等页面加载完成的超时上限。
///
/// child webview 创建 + 首屏加载比 snapshot 的纯 eval 往返慢得多，10s 是
/// 给普通站点（含 GitHub 这类稍重的）留足余量；超时不算失败，只是"还没等到"。
pub const NAVIGATE_LOAD_TIMEOUT: Duration = Duration::from_secs(10);

/// [`wait_for_page_load`] 的结果。
#[derive(Debug, Clone)]
pub(crate) enum LoadWaitOutcome {
    /// 在超时前等到了新一轮 `Finished`（generation 变了），带最终快照。
    Loaded(PageLoadState),
    /// 超时内没等到——**不代表 navigate 失败**，页面可能仍在加载慢资源。
    TimedOut,
}

/// 读一次 tab 当前的加载 generation。发起 navigate **之前**调用，拿到的值
/// 作为 [`wait_for_page_load`] 的 baseline，用来分辨"这一次 navigate 触发的
/// Finished"和"上一轮遗留的 Finished"。tab 不存在 / 还没注册 → 视为 0
/// （新建 tab 时 watch channel 就是从 `PageLoadState::default()` 即 0 开始）。
pub(crate) async fn current_load_generation(state: &Arc<BrowserState>, tab_id: &str) -> u64 {
    match state.load_state.lock().await.get(tab_id) {
        Some(tx) => tx.borrow().generation,
        None => 0,
    }
}

/// 等 tab 的加载状态 generation 超过 `baseline`，即等到**这一轮**导航的
/// `Finished` 事件。
///
/// 关键点：先立即 `borrow()` 一次当前值——如果 generation 在我们订阅之前就
/// 已经超过 baseline（比如 `browser_open` 带 url 建 webview，首屏加载可能在
/// AI 工具拿到 tab_id 之前就已经跑完），直接判定完成，不必等一个可能永远不会
/// 再来的 `changed()` 事件。之后才进入 `changed()` 循环等**未来**的变化。
///
/// 循环里过滤掉"只有 title 变了、generation 没变"的中间态通知（title 由
/// `on_document_title_changed` 独立驱动，跟 Finished 不同步）。
pub(crate) async fn wait_for_page_load(
    state: &Arc<BrowserState>,
    tab_id: &str,
    baseline_generation: u64,
    timeout: Duration,
) -> LoadWaitOutcome {
    let Some(tx) = state.load_state.lock().await.get(tab_id).cloned() else {
        // tab 没注册加载状态（理论上不该发生：browser_open_tab 建 tab 时就插入了）
        // —— 没法等，只能诚实报"没等到"，不谎报已完成。
        return LoadWaitOutcome::TimedOut;
    };
    let mut rx = tx.subscribe();

    {
        let snapshot = rx.borrow().clone();
        if snapshot.generation != baseline_generation {
            return LoadWaitOutcome::Loaded(snapshot);
        }
    }

    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return LoadWaitOutcome::TimedOut;
        }
        match tokio::time::timeout(remaining, rx.changed()).await {
            Ok(Ok(())) => {
                let snapshot = rx.borrow().clone();
                if snapshot.generation != baseline_generation {
                    return LoadWaitOutcome::Loaded(snapshot);
                }
                // 只是 title 更新，generation 没变 → 继续等
            }
            Ok(Err(_)) => return LoadWaitOutcome::TimedOut, // channel 关了（tab 被关掉）
            Err(_) => return LoadWaitOutcome::TimedOut,     // 超时
        }
    }
}

// =========================================================================
// v1.3.0 P7：谁是"用户当前看得见的 tab" —— 唯一判定入口
// =========================================================================
//
// 历史教训（v0.5.7 一次、v1.3.0 P7 又一次）：AI 工具操作的 webview 跟用户视觉
// 上看到的不是同一个（ghost webview）。真机现象：面板显示 baidu.com，AI 跑
// `document.title` 却拿到 "GitHub"。根因归纳为三类：
//
// 1. `current_active_id` 被写成一个后端根本不存在的 id（前端拿旧 id 调
//    set_active，老实现无脑记下），之后校验失败又退化成随机兜底
// 2. 判不出 active 时用 `HashMap::keys().next()` 兜底 —— HashMap 无序，
//    等于随机挑一个 webview
// 3. `browser_show_all_active` 把所有 webview 一起 show，"最上面那个"跟
//    `current_active_id` 根本不是一回事
//
// 现在统一收敛到 [`resolve_active_tab`]：**判不出就明说判不出，绝不猜**。
// 对 browser_eval（DESTRUCTIVE）这类工具，操作错对象远比操作失败严重。

/// 后端对"用户当前看得见的 tab"的判定结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ActiveTabResolution {
    /// 能唯一确定可见 tab。
    Resolved(String),
    /// 一个 webview 都没有（面板没开 / 全部 suspend）。
    NoTab,
    /// 有 N 个 webview，但后端无从判断哪个是用户看得见的那个。
    Ambiguous(usize),
}

/// 纯函数：由 `current_active_id` + 当前 webview id 列表判定可见 tab。
///
/// 规则（顺序无关，绝不依赖 HashMap 迭代顺序）：
/// - 没有 webview → [`ActiveTabResolution::NoTab`]
/// - `current` 指向一个真实存在的 webview → 用它（前端 set_active 同步过来的真相）
/// - `current` 失效但只有一个 webview → 它必然就是用户看到的那个，可唯一确定
/// - 其余（多个 webview 且 `current` 失效 / 为空）→ [`ActiveTabResolution::Ambiguous`]
pub(crate) fn resolve_active_tab(current: Option<&str>, tab_ids: &[String]) -> ActiveTabResolution {
    if tab_ids.is_empty() {
        return ActiveTabResolution::NoTab;
    }
    if let Some(id) = current {
        if tab_ids.iter().any(|t| t == id) {
            return ActiveTabResolution::Resolved(id.to_string());
        }
    }
    if tab_ids.len() == 1 {
        return ActiveTabResolution::Resolved(tab_ids[0].clone());
    }
    ActiveTabResolution::Ambiguous(tab_ids.len())
}

/// [`resolve_active_tab`] 的 state 版本。
///
/// 两把锁**分开取、不嵌套**：其它路径统一先 `active` 后 `current_active_id`，
/// 这里也不同时持有，避免锁序倒置。
pub(crate) async fn resolve_active_tab_of(state: &Arc<BrowserState>) -> ActiveTabResolution {
    let ids: Vec<String> = {
        let map = state.active.lock().await;
        map.keys().cloned().collect()
    };
    let current = { state.current_active_id.lock().await.clone() };
    resolve_active_tab(current.as_deref(), &ids)
}

/// 清空后端记录的 active tab。
///
/// 前端在"没法保证前后端一致"时主动调（见 `browser_clear_active`）：宁可让 AI
/// 工具明确报"当前没有确定的 active tab"，也不要它拿着过期 id 去操作 ghost。
pub(crate) async fn clear_current_active(state: &Arc<BrowserState>) {
    *state.current_active_id.lock().await = None;
}

/// [`browser_set_active`] 的可测内核：把指定 tab `show()`，其余全 `hide()`。
///
/// **失败即失败，不再静默**（v1.3.0 P7）：
/// - tab_id 不在 active map（前端拿的是旧 id）→ 清空 `current_active_id` 后返 Err，
///   前端据此自愈（把该 tab 标 suspended 重建）
/// - `show()` 失败 → 同样清空 + 返 Err
///
/// 只有真的 show 成功了才把它记成"用户看得见的 tab"。
pub(crate) async fn apply_set_active(
    state: &Arc<BrowserState>,
    tab_id: &str,
) -> Result<(), String> {
    let bounds_ready = state.bounds_applied.lock().await.contains(tab_id);

    let shown = {
        let map = state.active.lock().await;
        match decide_activate(map.contains_key(tab_id), bounds_ready) {
            ActivateOutcome::Missing => None,
            // 位置还不知道：其余照常 hide，目标也**保持隐藏**，只记下"它在等"。
            // 真实 bounds 一到，`browser_set_bounds` 会把它 show 出来。
            ActivateOutcome::Defer => {
                for wv in map.values() {
                    let _ = wv.hide();
                }
                Some(false)
            }
            ActivateOutcome::Show => {
                let mut ok = false;
                for (id, wv) in map.iter() {
                    if id == tab_id {
                        ok = wv.show().is_ok();
                    } else {
                        // 其它 tab hide 失败不致命（可能已被关闭），继续处理剩下的
                        let _ = wv.hide();
                    }
                }
                Some(ok)
            }
        }
    };

    // Defer：还没 show 成，先登记等待。current_active_id 保持空——它的语义是
    // "用户此刻真的看得见谁"，没人可见就不该指向任何 tab。
    if !bounds_ready && shown == Some(false) {
        *state.pending_show.lock().await = Some(tab_id.to_string());
        clear_current_active(state).await;
        return Ok(());
    }

    match shown {
        Some(true) => {
            // v0.5.7：把"用户看到的 tab"记到 state，AI 工具据此定位
            *state.current_active_id.lock().await = Some(tab_id.to_string());
            Ok(())
        }
        Some(false) => {
            clear_current_active(state).await;
            Err(format!("tab {tab_id} show 失败；后端已清空 active tab"))
        }
        None => {
            clear_current_active(state).await;
            Err(format!(
                "tab {tab_id} 不存在或已 suspend；后端已清空 active tab"
            ))
        }
    }
}

/// 切换前台 tab：把指定 tab `show()`，其余全 `hide()`。
///
/// Tauri 多 webview 在同一个 Window 内没有 z-index 概念，全靠可见性切。
///
/// v1.3.0 P7：**找不到 tab_id 现在会报错**（旧实现静默 Ok 且照样记下这个不存在
/// 的 id，正是 ghost webview 的源头之一）。前端 store 收到错误后会把该 tab 标
/// suspended 并重建 webview 自愈。
#[tauri::command]
pub async fn browser_set_active(
    state: tauri::State<'_, Arc<BrowserState>>,
    tab_id: String,
) -> Result<(), String> {
    apply_set_active(state.inner(), &tab_id).await
}

/// v1.3.0 P7：前端主动声明"我也不确定哪个 tab 可见了"，清空后端 active。
///
/// 触发时机（见前端 `stores/browser.ts`）：set_active 重试后仍失败、
/// panel_close_all 失败、关掉 active tab 后新 active 还没恢复 webview 等。
/// 清空后 AI 工具会明确报错并引导重新 `browser_open`，而不是操作一个随机 webview。
#[tauri::command]
pub async fn browser_clear_active(
    state: tauri::State<'_, Arc<BrowserState>>,
) -> Result<(), String> {
    clear_current_active(state.inner()).await;
    Ok(())
}

/// bounds 日志去重：跟上次记录的值不同才返 `true`，同时把新值记下。
///
/// 纯函数（只操作传进来的表），方便单测。**仅影响日志**，不影响 webview 行为——
/// 即使返回 `false`，[`browser_set_bounds`] 照样会把 bounds 应用到 webview，
/// 所以不存在"去重把某次真实尺寸吞掉"的风险。
pub(crate) fn bounds_log_changed(
    logged: &mut HashMap<String, (f64, f64, f64, f64)>,
    tab_id: &str,
    next: (f64, f64, f64, f64),
) -> bool {
    match logged.get(tab_id) {
        // f64 直接比相等即可：值来自前端同一份 rect，没有累积运算误差；
        // 判错了最多多打 / 少打一行日志，不影响任何行为。
        Some(prev) if *prev == next => false,
        _ => {
            logged.insert(tab_id.to_string(), next);
            true
        }
    }
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
    // 日志去重要在拿 active 锁之前算，避免嵌套持锁
    let changed = {
        let mut logged = state.last_logged_bounds.lock().await;
        bounds_log_changed(&mut logged, &tab_id, (x, y, w, h))
    };

    let map = state.active.lock().await;
    let Some(wv) = map.get(&tab_id) else {
        // 上报了但 webview 不存在：常见于 tab 刚 destroy 的 race，本身无害。
        // 但如果**持续** MISS，说明前端拿的 tab_id 跟后端对不上，webview 会一直
        // 停在创建时的占位尺寸（800×600）→ 网页按 800 宽布局、面板再窄也不重排。
        // 排查"网页不随面板自适应"时先看有没有一串 MISS。
        if changed {
            tracing::debug!("set_bounds 跳过：tab {tab_id} 不存在（w={w} h={h}）");
        }
        return Ok(());
    };
    if changed {
        // 排查"网页不随面板自适应"就看这一行的 w：它应等于浏览器面板当前宽度
        // （逻辑像素）。若始终是 800 = 占位尺寸没被覆盖；若等于面板宽度，
        // 说明 webview 已收到正确尺寸，问题在页面自身（如 google.com 的
        // `html,body{min-width:400px}` 让它低于 400 就不再重排，只会被裁剪）。
        tracing::debug!("set_bounds tab={tab_id} x={x} y={y} w={w} h={h}");
    }
    wv.set_position(LogicalPosition::new(x, y))
        .map_err(|e| format!("set_position 失败: {e}"))?;
    wv.set_size(LogicalSize::new(w, h))
        .map_err(|e| format!("set_size 失败: {e}"))?;
    // 位置已经是真的了 —— 若这个 tab 正等着被 show（创建后 set_active 时还没
    // bounds 而被推迟），现在兑现。持 active 锁期间只做 show，不再取别的锁。
    let should_show = wv.clone();
    drop(map);
    if note_bounds_applied(state.inner(), &tab_id).await {
        should_show
            .show()
            .map_err(|e| format!("延后的 show 失败: {e}"))?;
        *state.current_active_id.lock().await = Some(tab_id);
    }
    Ok(())
}

/// 设置某个 tab 的页面缩放比例。
///
/// 面板 UI 的缩放按钮、以及焦点在面板边框（不在页面内）时的 Cmd+= / Cmd+- 走这里；
/// 焦点在页面内时由 webview 的原生缩放热键处理，不经过 IPC。
///
/// 比例范围由前端约束（走固定档位），这里只挡明显离谱的值，避免把页面缩成不可用。
#[tauri::command]
pub async fn browser_set_zoom(
    state: tauri::State<'_, Arc<BrowserState>>,
    tab_id: String,
    factor: f64,
) -> Result<(), String> {
    if !(MIN_ZOOM..=MAX_ZOOM).contains(&factor) {
        return Err(format!(
            "缩放比例 {factor} 超出允许范围 {MIN_ZOOM}..={MAX_ZOOM}"
        ));
    }
    let map = state.active.lock().await;
    let wv = map
        .get(&tab_id)
        .ok_or_else(|| format!("tab {tab_id} 不存在或已 suspend"))?;
    wv.set_zoom(factor)
        .map_err(|e| format!("set_zoom 失败: {e}"))
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
    // v1.3.0 P4：所有 tab 的加载状态 channel 一并清空
    state.load_state.lock().await.clear();
    // v1.3.0 R3b：日志去重表一并清空
    state.last_logged_bounds.lock().await.clear();
    // 可见性记录一并清空（webview 都没了，"谁有 bounds / 谁在等 show"全部失效）
    state.bounds_applied.lock().await.clear();
    *state.pending_show.lock().await = None;
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

/// dialog 关闭后恢复 webview 显示。
///
/// v1.3.0 P7 语义收紧：**只 show 回"当前 active"那一个**，其余保持 hide。
///
/// 旧实现是字面意义的"show 全部"，多个 webview 同时可见时用户看到的是最上面
/// 那个，而 `current_active_id` 指的可能是另一个 —— AI 工具于是操作了一个用户
/// 看不见的页面。AI 审批弹窗（ConfirmDialog）本身就走这条路径，browser_eval
/// 这类 DESTRUCTIVE 工具批准后紧接着执行，正好踩中。
///
/// 判不出 active（多 webview 且 `current_active_id` 失效）时**一个都不 show**，
/// 并返 Err：前端 store 的 `reassertActive` 会立刻用自己的 activeKey 重新
/// set_active 把状态掰正 —— 宁可闪一下空白，也不要给 AI 一个错的操作对象。
#[tauri::command]
pub async fn browser_show_all_active(
    state: tauri::State<'_, Arc<BrowserState>>,
) -> Result<(), String> {
    let resolution = resolve_active_tab_of(state.inner()).await;
    let target = match resolution {
        ActiveTabResolution::Resolved(id) => id,
        ActiveTabResolution::NoTab => return Ok(()),
        ActiveTabResolution::Ambiguous(n) => {
            return Err(format!(
                "有 {n} 个 webview 但无法确定哪个可见，已保持全部隐藏；请重新 set_active"
            ));
        }
    };
    apply_set_active(state.inner(), &target).await
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

// =========================================================================
// v1.2.0 T-B3：AI 自己打开浏览器面板（后端 → 前端反向通道）
// =========================================================================

/// v1.2.0 T-B3：请前端打开浏览器面板的事件 payload。
///
/// 前端在**常驻组件**（App.tsx）订阅 `browser:open_requested`，收到后走跟用户点
/// ActivityBar 地球图标一样的 store 路径建 tab，再调 [`browser_open_result`] 回报。
#[derive(Debug, Clone, Serialize)]
pub struct OpenRequestedEvent {
    pub request_id: String,
    /// 打开后要导航到的 URL；`None` → 前端开 `about:blank`。
    pub url: Option<String>,
}

/// 等前端回报的超时。child webview 创建 + 首屏加载比 snapshot 慢得多
/// （snapshot 只是注入 JS），给 10s。
pub const OPEN_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

fn make_open_request_id() -> String {
    format!("open-{}", uuid::Uuid::new_v4())
}

/// 登记一个待前端回报的 open 请求，返回 (request_id, receiver)。
///
/// 拆成独立函数是为了可单测：单测里没有 Tauri app 无法 emit，但可以
/// register → resolve → await 走完整的通道逻辑。
pub(crate) async fn register_pending_open(
    state: &Arc<BrowserState>,
) -> (String, oneshot::Receiver<Result<String, String>>) {
    let req_id = make_open_request_id();
    let (tx, rx) = oneshot::channel::<Result<String, String>>();
    state.pending_opens.lock().await.insert(req_id.clone(), tx);
    (req_id, rx)
}

/// await 前端回报，超时 / 通道异常时**清理 pending_opens** 再返错。
pub(crate) async fn await_pending_open(
    state: &Arc<BrowserState>,
    request_id: &str,
    rx: oneshot::Receiver<Result<String, String>>,
    timeout: Duration,
) -> Result<String, String> {
    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(res)) => res,
        Ok(Err(_)) => {
            state.pending_opens.lock().await.remove(request_id);
            Err("打开浏览器的回报通道异常关闭".to_string())
        }
        Err(_) => {
            state.pending_opens.lock().await.remove(request_id);
            Err(format!(
                "等前端打开浏览器超时（{}s）",
                timeout.as_secs_f32()
            ))
        }
    }
}

/// 把前端回报的结果送回等待中的 oneshot。
///
/// 命令 [`browser_open_result`] 的可测内核。`ok=true` 但 tab_id 空 → 判失败
/// （**防谎报**：没拿到真 tab_id 就不能说"已打开"）。
pub(crate) async fn resolve_pending_open(
    state: &Arc<BrowserState>,
    request_id: &str,
    ok: bool,
    tab_id: Option<String>,
    error: Option<String>,
) {
    let Some(sender) = state.pending_opens.lock().await.remove(request_id) else {
        // 找不到 request_id：await 已超时删掉（race），静默忽略
        return;
    };
    let payload = if ok {
        match tab_id
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
        {
            Some(id) => Ok(id),
            None => Err("前端回报成功但没给 tab_id".to_string()),
        }
    } else {
        Err(error
            .map(|e| e.trim().to_string())
            .filter(|e| !e.is_empty())
            .unwrap_or_else(|| "前端打开浏览器失败（未给原因）".to_string()))
    };
    // sender 可能已被 timeout 丢弃，send 失败不报错
    let _ = sender.send(payload);
}

/// 请前端打开浏览器面板（可选直接导航到 `url`），await 到真 tab_id 才返 Ok。
///
/// AI 工具 `browser_open` 和 `browser_navigate`（面板未打开兜底）共用这条路径。
///
/// Tauri 2 multi-webview 下**必须** `emit_to(EventTarget::webview("main"))`——
/// 裸 `emit` 会被 child webview 抢掉导致主 webview 漏收（v0.5.9 踩过）。
pub(crate) async fn request_frontend_open(
    state: &Arc<BrowserState>,
    url: Option<&str>,
) -> Result<String, String> {
    let app = state
        .app
        .get()
        .cloned()
        .ok_or_else(|| "后端未持有 AppHandle（启动期未初始化）".to_string())?;

    let (req_id, rx) = register_pending_open(state).await;
    let payload = OpenRequestedEvent {
        request_id: req_id.clone(),
        url: url.map(|s| s.to_string()),
    };
    if let Err(e) = app.emit_to(
        tauri::EventTarget::webview("main"),
        "browser:open_requested",
        &payload,
    ) {
        state.pending_opens.lock().await.remove(&req_id);
        return Err(format!("emit browser:open_requested 失败: {e}"));
    }
    await_pending_open(state, &req_id, rx, OPEN_REQUEST_TIMEOUT).await
}

/// v1.2.0 T-B3：前端建好（或没建成）浏览器 tab 后回报结果。
///
/// - `ok=true` + `tab_id` → AI 工具那边 await 到 tab_id，可以如实说"已打开"
/// - `ok=false` + `error` → AI 工具拿到失败原因，必须如实报告失败
#[tauri::command]
pub async fn browser_open_result(
    state: tauri::State<'_, Arc<BrowserState>>,
    request_id: String,
    ok: bool,
    tab_id: Option<String>,
    error: Option<String>,
) -> Result<(), String> {
    resolve_pending_open(state.inner(), &request_id, ok, tab_id, error).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// v1.2.0 真机诊断：UA 尾部缺 `Safari/` 标识会被百度等站点判成非标准客户端，
    /// 返回 https→http 降级脚本 → 被 ATS 拦 → 白屏。这里锁住关键特征防回退。
    #[cfg(target_os = "macos")]
    #[test]
    fn mac_user_agent_含完整_safari_标识() {
        assert!(
            MAC_SAFARI_USER_AGENT.starts_with("Mozilla/5.0 (Macintosh;"),
            "UA 应声明为 macOS 客户端"
        );
        assert!(
            MAC_SAFARI_USER_AGENT.contains("Safari/"),
            "必须含 Safari/ 标识——缺它就是 baidu 白屏的根因"
        );
        assert!(
            MAC_SAFARI_USER_AGENT.contains("Version/"),
            "必须含 Version/ 段，裸 WKWebView UA 正是缺这两段"
        );
        // 换行续写的字符串字面量不该把缩进空格带进 UA
        assert!(
            !MAC_SAFARI_USER_AGENT.contains("  "),
            "UA 不应含连续空格（\\ 续行缩进泄漏）"
        );
    }

    /// 移动版 UA 必须**所有平台**都能用。
    ///
    /// 这条测试本身不加 `#[cfg]` 就是锁：常量若再被圈回某个平台，别的平台编译
    /// 直接失败。之前它被圈在 macOS，Windows 上点"请求移动版站点"会重新加载页面、
    /// 图标变成移动版、状态也存进快照，唯独页面还是桌面版。
    #[test]
    fn 移动版_user_agent_全平台可用且含移动标识() {
        assert!(
            IPHONE_SAFARI_USER_AGENT.contains("iPhone"),
            "UA 要声明成 iPhone，站点才发移动版"
        );
        assert!(
            IPHONE_SAFARI_USER_AGENT.contains("Mobile/"),
            "必须含 Mobile/ 段——UA 嗅探常靠它判移动端"
        );
        assert!(
            IPHONE_SAFARI_USER_AGENT.contains("Safari/"),
            "同桌面版：缺 Safari/ 标识会被部分站点判成非标准客户端"
        );
        assert!(
            !IPHONE_SAFARI_USER_AGENT.contains("  "),
            "UA 不应含连续空格（\\ 续行缩进泄漏）"
        );
    }

    // v1.3.0 R3b：bounds 日志去重（排查"网页不随面板自适应"时要能读懂 dev log）
    #[test]
    fn bounds_日志_首次必打_相同值不重复打() {
        let mut logged = HashMap::new();
        assert!(bounds_log_changed(&mut logged, "t1", (0.0, 30.0, 370.0, 500.0)));
        // 前端 scroll 监听会用完全相同的值反复上报 → 不该刷屏
        assert!(!bounds_log_changed(&mut logged, "t1", (0.0, 30.0, 370.0, 500.0)));
        assert!(!bounds_log_changed(&mut logged, "t1", (0.0, 30.0, 370.0, 500.0)));
    }

    #[test]
    fn bounds_日志_尺寸变化必打_拖窄面板不会被去重吞掉() {
        let mut logged = HashMap::new();
        assert!(bounds_log_changed(&mut logged, "t1", (0.0, 30.0, 800.0, 600.0)));
        // 面板被拖窄：宽度变了，必须留下日志，否则排查时看不到真实尺寸
        assert!(bounds_log_changed(&mut logged, "t1", (0.0, 30.0, 370.0, 600.0)));
        // 只有 x 变（面板左右平移）同样要打
        assert!(bounds_log_changed(&mut logged, "t1", (12.0, 30.0, 370.0, 600.0)));
    }

    #[test]
    fn bounds_日志_按_tab_独立记账() {
        let mut logged = HashMap::new();
        assert!(bounds_log_changed(&mut logged, "t1", (0.0, 0.0, 370.0, 500.0)));
        // 另一个 tab 即使数值相同也是首次 → 要打
        assert!(bounds_log_changed(&mut logged, "t2", (0.0, 0.0, 370.0, 500.0)));
        assert!(!bounds_log_changed(&mut logged, "t2", (0.0, 0.0, 370.0, 500.0)));
        assert!(!bounds_log_changed(&mut logged, "t1", (0.0, 0.0, 370.0, 500.0)));
    }

    #[tokio::test]
    async fn bounds_日志表_close_tab_后清理() {
        let state = Arc::new(BrowserState::default());
        {
            let mut logged = state.last_logged_bounds.lock().await;
            bounds_log_changed(&mut logged, "t1", (0.0, 0.0, 370.0, 500.0));
        }
        assert_eq!(state.last_logged_bounds.lock().await.len(), 1);
        // 模拟 browser_close_tab / panel_close_all 的清理动作
        state.last_logged_bounds.lock().await.remove("t1");
        assert!(state.last_logged_bounds.lock().await.is_empty());
    }

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

    // =====================================================================
    // v1.2.0 T-B3：AI 主动开浏览器（browser:open_requested 反向通道）
    // =====================================================================

    #[tokio::test]
    async fn pending_opens_默认为空() {
        let s = BrowserState::default();
        assert_eq!(s.pending_opens.lock().await.len(), 0);
        assert!(s.app.get().is_none(), "单测环境不应有 AppHandle");
    }

    #[test]
    fn open_requested_event_序列化_snake_case() {
        let ev = OpenRequestedEvent {
            request_id: "open-1".to_string(),
            url: Some("https://example.com".to_string()),
        };
        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains("\"request_id\":\"open-1\""));
        assert!(json.contains("\"url\":\"https://example.com\""));
        // url 缺省时序列化为 null（前端类型 string | null）
        let ev2 = OpenRequestedEvent {
            request_id: "open-2".to_string(),
            url: None,
        };
        assert!(serde_json::to_string(&ev2).unwrap().contains("\"url\":null"));
    }

    #[tokio::test]
    async fn 前端回报成功_await_拿到_tab_id() {
        let state = Arc::new(BrowserState::default());
        let (req_id, rx) = register_pending_open(&state).await;
        assert!(req_id.starts_with("open-"));
        assert_eq!(state.pending_opens.lock().await.len(), 1);

        resolve_pending_open(&state, &req_id, true, Some("browser-x".into()), None).await;
        let got = await_pending_open(&state, &req_id, rx, Duration::from_secs(1)).await;
        assert_eq!(got.unwrap(), "browser-x");
        assert_eq!(
            state.pending_opens.lock().await.len(),
            0,
            "resolve 后 pending 必须清空"
        );
    }

    #[tokio::test]
    async fn 前端回报失败_await_拿到_错误原因() {
        let state = Arc::new(BrowserState::default());
        let (req_id, rx) = register_pending_open(&state).await;
        resolve_pending_open(&state, &req_id, false, None, Some("openTab 被拒".into())).await;
        let got = await_pending_open(&state, &req_id, rx, Duration::from_secs(1)).await;
        assert_eq!(got.unwrap_err(), "openTab 被拒");
    }

    #[tokio::test]
    async fn 前端回报_ok_但没给_tab_id_视为失败() {
        // 防谎报：没有真 tab_id 就不能算"已打开"
        let state = Arc::new(BrowserState::default());
        let (req_id, rx) = register_pending_open(&state).await;
        resolve_pending_open(&state, &req_id, true, Some("   ".into()), None).await;
        let got = await_pending_open(&state, &req_id, rx, Duration::from_secs(1)).await;
        assert!(got.is_err(), "空 tab_id 必须判失败");
    }

    #[tokio::test]
    async fn await_pending_open_超时_清理_pending_并报错() {
        let state = Arc::new(BrowserState::default());
        let (req_id, rx) = register_pending_open(&state).await;
        let got = await_pending_open(&state, &req_id, rx, Duration::from_millis(30)).await;
        let err = got.unwrap_err();
        assert!(err.contains("超时"), "错误应说明超时，实际: {err}");
        assert_eq!(
            state.pending_opens.lock().await.len(),
            0,
            "超时必须清理 pending_opens，避免泄漏"
        );
    }

    #[tokio::test]
    async fn resolve_pending_open_未知_request_id_静默忽略() {
        // race：await 已超时删掉 pending，前端结果才到
        let state = Arc::new(BrowserState::default());
        resolve_pending_open(&state, "ghost", true, Some("t".into()), None).await;
        assert_eq!(state.pending_opens.lock().await.len(), 0);
    }

    #[tokio::test]
    async fn request_frontend_open_无_app_handle_报错_且不残留_pending() {
        // 单测环境没有 Tauri app → 必须明确失败（不能谎报成功），且不泄漏 pending
        let state = Arc::new(BrowserState::default());
        let r = request_frontend_open(&state, Some("https://example.com")).await;
        let err = r.unwrap_err();
        assert!(!err.is_empty());
        assert_eq!(state.pending_opens.lock().await.len(), 0);
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

    // =====================================================================
    // v1.3.0 P4：等页面真正加载完（wait_for_page_load / current_load_generation）
    // =====================================================================

    #[tokio::test]
    async fn current_load_generation_未注册_tab_视为_0() {
        let state = Arc::new(BrowserState::default());
        assert_eq!(current_load_generation(&state, "ghost").await, 0);
    }

    #[tokio::test]
    async fn current_load_generation_读到_channel_里的实际值() {
        let state = Arc::new(BrowserState::default());
        let (tx, _rx) = watch::channel(PageLoadState {
            generation: 3,
            url: "https://x.com".into(),
            title: "X".into(),
        });
        state.load_state.lock().await.insert("tab-1".into(), tx);
        assert_eq!(current_load_generation(&state, "tab-1").await, 3);
    }

    #[tokio::test]
    async fn wait_for_page_load_tab_不存在_视为超时_不谎报完成() {
        let state = Arc::new(BrowserState::default());
        let outcome = wait_for_page_load(&state, "ghost", 0, Duration::from_millis(50)).await;
        assert!(matches!(outcome, LoadWaitOutcome::TimedOut));
    }

    #[tokio::test]
    async fn wait_for_page_load_订阅前就已完成_立即返回不空等() {
        // 模拟 browser_open 带 url 建 webview：等 AI 工具拿到 tab_id、
        // 调 wait_for_page_load 之前，首屏加载可能已经跑完了。
        let state = Arc::new(BrowserState::default());
        let (tx, _rx) = watch::channel(PageLoadState::default());
        tx.send_modify(|s| {
            s.generation = 1;
            s.url = "https://example.com".into();
            s.title = "Example".into();
        });
        state.load_state.lock().await.insert("tab-1".into(), tx);

        let started = tokio::time::Instant::now();
        let outcome = wait_for_page_load(&state, "tab-1", 0, Duration::from_secs(5)).await;
        // 立即返回，不应该真等了 5s 超时
        assert!(started.elapsed() < Duration::from_secs(1));
        match outcome {
            LoadWaitOutcome::Loaded(s) => {
                assert_eq!(s.generation, 1);
                assert_eq!(s.url, "https://example.com");
                assert_eq!(s.title, "Example");
            }
            LoadWaitOutcome::TimedOut => panic!("已完成的加载不该判超时"),
        }
    }

    #[tokio::test]
    async fn wait_for_page_load_晚到的_finished_也能等到() {
        let state = Arc::new(BrowserState::default());
        let (tx, _rx) = watch::channel(PageLoadState::default());
        state.load_state.lock().await.insert("tab-1".into(), tx.clone());

        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(30)).await;
            tx.send_modify(|s| {
                s.generation = 1;
                s.url = "https://x.com".into();
            });
        });

        let outcome = wait_for_page_load(&state, "tab-1", 0, Duration::from_secs(2)).await;
        assert!(matches!(outcome, LoadWaitOutcome::Loaded(_)));
    }

    #[tokio::test]
    async fn wait_for_page_load_只有_title_变化_generation_不变_继续等到超时() {
        // title 由 on_document_title_changed 独立驱动，不代表 Finished；
        // 不能把纯 title 更新误判成"加载完成"。
        let state = Arc::new(BrowserState::default());
        let (tx, _rx) = watch::channel(PageLoadState::default());
        state.load_state.lock().await.insert("tab-1".into(), tx.clone());

        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            tx.send_modify(|s| {
                s.title = "loading...".into();
            });
        });

        let outcome = wait_for_page_load(&state, "tab-1", 0, Duration::from_millis(150)).await;
        assert!(matches!(outcome, LoadWaitOutcome::TimedOut));
    }

    #[tokio::test]
    async fn wait_for_page_load_baseline_非_0_只认超过_baseline_的新一轮() {
        // 模拟"第二次 navigate"：tab 已经加载过一次（generation=1），
        // baseline 传 1，只有 generation 变成 2 才算这一轮完成。
        let state = Arc::new(BrowserState::default());
        let (tx, _rx) = watch::channel(PageLoadState {
            generation: 1,
            url: "https://old.example".into(),
            title: "旧页面".into(),
        });
        state.load_state.lock().await.insert("tab-1".into(), tx.clone());

        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            tx.send_modify(|s| {
                s.generation = 2;
                s.url = "https://new.example".into();
            });
        });

        let outcome = wait_for_page_load(&state, "tab-1", 1, Duration::from_secs(2)).await;
        match outcome {
            LoadWaitOutcome::Loaded(s) => assert_eq!(s.url, "https://new.example"),
            LoadWaitOutcome::TimedOut => panic!("应等到 generation=2 的新一轮完成"),
        }
    }

    #[tokio::test]
    async fn browser_open_tab_注册的_load_state_默认_generation_0() {
        // browser_open_tab 里 watch::channel(PageLoadState::default()) 的起始值
        // 就是 default；这里单独锁死这个约定（新建 tab 首次 Finished 才是 gen=1）。
        assert_eq!(PageLoadState::default().generation, 0);
        assert_eq!(PageLoadState::default().url, "");
        assert_eq!(PageLoadState::default().title, "");
    }

    // =====================================================================
    // v1.3.0 P7：ghost webview —— "用户当前看得见的 tab" 判定
    // =====================================================================

    #[test]
    fn resolve_active_tab_没有任何_webview_时_no_tab() {
        assert_eq!(resolve_active_tab(None, &[]), ActiveTabResolution::NoTab);
        assert_eq!(
            resolve_active_tab(Some("browser-1"), &[]),
            ActiveTabResolution::NoTab,
            "current_active_id 是过期值时也不能凭空造出一个 tab"
        );
    }

    #[test]
    fn resolve_active_tab_current_有效时直接用() {
        let ids = vec!["browser-a".to_string(), "browser-b".to_string()];
        assert_eq!(
            resolve_active_tab(Some("browser-b"), &ids),
            ActiveTabResolution::Resolved("browser-b".to_string())
        );
    }

    #[test]
    fn resolve_active_tab_current_失效_且有多个_webview_必须_ambiguous() {
        // 这是 ghost webview 的核心：绝不允许退化成 keys().next() 随机挑一个
        let ids = vec![
            "browser-a".to_string(),
            "browser-b".to_string(),
            "browser-c".to_string(),
        ];
        assert_eq!(
            resolve_active_tab(Some("已被关掉的-tab"), &ids),
            ActiveTabResolution::Ambiguous(3)
        );
        assert_eq!(resolve_active_tab(None, &ids), ActiveTabResolution::Ambiguous(3));
    }

    #[test]
    fn resolve_active_tab_只有一个_webview_时可唯一确定() {
        // 只有一个 webview → 它必然就是用户看到的那个，不存在"操作错对象"
        let ids = vec!["browser-only".to_string()];
        assert_eq!(
            resolve_active_tab(None, &ids),
            ActiveTabResolution::Resolved("browser-only".to_string())
        );
        assert_eq!(
            resolve_active_tab(Some("过期 id"), &ids),
            ActiveTabResolution::Resolved("browser-only".to_string())
        );
    }

    #[test]
    fn resolve_active_tab_结果不依赖_tab_顺序() {
        // 锁死"不能靠 HashMap 迭代顺序"的约定：换个顺序结果必须一样
        let a = vec!["x".to_string(), "y".to_string()];
        let b = vec!["y".to_string(), "x".to_string()];
        assert_eq!(resolve_active_tab(None, &a), resolve_active_tab(None, &b));
        assert_eq!(
            resolve_active_tab(Some("y"), &a),
            resolve_active_tab(Some("y"), &b)
        );
    }

    #[tokio::test]
    async fn apply_set_active_对不存在的_tab_报错_且清空_current_active_id() {
        // 前端拿旧 id 调 set_active 时，旧实现会把这个"幽灵 id"记成 current_active_id，
        // 之后 AI 侧校验失败又退化成随机兜底 —— 这里改成明确失败 + 清空。
        let state = Arc::new(BrowserState::default());
        *state.current_active_id.lock().await = Some("browser-old".to_string());

        let r = apply_set_active(&state, "browser-ghost").await;

        assert!(r.is_err(), "后端没有这个 webview 时必须报错");
        assert!(
            state.current_active_id.lock().await.is_none(),
            "失败后绝不能残留任何 active id（宁可不知道，也不要指错）"
        );
    }

    // === 错位黑块 webview ===
    //
    // 根因是"webview 创建时只有占位 bounds，却已经可见"。这里锁住新的硬不变量：
    // **一个 webview 在拿到真实 bounds 之前，绝不允许被 show。**

    #[test]
    fn 没拿到真实_bounds_的_tab_只能延后_show_不能立刻露脸() {
        assert!(matches!(
            decide_activate(true, false),
            ActivateOutcome::Defer
        ));
    }

    #[test]
    fn 拿到过真实_bounds_才允许_show() {
        assert!(matches!(decide_activate(true, true), ActivateOutcome::Show));
    }

    #[test]
    fn 后端压根没有这个_tab_仍然是_missing() {
        // 不能因为新增了 Defer 分支，就把"幽灵 tab_id"也吞成 Defer
        assert!(matches!(
            decide_activate(false, false),
            ActivateOutcome::Missing
        ));
        assert!(matches!(
            decide_activate(false, true),
            ActivateOutcome::Missing
        ));
    }

    #[tokio::test]
    async fn 真实_bounds_到达时_把等待中的_tab_放行() {
        let state = Arc::new(BrowserState::default());
        *state.pending_show.lock().await = Some("browser-a".to_string());

        let 该放行 = note_bounds_applied(&state, "browser-a").await;

        assert!(该放行, "正等着的 tab 拿到 bounds 后必须立刻被 show");
        assert!(
            state.bounds_applied.lock().await.contains("browser-a"),
            "应记下这个 tab 已有真实 bounds"
        );
        assert!(
            state.pending_show.lock().await.is_none(),
            "放行后不该再残留 pending"
        );
    }

    #[tokio::test]
    async fn 非等待中的_tab_拿到_bounds_不会被顺手_show() {
        // 后台 tab 的 bounds 上报不该把它抢到前台来
        let state = Arc::new(BrowserState::default());
        *state.pending_show.lock().await = Some("browser-a".to_string());

        let 该放行 = note_bounds_applied(&state, "browser-b").await;

        assert!(!该放行, "b 不是等待中的那个，不该被 show");
        assert_eq!(
            state.pending_show.lock().await.as_deref(),
            Some("browser-a"),
            "a 仍在等待，不能被 b 的上报清掉"
        );
    }

    #[tokio::test]
    async fn 关掉_tab_时清掉它的_bounds_与_pending_记录() {
        let state = Arc::new(BrowserState::default());
        state
            .bounds_applied
            .lock()
            .await
            .insert("browser-a".to_string());
        *state.pending_show.lock().await = Some("browser-a".to_string());

        forget_tab_visibility(&state, "browser-a").await;

        assert!(state.bounds_applied.lock().await.is_empty());
        assert!(
            state.pending_show.lock().await.is_none(),
            "已关闭的 tab 不能继续挂在 pending 上——否则新 tab 的 bounds 到了也放行不了它"
        );
    }

    #[tokio::test]
    async fn 关掉别的_tab_不影响正在等待的那个() {
        let state = Arc::new(BrowserState::default());
        *state.pending_show.lock().await = Some("browser-a".to_string());

        forget_tab_visibility(&state, "browser-b").await;

        assert_eq!(
            state.pending_show.lock().await.as_deref(),
            Some("browser-a")
        );
    }

    #[tokio::test]
    async fn clear_current_active_把_active_置空() {
        let state = Arc::new(BrowserState::default());
        *state.current_active_id.lock().await = Some("browser-a".to_string());
        clear_current_active(&state).await;
        assert!(state.current_active_id.lock().await.is_none());
    }

    #[tokio::test]
    async fn resolve_active_tab_of_空_state_是_no_tab() {
        let state = Arc::new(BrowserState::default());
        assert_eq!(
            resolve_active_tab_of(&state).await,
            ActiveTabResolution::NoTab
        );
    }

    #[tokio::test]
    async fn close_tab_同时清理_load_state_避免泄漏() {
        // 直接操作 state 模拟 browser_close_tab 内部逻辑（单测没有真 Webview）
        let state = Arc::new(BrowserState::default());
        let (tx, _rx) = watch::channel(PageLoadState::default());
        state.load_state.lock().await.insert("tab-1".into(), tx);
        assert_eq!(state.load_state.lock().await.len(), 1);

        state.load_state.lock().await.remove("tab-1");
        assert_eq!(state.load_state.lock().await.len(), 0);
    }
}
