/**
 * 备用屏（alternate screen）滚轮 → 方向键转换。
 *
 * 背景（v1.1.0 R7，真机反馈）：Claude Code / vim / less / htop 等全屏 TUI 运行时
 * 占用终端「备用屏缓冲区」，备用屏按设计没有 scrollback（xterm 默认在备用屏里
 * 滚轮什么都不做）。macOS Terminal / iTerm2 有个**默认开启的终端级特性**：备用屏里
 * 滚轮转成方向键发给应用，让全屏 TUI 能被滚轮驱动自身滚动。xterm.js 不默认做这个，
 * 导致 aitm 里"CC 长上下文卡住、只能看当前一屏、滚不动"——这里补上，对齐 Terminal.app。
 *
 * 仅在「备用屏 + 应用未开启鼠标追踪」时生效（应用开了鼠标追踪时滚轮走鼠标上报，
 * 交给应用，跟 iTerm 的 alternate-scroll 语义一致）。
 */

/** DOM WheelEvent.deltaMode 的 line 档位常量（避免依赖 WheelEvent 全局）。 */
const DOM_DELTA_LINE = 1;

/** 是否应把滚轮转成方向键（备用屏 + 无鼠标追踪）。 */
export function shouldAltScroll(
  bufferType: "normal" | "alternate",
  mouseTrackingMode: "none" | "x10" | "vt200" | "drag" | "any",
): boolean {
  return bufferType === "alternate" && mouseTrackingMode === "none";
}

/**
 * 根据一次滚轮事件算出要发给 PTY 的方向键序列（多行则重复）。
 * - 向上滚（deltaY < 0）→ Up；向下 → Down。
 * - applicationCursorKeys（DECCKM，全屏应用通常开）决定用 `ESC O A` 还是 `ESC [ A`。
 * - deltaY 为 0（纯横向滚动）返回空串（调用方据此不拦截、走默认）。
 * - 行数：line 档位直接用 |deltaY|；pixel 档位按 ~40px/行估算；夹在 1..10 之间，
 *   避免快速甩动一次跳太多。
 */
export function altScrollSequence(opts: {
  deltaY: number;
  deltaMode: number;
  applicationCursorKeys: boolean;
}): string {
  if (opts.deltaY === 0) return "";
  const raw =
    opts.deltaMode === DOM_DELTA_LINE
      ? Math.abs(opts.deltaY)
      : Math.abs(opts.deltaY) / 40;
  const lines = Math.max(1, Math.min(10, Math.round(raw) || 1));
  const up = opts.deltaY < 0;
  const seq = opts.applicationCursorKeys
    ? up
      ? "\x1bOA"
      : "\x1bOB"
    : up
      ? "\x1b[A"
      : "\x1b[B";
  return seq.repeat(lines);
}
