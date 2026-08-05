import {
  browserOpenResult,
  type BrowserBounds,
  type BrowserOpenRequestedEvent,
} from "./tauri";
import { useBrowserStore } from "../stores/browser";

/**
 * v1.2.0 T-B3：处理后端 `browser:open_requested` —— **AI 自己打开内嵌浏览器面板**。
 *
 * 为什么要前端参与：后端 `browser_open_tab` 需要 bounds（webview 的屏幕位置 /
 * 大小），bounds 只有前端布局算得出（BrowserPanel 的 ResizeObserver 上报）。
 * 所以 AI 工具 emit 事件请前端代劳，前端建完调 `browser_open_result` 回报。
 *
 * **bounds 绝不自己新算**（v0.4.1 / v0.4.2 / v0.4.3 真机反复翻车：framer-motion
 * transform 让 getBoundingClientRect 偏、wry macOS y 偏移 30px）。这里直接复用
 * ActivityBar 点地球图标那条路径的占位 bounds
 * [`PLACEHOLDER_BROWSER_BOUNDS`]，真值由 BrowserPanel mount 后的
 * ResizeObserver 覆盖 —— 跟用户手动打开面板走的是同一套代码。
 */

/**
 * 打开浏览器面板用的占位 bounds。
 *
 * ActivityBar 的 `handleBrowserClick` 和本模块共用同一个常量，保证 AI 打开面板
 * 跟用户点地球图标**走完全相同的代码路径**。BrowserPanel mount 后
 * ResizeObserver 会立刻用真实 bounds 覆盖，这里只是给 webview 创建一个起点。
 */
export const PLACEHOLDER_BROWSER_BOUNDS: BrowserBounds = {
  x: 0,
  y: 0,
  w: 800,
  h: 600,
};

/**
 * 已处理过的 request_id。
 *
 * React StrictMode 下 effect 会 mount → unmount → mount，中间存在两个 listener
 * 短暂共存的窗口；同一事件被处理两次会开出两个 tab。用 Set 去重挡住。
 */
const handledRequests = new Set<string>();

/** 仅测试用：清空去重表。 */
export function __resetHandledOpenRequests(): void {
  handledRequests.clear();
}

/**
 * 打开（或恢复）浏览器面板并按需导航，返回真实 tab_id。
 *
 * - 没有任何 tab → `openTab(url)`：一步建 webview + 直接加载目标 URL
 * - 已有 tab（面板收起 / 全 suspended）→ `restorePanel()` 恢复 activeKey 那个
 *   tab（跟用户点地球图标一致），再按需 `navigate` 到目标 URL
 *
 * 拿不到 tab id 就抛错 —— 上层会回报 ok=false，**绝不让 AI 谎报"已打开"**。
 */
async function openBrowserPanelForAi(url: string | null): Promise<string> {
  const target = url?.trim() ? url.trim() : "about:blank";
  const store = useBrowserStore.getState();

  if (store.tabs.length === 0) {
    await store.openTab(target, PLACEHOLDER_BROWSER_BOUNDS);
  } else {
    await store.restorePanel(PLACEHOLDER_BROWSER_BOUNDS);
    // 只有 AI 明确给了 url 才导航；没给就保持用户原来那个页面
    if (url?.trim()) {
      const restored = useBrowserStore.getState();
      if (restored.activeKey) {
        await restored.navigate(restored.activeKey, target);
      }
    }
  }

  const after = useBrowserStore.getState();
  const active = after.tabs.find((t) => t.key === after.activeKey);
  if (!active?.id) {
    throw new Error("浏览器 webview 创建失败（后端未返回 tab_id）");
  }
  // v1.3.0 P7：前后端 active 失步时，这个 tab_id 未必是用户真正看得见的那个。
  // 与其把可能是 ghost 的 id 交给 AI（它接着就会 eval / click），不如直接失败。
  if (after.activeSyncError) {
    throw new Error(
      `浏览器 tab 与后端失步，已放弃本次操作以免 AI 操作到用户看不见的页面：${after.activeSyncError}`,
    );
  }
  return active.id;
}

/**
 * `browser:open_requested` 事件 handler：开面板 → 回报结果。
 *
 * 成功 / 失败**都要**回报，否则后端 AI 工具会死等到 10s 超时。
 */
export async function handleBrowserOpenRequested(
  ev: BrowserOpenRequestedEvent,
): Promise<void> {
  if (handledRequests.has(ev.request_id)) return;
  handledRequests.add(ev.request_id);

  try {
    const tabId = await openBrowserPanelForAi(ev.url);
    await browserOpenResult(ev.request_id, true, tabId, null);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    // 回报失败本身再失败也不能抛（事件 handler 内 unhandled rejection）
    await browserOpenResult(ev.request_id, false, null, reason).catch(() => {});
  }
}
