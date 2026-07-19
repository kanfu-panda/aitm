import { create } from "zustand";
import i18n from "../lib/i18n";
import { trackEvent } from "../lib/analytics";
import { useNotificationsStore } from "./notifications";

/** 前端 tab id（与后端 SessionId 不同——前端可能在 session 还未打开时已有 tab）。 */
export type TabId = string;

export interface Tab {
  id: TabId;
  title: string;
  /** 后端 session id；session 打开后回填。 */
  sessionId: string | null;
  /**
   * v0.9.0 T3：title 是否自动跟随 shell cwd（OSC 7 上报）。
   * - 新 tab 默认 `true`：shell 调 `cd` 后 title 自动改成 basename(cwd)。
   * - 用户手动 [`setTitle`] / 双击改 title 后自动转 `false`，给"我已经命名了，
   *   别覆盖"留余地。
   * - 右键菜单"重置为自动跟随目录"→ `setAutoTitle(id, true)`，立刻按当前 cwd 刷一次。
   */
  auto_title: boolean;
  /** 最后一次从 OSC 7 接到的 shell cwd 绝对路径；首条到来前为 undefined。 */
  cwd?: string;
  /**
   * v0.9.1 HR3-1：跨重启持久化用的 cwd 快照。
   *
   * - 与 [`cwd`] 同步更新（applyCwdChange + restore 走 snapshot 时填）。
   * - 重启时由 [`App.tsx`] handleRestore 从 `SessionSnapshot.cwd` 还原；
   *   TerminalView 调 `sessionOpen` 时把它作为 cfg.cwd 传给后端，PTY
   *   启动时 chdir 过去。
   * - 与 `cwd` 拆开是因为 `cwd` 语义是"当前实际 cwd"（OSC 7 实时），
   *   `last_cwd` 是"上次会话最后一次 cwd"——重启时只有 `last_cwd`，
   *   `cwd` 要等 PTY 实际跑出 OSC 7 才有。
   */
  last_cwd?: string;
  /**
   * v0.10.5 #1：PTY spawn 失败时的错误消息。
   * - undefined = spawn 成功 / 还没尝试
   * - 字符串 = 后端 session_open 抛错，UI 在终端容器内渲染 banner
   *   提示用户（macOS open file 限制 / fork 失败 / 路径无效等）
   * 用户右键关 tab / Cmd+W 关掉后从 store 移除。
   */
  spawnError?: string;
}

interface TabsState {
  tabs: Tab[];
  activeId: TabId | null;
  /**
   * 每个 tab 的未读计数；切到该 tab 自动清零。0 表示已读。
   * 仅 in-memory，不持久化（v0.2.0 决议）。
   */
  unreadByTab: Record<TabId, number>;
  addTab: () => TabId;
  closeTab: (id: TabId) => void;
  setActive: (id: TabId) => void;
  setSessionId: (tabId: TabId, sessionId: string) => void;
  /**
   * 用户手动改 title。**副作用**：自动 `auto_title=false`，避免下一次 OSC 7
   * 把用户命名的 title 覆写回 basename。要恢复自动跟随调 [`setAutoTitle`]。
   */
  setTitle: (tabId: TabId, title: string) => void;
  /** v0.9.0 T3：切换 tab 的 `auto_title` 标志。 */
  setAutoTitle: (tabId: TabId, autoTitle: boolean) => void;
  /**
   * v0.9.0 T3：后端 OSC 7 解析出新 cwd 时调用。
   * - 更新 `cwd` 字段
   * - 若该 tab `auto_title === true`，按 `basename(cwd)` 同步 title
   * - v0.9.1 HR3-1：同步刷 `last_cwd`（跨重启持久化）
   */
  applyCwdChange: (sessionId: string, cwd: string) => void;
  /**
   * v0.9.1 HR3-1：跨重启 restore 时回填 last_cwd。
   * 由 App.tsx handleRestore 按 SessionSnapshot.cwd 喂回；
   * TerminalView 启动 PTY 时把它作为 cfg.cwd 传给后端。
   */
  setLastCwd: (tabId: TabId, cwd: string | undefined) => void;
  /**
   * 给指定 tab 计数 +1；如果 tab 已是 active 则 noop。
   * 内部 200ms 节流：同一 tabId 在 200ms 窗口内多次触发只算一次，
   * 避免高吞吐 PTY 输出（如 npm install）轰炸 zustand 写入。
   */
  markUnread: (tabId: TabId) => void;
  /** 强制清零指定 tab 的未读计数。setActive 内部会自动调用。 */
  clearUnread: (tabId: TabId) => void;
  /** v0.10.5 #1：标记 tab 的 PTY spawn 失败状态。null 清除。 */
  setSpawnError: (tabId: TabId, error: string | null) => void;
  /**
   * v1.1.0 R1：主窗口是否聚焦（由后端 WindowEvent::Focused 经
   * `window:focus-changed` 事件推送，App.tsx 订阅后写入）。markUnread 用它门控：
   * 活跃 tab && 窗口聚焦 → 不 badge。默认 true（app 启动即聚焦）。
   */
  windowFocused: boolean;
  setWindowFocused: (focused: boolean) => void;
}

let counter = 0;
function nextTabId(): TabId {
  counter += 1;
  return `tab-${counter}`;
}

/**
 * v0.9.0 T3：把绝对路径切到 basename，作为 tab title 显示。
 * - `/Users/leo/proj/aitm` → `aitm`
 * - `/` → `/`（根目录保留斜杠）
 * - 末尾多斜杠忽略：`/x/y/` → `y`
 * - 空串兜底返回 `/`，避免 title 完全空白
 */
