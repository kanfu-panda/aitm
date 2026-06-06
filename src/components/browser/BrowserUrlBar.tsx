import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useBrowserStore } from "../../stores/browser";

/** 新 tab 默认 bounds 占位；BrowserPanel 的 ResizeObserver 启动后会立刻覆盖真值。 */
const PLACEHOLDER_BOUNDS = { x: 0, y: 0, w: 800, h: 600 };

/**
 * 视为"空 URL" 的特殊页面集合；显示在地址栏时应留空让 placeholder 显示，
 * 用户不用先删 "about:blank" 才能输入新地址（v0.4.1 真机 smoke #4）。
 */
const BLANK_URLS = new Set(["about:blank", "about:newtab", ""]);

const displayUrl = (url: string | undefined) =>
  url && !BLANK_URLS.has(url) ? url : "";

/**
 * Phase 4A T2：浏览器 URL 栏。
 *
 * - **始终可输入**（不 disable）；首次打开浏览器面板还没 tab 时，用户可以
 *   直接在地址栏敲 URL → Enter → 自动 openTab 新建 tab 加载该 URL
 * - 切换 active tab 自动同步显示当前 URL
 * - Enter 行为：
 *   - 已有 active tab → navigate 当前 tab 到新 URL
 *   - 没 active tab → openTab 新建 tab 加载该 URL
 * - 不做严格 URL 校验：用户输入 `example.com` 自动补 `https://` 前缀
 *   （Tauri Url::parse 严格要求 scheme，所以前端补一下避免后端报错）
 */
export default function BrowserUrlBar() {
  const { t } = useTranslation();
  const tabs = useBrowserStore((s) => s.tabs);
  const activeKey = useBrowserStore((s) => s.activeKey);
  const navigate = useBrowserStore((s) => s.navigate);
  const openTab = useBrowserStore((s) => s.openTab);

  const activeTab = tabs.find((t) => t.key === activeKey);
  const [draft, setDraft] = useState(displayUrl(activeTab?.url));

  // 切换 active tab 或外部更新 url 时同步输入框
  // about:blank / 空 URL 视为空让 placeholder 显示，避免用户手动删
  useEffect(() => {
    setDraft(displayUrl(activeTab?.url));
  }, [activeTab?.url, activeTab?.key]);

  /**
   * @param forceNewTab true → 强制新建 tab；false → 当前 tab 跳转（无 active 时也新建）
   */
  const submit = (forceNewTab: boolean) => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    const url = normalizeUrl(trimmed);
    if (activeTab && !forceNewTab) {
      void navigate(activeTab.key, url);
    } else {
      // 没 active tab 或强制新建 → 直接新建 tab 加载（BrowserPanel ResizeObserver 启动后覆盖 bounds）
      void openTab(url, PLACEHOLDER_BOUNDS);
    }
  };

  return (
    <input
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          // Cmd / Ctrl / Shift + Enter → 在新 tab 打开（保留 Enter = 当前 tab 跳转）
          submit(e.metaKey || e.ctrlKey || e.shiftKey);
        }
      }}
      placeholder={
        activeTab
          ? t("browserUrlBar.placeholderActive")
          : t("browserUrlBar.placeholderEmpty")
      }
      aria-label={t("browserUrlBar.addressBarAria")}
      // v0.5.6：禁 macOS 文本辅助（autocorrect 把 github → Github 等）
      autoCapitalize="off"
      autoCorrect="off"
      autoComplete="off"
      spellCheck={false}
      className="flex-1 rounded border border-[var(--c-border-strong)] bg-[var(--c-bg-base)] px-2 text-xs text-[var(--c-text-base)] placeholder:text-[var(--c-text-faint)] focus:border-[var(--c-info)] focus:outline-none"
      style={{ height: 28 }}
    />
  );
}

/**
 * 把用户输入归一为合法 URL：
 * - 已有 scheme（http/https/file/about）→ 原样
 * - 否则补 `https://`
 */
export function normalizeUrl(input: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(input)) return input;
  return `https://${input}`;
}
