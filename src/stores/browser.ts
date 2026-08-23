import { create } from "zustand";
import { trackEvent } from "../lib/analytics";
import { DEFAULT_ZOOM, stepZoom } from "../lib/browserZoom";
import {
  browserClearActive,
  browserCloseTab,
  browserNavigate,
  browserOpenTab,
  browserSetZoom,
  browserPanelCloseAll,
  browserSetActive,
  browserSetScrollY,
  browserSuspendTab,
  type BrowserBounds,
} from "../lib/tauri";

/**
 * Phase 4A T2 + v0.4.1 T3：内嵌浏览器前端 store。
 *
 * tab 的所有 UI 状态（url / title / scrollY / pinned）由 zustand 持有；
 * 后端 [`BrowserState`] 只持有当前 **未 suspend** 的 webview handle。
 *
 * suspended tab：webview 已 destroy（释放 WKWebView 进程），仅前端残留 state；
 * resume 时调 [`browserOpenTab`] 重建 + [`browserSetScrollY`] 恢复滚动。
 *
 * `key` 是前端持久 id（不变；resume 会换 `id` 但 `key` 保留），保证 React diff 稳定。
 *
 * v0.4.1 T3 状态机三态（plan §5.1）：
 * - closed：     panelOpen=false, tabs=[]      （初始 / 用户主动清空）
 * - open：       panelOpen=true,  tabs ≥ 1     （面板可见，至少 1 active webview）
 * - suspended-all：panelOpen=false, tabs 保留    （面板隐藏，webview 全 destroy）
 *
 * 转换：
 * - openPanel():     closed → open（首次创建）
 * - minimizePanel(): open → suspended-all（保留 tabs，destroy webview）
 * - restorePanel():  suspended-all → open（恢复 active tab）
 * - closePanel():    任意 → closed（destructive，仅右键菜单 / 设置面板调）
 */

/** 单个 tab 的全部前端状态。 */
export interface BrowserTab {
  /** 后端 webview label；suspended 时为 null（webview 已 destroy）。 */
  id: string | null;
  url: string;
  title: string;
  /** 页面缩放比例（档位见 lib/browserZoom）。
   *  可选：持久化里的老数据没有这个字段，读的时候一律兜底 DEFAULT_ZOOM。 */
  zoom?: number;
  /** 是否以移动版 UA 打开。可选：老的持久化数据没这个字段，缺省当桌面版。 */
  mobile?: boolean;
  /**
   * - `active`：真在前台跑（后端有 webview）
   * - `suspended`：webview 已 destroy 只剩前端 state
   * - `loading`：openTab / resumeTab 调用中过渡态（避免重复触发）
   */
  state: "active" | "suspended" | "loading";
  /** suspend 前的滚动位置；resume 时调 [`browserSetScrollY`] 恢复。 */
  scrollY: number;
  /** pin 的 tab 永不被自动 suspend（即使超时 / 超 LRU 上限）。 */
  pinned: boolean;
  /** 上次 setActive 的时间戳（Date.now()）；自动 suspend timer 用这个判超时。 */
  lastActiveAt: number;
  /** 内部唯一 key（不变；id 可能因 suspend/resume 变化）。 */
  key: string;
}

interface BrowserState {
  /** 浏览器面板是否打开（用户点工具栏切换）。 */
  panelOpen: boolean;
  /** 当前 tab 列表（顺序 = UI 显示顺序）。 */
  tabs: BrowserTab[];
  /** 当前 active tab 的 key（不是 id；id 在 suspend/resume 时会变）。 */
  activeKey: string | null;
  /**
   * v1.3.0 P7：前端 `activeKey` 与后端 `current_active_id` 失步的原因；
   * `null` = 已同步。
   *
   * 后端"以为的 active tab"跟用户视觉看到的不是同一个，就是 ghost webview
   * （AI 操作了一个用户看不见的页面）。所以 set_active 失败**绝不静默吞**：
   * 重试仍失败就写这里 + 调 [`browserClearActive`] 让后端宁可不知道。
   * AI 开面板路径（`lib/browserOpenRequest.ts`）见到非 null 会直接回报失败。
   */
  activeSyncError: string | null;

