import { useState, type CSSProperties, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { FileText, Folder, Globe, Settings, Sparkles } from "../icons";
import { useBrowserStore } from "../../stores/browser";
import { useSidebarStore } from "../../stores/sidebar";
import { useFileEditorStore } from "../../stores/file-editor";
import { ActivityBarItem } from "./ActivityBarItem";
import {
  BAR_HEIGHT_HORIZONTAL,
  BAR_WIDTH_VERTICAL,
  ICON_SIZE_HORIZONTAL,
  ICON_SIZE_VERTICAL,
  ITEM_SIZE_HORIZONTAL,
  ITEM_SIZE_VERTICAL,
  type ActivityBarPosition,
} from "./constants";

interface ActivityBarProps {
  /** 当前 bar 位置；由 App.tsx 从 settings.ui.activity_bar_position 传入。 */
  position: ActivityBarPosition;
  /** 设置按钮 click handler；由 App.tsx 持有 settingsOpen state 并传入 setter。 */
  onSettingsOpen: () => void;
}

/**
 * v0.4.1 ActivityBar — VS Code 风格 4 向可配置面板切换栏。
 *
 * 主图标在主轴起点端、Settings 在尾端；spacer 用 `flex-1` 撑开。
 * 不论方向，视觉顺序保持一致（用户切到 top 也不会找不到 Settings）。
 *
 * Plan §4 / §6.1：本组件取代 v0.4.0 散在 TabBar 右侧的 inline 🌐 / ⚙ 按钮 +
 * AiSidebar 顶部的 ✦ toggle。所有面板切换器集中收口在这里。
 *
 * v0.4.1 T3：浏览器按钮语义改为 minimize/restore（保留 tabs），
 * 同时支持右键 → "关闭所有标签"（destructive，调 closePanel）。
 */
export function ActivityBar({ position, onSettingsOpen }: ActivityBarProps) {
  const { t } = useTranslation();
  const aiOpen = useSidebarStore((s) => s.open);
  const toggleAi = useSidebarStore((s) => s.toggle);
  const fileTreeOpen = useSidebarStore((s) => s.fileTreeOpen);
  const toggleFileTree = useSidebarStore((s) => s.toggleFileTree);
  // v0.10.0 HR9-4：文件预览面板可收起
  const filePreviewVisible = useSidebarStore((s) => s.filePreviewVisible);
  const toggleFilePreview = useSidebarStore((s) => s.toggleFilePreview);
  const filePreviewHasContent = useFileEditorStore(
    (s) => s.openFiles.length > 0,
  );

  const browserPanelOpen = useBrowserStore((s) => s.panelOpen);
  const browserTabsCount = useBrowserStore((s) => s.tabs.length);
  const minimizeBrowserPanel = useBrowserStore((s) => s.minimizePanel);
  const restoreBrowserPanel = useBrowserStore((s) => s.restorePanel);
  const closeBrowserPanel = useBrowserStore((s) => s.closePanel);

  const [contextMenuOpen, setContextMenuOpen] = useState(false);

  const isVertical = position === "left" || position === "right";
  const iconSize = isVertical ? ICON_SIZE_VERTICAL : ICON_SIZE_HORIZONTAL;
  const itemSize = isVertical ? ITEM_SIZE_VERTICAL : ITEM_SIZE_HORIZONTAL;

  // border 跟主区交界（plan §4.4）— vertical bar 和主区在水平方向相邻、
  // horizontal bar 在垂直方向相邻；border 永远画在朝主区那一侧。
  const borderClass = (() => {
    switch (position) {
      case "right":
        return "border-l border-[var(--c-border)]";
      case "left":
        return "border-r border-[var(--c-border)]";
      case "top":
        return "border-b border-[var(--c-border)]";
      case "bottom":
        return "border-t border-[var(--c-border)]";
    }
  })();

  const layoutStyle: CSSProperties = isVertical
    ? { width: BAR_WIDTH_VERTICAL, flex: "0 0 auto" }
    : { height: BAR_HEIGHT_HORIZONTAL, flex: "0 0 auto" };

  // 单按钮的 wrapper 尺寸（vertical = item 占满宽度 + 固定高；horizontal 反过来）
  const itemWrapperStyle: CSSProperties = isVertical
    ? { width: BAR_WIDTH_VERTICAL, height: itemSize, flex: "0 0 auto" }
    : { width: itemSize, height: BAR_HEIGHT_HORIZONTAL, flex: "0 0 auto" };

  /**
   * 浏览器按钮 click（v0.4.1 T3 + v0.9.1 HR3-7）：
   * - 关闭状态：统一调 restorePanel；内部已兜底
   *   - tabs.length === 0 → 调 openTab 创建 about:blank（首次/closePanel 后重开语义）
   *   - tabs.length  > 0 → resume activeKey 对应 tab
   * - 打开状态：调 minimizePanel（保留 tabs，仅 destroy webview）
   *
   * v0.9.1 HR3-7 修：之前 tabs 为空走 openPanel() 只切 panelOpen=true 不建 tab；
   * 而 v0.9.0 HR2-1 删了 BrowserPanel 里"tabs 为空自动开 blank"的 useEffect，
   * 真机出现空 URL 栏壳。改成统一走 restorePanel 让 store 内部兜底建 about:blank。
   *
   * bounds 用 placeholder (0,0,800,600)，BrowserPanel mount 后由
   * ResizeObserver 立刻覆盖真值；这里只是为了让 webview 创建时有个起点。
   */
  const handleBrowserClick = () => {
    if (browserPanelOpen) {
      void minimizeBrowserPanel();
    } else {
      void restoreBrowserPanel({ x: 0, y: 0, w: 800, h: 600 });
    }
  };

  /**
   * 浏览器按钮右键 → context menu。
   * 单项 "关闭所有标签 (N)"，N=tabs.length；< 1 时禁用。
   * click → toast 二次确认（用 confirm() 简化；不引第三方 toast 库）→ closePanel。
   */
  const handleBrowserContextMenu = (e: MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenuOpen(true);
  };

  const handleCloseAllTabs = () => {
    setContextMenuOpen(false);
    if (browserTabsCount === 0) return;
    // 二次确认：用浏览器原生 confirm（足够简单 + 走 OS 原生 modal，不引 dep）
    const ok = window.confirm(
      t("activityBar.browserContextConfirm", { count: browserTabsCount }),
    );
    if (ok) void closeBrowserPanel();
  };

  // badge 仅在 panelOpen=false 且 tabs.length > 0 时显示（plan §5.4）
  const browserBadge =
    !browserPanelOpen && browserTabsCount > 0 ? browserTabsCount : undefined;

  return (
    <nav
      data-position={position}
      data-testid="activity-bar"
      aria-label="ActivityBar"
      className={
        "flex bg-[var(--c-bg-elev-1)] " +
        (isVertical ? "flex-col " : "flex-row ") +
        borderClass
      }
      style={layoutStyle}
    >
      <div style={itemWrapperStyle}>
        <ActivityBarItem
          icon={<Sparkles size={iconSize} aria-hidden />}
          label={t("activityBar.ai")}
          // v0.10.0 HR7-5：AI 侧栏快捷键 ⌘E → ⌘/ 对齐 useShortcuts 实际绑定。
          // ⌘E 在 macOS 是 Emoji 输入法 / 系统占用，跟 AI 助手没语义关联；改 ⌘/
          // （斜杠）是 Cursor / Copilot Chat 通用约定，且 ⌘E 留给"快速文件搜索"
          // 未来功能。
          shortcut="⌘/"
          isActive={aiOpen}
          onClick={toggleAi}
          position={position}
          testId="activity-bar-item-ai"
        />
      </div>
      {/* 浏览器按钮：onClick = minimize/restore；onContextMenu = 关闭全部 */}
      <div
        style={itemWrapperStyle}
        onContextMenu={handleBrowserContextMenu}
        // 关闭打开的菜单：点击其它地方
        onClick={() => contextMenuOpen && setContextMenuOpen(false)}
        className="relative"
      >
        <ActivityBarItem
          icon={<Globe size={iconSize} aria-hidden />}
          label={t("activityBar.browser")}
          // v0.9.1 HR3-5：tooltip 显示 Cmd+Shift+B 快捷键。
          // ⌘B 已被 FileTree 占用，浏览器用 ⌘⇧B 组合避免冲突。
          shortcut="⌘⇧B"
          isActive={browserPanelOpen}
          onClick={handleBrowserClick}
          badge={browserBadge}
          position={position}
          testId="activity-bar-item-browser"
        />
        {/* 极简右键菜单：单项 "关闭所有标签 (N)"。 */}
        {contextMenuOpen && (
          <div
            data-testid="activity-bar-browser-context-menu"
            role="menu"
            // 朝向内容区一侧弹（vertical bar → 主区方向；horizontal bar → 主区方向）
            className={
              "absolute z-50 min-w-[180px] rounded border border-[var(--c-border-strong)] " +
              "bg-[var(--c-bg-elev-1)] py-1 text-xs text-[var(--c-text-base)] shadow-lg " +
              (position === "right"
                ? "right-full top-0 mr-1"
                : position === "left"
                  ? "left-full top-0 ml-1"
                  : position === "top"
                    ? "top-full left-0 mt-1"
                    : "bottom-full left-0 mb-1")
            }
          >
            <button
              type="button"
              role="menuitem"
              data-testid="activity-bar-browser-close-all"
              onClick={(e) => {
                e.stopPropagation();
                handleCloseAllTabs();
              }}
              disabled={browserTabsCount === 0}
              className={
                "block w-full text-left px-3 py-1.5 " +
                (browserTabsCount === 0
                  ? "text-[var(--c-text-faint)] cursor-not-allowed"
                  : "hover:bg-[var(--c-bg-elev-2)] hover:text-[var(--c-error)] cursor-pointer")
              }
            >
              {t("activityBar.browserContextNoTabs", {
                count: browserTabsCount,
              })}
            </button>
          </div>
        )}
      </div>
      <div style={itemWrapperStyle}>
        <ActivityBarItem
          icon={<Folder size={iconSize} aria-hidden />}
          label={t("activityBar.fileTree")}
          shortcut="⌘B"
          isActive={fileTreeOpen}
          onClick={toggleFileTree}
          position={position}
          testId="activity-bar-item-file-tree"
        />
      </div>
      {/* v0.10.0 HR9-4 / HR9-6：文件预览按钮**常驻**（跟浏览器按钮一致），
       *  没文件时 disabled 灰显。点击 = toggle 可见性。 */}
      <div style={itemWrapperStyle}>
        <ActivityBarItem
          icon={<FileText size={iconSize} aria-hidden />}
          label={
            filePreviewHasContent
              ? t("activityBar.filePreview")
              : t("activityBar.filePreviewEmpty")
          }
          shortcut="⌘⇧E"
          isActive={filePreviewHasContent && filePreviewVisible}
          disabled={!filePreviewHasContent}
          onClick={toggleFilePreview}
          position={position}
          testId="activity-bar-item-file-preview"
        />
      </div>
      <div className="flex-1" data-testid="activity-bar-spacer" />
      <div style={itemWrapperStyle}>
        <ActivityBarItem
          icon={<Settings size={iconSize} aria-hidden />}
          label={t("activityBar.settings")}
          shortcut="⌘,"
          onClick={onSettingsOpen}
          position={position}
          testId="activity-bar-item-settings"
        />
      </div>
    </nav>
  );
}
