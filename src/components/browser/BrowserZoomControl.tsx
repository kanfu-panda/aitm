import { useTranslation } from "react-i18next";

import { useBrowserStore } from "../../stores/browser";
import { DEFAULT_ZOOM, formatZoom } from "../../lib/browserZoom";

/**
 * 浏览器面板的缩放控件：`−  100%  +`。
 *
 * 面板通常只有两三百逻辑像素宽，而做 UA 嗅探的站点仍会发 PC 版页面（尺寸传得
 * 是对的，站点自己不认窄屏），整体缩小是最省事的补救。
 *
 * 焦点在页面内时 webview 自带的 Cmd+= / Cmd+- / Cmd+0 已经能缩放；这个控件是
 * 给"焦点不在页面里"以及不记快捷键的用户的可见入口，同时把当前比例显示出来。
 *
 * 不是 100% 时百分比高亮，否则用灰字——让"我是不是把页面缩过"一眼可见。
 */
export default function BrowserZoomControl() {
  const { t } = useTranslation();
  const tabs = useBrowserStore((s) => s.tabs);
  const activeKey = useBrowserStore((s) => s.activeKey);
  const adjustZoom = useBrowserStore((s) => s.adjustZoom);

  const activeTab = tabs.find((tab) => tab.key === activeKey);
  const zoom = activeTab?.zoom ?? DEFAULT_ZOOM;
  const disabled = !activeTab?.id;
  const isDefault = zoom === DEFAULT_ZOOM;

  const btn =
    "rounded px-1 text-[var(--c-text-dim)] hover:bg-[var(--c-bg-elev-2)] hover:text-[var(--c-text-base)] disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <div className="flex shrink-0 items-center" data-testid="browser-zoom">
      <button
        type="button"
        onClick={() => void adjustZoom(-1)}
        disabled={disabled}
        className={btn}
        aria-label={t("browserZoom.out")}
        title={t("browserZoom.out")}
      >
        −
      </button>
      <button
        type="button"
        onClick={() => void adjustZoom("reset")}
        disabled={disabled}
        data-testid="browser-zoom-reset"
        className={[
          "min-w-[38px] rounded px-1 text-center text-[11px] tabular-nums hover:bg-[var(--c-bg-elev-2)] disabled:cursor-not-allowed disabled:opacity-40",
          isDefault
            ? "text-[var(--c-text-dim)]"
            : "text-[var(--c-success-fg)]",
        ].join(" ")}
        aria-label={t("browserZoom.reset")}
        title={t("browserZoom.reset")}
      >
        {formatZoom(zoom)}
      </button>
      <button
        type="button"
        onClick={() => void adjustZoom(1)}
        disabled={disabled}
        className={btn}
        aria-label={t("browserZoom.in")}
        title={t("browserZoom.in")}
      >
        +
      </button>
    </div>
  );
}