  // ===== 面板级 actions =====

  /** 打开浏览器面板（仅切 panelOpen=true）。 */
  openPanel: () => void;
  /**
   * **destructive**：清空所有 tabs + destroy webview + 关面板。
   *
   * v0.4.1 T3 起这个动作只用于"用户明确要清空"场景：
   * - ActivityBar 🌐 按钮右键 → "关闭所有标签"（带二次确认）
   * - 设置面板"浏览器"段 → "清空所有标签"按钮
   *
   * 普通收起/恢复用 [`minimizePanel`] / [`restorePanel`]，保留 tabs。
   */
  closePanel: () => Promise<void>;
  /**
   * v0.4.1 T3 新增：收起面板，**保留 tabs state**。
   *
   * - 调 [`browserPanelCloseAll`] destroy 所有 webview
   * - tabs 数组保留；每个 tab 的 `state` 改为 `"suspended"`、`id` 清 null
   * - activeKey 保留，下次 [`restorePanel`] 自动恢复该 tab
   * - panelOpen=false
   *
   * 内存：webview 全 destroy → 主进程基线（参考 plan §5.1 表）
   */
  minimizePanel: () => Promise<void>;
  /**
   * v0.4.1 T3 新增：从 minimize 状态恢复面板。
   *
   * - panelOpen=true
   * - 若 tabs 为空 → 创建 about:blank（fallback 到首次打开语义）
   * - 若 activeKey 对应的 tab 为 suspended → 调 resumeTab 恢复（调用方传 bounds）
   * - 其它非 active tab 保持 suspended，符合 v0.4.0 既有 LRU 策略
   *
   * 注意：恢复 active tab 需要 bounds，由调用方（ActivityBar）持有。
   */
  restorePanel: (bounds: BrowserBounds) => Promise<void>;

  // ===== Tab 级 actions =====

  /** 新建 tab + 调后端创建 webview；自动设为 active。 */
  openTab: (url: string, bounds: BrowserBounds) => Promise<void>;
  /** 关闭 tab（destroy webview + 从列表删；若关的是 active 自动切到下一个）。 */
  closeTab: (key: string) => Promise<void>;
  /** 切前台 tab；suspended tab 自动 resume；更新 lastActiveAt。 */
  setActive: (key: string, bounds: BrowserBounds) => Promise<void>;
  /** 切 URL（走真 navigate API）。 */
  navigate: (key: string, url: string) => Promise<void>;
  /**
   * v0.5.8：后端 `browser:url_changed` 事件回调；AI 工具 / IPC navigate 完成
   * 后 emit，前端按 tab_id 找到 tab 同步更新 url + title。
   */
  applyUrlChanged: (tabId: string, url: string) => void;
  /** 后端 `browser:title_changed` 回调：把标签文字从 URL 换成真实标题。 */
  applyTitleChanged: (tabId: string, title: string) => void;
  /** 调整当前 tab 的页面缩放：+1 放大 / -1 缩小 / "reset" 回 100%。 */
  adjustZoom: (direction: 1 | -1 | "reset") => Promise<void>;
  /** 在"移动版 / 桌面版"之间切换当前 tab。UA 只能创建时定，所以会重建 webview
   *  并重新加载页面（登录态和滚动位置会丢，UI 上要提示）。 */
  toggleMobile: (bounds: BrowserBounds) => Promise<void>;

  // ===== Suspend / Resume =====

