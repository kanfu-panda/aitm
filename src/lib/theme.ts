/**
 * v0.4.1: 主题模式（light / dark / auto）应用 + 系统主题监听
 *
 * - applyTheme(mode)        把 mode 写到 document.documentElement.dataset.theme
 *                           （`light` | `dark`，auto 解析为系统当前值）
 * - watchSystemTheme(getMode) 监听 prefers-color-scheme 变化，仅当 getMode()
 *                           返回 'auto' 时才重新应用
 *
 */

export type ThemeMode = "auto" | "dark" | "light";

/**
 * 把 mode 应用到 <html data-theme="…">。
 * - 'dark' / 'light' 直接写入
 * - 'auto' 读 matchMedia('(prefers-color-scheme: light)') 解析
 */
export function applyTheme(mode: ThemeMode): void {
  const resolved: "dark" | "light" =
    mode === "auto"
      ? window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark"
      : mode;
  document.documentElement.dataset.theme = resolved;
}

/**
 * 注册系统主题切换监听。
 * - 仅当 getMode() 返回 'auto' 时才重新应用（dark/light 强制态忽略系统切换）
 * - 返回 unsubscribe 函数，调用即解绑
 */
export function watchSystemTheme(getMode: () => ThemeMode): () => void {
  const mq = window.matchMedia("(prefers-color-scheme: light)");
  const handler = () => {
    if (getMode() === "auto") applyTheme("auto");
  };
  mq.addEventListener("change", handler);
  return () => mq.removeEventListener("change", handler);
}
