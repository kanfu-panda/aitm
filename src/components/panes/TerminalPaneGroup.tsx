/* =============================================================================
 * TerminalPaneGroup.tsx —— v0.10.0 HR6-3b 终端 group
 * -----------------------------------------------------------------------------
 * 一个 PaneGroup（type=terminal）的完整渲染：
 *   - 顶部内部 TabBar（基于全局 useTabsStore，但 active 用 group.active_tab_id）
 *   - 下方：所有 tab 都 mount + visibility 切换（保留 xterm 历史；详见 App.tsx 注释）
 *   - 点击容器任意位置 → setActiveGroup(group.id) 切焦点
 *
 * 阶段 1 共享 store 决策：
 *   所有 group 看同一份 useTabsStore.tabs（即所有终端 tab 列表）；
 *   group.active_tab_id 决定该 group 显示哪个 tab。这导致目前两个 terminal
 *   group 看到的 tab 列表完全一样，只是 active 不同——本期接受，阶段 2
 *   拖拽功能时再让 group 拥有独立 tab 子集。
 *
 * Group 顶部 TabBar 不复用全局 TabBar（那个直接读 useTabsStore.activeId 切 active），
 * 而是简化版：渲染 group.tab_ids 的子集 + 用 group.active_tab_id 标 active。
 * 切 active 时调 setActiveTabInGroup(group.id, tabId)；同时也把全局 activeId
 * 同步过去（为了让 useShortcuts / xterm 焦点路径继续工作）。
 * ========================================================================== */

import { useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useTabsStore } from "../../stores/tabs";
import { usePaneLayoutStore, type PaneGroup } from "../../stores/pane-layout";
import { useFocusSurfaceStore } from "../../stores/focus-surface";
import type { SessionId } from "../../lib/tauri";
import TerminalView from "../TerminalView";
import TabMetadataIcons from "../TabMetadataIcons";
import { Bell } from "../icons";
import {
  useNotificationsStore,
  type NotificationLevel,
} from "../../stores/notifications";
import { usePaneDragState } from "./PaneDndContext";

/**
 * v0.10.3 HR9-2：tab 小喇叭按通知 level 上色。
 * waiting 最显眼（用户需要确认），其它按严重度递减。
 */
function notifLevelColorClass(level: NotificationLevel): string {
  switch (level) {
    case "waiting":
      return "text-[var(--c-warning)]"; // amber，最需要注意
    case "error":
      return "text-[var(--c-error)]";
    case "done":
      return "text-[var(--c-success)]";
    case "running":
      return "text-[var(--c-info)]";
  }
}

interface Props {
  group: PaneGroup;
}

