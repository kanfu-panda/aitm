/* =============================================================================
 * 字号缩放工具（aitm v0.10.6 T4）
 * -----------------------------------------------------------------------------
 * Cmd++/Cmd+-/Cmd+0 + NSMenu View > Increase/Decrease/Reset Font Size 共享入口。
 *
 * 路由策略（按 `useFocusSurfaceStore.lastSurface`）：
 * - `editor`                  → 改 `settings.editor.font_size`
 * - `terminal` / `browser` /  → 改 `settings.terminal.font_size`
 *   `ai-sidebar` / 其他
 *
 * 范围：10..24（整数 px）。越界 `clampFontSize` 兜底；reset 回 13。
 *
 * 终端字号变化由 TerminalView 现有 settings.terminal.font_size subscription
 * 接 xterm.js setOption + fit.fit() 自动 reflow；编辑器字号由 main.tsx 启动
 * 时 apply + subscription 写 `document.documentElement.style.--cm-font-size`，
 * CodeMirror 主题（cm-theme.ts）读 var 即时生效，无需重建 EditorView。
 * ========================================================================== */

import { useSettingsStore } from "../stores/settings";
import { useFocusSurfaceStore } from "../stores/focus-surface";

export const FONT_SIZE_MIN = 10;
export const FONT_SIZE_MAX = 24;
export const FONT_SIZE_DEFAULT_TERMINAL = 13;
export const FONT_SIZE_DEFAULT_EDITOR = 13;

/**
 * 把 raw 数值 clamp 到 [10, 24] 整数 px。NaN / 非有限值 fallback 到 13。
 */
export function clampFontSize(n: number): number {
  if (!Number.isFinite(n)) return FONT_SIZE_DEFAULT_TERMINAL;
  const rounded = Math.round(n);
  return Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, rounded));
}

/**
 * 按 `useFocusSurfaceStore.lastSurface` 路由调整字号。
 *
 * - `delta = +1` / `-1`：当前字号 ± 1，clamp 到 [10, 24]
 * - `delta = "reset"`  ：回 13（与后端 default 同步）
 *
 * 不触发任何变更时（已 clamp 到边界 / reset 到当前值）silently skip
 * 避免 debounced 写后端浪费。
 */
export async function adjustFontSize(delta: number | "reset"): Promise<void> {
  const surface = useFocusSurfaceStore.getState().lastSurface;
  const store = useSettingsStore.getState();
  const isEditor = surface === "editor";
  const current = isEditor
    ? store.settings.editor.font_size
    : store.settings.terminal.font_size;
  const next =
    delta === "reset"
      ? isEditor
        ? FONT_SIZE_DEFAULT_EDITOR
        : FONT_SIZE_DEFAULT_TERMINAL
      : clampFontSize(current + delta);
  if (next === current) return;
  store.update(
    isEditor ? { editor: { font_size: next } } : { terminal: { font_size: next } },
  );
}

/**
 * 把 editor 字号写到 `:root` 的 `--cm-font-size` CSS 变量。
 * CodeMirror 主题 fontSize 读这个 var，写完即时生效。
 */
export function applyEditorFontSize(size: number): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty(
    "--cm-font-size",
    `${clampFontSize(size)}px`,
  );
}
