import { useTranslation } from "react-i18next";

import { browserGoBack, browserGoForward, browserReload } from "../../lib/tauri";
import { ArrowLeft, ArrowRight, RotateCw } from "../icons";
import { useBrowserStore } from "../../stores/browser";

/**
 * 浏览器导航按钮（← → ⟳）。
 *
 * 这三个按钮从 Phase 4A 起一直是硬编码 `disabled` 的占位符，tooltip 写着
 * "v0.4.x 加"，到 1.4.x 仍然点不动——当时 Tauri 连原生 `reload()` 都还没有。
 * 现在补上真实实现：后退/前进注入 `history.back()` / `history.forward()`
 * （Tauri 至今未暴露原生 goBack），刷新走原生 `reload()`。
 *
 * **为什么不按"有没有历史"置灰**：Tauri 没有暴露 WKWebView 的
 * `canGoBack` / `canGoForward`，前端也无法可靠推断——`browser:url_changed`
 * 对前进后退同样会触发，自己数导航次数很快就会跟真实历史栈对不上。
 * 与其显示一个**会骗人的**禁用态，不如始终可点：没有历史时
 * `history.back()` 本身就是无害的空操作。
 */
export default function BrowserNavButtons() {
  const { t } = useTranslation();
  const tabs = useBrowserStore((s) => s.tabs);
  const activeKey = useBrowserStore((s) => s.activeKey);

  const activeTab = tabs.find((tab) => tab.key === activeKey);
  const id = activeTab?.id ?? null;

  const cls =
    "rounded p-1 text-[var(--c-text-dim)] hover:bg-[var(--c-bg-elev-2)] hover:text-[var(--c-text-base)] disabled:cursor-not-allowed disabled:opacity-40";

  /** 失败只 warn：导航失败（如 webview 刚被 suspend）不该弹错打断用户。 */
  const run = (fn: (tabId: string) => Promise<void>) => {
    if (!id) return;
    void fn(id).catch((e) => console.warn("[browser] 导航失败", e));
  };

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <button
        type="button"
        onClick={() => run(browserGoBack)}
        disabled={!id}
        aria-label={t("browserNav.back")}
        title={t("browserNav.back")}
        data-testid="browser-back"
        className={cls}
      >
        <ArrowLeft size={16} aria-hidden />
      </button>
      <button
        type="button"
        onClick={() => run(browserGoForward)}
        disabled={!id}
        aria-label={t("browserNav.forward")}
        title={t("browserNav.forward")}
        data-testid="browser-forward"
        className={cls}
      >
        <ArrowRight size={16} aria-hidden />
      </button>
      <button
        type="button"
        onClick={() => run(browserReload)}
        disabled={!id}
        aria-label={t("browserNav.reload")}
        title={t("browserNav.reload")}
        data-testid="browser-reload"
        className={cls}
      >
        <RotateCw size={16} aria-hidden />
      </button>
    </div>
  );
}