  /** 主动 suspend 一个 tab：destroy webview，保留 url/title/scrollY/pinned。 */
  suspendTab: (key: string) => Promise<void>;
  /**
   * v1.4.0：跨重启恢复浏览器 tab（由 snapshot 喂进来）。
   *
   * 恢复成 **suspended** 而不是真去建 webview：启动就给每个 tab 建一个 native
   * webview 会拖慢冷启动、白占内存，而且用户这次未必会打开浏览器面板。面板真被
   * 打开时 `restorePanel` 会 resume active 那个，其余按需 resume——跟自动 suspend
   * 之后的状态完全一样，走的是同一套机器。
   *
   * **不动 panelOpen**：上次收着面板的人，不该因为恢复就被弹一个面板出来。
   */
  restoreTabs: (
    tabs: {
      url: string;
      title: string;
      zoom?: number | null;
      mobile?: boolean;
    }[],
    activeIndex: number | null,
  ) => void;
  /** 主动 resume 一个 suspended tab：重建 webview + 恢复滚动。 */
  resumeTab: (key: string, bounds: BrowserBounds) => Promise<void>;

  /**
   * v1.3.0 P7：把"当前 activeKey 对应的 webview"重新同步给后端。
   *
   * 用在 dialog 关闭后（`useBrowserModalGuard`）——后端 `show_all_active` 只
   * 恢复它自己认为的 active，前端这边再断言一次，两边不一致时立刻掰正。
   * 没有任何 tab 时不发任何 IPC（多数 dialog 场景根本没开浏览器）。
   */
  reassertActive: () => Promise<void>;

  // ===== 标记类（仅改 store） =====

  /** 切换 pin 状态。 */
  pinTab: (key: string, pinned: boolean) => void;
  /** 写入 scrollY（前端可由 webview eval 周期性读 + IPC 上报；T2 仅 store 钩子）。 */
  updateScroll: (key: string, scrollY: number) => void;
  /** 更新 title（导航完成 / postMessage 来源；T2 仅 store 钩子）。 */
  updateTitle: (key: string, title: string) => void;
}

/** scrollY 恢复延迟：webview 创建后等 DOM 加载完再 eval scrollTo。 */
const SCROLL_RESTORE_DELAY_MS = 500;

