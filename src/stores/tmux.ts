import { create } from "zustand";
import {
  tmuxAvailable,
  tmuxInterruptSession,
  tmuxKillSession,
  tmuxListSessions,
  type TmuxSession,
} from "../lib/tauri";

/**
 * tmux 会话管理器状态。
 *
 * 刻意**不做自动轮询**：每次拉取都会 fork 一个 tmux 进程，常驻轮询等于持续 fork，
 * 与项目的性能宪章相悖。只在面板打开和用户点刷新时拉。
 */
interface TmuxState {
  /** 最近一次拉到的会话列表。 */
  sessions: TmuxSession[];
  /** 是否有一次拉取在飞行中。 */
  loading: boolean;
  /** 最近一次失败的原因；成功时归 null。 */
  error: string | null;
  /** 本机是否能用 tmux。false 时面板显示"未检测到 tmux"空状态。 */
  available: boolean;

  /** 重新探测可用性并拉取列表。 */
  refresh: () => Promise<void>;
  /** 中断某个会话里正在跑的命令（会话保留），完成后刷新。 */
  interruptSession: (name: string) => Promise<void>;
  /** 结束某个会话，完成后刷新。**二次确认由调用方负责**。 */
  killSession: (name: string) => Promise<void>;
}

/** 把任意异常收敛成可展示的中文字符串。 */
function toMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const useTmuxStore = create<TmuxState>((set, get) => ({
  sessions: [],
  loading: false,
  error: null,
  available: true,

  refresh: async () => {
    set({ loading: true });
    try {
      const available = await tmuxAvailable();
      if (!available) {
        // 没装 tmux 是正常状态，不是错误：清空列表交给空状态 UI，不留红色错误条
        set({ available: false, sessions: [], error: null, loading: false });
        return;
      }
      const sessions = await tmuxListSessions();
      set({ available: true, sessions, error: null, loading: false });
    } catch (e) {
      // 拉取失败时**保留上一次列表**，避免界面整块闪空
      set({ error: toMessage(e), loading: false });
    }
  },

  interruptSession: async (name) => {
    await runThenRefresh(() => tmuxInterruptSession(name), set, get);
  },

  killSession: async (name) => {
    // 失败也要刷新：会话很可能已经自己没了，列表该跟着更新
    await runThenRefresh(() => tmuxKillSession(name), set, get);
  },
}));

/**
 * 跑一个干预动作，然后无条件刷新列表。
 *
 * 顺序有讲究：`refresh()` 成功时会把 `error` 清成 null，所以动作本身的失败信息
 * 必须在刷新**之后**再写回去，否则用户看不到"结束会话失败"这类提示。
 */
async function runThenRefresh(
  action: () => Promise<void>,
  set: (partial: Partial<TmuxState>) => void,
  get: () => TmuxState,
): Promise<void> {
  let failure: string | null = null;
  try {
    await action();
  } catch (e) {
    failure = toMessage(e);
  }
  await get().refresh();
  if (failure !== null) set({ error: failure });
}