export function TerminalPaneGroup({ group }: Props) {
  const { t } = useTranslation();
  const tabs = useTabsStore((s) => s.tabs);
  const setGlobalActive = useTabsStore((s) => s.setActive);
  const setSessionId = useTabsStore((s) => s.setSessionId);
  const unreadByTab = useTabsStore((s) => s.unreadByTab);
  const notifLevelByTab = useNotificationsStore((s) => s.byTab);

  const setActiveGroup = usePaneLayoutStore((s) => s.setActiveGroup);
  const setActiveTabInGroup = usePaneLayoutStore((s) => s.setActiveTabInGroup);
  const activeGroupId = usePaneLayoutStore((s) => s.active_group_id);

  // v0.10.0 HR7-1：删 HR6-3b 的"group.tab_ids 空时 fallback 全局 tabs"——
  // 那个 fallback 是"分屏后两边镜像"bug 的根因（两个 group 看到一样的 tab
  // 列表）。现在 group.tab_ids 是真独占的 tab 子集：splitGroupWithNewTab
  // seed 新 tab、addTabToActiveGroup 加进 active group、closeTabInGroup
  // 关 tab，都保证每个 group 各自一套 tab_ids；空 group 显示"点击新建"占位。
  //
  // activeTabId 直接读 group.active_tab_id（不再 fallback 全局 activeId），
  // 否则"焦点在 B group 但显示 A group 的 tab"的诡异状态会出现。
  const visibleTabs = tabs.filter((t) => group.tab_ids.includes(t.id));
  const activeTabId = group.active_tab_id;
  const activeTab = visibleTabs.find((t) => t.id === activeTabId) ?? null;

  // v0.10.0 HR7-1："+" 按钮 / 空 group 占位 → addTabToActiveGroup（保 active
  // 是本 group 才进本 group）。close tab → closeTabInGroup（同步关 PTY +
  // 从 group 移除 + 空 group 时 cascade 关 group / 根重 seed）。
  const addTabToActiveGroup = usePaneLayoutStore(
    (s) => s.addTabToActiveGroup,
  );
  const closeTabInGroup = usePaneLayoutStore((s) => s.closeTabInGroup);
  const handleAddTab = () => {
    // 先把焦点切到本 group，确保 addTabToActiveGroup 加进本 group
    setActiveGroup(group.id);
    void addTabToActiveGroup();
  };
  const handleCloseTab = (tabId: string) => {
    void closeTabInGroup(group.id, tabId);
  };

  // v0.10.6 hotfix：tab 右键菜单（对齐 FileTabBar 4-action 菜单）。
  // group.tab_ids 顺序即视觉顺序，closeOthers/closeRight 基于此切片。
  const [contextMenu, setContextMenu] = useState<{
    tabId: string;
    x: number;
    y: number;
  } | null>(null);
  useEffect(() => {
    if (!contextMenu) return;
    const onDocClick = () => setContextMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setContextMenu(null);
    };
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [contextMenu]);
  const ctxIdx = contextMenu
    ? group.tab_ids.indexOf(contextMenu.tabId)
    : -1;
  const otherCount = contextMenu
    ? Math.max(0, group.tab_ids.length - 1)
    : 0;
  const rightCount =
    contextMenu && ctxIdx >= 0 ? group.tab_ids.length - 1 - ctxIdx : 0;
  const closeBatch = async (ids: string[]) => {
    // 顺序 await 避免 store race（closeTabInGroup 内部会改 group.tab_ids）
    for (const id of ids) {
      await closeTabInGroup(group.id, id);
    }
  };
  const handleCloseOthers = () => {
    if (!contextMenu) return;
    const keep = contextMenu.tabId;
    const targets = group.tab_ids.filter((id) => id !== keep);
    setContextMenu(null);
    void closeBatch(targets);
  };
  const handleCloseRight = () => {
    if (!contextMenu || ctxIdx < 0) return;
    const targets = group.tab_ids.slice(ctxIdx + 1);
    setContextMenu(null);
    void closeBatch(targets);
  };
  const handleCloseAll = () => {
    const targets = [...group.tab_ids];
    setContextMenu(null);
    void closeBatch(targets);
  };

  const isFocused = activeGroupId === group.id;

  const handleTabClick = (tabId: string) => {
    // 点击 group 内 tab → 该 group 成 focus，并同步全局 active 给 xterm 路径
    setActiveGroup(group.id);
    setActiveTabInGroup(group.id, tabId);
    setGlobalActive(tabId);
  };

  // v0.10.6 HR7-6：tab bar 空白处 droppable —— 拖 tab 到此 group 的 bar
  // 空白时触发跨 group moveTab。id 约定见 PaneDndContext.tsx。
  const { setNodeRef: setBarRef, isOver: isBarOver } = useDroppable({
    id: `group-bar-${group.id}`,
  });

  const drag = usePaneDragState();
  // 只在拖一个不属于本 group 的 tab 时高亮 bar drop hover（同 group 也允许 drop，
  // 但视觉上更倾向于"位置交换"由 sortable 给 placeholder 提示）
  const showBarDropHover =
    drag.isDraggingTab &&
    drag.activeTabId !== null &&
    !group.tab_ids.includes(drag.activeTabId) &&
    isBarOver;

  return (
    <div
      data-testid="terminal-pane-group"
      data-group-id={group.id}
      data-focused={isFocused ? "true" : "false"}
      // v0.10.0 HR7-3：focus 视觉换方案 A —— 删 outer 满边框，让"高亮提示"集中在
      // 内部 tab bar 背景一档（见下方 tabbar className）和 active tab 底部 2px
      // emerald 横线。这样避免 5 块分屏时屏幕被多条绿框包围、视觉嘈杂。
      className="relative flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden border border-[var(--c-border)]"
      // 点击 group 容器任意区域 → 焦点切到本 group（写 active_group_id）
      // v0.10.0 HR9-11：同时记 lastSurface=terminal 给 Cmd+W 路由用
      // v0.10.0 HR9-14：同步全局 useTabsStore.activeId 到本 group 的 active_tab_id，
      // 避免"切 group 但全局 activeId 仍在别处"——这会让 Cmd+W / xterm 焦点
      // 路径都指向错误 tab。
      onMouseDownCapture={() => {
        useFocusSurfaceStore.getState().setSurface("terminal");
        if (!isFocused) {
          setActiveGroup(group.id);
          if (activeTabId) setGlobalActive(activeTabId);
        }
      }}
    >
      {/* group 内部 tab bar（简化版，不含 inline 编辑 / 右键菜单——本期不复用 TabBar）
          v0.10.0 HR7-3：active group 的 tab bar 背景亮一档（elev-1 → elev-2）。
          v0.10.6 HR7-6：整条 bar 是 useDroppable（id=group-bar-${groupId}），
          内部 tab 列表用 SortableContext 包，每个 tab 是 useSortable。 */}
      <div
        ref={setBarRef}
        className={
          "flex h-9 shrink-0 items-center gap-1 border-b px-2 select-none " +
          (showBarDropHover
            ? "border-[var(--c-success)] bg-[var(--c-success)]/10 outline outline-2 outline-[var(--c-success)] -outline-offset-2"
            : isFocused
              ? "border-[var(--c-border)] bg-[var(--c-bg-elev-2)]"
              : "border-[var(--c-border)] bg-[var(--c-bg-elev-1)]")
        }
        data-testid="terminal-pane-group-tabbar"
      >
        <SortableContext
          items={group.tab_ids}
          strategy={horizontalListSortingStrategy}
        >
          {visibleTabs.map((t) => {
            const isActive = t.id === activeTabId;
            const unread = unreadByTab[t.id] ?? 0;
            return (
              <SortableTab
                key={t.id}
                tabId={t.id}
                title={t.title}
                isActive={isActive}
                isFocused={isFocused}
                unread={unread}
                notifLevel={notifLevelByTab[t.id]?.level}
                sessionId={t.sessionId}
                onClick={() => handleTabClick(t.id)}
                onClose={() => handleCloseTab(t.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setContextMenu({ tabId: t.id, x: e.clientX, y: e.clientY });
                }}
              />
            );
          })}
        </SortableContext>
        <button
          onClick={handleAddTab}
          className="ml-1 flex h-6 w-6 items-center justify-center rounded text-base text-[var(--c-text-muted)] hover:bg-[var(--c-bg-elev-2)] hover:text-[var(--c-text-base)]"
          aria-label="新建标签"
          title="新建标签 (⌘T)"
        >
          +
        </button>
      </div>

      {/* 终端区：所有 tab mount + visibility 切显隐（保留 xterm 历史；同 App.tsx 模式） */}
      <div className="relative flex-1 overflow-hidden">
        {visibleTabs.map((t) => (
          <div
            key={t.id}
            className="absolute inset-0"
            style={{
              visibility: t.id === activeTabId ? "visible" : "hidden",
              pointerEvents: t.id === activeTabId ? "auto" : "none",
              zIndex: t.id === activeTabId ? 1 : 0,
            }}
            aria-hidden={t.id !== activeTabId}
          >
            <TerminalView
              sessionId={(t.sessionId as SessionId | null) ?? null}
              initialCwd={t.last_cwd ?? null}
              onSessionOpened={(sid) => setSessionId(t.id, sid)}
              onExit={() => handleCloseTab(t.id)}
            />
          </div>
        ))}
        {!activeTab && (
          <button
            onClick={handleAddTab}
            className="flex h-full w-full flex-col items-center justify-center gap-3 text-[var(--c-text-dim)] hover:text-[var(--c-text-muted)] transition-colors"
            aria-label="新建标签"
          >
            <span className="text-5xl font-thin">+</span>
            <span className="text-sm">
              点击新建标签 · 或按{" "}
              <kbd className="rounded bg-[var(--c-bg-elev-2)] px-1.5 py-0.5 text-xs font-mono text-[var(--c-text-muted)]">
                ⌘T
              </kbd>
            </span>
          </button>
        )}
        {/* v0.10.6 HR7-6：4 条边沿 droppable，仅在 dragging 时显示。
            z 高于 PanelResizeHandle（z-10）但 pointer-events 只 dragging 时启用。 */}
        {drag.isDraggingTab && <EdgeDroppables groupId={group.id} />}
      </div>
      {/* v0.10.6 hotfix：tab 右键菜单（对齐 FileTabBar 4-action 风格）。
          fixed 定位避免被 PanelGroup overflow clip；z-50 高于 EdgeDroppables。 */}
      {contextMenu && (
        <div
          role="menu"
          aria-label={t("tabs.contextMenuAria")}
          data-testid="terminal-tab-context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          className="fixed z-50 min-w-[180px] rounded border border-[var(--c-border)] bg-[var(--c-bg-elev-2)] py-1 text-xs font-mono text-[var(--c-text-base)] shadow-lg"
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button
            type="button"
            role="menuitem"
            data-testid="terminal-tab-ctx-close"
            className="block w-full cursor-pointer px-3 py-1.5 text-left hover:bg-[var(--c-bg-elev-1)]"
            onClick={() => {
              const id = contextMenu.tabId;
              setContextMenu(null);
              handleCloseTab(id);
            }}
          >
            {t("tabs.contextMenu.close")}
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="terminal-tab-ctx-close-others"
            disabled={otherCount === 0}
            className="block w-full cursor-pointer px-3 py-1.5 text-left hover:bg-[var(--c-bg-elev-1)] disabled:cursor-not-allowed disabled:text-[var(--c-text-dim)] disabled:hover:bg-transparent"
            onClick={handleCloseOthers}
          >
            {t("tabs.contextMenu.closeOthers")}
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="terminal-tab-ctx-close-right"
            disabled={rightCount === 0}
            className="block w-full cursor-pointer px-3 py-1.5 text-left hover:bg-[var(--c-bg-elev-1)] disabled:cursor-not-allowed disabled:text-[var(--c-text-dim)] disabled:hover:bg-transparent"
            onClick={handleCloseRight}
          >
            {t("tabs.contextMenu.closeRight")}
          </button>
          <div className="my-1 h-px bg-[var(--c-border)]" aria-hidden />
          <button
            type="button"
            role="menuitem"
            data-testid="terminal-tab-ctx-close-all"
            className="block w-full cursor-pointer px-3 py-1.5 text-left hover:bg-[var(--c-bg-elev-1)]"
            onClick={handleCloseAll}
          >
            {t("tabs.contextMenu.closeAll")}
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// v0.10.6 HR7-6 子组件
// ---------------------------------------------------------------------------

interface SortableTabProps {
  tabId: string;
  title: string;
  isActive: boolean;
  isFocused: boolean;
  unread: number;
  notifLevel: NotificationLevel | undefined;
  sessionId: string | null;
  onClick: () => void;
  onClose: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

/**
 * 单 tab 节点：包了 useSortable。
 *
 * - id = tabId（PaneDndContext.handleDragEnd 用此 id 找属于哪个 group）
 * - 整个 tab 头部都是 drag activator；关闭按钮 stopPropagation 不触发拖
 * - dragging 时 opacity-50 + cursor-grabbing 提示
 */
function SortableTab({
  tabId,
  title,
  isActive,
  isFocused,
  unread,
  notifLevel,
  sessionId,
  onClick,
  onClose,
  onContextMenu,
}: SortableTabProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: tabId });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    cursor: isDragging ? "grabbing" : "pointer",
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      data-testid={`terminal-pane-group-tab-${tabId}`}
      role="tab"
      aria-selected={isActive}
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={
        "group flex items-center gap-2 px-3 py-1 text-xs font-mono " +
        (isActive
          ? isFocused
            ? "border-b-2 border-[var(--c-success)] bg-[var(--c-bg-elev-2)] text-[var(--c-text-base)]"
            : "border-b-2 border-[var(--c-border-strong)] bg-[var(--c-bg-elev-2)] text-[var(--c-text-base)]"
          : "rounded text-[var(--c-text-muted)] hover:bg-[var(--c-bg-elev-2)] hover:text-[var(--c-text-base)]")
      }
    >
      <span className="truncate max-w-40">{title}</span>
      {unread > 0 && (
        <span
          className="inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-[var(--c-error)] px-1 text-[10px] font-bold leading-none text-white"
          aria-label={`${unread} 条未读`}
          data-testid={`tab-unread-badge-${tabId}`}
        >
          {unread > 99 ? "99+" : unread}
        </span>
      )}
      {notifLevel && (
        <Bell
          size={12}
          className={notifLevelColorClass(notifLevel)}
          aria-label={`通知：${notifLevel}`}
          data-testid={`tab-bell-${tabId}`}
        />
      )}
      <TabMetadataIcons sessionId={sessionId} poll={isActive} />
      <span
        role="button"
        tabIndex={-1}
        onPointerDown={(e) => {
          // 关闭按钮 pointerDown 抢在 dnd-kit activator 前，避免点 × 也触发拖
          e.stopPropagation();
        }}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="text-[var(--c-text-dim)] hover:text-[var(--c-text-base)]"
        aria-label="关闭标签"
      >
        ×
      </span>
    </div>
  );
}

interface EdgeDroppablesProps {
  groupId: string;
}

/**
 * v0.10.6 HR7-6：4 条 ~20px 边沿 droppable 条带，仅在 dragging 时挂载。
 *
 * 命名 id：`group-edge-${groupId}-{top|right|bottom|left}`。
 *
 * 视觉：
 * - 平时：透明（外层条件渲染不挂）
 * - hover（isOver）：emerald 半透明，提示新 split 落点位置 + 方向
 *
 * Z-index 高于 xterm（xterm 默认 z-index:auto），但因为只在 dragging 时挂、
 * 平时不挡 PanelResizeHandle 操作。
 */
function EdgeDroppables({ groupId }: EdgeDroppablesProps) {
  return (
    <>
      <EdgeDroppable groupId={groupId} side="top" />
      <EdgeDroppable groupId={groupId} side="right" />
      <EdgeDroppable groupId={groupId} side="bottom" />
      <EdgeDroppable groupId={groupId} side="left" />
    </>
  );
}

interface EdgeDroppableProps {
  groupId: string;
  side: "top" | "right" | "bottom" | "left";
}

function EdgeDroppable({ groupId, side }: EdgeDroppableProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: `group-edge-${groupId}-${side}`,
  });

  // 20px 厚度条带绝对定位贴在父 container 各边
  const baseClass = "absolute pointer-events-auto z-20 transition-colors";
  const positionClass = (() => {
    switch (side) {
      case "top":
        return "top-0 left-0 right-0 h-5";
      case "bottom":
        return "bottom-0 left-0 right-0 h-5";
      case "left":
        return "top-0 bottom-0 left-0 w-5";
      case "right":
        return "top-0 bottom-0 right-0 w-5";
    }
  })();
  const hoverClass = isOver
    ? "bg-[var(--c-success)]/30 outline outline-2 outline-[var(--c-success)] -outline-offset-2"
    : "";

  return (
    <div
      ref={setNodeRef}
      className={`${baseClass} ${positionClass} ${hoverClass}`}
      data-testid={`group-edge-${groupId}-${side}`}
      aria-label={`拖到此处在${side === "top" ? "上" : side === "bottom" ? "下" : side === "left" ? "左" : "右"}侧拆分`}
    />
  );
}
