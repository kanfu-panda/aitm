import { useBrowserStore } from "../stores/browser";

/**
 * Phase 4A T3：内嵌浏览器 tab 自动 suspend 策略。
 *
 * 两条策略：
 * 1. **失焦超时**：非 active 且非 pinned tab 距上次 setActive 超过
 *    `suspendTimerMs` → 调 `suspendTab`（释放 WKWebView 进程）
 * 2. **LRU 上限**：active webview 总数（含当前 active）超过 `maxActive` 时，
 *    从最旧的非 pinned 非 active tab 起 suspend，直到回落到上限
 *
 * 设计要点：
 * - 30s 扫一次而非 setInterval(每秒)：suspend 不是实时性需求，省 CPU
 * - 当前 active tab + pinned tab 都豁免（pinned 永不 suspend；active 用户正在看）
 * - LRU 顺序按 `lastActiveAt`（setActive 时刻）排，最旧的最先 suspend
 *
 * T5 settings 集成后，maxActive / suspendTimerMs 改读 settings；T2/T3 阶段先
 * 在 App.tsx 调用方 hardcode（默认 maxActive=3, suspendTimerMs=5min）。
 */

/** 扫描间隔：每 N 毫秒扫一次 store。 */
const SCAN_INTERVAL_MS = 30_000;

let intervalId: ReturnType<typeof setInterval> | null = null;

/** 自动 suspend 策略配置。 */
export interface BrowserSuspendOptions {
  /** active webview 总数上限（含当前 active；超过 → LRU suspend）。默认建议 3。 */
  maxActive: number;
  /** 失焦超时阈值（ms）；非 active 且非 pinned 超过此值 → suspend。默认建议 5 min。 */
  suspendTimerMs: number;
}

/**
 * 启动浏览器 suspend 定时器。重复调用是 noop（已运行不再启）。
 * 通常在 App.tsx 的 useEffect 里调用一次。
 */
export function startBrowserSuspendTimer(opts: BrowserSuspendOptions): void {
  if (intervalId !== null) return;
  intervalId = setInterval(() => {
    scanAndSuspend(opts);
  }, SCAN_INTERVAL_MS);
}

/** 停止浏览器 suspend 定时器（e.g. 测试 teardown / 应用关闭）。 */
export function stopBrowserSuspendTimer(): void {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

/**
 * 扫一次 store 并按策略 suspend。导出给单测直接驱动（不经过定时器）。
 *
 * 策略顺序：
 * 1. 先做失焦超时 suspend（满足条件的全部 suspend）
 * 2. 再做 LRU 上限裁剪（如果还超就裁最旧的）
 *
 * 两步分开是为了 LRU 步用的是更新后的 active 数组（步 1 结果之上算 LRU）。
 */
export function scanAndSuspend(opts: BrowserSuspendOptions): void {
  const state = useBrowserStore.getState();
  const now = Date.now();

  // 1. 失焦超时：非 active、非 pinned，超过 suspendTimerMs → suspend
  for (const tab of state.tabs) {
    if (tab.state !== "active") continue;
    if (tab.pinned) continue;
    if (tab.key === state.activeKey) continue;
    if (now - tab.lastActiveAt > opts.suspendTimerMs) {
      void state.suspendTab(tab.key);
    }
  }

  // 2. LRU 上限：可被 LRU 裁的候选 = active 且非 pinned 且非当前 active
  //    按 lastActiveAt 升序（最旧排前）。
  //    "已占用配额"：当前 active（豁免但占名额）+ pinned active（豁免但占名额）
  //    即 candidate 数 + reserved 不能超过 maxActive；超出部分从最旧 candidate 砍
  const fresh = useBrowserStore.getState();
  const activeNonSuspended = fresh.tabs.filter((t) => t.state === "active");
  const pinnedActive = activeNonSuspended.filter((t) => t.pinned).length;
  const reserveActive = fresh.activeKey
    ? activeNonSuspended.some(
        (t) => t.key === fresh.activeKey && !t.pinned,
      )
      ? 1
      : 0
    : 0;
  const reserved = pinnedActive + reserveActive;
  const allowed = Math.max(0, opts.maxActive - reserved);

  const lruCandidates = activeNonSuspended
    .filter((t) => !t.pinned && t.key !== fresh.activeKey)
    .sort((a, b) => a.lastActiveAt - b.lastActiveAt);

  while (lruCandidates.length > allowed) {
    const oldest = lruCandidates.shift();
    if (oldest) void fresh.suspendTab(oldest.key);
  }
}

/** 测试钩子：导出给单测查 timer 是否在跑。 */
export function __isTimerRunning(): boolean {
  return intervalId !== null;
}
