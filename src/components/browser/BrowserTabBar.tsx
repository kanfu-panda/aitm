import { useTranslation } from "react-i18next";

import { Globe, Pause, Pin, Plus } from "../icons";
import { useBrowserStore } from "../../stores/browser";

/**
 * Phase 4A T2 + v0.4.1 T4：浏览器 tab bar。
 *
 * 每个 tab 显示：
 * - 状态图标（lucide）：Pin (pinned) / Pause (suspended) / Globe (默认)，size=12
 * - title（截断）
 * - × 关闭按钮
 *
 * 中间 + 按钮新建 tab，默认导航到 about:blank（让用户在 URL 栏输入目标）。
 *
 * setActive / closeTab 都需要 bounds 才能调（resume 时会传给后端 open_tab）；
 * 但 tab bar 本身不知 webview 容器 bounds——交给 BrowserPanel 的
 * ResizeObserver 上报来做 bounds 同步。这里调 setActive 时给一个 placeholder
 * bounds（0,0,800,600），实际会在 ResizeObserver 触发后被覆盖。
 *
 * v0.4.1 T4：emoji → lucide-react SVG icons（plan §3.4 / §3.3 颜色规则）
 *  - Pin (--c-warn)：固定 tab
 *  - Pause (--c-text-dim)：suspended tab
 *  - Globe (--c-text-muted)：普通 tab
 */
const PLACEHOLDER_BOUNDS = { x: 0, y: 0, w: 800, h: 600 };

const DEFAULT_NEW_TAB_URL = "about:blank";

export default function BrowserTabBar() {
  const { t } = useTranslation();
  const tabs = useBrowserStore((s) => s.tabs);
  const activeKey = useBrowserStore((s) => s.activeKey);
  const setActive = useBrowserStore((s) => s.setActive);
  const closeTab = useBrowserStore((s) => s.closeTab);
  const openTab = useBrowserStore((s) => s.openTab);

  return (
    <div className="flex items-center gap-1 overflow-x-auto px-2 pt-1">
      {tabs.map((tab) => {
        const isActive = tab.key === activeKey;
        const StatusIcon = tab.pinned
          ? Pin
          : tab.state === "suspended"
            ? Pause
            : Globe;
        const iconColor = tab.pinned
          ? "text-[var(--c-warn)]"
          : tab.state === "suspended"
            ? "text-[var(--c-text-dim)]"
            : "text-[var(--c-text-muted)]";
        const iconLabel = tab.pinned
          ? t("browserTabBar.stateLabel.pinned")
          : tab.state === "suspended"
            ? t("browserTabBar.stateLabel.suspended")
            : t("browserTabBar.stateLabel.active");
        const iconTestId = tab.pinned
          ? "icon-pin"
          : tab.state === "suspended"
            ? "icon-pause"
            : "icon-globe";
        return (
          <div
            key={tab.key}
            role="tab"
            aria-selected={isActive}
            tabIndex={0}
            onClick={() => void setActive(tab.key, PLACEHOLDER_BOUNDS)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                void setActive(tab.key, PLACEHOLDER_BOUNDS);
              }
            }}
            className={[
              "group flex max-w-[180px] cursor-pointer items-center gap-1 rounded-t border-b-2 px-2 py-1 text-xs",
              isActive
                ? "border-[var(--c-info)] bg-[var(--c-bg-elev-2)] text-[var(--c-text-base)]"
                : "border-transparent text-[var(--c-text-muted)] hover:bg-[var(--c-bg-elev-2)] hover:text-[var(--c-text-base)]",
            ].join(" ")}
            title={`${tab.title}\n${tab.url}`}
          >
            <StatusIcon
              size={12}
              className={`shrink-0 ${iconColor}`}
              aria-label={iconLabel}
              data-testid={iconTestId}
            />
            <span className="truncate">{tab.title || tab.url}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void closeTab(tab.key);
              }}
              className="ml-1 rounded p-0.5 text-[var(--c-text-dim)] opacity-60 hover:bg-[var(--c-bg-elev-3)] hover:text-[var(--c-text-base)] group-hover:opacity-100"
              aria-label={t("browserTabBar.closeTabAria", {
                label: tab.title || tab.url,
              })}
            >
              ×
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => void openTab(DEFAULT_NEW_TAB_URL, PLACEHOLDER_BOUNDS)}
        className="ml-1 flex items-center justify-center rounded p-1 text-[var(--c-success-fg)] hover:bg-[var(--c-bg-elev-2)] hover:text-[var(--c-success)]"
        aria-label={t("browserTabBar.newTabAria")}
        title={t("browserTabBar.newTabTitle")}
      >
        <Plus size={16} aria-hidden />
      </button>
    </div>
  );
}
