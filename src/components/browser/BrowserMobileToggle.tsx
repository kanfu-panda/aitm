import { useTranslation } from "react-i18next";

import { Monitor, Smartphone } from "../icons";
import { useBrowserStore } from "../../stores/browser";

/** 重建 webview 时的占位 bounds；BrowserPanel 的 ResizeObserver 会立刻覆盖真值。 */
const PLACEHOLDER_BOUNDS = { x: 0, y: 0, w: 800, h: 600 };

/**
 * "请求移动版 / 桌面版站点"切换。
 *
 * 面板窄的时候，做 UA 嗅探的站点（新闻、门户、登录页）看到桌面 Safari UA 就发
 * PC 版页面，塞进两三百像素只能被裁。切成 iPhone UA 后它们会发移动版，比"把 PC
 * 版缩小"好读得多。
 *
 * **代价**：UA 只能在创建 webview 时定（wry / WKWebView 都不支持运行时改），
 * 所以切换必然重建 webview + 重新加载页面，登录态和滚动位置会丢。tooltip 里
 * 明说这一点，别让用户在填了一半的表单上误点。
 *
 * 当前处于移动版时图标高亮，一眼能看出自己在哪个模式。
 */
export default function BrowserMobileToggle() {
  const { t } = useTranslation();
  const tabs = useBrowserStore((s) => s.tabs);
  const activeKey = useBrowserStore((s) => s.activeKey);
  const toggleMobile = useBrowserStore((s) => s.toggleMobile);

  const activeTab = tabs.find((tab) => tab.key === activeKey);
  const isMobile = activeTab?.mobile ?? false;
  const disabled = !activeTab?.id;
  const Icon = isMobile ? Smartphone : Monitor;

  return (
    <button
      type="button"
      onClick={() => void toggleMobile(PLACEHOLDER_BOUNDS)}
      disabled={disabled}
      data-testid="browser-mobile-toggle"
      aria-pressed={isMobile}
      className={[
        "shrink-0 rounded p-1 hover:bg-[var(--c-bg-elev-2)] disabled:cursor-not-allowed disabled:opacity-40",
        isMobile
          ? "text-[var(--c-success-fg)]"
          : "text-[var(--c-text-dim)] hover:text-[var(--c-text-base)]",
      ].join(" ")}
      aria-label={isMobile ? t("browserMobile.toDesktop") : t("browserMobile.toMobile")}
      title={
        isMobile
          ? `${t("browserMobile.toDesktop")}\n${t("browserMobile.reloadHint")}`
          : `${t("browserMobile.toMobile")}\n${t("browserMobile.reloadHint")}`
      }
    >
      <Icon size={16} aria-hidden />
    </button>
  );
}
