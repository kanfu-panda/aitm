import { create } from "zustand";

/**
 * 通知状态环颜色（v0.5.0-A，plan §1.2）。
 *
 * 优先级：waiting > error > done > running（plan §7 维护者 决策 #1）。
 * 同一 tab 只显示最高优先级状态，低优先级不能覆盖高优先级。
 */
export type NotificationLevel = "running" | "waiting" | "done" | "error";

export interface TabNotificationState {
  /** 当前 tab 显示的最高优先级状态 */
  level: NotificationLevel;
  /** 最近一条通知的 message，用于系统通知 body / Cmd+Shift+U 跳过去后定位 */
  lastMessage: string | null;
  /** 最近一条通知时间，jumpToLatestUnread 排序用 */
  lastTimestampMs: number;
}

/** 后端 emit "notification:received" 的 payload；session_id 转 tabId 由订阅方做 */
export interface NotificationEvent {
  session_id: string;
  level: NotificationLevel;
  message: string;
  source: "ai_tool_loop" | "osc_9" | "osc_99" | "osc_777";
  timestamp_ms: number;
}

/** 优先级 helper（plan §7 决策 1：waiting > error > done > running） */
export function priority(level: NotificationLevel | null): number {
  if (!level) return 0;
  const map: Record<NotificationLevel, number> = {
    running: 1,
    done: 2,
    error: 3,
    waiting: 4,
  };
  return map[level];
}

/**
 * 系统通知 hook 注入点。
 *
 * T5 实现 src/lib/systemNotification.ts 后在 main.tsx 调
 * setSystemNotificationHook 注入；T2 阶段 store 自包含，单测可注入 mock。
 *
 * 设计上 store **不直接依赖** Tauri plugin-notification，让 store 单测在
 * jsdom 内运行不需要 mock 整个 plugin。
 */
let systemNotificationHook: ((event: NotificationEvent) => void) | null = null;

export function setSystemNotificationHook(
  hook: ((event: NotificationEvent) => void) | null,
): void {
  systemNotificationHook = hook;
}

/**
 * v0.10.5：notifications → tabs.markUnread 注入。
 *
 * 避免 notifications.ts 直接 import tabs.ts（tabs 已 import notifications
 * 形成循环）。main.tsx 启动时调 setMarkUnreadHook 注入。
 */
let markUnreadHook: ((tabId: string) => void) | null = null;

export function setMarkUnreadHook(
  hook: ((tabId: string) => void) | null,
): void {
  markUnreadHook = hook;
}

/** 单测用：读当前 hook，便于断言注入 */
export function getSystemNotificationHook():
  | ((event: NotificationEvent) => void)
  | null {
  return systemNotificationHook;
}

interface NotificationsState {
  byTab: Record<string, TabNotificationState>;

  /**
   * 仅更新 UI 状态环，**不**触发系统通知。AI 工具循环 / OSC 解析路径若想细粒度
   * 控制是否发系统通知（如 running 不发）用这个；否则用 emitNotification。
   *
   * 按优先级保护：当前 level 优先级 > 新 level → 不覆盖。
   * 当前 level 优先级 ≤ 新 level → 覆盖 + 更新 lastTimestampMs。
   */
  setTabState: (
    tabId: string,
    level: NotificationLevel,
    message?: string,
  ) => void;

  /**
   * 完整发通知：先 setTabState 更新 UI，再调 systemNotificationHook
   * （running 级别 **不** 调 hook，plan §7 决策 #2）。
   */
  emitNotification: (tabId: string, event: NotificationEvent) => void;

  /** 用户切到该 tab 时调，删除整个 entry 让 jumpToLatestUnread 跳过 */
  clearTab: (tabId: string) => void;

  /** Cmd+Shift+U 跳最近未读：返回 lastTimestampMs 最大的 tabId，空时 null */
  jumpToLatestUnread: () => string | null;
}

export const useNotificationsStore = create<NotificationsState>((set, get) => ({
  byTab: {},

  setTabState: (tabId, level, message) =>
    set((s) => {
      const existing = s.byTab[tabId];
      // 优先级保护：当前更高 → 不覆盖（但仍更新 message 若提供，避免 user
      // 看到状态环但 message 是旧的）
      if (existing && priority(existing.level) > priority(level)) {
        if (message === undefined) return s;
        return {
          byTab: {
            ...s.byTab,
            [tabId]: { ...existing, lastMessage: message },
          },
        };
      }
      return {
        byTab: {
          ...s.byTab,
          [tabId]: {
            level,
            lastMessage: message ?? existing?.lastMessage ?? null,
            lastTimestampMs: Date.now(),
          },
        },
      };
    }),

  emitNotification: (tabId, event) => {
    get().setTabState(tabId, event.level, event.message);
    // v0.10.5 hotfix：unread 数字 badge 触发挪到这里（之前在 TerminalView
    // 的 onSessionData 任何 PTY 输出 +1，noisy）。现在只在真有通知
    // （OSC 9/777/AI tool）时 +1，跟 macOS Terminal 的 BEL 语义一致。
    // 用 markUnreadHook 注入避免 notifications ↔ tabs 循环 import 死锁
    // （tabs 已 import notifications，注入而非反向 import）。
    markUnreadHook?.(tabId);
    if (event.level !== "running") {
      systemNotificationHook?.(event);
    }
  },

  clearTab: (tabId) =>
    set((s) => {
      if (!s.byTab[tabId]) return s;
      const next = { ...s.byTab };
      delete next[tabId];
      return { byTab: next };
    }),

  jumpToLatestUnread: () => {
    const entries = Object.entries(get().byTab);
    if (entries.length === 0) return null;
    // sort 已自动跳过 level=null 的 entry（clearTab 删整 entry，存在的 entry
    // 一定有 level）；按 timestamp 倒序，取最新
    entries.sort((a, b) => b[1].lastTimestampMs - a[1].lastTimestampMs);
    return entries[0][0];
  },
}));