export function basenameOrRoot(path: string): string {
  if (!path) return "/";
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0) return "/";
  return parts[parts.length - 1];
}

/** markUnread 节流窗口：单位 ms。 */
const MARK_UNREAD_THROTTLE_MS = 200;
/** 每个 tabId 上次成功 mark 的时间戳（performance.now()）。 */
const lastMarkAt: Map<TabId, number> = new Map();

export const useTabsStore = create<TabsState>((set, get) => ({
  tabs: [],
  activeId: null,
  unreadByTab: {},
  windowFocused: true,

  addTab: () => {
    const id = nextTabId();
    set((s) => ({
      tabs: [
        ...s.tabs,
        // v0.10.5：title 走 i18n（之前硬编码"新标签"在英/日 UI 下显示突兀）。
        // i18n 实例已在 main.tsx import "./lib/i18n" 时 init；store 顶层 import
        // 不触发 react 上下文，可以直接调 i18n.t。
        // 首条 OSC 7 cwd 到达后 applyCwdChange 会把 auto_title=true 的 tab
        // 改为 basename(cwd)，所以这个默认 title 通常 < 1s 就被替换。
        { id, title: i18n.t("tabs.newTab"), sessionId: null, auto_title: true },
      ],
      activeId: id,
    }));
    // v0.7.0-A：匿名统计——新开 terminal tab（不传 id / title）
    trackEvent("tab_opened");
    return id;
  },

  closeTab: (id) => {
    const { tabs, activeId } = get();
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const remaining = tabs.filter((t) => t.id !== id);
    let newActive: TabId | null = activeId;
    if (activeId === id) {
      // 切到右侧；右侧没有就切到左侧；都没有 → null
      newActive = remaining[idx]?.id ?? remaining[idx - 1]?.id ?? null;
    }
    // 顺手清理被关 tab 的 unread + 节流记录
    lastMarkAt.delete(id);
    set((s) => {
      const nextUnread = { ...s.unreadByTab };
      delete nextUnread[id];
      return { tabs: remaining, activeId: newActive, unreadByTab: nextUnread };
    });
  },

  setActive: (id) => {
    // 切到目标 tab 时自动清零它的未读 + v0.5.0-A 通知状态环（用户看见了等于已读）
    useNotificationsStore.getState().clearTab(id);
    set((s) => {
      if (s.unreadByTab[id]) {
        const nextUnread = { ...s.unreadByTab };
        delete nextUnread[id];
        return { activeId: id, unreadByTab: nextUnread };
      }
      return { activeId: id };
    });
  },

  setSessionId: (tabId, sessionId) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, sessionId } : t)),
    })),

  setTitle: (tabId, title) =>
    set((s) => ({
      // 用户手改 title → 自动 auto_title=false；OSC 7 之后不再覆盖
      tabs: s.tabs.map((t) =>
        t.id === tabId ? { ...t, title, auto_title: false } : t,
      ),
    })),

  setAutoTitle: (tabId, autoTitle) =>
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== tabId) return t;
        // 切回 auto=true 且当前有 cwd 缓存 → 顺手用 basename(cwd) 刷一次 title
        if (autoTitle && t.cwd) {
          return { ...t, auto_title: true, title: basenameOrRoot(t.cwd) };
        }
        return { ...t, auto_title: autoTitle };
      }),
    })),

  applyCwdChange: (sessionId, cwd) =>
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.sessionId !== sessionId) return t;
        // v0.9.1 HR3-1：last_cwd 跟 cwd 实时同步，重启时由 snapshot 持久化路径写盘
        const next: Tab = { ...t, cwd, last_cwd: cwd };
        if (t.auto_title) {
          next.title = basenameOrRoot(cwd);
        }
        return next;
      }),
    })),

  setLastCwd: (tabId, cwd) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, last_cwd: cwd } : t)),
    })),

  markUnread: (tabId) => {
    // v1.1.0 R1：恢复焦点门控——**用后端 OS 级 window:focus-changed 信号**（可靠），
    // 不再用上次那套 Tauri JS onFocusChanged（多 webview 真机不触发，才被迫全删）。
    // 用户正看着某 tab（该 tab active 且窗口聚焦）时，tab 补全响铃等 BEL 噪声不该
    // 点角标（真机反馈：敲 `cd ` 补全就 badge 了）；只有该 tab 在后台、或用户切到
    // 别的 app（窗口失焦）时才计未读点角标。清零仍交给 setActive（点 / 切到该 tab）。
    const { activeId, windowFocused } = get();
    if (tabId === activeId && windowFocused) return;
    // 节流：200ms 窗口内同一 tabId 的连续 mark 只算 1 次。
    const now = Date.now();
    const prev = lastMarkAt.get(tabId);
    if (prev !== undefined && now - prev < MARK_UNREAD_THROTTLE_MS) return;
    lastMarkAt.set(tabId, now);
    set((s) => ({
      unreadByTab: {
        ...s.unreadByTab,
        [tabId]: (s.unreadByTab[tabId] ?? 0) + 1,
      },
    }));
  },

  clearUnread: (tabId) => {
    lastMarkAt.delete(tabId);
    set((s) => {
      if (!s.unreadByTab[tabId]) return s;
      const nextUnread = { ...s.unreadByTab };
      delete nextUnread[tabId];
      return { unreadByTab: nextUnread };
    });
  },

  setSpawnError: (tabId, error) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId
          ? { ...t, spawnError: error === null ? undefined : error }
          : t,
      ),
    })),

  setWindowFocused: (focused) => set({ windowFocused: focused }),
}));