let keyCounter = 0;
function nextKey(): string {
  keyCounter += 1;
  return `btab-${keyCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

/* ===========================================================================
 * v1.3.0 P7：前后端 active tab 同步（ghost webview 防线）
 * ---------------------------------------------------------------------------
 * 真机 bug：面板显示 baidu.com，AI 的 browser_eval 拿到的却是 GitHub —— 存在
 * 一个用户看不见、AI 却在操作的 webview。根因之一就是这里原来把
 * `browserSetActive` 的失败 `catch {}` 静默吞了：后端 `current_active_id` 停在
 * 旧 tab，前端 UI 却已经切走，两边默默分叉。
 *
 * 现在的约定：**同步失败可以接受，状态默默分叉不行**。
 * ======================================================================== */

/** 同步结果：ok = 后端已确认；gone = 后端说这个 webview 没了；failed = 同步不上。 */
type ActiveSyncResult = "ok" | "gone" | "failed";

/** 后端 `apply_set_active` 报"这个 webview 不存在"的特征文案。 */
function isTabGoneError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes("不存在") || msg.includes("suspend");
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 把"用户当前看的是这个 webview"同步给后端，失败不静默。
 *
 * - 第一次失败若是"webview 已不存在" → 直接返 `gone`（重试没意义，交给调用方自愈）
 * - 其它失败 → 重试一次（IPC 抖动 / race）
 * - 仍失败 → 返 `failed`，调用方负责调 [`clearBackendActive`] + 记 `activeSyncError`
 */
async function pushActiveToBackend(tabId: string): Promise<ActiveSyncResult> {
  try {
    await browserSetActive(tabId);
    return "ok";
  } catch (e) {
    if (isTabGoneError(e)) return "gone";
    try {
      await browserSetActive(tabId);
      return "ok";
    } catch (e2) {
      if (isTabGoneError(e2)) return "gone";
      console.error("[browser] set_active 重试后仍失败，已清空后端 active", e2);
      return "failed";
    }
  }
}

/** 让后端"宁可不知道 active 是谁"——AI 工具会明确报错而不是操作随机 webview。 */
async function clearBackendActive(): Promise<void> {
  try {
    await browserClearActive();
  } catch (e) {
    // 连清空都失败：后端可能已经不可用；至少把原因留在控制台
    console.error("[browser] clear_active 失败", e);
  }
}

/**
 * destroy 全部 webview（收起 / 清空面板共用）；失败重试一次。
 *
 * 返回 `null` = 成功；否则返回失败原因。失败意味着**后端可能还残留 webview**
 * 而前端已经按"没有了"记账，属于典型的 ghost 温床 —— 至少要清掉后端 active
 * 并把原因暴露到 `activeSyncError`，不能默默算过去。
 */
async function closeAllWithRetry(): Promise<string | null> {
  try {
    await browserPanelCloseAll();
    return null;
  } catch {
    try {
      await browserPanelCloseAll();
      return null;
    } catch (e2) {
      console.error("[browser] panel_close_all 重试后仍失败，后端可能残留 webview", e2);
      await clearBackendActive();
      return errText(e2);
    }
  }
}

export const useBrowserStore = create<BrowserState>((set, get) => ({
  panelOpen: false,
  tabs: [],
  activeKey: null,
  activeSyncError: null,

  openPanel: () => {
    set({ panelOpen: true });
    // v0.7.0-A：匿名统计——打开内嵌浏览器面板（不传 url / tabs 数）
    trackEvent("browser_opened");
  },

  closePanel: async () => {
    // destructive：清空全部。仅给"关闭所有标签"出口用。
    const err = await closeAllWithRetry();
    set({
      panelOpen: false,
      tabs: [],
      activeKey: null,
      activeSyncError: err ? `关闭浏览器时 webview 未能全部销毁：${err}` : null,
    });
  },

  minimizePanel: async () => {
    // 收起：destroy 所有 webview，但**保留** tabs/activeKey state。
    // 每个 tab 状态改为 suspended、id 清 null（webview 已不存在）。
    const err = await closeAllWithRetry();
    set((s) => ({
      panelOpen: false,
      // activeKey 保留（不动）
      tabs: s.tabs.map((t) => ({
        ...t,
        id: null,
        // loading 中的 tab 直接降到 suspended（重新打开时由 restorePanel 恢复）
        state: "suspended" as const,
      })),
      // 后端 destroy 失败 = 前端说"都没了"、后端可能还留着 webview → 记失步
      activeSyncError: err ? `收起浏览器时 webview 未能全部销毁：${err}` : null,
    }));
  },

  restorePanel: async (bounds) => {
    const { tabs, activeKey } = get();
    // 先开面板
    set({ panelOpen: true });

    // 若没 tabs（首次打开 / 之前 closePanel 清空过）→ 兜底新建 about:blank
    if (tabs.length === 0) {
      await get().openTab("about:blank", bounds);
      return;
    }

    // 若 activeKey 不存在或对应 tab 没了 → 选第一个非 loading 的 tab
    const activeTab = activeKey
      ? tabs.find((t) => t.key === activeKey)
      : undefined;
    const targetKey = activeTab?.key ?? tabs[0]?.key ?? null;
    if (!targetKey) return;
    const target = tabs.find((t) => t.key === targetKey);
    if (!target) return;

    // 已 active（理论上 minimize 后不会有，但容错）→ 仅 setActive
    if (target.state === "active" && target.id) {
      const sync = await pushActiveToBackend(target.id);
      if (sync === "gone") {
        // 前端记着 active、后端 webview 其实早没了 → 标 suspended 后重建自愈
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.key === targetKey ? { ...t, id: null, state: "suspended" } : t,
          ),
        }));
        await get().resumeTab(targetKey, bounds);
        return;
      }
      if (sync === "failed") {
        await clearBackendActive();
        set({ activeSyncError: `恢复面板时无法把 active tab 同步给后端` });
      } else {
        set({ activeSyncError: null });
      }
      set({ activeKey: targetKey });
      return;
    }

    // 默认情况：suspended → 走 resumeTab
    if (target.state === "suspended") {
      await get().resumeTab(targetKey, bounds);
    }
  },

  restoreTabs: (snapshotTabs, activeIndex) => {
    if (snapshotTabs.length === 0) return;
    // 已经有 tab 说明这轮启动已经恢复过（或用户已经开了 tab），不重复灌
    if (get().tabs.length > 0) return;

    const restored: BrowserTab[] = snapshotTabs.map((t) => ({
      id: null,
      url: t.url,
      title: t.title || t.url,
      state: "suspended",
      scrollY: 0,
      pinned: false,
      zoom: t.zoom ?? DEFAULT_ZOOM,
      mobile: t.mobile ?? false,
      lastActiveAt: Date.now(),
      key: nextKey(),
    }));

    // 下标越界或缺省都兜底到第一个：留着 activeKey=null 会让面板打开后没东西可 resume
    const idx =
      activeIndex !== null && activeIndex >= 0 && activeIndex < restored.length
        ? activeIndex
        : 0;

    set({ tabs: restored, activeKey: restored[idx].key });
  },

  openTab: async (url, bounds) => {
    // 占位 tab：先标 loading 防快速重复点；后端返回后回填 id
    const key = nextKey();
    const placeholder: BrowserTab = {
      id: null,
      url,
      title: url, // 默认用 url 当 title，等导航完成由 updateTitle 覆盖
      state: "loading",
      scrollY: 0,
      pinned: false,
      zoom: DEFAULT_ZOOM,
      lastActiveAt: Date.now(),
      key,
    };
    set((s) => ({
      tabs: [...s.tabs, placeholder],
      activeKey: key,
      panelOpen: true,
    }));

    try {
      const result = await browserOpenTab(url, bounds, false);
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.key === key ? { ...t, id: result.tab_id, state: "active" } : t,
        ),
      }));
      // 新开的 tab 即 active；调一次 set_active 把别的 hide 掉。
      // v1.3.0 P7：这里**不能**吞异常 —— 同步不上就意味着后端 current_active_id
      // 还指着上一个 tab，而屏幕上显示的是刚建的这个：AI 操作的就成了 ghost。
      const sync = await pushActiveToBackend(result.tab_id);
      if (sync === "ok") {
        set({ activeSyncError: null });
      } else {
        await clearBackendActive();
        set({
          activeSyncError: `新建浏览器 tab 后无法把 active 同步给后端（${sync}）`,
        });
      }
    } catch (e) {
      // 创建失败：把占位 tab 撤销
      console.error("openTab 失败", e);
      set((s) => ({
        tabs: s.tabs.filter((t) => t.key !== key),
        activeKey:
          s.activeKey === key
            ? (s.tabs.find((t) => t.key !== key)?.key ?? null)
            : s.activeKey,
      }));
    }
  },

  closeTab: async (key) => {
    const { tabs, activeKey } = get();
    const tab = tabs.find((t) => t.key === key);
    if (!tab) return;
    if (tab.id) {
      try {
        await browserCloseTab(tab.id);
      } catch {
        // 后端已不存在亦无碍
      }
    }
    const idx = tabs.findIndex((t) => t.key === key);
    const remaining = tabs.filter((t) => t.key !== key);

    // v0.9.0 H4：关到最后一个 tab → 浏览器面板自动收起（destructive 关闭）
    // 之前真机：关 last tab 后浏览器面板空 URL 栏还在，要再去右键 "关闭浏览器" 才能消失
    if (remaining.length === 0) {
      set({ tabs: [], activeKey: null });
      await get().closePanel();
      return;
    }

    let newActive = activeKey;
    if (activeKey === key) {
      // 切到右侧；右侧没有就切到左侧
      newActive = remaining[idx]?.key ?? remaining[idx - 1]?.key ?? null;
    }
    set({ tabs: remaining, activeKey: newActive });

    // v1.3.0 P7：关掉的是 active tab 时，后端的 current_active_id 已被清空
    // （见 ipc/browser.rs 的 browser_close_tab）。这里必须把新 active 补同步过去，
    // 否则后端"有 webview 却不知道哪个可见"：旧实现会退化成随机挑一个给 AI，
    // 用户这边则是新 active 的 webview 还处于 hide 状态（面板空白）。
    if (activeKey === key) {
      const next = remaining.find((t) => t.key === newActive);
      if (next?.id && next.state === "active") {
        const sync = await pushActiveToBackend(next.id);
        if (sync === "ok") {
          set({ activeSyncError: null });
        } else {
          await clearBackendActive();
          set({ activeSyncError: `关闭 tab 后无法把新 active 同步给后端` });
        }
      } else {
        // 新 active 还是 suspended（等调用方带 bounds 来 resume）——
        // 后端此刻没有对应 webview，明确告诉它"不知道"，别让 AI 猜。
        await clearBackendActive();
      }
    }
    // 切到的新 active 若是 suspended，等下次 setActive 由调用方触发 resume；
    // store 内部不主动 resume，避免在 closeTab 路径需要传 bounds。
  },

  setActive: async (key, bounds) => {
    const tab = get().tabs.find((t) => t.key === key);
    if (!tab) return;
    const now = Date.now();

    if (tab.state === "suspended") {
      // 直接走 resume 路径（resume 自带 setActive）
      await get().resumeTab(key, bounds);
      return;
    }

    if (tab.id) {
      const sync = await pushActiveToBackend(tab.id);
      if (sync === "gone") {
        // 后端 webview 已经不在（被 close / suspend 抢跑）：前端 state 是假的，
        // 标回 suspended 再走 resume 重建 —— 自愈，而不是让两边继续分叉。
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.key === key ? { ...t, id: null, state: "suspended" as const } : t,
          ),
        }));
        await get().resumeTab(key, bounds);
        return;
      }
      if (sync === "ok") {
        set({ activeSyncError: null });
      } else {
        await clearBackendActive();
        set({ activeSyncError: `切换 tab 后无法把 active 同步给后端` });
      }
    }
    set((s) => ({
      activeKey: key,
      tabs: s.tabs.map((t) => (t.key === key ? { ...t, lastActiveAt: now } : t)),
    }));
  },

  navigate: async (key, url) => {
    const tab = get().tabs.find((t) => t.key === key);
    if (!tab || !tab.id) return;
    try {
      await browserNavigate(tab.id, url);
      set((s) => ({
        tabs: s.tabs.map((t) => (t.key === key ? { ...t, url, title: url } : t)),
      }));
    } catch {
      // navigate 失败保留旧 url
    }
  },

  adjustZoom: async (direction) => {
    const { tabs, activeKey } = get();
    const tab = tabs.find((t) => t.key === activeKey);
    if (!tab?.id) return;
    const next =
      direction === "reset"
        ? DEFAULT_ZOOM
        : stepZoom(tab.zoom ?? DEFAULT_ZOOM, direction);
    // 先落 store 再发 IPC：IPC 失败也不该让 UI 上的百分比跟页面不一致——
    // 失败时回滚回原值，宁可什么都没变，也不要显示一个假的比例
    set((s) => ({
      tabs: s.tabs.map((t) => (t.key === tab.key ? { ...t, zoom: next } : t)),
    }));
    try {
      await browserSetZoom(tab.id, next);
    } catch (e) {
      console.warn("[browser] 设置缩放失败，回滚", e);
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.key === tab.key ? { ...t, zoom: tab.zoom ?? DEFAULT_ZOOM } : t,
        ),
      }));
    }
  },

  toggleMobile: async (bounds) => {
    const { tabs, activeKey } = get();
    const tab = tabs.find((t) => t.key === activeKey);
    if (!tab) return;
    const next = !(tab.mobile ?? false);
    // 先写标志再走 suspend → resume：resumeTab 会读 tab.mobile 决定用哪个 UA。
    // 复用这两条已有路径，而不是自己拼一套销毁重建 —— 它们已经处理好了
    // active 同步、失败回滚、滚动恢复这些边界。
    set((s) => ({
      tabs: s.tabs.map((t) => (t.key === tab.key ? { ...t, mobile: next } : t)),
    }));
    await get().suspendTab(tab.key);
    await get().resumeTab(tab.key, bounds);
  },

  applyTitleChanged: (tabId, title) => {
    // 按后端 tab_id 找（不是 key）。空标题忽略：宁可继续显示 URL，
    // 也不要给用户一个没有文字的标签页
    const trimmed = title.trim();
    if (!trimmed) return;
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, title: trimmed } : t)),
    }));
  },

  applyUrlChanged: (tabId, url) => {
    // v0.5.8：按后端 tab_id（不是 key）找 tab；AI 工具调 wv.navigate 后 emit
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId ? { ...t, url, title: url } : t,
      ),
    }));
  },

  suspendTab: async (key) => {
    const tab = get().tabs.find((t) => t.key === key);
    if (!tab || tab.state !== "active" || !tab.id) return;
    try {
      await browserSuspendTab(tab.id);
    } catch {
      // 后端已 destroy 亦无碍
    }
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.key === key ? { ...t, id: null, state: "suspended" } : t,
      ),
    }));
  },

  resumeTab: async (key, bounds) => {
    const tab = get().tabs.find((t) => t.key === key);
    if (!tab || tab.state !== "suspended") return;
    // 先标 loading 防重复触发
    set((s) => ({
      tabs: s.tabs.map((t) => (t.key === key ? { ...t, state: "loading" } : t)),
    }));

    try {
      const result = await browserOpenTab(tab.url, bounds, tab.mobile ?? false);
      const newId = result.tab_id;
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.key === key
            ? { ...t, id: newId, state: "active", lastActiveAt: Date.now() }
            : t,
        ),
        activeKey: key,
      }));
      // v1.3.0 P7：resume 出来的是**新** webview id，同步不上后端就还指着旧 id
      const sync = await pushActiveToBackend(newId);
      if (sync === "ok") {
        set({ activeSyncError: null });
      } else {
        await clearBackendActive();
        set({ activeSyncError: `恢复 tab 后无法把 active 同步给后端（${sync}）` });
      }
      // 恢复缩放：webview 是**新建的**，缩放比例不会跟着 tab 状态自动回来，
      // 不重新下发的话用户会发现"收起再展开，页面又变回 100%"
      const savedZoom = tab.zoom ?? DEFAULT_ZOOM;
      if (savedZoom !== DEFAULT_ZOOM) {
        browserSetZoom(newId, savedZoom).catch((e) => {
          console.warn("[browser] 恢复缩放失败", e);
        });
      }
      // 恢复滚动：等 webview 加载完成再 eval。500ms 是经验值；
      // 真机上慢页面可能不够，但 T2 阶段保守即可——失败也只是回到顶部。
      if (tab.scrollY > 0) {
        setTimeout(() => {
          browserSetScrollY(newId, tab.scrollY).catch(() => {});
        }, SCROLL_RESTORE_DELAY_MS);
      }
    } catch {
      // resume 失败回退到 suspended 状态；下次 setActive 再试
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.key === key ? { ...t, state: "suspended" } : t,
        ),
      }));
    }
  },

  reassertActive: async () => {
    const { tabs, activeKey } = get();
    // 没开过浏览器 → 一个 IPC 都不发（绝大多数 dialog 场景都是这种）
    if (tabs.length === 0) return;
    const target = tabs.find((t) => t.key === activeKey);
    if (target?.id && target.state === "active") {
      const sync = await pushActiveToBackend(target.id);
      if (sync === "ok") {
        set({ activeSyncError: null });
      } else {
        await clearBackendActive();
        set({ activeSyncError: `重新同步 active tab 失败（${sync}）` });
      }
      return;
    }
    // active tab 目前没有 webview（suspended / loading）→ 后端不该保留任何 active
    await clearBackendActive();
  },

  pinTab: (key, pinned) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.key === key ? { ...t, pinned } : t)),
    })),

  updateScroll: (key, scrollY) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.key === key ? { ...t, scrollY } : t)),
    })),

  updateTitle: (key, title) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.key === key ? { ...t, title } : t)),
    })),
}));
