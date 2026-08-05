/**
 * v1.3.0 R3b：内嵌浏览器 webview 的 bounds 上报节流器（从 `BrowserPanel` 抽出）。
 *
 * ## 为什么要独立成模块
 *
 * child webview 是 native overlay，创建时只能给一个**占位尺寸**
 * （`PLACEHOLDER_BROWSER_BOUNDS` = 800×600，见 `lib/browserOpenRequest.ts`）——
 * 后端拿不到前端布局，真实 bounds 只能由 `BrowserPanel` 量出来再 IPC 上报。
 *
 * 于是有一条硬不变量：**占位尺寸必须被真实尺寸覆盖**。覆盖没发生的话，
 * 网页会一直按 800 逻辑像素宽布局，面板拖多窄都只是被裁剪、不会重排
 * （排查"网页不随面板自适应"时的头号嫌疑）。
 *
 * 这段时序逻辑原本内联在 `BrowserPanel` 的 effect 里，混着 DOM 事件没法单测。
 * 抽出来后把时钟 / rAF 都做成可注入，就能用单测锁住不变量
 * （见 `__tests__/browserBounds.test.ts`）。真实 WKWebView 的 viewport 行为
 * 依然只能真机验证，这里只保证"上报一定发生、且不被节流吞掉"。
 *
 * ## 行为（与抽出前逐字等价，不改语义）
 *
 * - [`BoundsReporter.report`]：节流入口，给 ResizeObserver / scroll / resize 用。
 *   距上次上报 ≥ 16ms 立即发；否则合并到下一帧补发（保证最后一次不丢）。
 * - [`BoundsReporter.reportNow`]：绕过节流强制上报，给 mount 后的兜底帧用。
 * - 补发帧回调里**重新 measure**，所以拿到的永远是最新尺寸而非排队那一刻的旧值。
 */

/** 逻辑像素的 webview 矩形（跟后端 `browser_set_bounds` 的入参一一对应）。 */
export interface BoundsRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 节流窗口：60fps 一帧的时长，既不丢帧也不轰炸 IPC。 */
export const BOUNDS_REPORT_THROTTLE_MS = 16;

export interface BoundsReporterOptions {
  /** 量当前容器 bounds；返回 `null` 表示容器不可用（已卸载）→ 本次不上报。 */
  measure: () => BoundsRect | null;
  /** 真正发出 IPC（`BrowserPanel` 传的是 `browserSetBounds` 的偏函数）。 */
  send: (bounds: BoundsRect) => void;
  /** 时钟，默认 `performance.now`；单测注入可控时钟。 */
  now?: () => number;
  /** 排下一帧，默认 `requestAnimationFrame`。 */
  requestFrame?: (cb: () => void) => number;
  /** 取消排队的帧，默认 `cancelAnimationFrame`。 */
  cancelFrame?: (handle: number) => void;
}

export interface BoundsReporter {
  /** 节流上报（事件源用）。 */
  report: () => void;
  /** 强制上报一次，绕过节流（mount 兜底 / 动画结束兜底用）。 */
  reportNow: () => void;
  /** 卸载清理：取消排队中的补发帧。 */
  dispose: () => void;
}

export function createBoundsReporter(
  options: BoundsReporterOptions,
): BoundsReporter {
  const {
    measure,
    send,
    now = () => performance.now(),
    requestFrame = (cb) => requestAnimationFrame(cb),
    cancelFrame = (h) => cancelAnimationFrame(h),
  } = options;

  let lastReport = 0;
  let pendingHandle: number | null = null;

  const reportNow = () => {
    pendingHandle = null;
    lastReport = now();
    const rect = measure();
    // 容器已卸载 / 拿不到尺寸：宁可不报，也不要把 0×0 之类的假尺寸推给 webview
    if (!rect) return;
    send(rect);
  };

  const report = () => {
    if (now() - lastReport >= BOUNDS_REPORT_THROTTLE_MS) {
      reportNow();
      return;
    }
    // 离上次不到一帧：拖到下一帧再报，防止快速连续触发把最后一次吞掉
    if (pendingHandle !== null) return;
    pendingHandle = requestFrame(reportNow);
  };

  const dispose = () => {
    if (pendingHandle !== null) {
      cancelFrame(pendingHandle);
      pendingHandle = null;
    }
  };

  return { report, reportNow, dispose };
}
