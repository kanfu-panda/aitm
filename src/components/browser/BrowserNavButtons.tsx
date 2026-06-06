/**
 * Phase 4A T2：浏览器导航按钮（← → ⟳）。
 *
 * **当前是占位**：Tauri 2 的 `Webview::navigate` 只能切 URL，没有暴露
 * `history.back/forward` API；用 `eval("history.back()")` 在某些 webview
 * 后端（mac WKWebView 当前 sandbox）可能不一致。**T2 阶段先 disabled**，
 * 留给 v0.4.x patch 加（思路：后端加 `browser_eval` IPC + 前端走 eval）。
 *
 * tab + URL 栏 + 关闭已是核心；← → ⟳ 是 nice-to-have。
 */
export default function BrowserNavButtons() {
  return (
    <div className="flex items-center gap-0.5">
      <button
        type="button"
        disabled
        aria-label="后退"
        title="历史导航 — v0.4.x 加"
        className="rounded p-1 text-[var(--c-text-faint)] disabled:cursor-not-allowed"
      >
        ←
      </button>
      <button
        type="button"
        disabled
        aria-label="前进"
        title="历史导航 — v0.4.x 加"
        className="rounded p-1 text-[var(--c-text-faint)] disabled:cursor-not-allowed"
      >
        →
      </button>
      <button
        type="button"
        disabled
        aria-label="刷新"
        title="刷新 — v0.4.x 加"
        className="rounded p-1 text-[var(--c-text-faint)] disabled:cursor-not-allowed"
      >
        ⟳
      </button>
    </div>
  );
}
