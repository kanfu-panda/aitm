import { create } from "zustand";
import { trackEvent } from "../lib/analytics";
import {
  browserCloseTab,
  browserNavigate,
  browserOpenTab,
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

  // ===== Suspend / Resume =====

  /** 主动 suspend 一个 tab：destroy webview，保留 url/title/scrollY/pinned。 */
  suspendTab: (key: string) => Promise<void>;
  /** 主动 resume 一个 suspended tab：重建 webview + 恢复滚动。 */
  resumeTab: (key: string, bounds: BrowserBounds) => Promise<void>;

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

export const useBrowserStore = create<BrowserState>((set, get) => ({
  panelOpen: false,
  tabs: [],
  activeKey: null,

  openPanel: () => {
    set({ panelOpen: true });
    // v0.7.0-A：匿名统计——打开内嵌浏览器面板（不传 url / tabs 数）
    trackEvent("browser_opened");
  },

  closePanel: async () => {
    // destructive：清空全部。仅给"关闭所有标签"出口用。
    try {
      await browserPanelCloseAll();
    } catch {
      // close 失败不致命：前端 state 仍清空
    }
    set({ panelOpen: false, tabs: [], activeKey: null });
  },

  minimizePanel: async () => {
    // 收起：destroy 所有 webview，但**保留** tabs/activeKey state。
    // 每个 tab 状态改为 suspended、id 清 null（webview 已不存在）。
    try {
      await browserPanelCloseAll();
    } catch {
      // 后端 destroy 失败不致命：state 仍标 suspended
    }
    set((s) => ({
      panelOpen: false,
      // activeKey 保留（不动）
      tabs: s.tabs.map((t) => ({
        ...t,
        id: null,
        // loading 中的 tab 直接降到 suspended（重新打开时由 restorePanel 恢复）
        state: "suspended" as const,
      })),
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
      try {
        await browserSetActive(target.id);
      } catch {
        // 失败不致命
      }
      set({ activeKey: targetKey });
      return;
    }

    // 默认情况：suspended → 走 resumeTab
    if (target.state === "suspended") {
      await get().resumeTab(targetKey, bounds);
    }
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
      lastActiveAt: Date.now(),
      key,
    };
    set((s) => ({
      tabs: [...s.tabs, placeholder],
      activeKey: key,
      panelOpen: true,
    }));

    try {
      const result = await browserOpenTab(url, bounds);
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.key === key ? { ...t, id: result.tab_id, state: "active" } : t,
        ),
      }));
      // 新开的 tab 即 active；调一次 set_active 把别的 hide 掉
      try {
        await browserSetActive(result.tab_id);
      } catch {
        // 失败不致命：UI 上只是多个 webview 同时显示，下一次 setActive 会修
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
      try {
        await browserSetActive(tab.id);
      } catch {
        // 失败不致命
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
      const result = await browserOpenTab(tab.url, bounds);
      const newId = result.tab_id;
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.key === key
            ? { ...t, id: newId, state: "active", lastActiveAt: Date.now() }
            : t,
        ),
        activeKey: key,
      }));
      try {
        await browserSetActive(newId);
      } catch {
        // 失败不致命
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
