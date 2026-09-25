import { create } from "zustand";
import {
  tmuxAvailable,
  tmuxInterruptSession,
  tmuxKillSession,
  tmuxListSessions,
  tmuxNewSession,
  tmuxRenameSession,
  type TmuxSession,
} from "../lib/tauri";
import { useTabsStore } from "./tabs";
import { detectHandTypedTmux } from "../lib/tmuxTabDetect";

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
  /**
   * 每个会话（按 id）在用户最后一次查看时的 `activity`。
   *
   * 某个 id **第一次**出现在列表里时，记为它当时的 activity——所以首次加载不会满屏
   * "新输出"标记。只存在内存里，应用重启后以当次首次加载为基线。
   */
  seen: Record<string, number>;

  /**
   * 重新探测可用性并拉取列表。
   *
   * `silent: true` 用于每 3 秒的自动刷新：不切换 `loading`，否则刷新按钮会跟着
   * 每 3 秒闪一次。手动刷新、干预动作之后的刷新照旧显示加载态。
   *
   * 上一次刷新还没返回时：**静默刷新直接跳过**（tmux 卡住时不至于每 3 秒再叠一个
   * 子进程）；**非静默刷新则等它结束后再拉一次**——比如刚结束了一个会话，这次刷新
   * 必须拿到最新列表，不能因为撞上后台刷新就被丢掉。
   */
  refresh: (opts?: { silent?: boolean }) => Promise<void>;
  /** 中断某个会话里正在跑的命令（会话保留），完成后刷新。 */
  interruptSession: (id: string) => Promise<void>;
  /** 结束某个会话，完成后刷新。**二次确认由调用方负责**。 */
  killSession: (id: string) => Promise<void>;
  /** 新建会话并刷新列表，返回新会话的 id。失败时抛出，交给调用方的输入框显示。 */
  newSession: (name: string, cwd: string | null) => Promise<string>;
  /** 重命名并刷新。失败时抛出。 */
  renameSession: (id: string, name: string) => Promise<void>;
  /** 用户查看了该会话（展开预览或接入），把它的新输出标记清掉。 */
  markSeen: (id: string) => void;
}

/** 该会话在用户上次查看之后是否有了新输出。没有基线时视为没有。 */
export function hasNewOutput(
  s: TmuxSession,
  seen: Record<string, number>,
): boolean {
  const last = seen[s.id];
  return last !== undefined && s.activity > last;
}

/**
 * 正被 aitm 自己的标签接着的会话，把"已查看"推进到当前活动时间。
 *
 * 接入这个动作本身会让 tmux 重绘、刷新活动时间，用户在里面打字也会——这些都是
 * 用户正在看的输出，标"新输出"只会是噪音。别处终端接着的会话不受影响。
 */
function seenByAitmTabs(
  seen: Record<string, number>,
  sessions: TmuxSession[],
): Record<string, number> {
  const mine = new Set(
    useTabsStore
      .getState()
      .tabs.map((t) => t.tmuxSessionId)
      .filter((id): id is string => id !== undefined),
  );
  if (mine.size === 0) return seen;
  const next = { ...seen };
  for (const s of sessions) {
    if (mine.has(s.id)) next[s.id] = s.activity;
  }
  return next;
}

/** 给第一次出现的 id 记基线；已有记录的原样保留。 */
function withBaseline(
  seen: Record<string, number>,
  sessions: TmuxSession[],
): Record<string, number> {
  const next = { ...seen };
  for (const s of sessions) {
    if (next[s.id] === undefined) next[s.id] = s.activity;
  }
  return next;
}

/** 正在进行的那次刷新。放在模块级而不是 store 里：它不需要触发重渲染。 */
let inFlight: Promise<void> | null = null;

/** 把任意异常收敛成可展示的中文字符串。 */
function toMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const useTmuxStore = create<TmuxState>((set, get) => ({
  sessions: [],
  loading: false,
  error: null,
  available: true,
  seen: {},

  refresh: async (opts) => {
    const silent = opts?.silent === true;
    if (inFlight) {
      if (silent) return;
      await inFlight;
    }
    const run = (async () => {
      if (!silent) set({ loading: true });
      try {
        const available = await tmuxAvailable();
        if (!available) {
          // 没装 tmux 是正常状态，不是错误：清空列表交给空状态 UI，不留红色错误条
          set({ available: false, sessions: [], error: null, loading: false });
          return;
        }
        const sessions = await tmuxListSessions();
        // 有会话接着客户端、却没有哪个标签记着它：可能是在标签里手敲的接入，查一遍。
        // 只在这类会话的客户端数与上次刷新不同时才查——会话在别的终端里一直接着时，
        // 面板每 3 秒刷新都去 fork 进程识别是浪费；手敲接入会让客户端数变化
        const known = new Set(
          useTabsStore.getState().tabs.map((t) => t.tmuxSessionId),
        );
        const prevAttached = new Map(
          get().sessions.map((s) => [s.id, s.attached] as const),
        );
        if (
          sessions.some(
            (s) =>
              s.attached > 0 &&
              !known.has(s.id) &&
              prevAttached.get(s.id) !== s.attached,
          )
        ) {
          void detectHandTypedTmux();
        }
        set((st) => ({
          available: true,
          sessions,
          seen: seenByAitmTabs(withBaseline(st.seen, sessions), sessions),
          error: null,
          loading: false,
        }));
      } catch (e) {
        // 拉取失败时**保留上一次列表**，避免界面整块闪空
        set({ error: toMessage(e), loading: false });
      }
    })();
    inFlight = run;
    try {
      await run;
    } finally {
      if (inFlight === run) inFlight = null;
    }
  },

  interruptSession: async (id) => {
    await runThenRefresh(() => tmuxInterruptSession(id), set, get);
  },

  killSession: async (id) => {
    // 失败也要刷新：会话很可能已经自己没了，列表该跟着更新
    await runThenRefresh(() => tmuxKillSession(id), set, get);
  },

  newSession: async (name, cwd) => {
    const id = await tmuxNewSession(name, cwd);
    await get().refresh();
    return id;
  },

  renameSession: async (id, name) => {
    const oldName = get().sessions.find((x) => x.id === id)?.name;
    await tmuxRenameSession(id, name);
    // 接着这个会话的标签标题就是会话名，改名后跟着变；标题已被用户手动改成
    // 别的名字的不动（判断依据：标题不等于旧会话名）
    if (oldName !== undefined) {
      const { tabs, setTitle } = useTabsStore.getState();
      for (const t of tabs) {
        if (t.tmuxSessionId === id && t.title === oldName) setTitle(t.id, name);
      }
    }
    await get().refresh();
  },

  markSeen: (id) => {
    const s = get().sessions.find((x) => x.id === id);
    if (!s) return;
    set((st) => ({ seen: { ...st.seen, [id]: s.activity } }));
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
