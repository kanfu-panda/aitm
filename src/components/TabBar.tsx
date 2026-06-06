import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useTabsStore, type Tab, type TabId } from "../stores/tabs";
import { useNotificationsStore } from "../stores/notifications";
import { sessionHasRunningCommand } from "../lib/tauri";
import CloseTabConfirmDialog from "./CloseTabConfirmDialog";
import StatusRing from "./StatusRing";
import TabMetadataIcons from "./TabMetadataIcons";

export default function TabBar() {
  const { t } = useTranslation();
  const tabs = useTabsStore((s) => s.tabs);
  const activeId = useTabsStore((s) => s.activeId);
  const unreadByTab = useTabsStore((s) => s.unreadByTab);
  const addTab = useTabsStore((s) => s.addTab);
  const closeTab = useTabsStore((s) => s.closeTab);
  const setActive = useTabsStore((s) => s.setActive);
  const setTitle = useTabsStore((s) => s.setTitle);
  const setAutoTitle = useTabsStore((s) => s.setAutoTitle);
  const notifLevelByTab = useNotificationsStore((s) => s.byTab);

  /** 当前正在 inline 编辑的 tab id；null 表示无编辑态。 */
  const [editingId, setEditingId] = useState<TabId | null>(null);

  /** v0.9.0 T3：右键菜单状态。null = 未显示；非空 = 在指定 tab 上点了右键。
   *  仅 auto_title === false 的 tab 才有意义（其它情况菜单空空如也，不显示）。 */
  const [contextMenu, setContextMenu] = useState<{
    tabId: TabId;
    x: number;
    y: number;
  } | null>(null);

  /** 待关 tab（有运行中命令时）；null = 无待关 tab，dialog 不显示。
   *  Phase 3A T5：避免误关 npm install / cargo test 等长任务。 */
  const [pendingClose, setPendingClose] = useState<{
    tabId: TabId;
    title: string;
  } | null>(null);

  // v0.9.0 T3：右键菜单显示时，挂全局 click / Escape / 滚动监听点空白处关闭
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

  /**
   * 处理 tab 关闭按钮点击：
   * - session 未开 → 直接 closeTab
   * - 有运行中命令 → 弹 CloseTabConfirmDialog
   * - 检测失败 → 静默直关，不阻塞用户操作
   */
  const handleClose = async (tab: Tab) => {
    if (!tab.sessionId) {
      closeTab(tab.id);
      return;
    }
    try {
      const hasRunning = await sessionHasRunningCommand(tab.sessionId);
      if (hasRunning) {
        setPendingClose({ tabId: tab.id, title: tab.title });
        return;
      }
    } catch (e) {
      // 检测失败 → 静默直关（fallback），日志只 warn 不打扰用户
      console.warn("sessionHasRunningCommand 失败", e);
    }
    closeTab(tab.id);
  };

  return (
    <>
      <div className="flex h-9 items-center gap-1 border-b border-[var(--c-border)] bg-[var(--c-bg-elev-1)] px-2 select-none">
        {tabs.map((tab) => {
          const isActive = tab.id === activeId;
          const unread = unreadByTab[tab.id] ?? 0;
          const isEditing = editingId === tab.id;
          return (
            <div
              key={tab.id}
              onClick={() => {
                if (!isEditing) setActive(tab.id);
              }}
              onContextMenu={(e) => {
                // v0.9.0 T3：右键菜单仅在 tab 已被手动改名（auto_title=false）
                // 时显示一个"重置为自动跟随目录"项。其他情况下不挡用户原生右键。
                if (isEditing || tab.auto_title) return;
                e.preventDefault();
                e.stopPropagation();
                setContextMenu({ tabId: tab.id, x: e.clientX, y: e.clientY });
              }}
              className={
                "group flex items-center gap-2 rounded px-3 py-1 text-xs font-mono cursor-pointer " +
                (isActive
                  ? "bg-[var(--c-bg-elev-2)] text-[var(--c-text-base)]"
                  : "text-[var(--c-text-muted)] hover:bg-[var(--c-bg-elev-2)] hover:text-[var(--c-text-base)]")
              }
            >
              {isEditing ? (
                <TabTitleInput
                  initial={tab.title}
                  onSubmit={(value) => {
                    // 空字符串不更新，保留原 title
                    if (value.trim().length > 0) {
                      setTitle(tab.id, value.trim());
                    }
                    setEditingId(null);
                  }}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <span
                  className="truncate max-w-40"
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setEditingId(tab.id);
                  }}
                  title={t("tabs.doubleClickRenameHint")}
                >
                  {tab.title}
                </span>
              )}
              {/* 未读小圆点：仅非 active + unread > 0 时显示。v0.2.0 加的"有 PTY
                  输出"指示，跟 v0.5.0-A 的 StatusRing 并存（语义不同）。 */}
              {unread > 0 && !isEditing && (
                <span
                  className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--c-success)]"
                  aria-label={t("tabs.unreadAria", { count: unread })}
                  title={t("tabs.unreadAria", { count: unread })}
                />
              )}
              {/* v0.5.0-A 通知状态环：4 色 done/waiting/running/error。优先级保护
                  + tab 切到 active 时 clearTab，详见 notifications store。 */}
              {!isEditing && notifLevelByTab[tab.id] && (
                <StatusRing level={notifLevelByTab[tab.id].level} />
              )}
              {/* v0.5.0-B Tab 元信息图标（git / 端口），hover 显示完整 tooltip。
                  只 active tab 5s 轮询拉新；非 active 用 cache 不主动刷新。 */}
              {!isEditing && (
                <TabMetadataIcons
                  sessionId={tab.sessionId}
                  poll={isActive}
                />
              )}
              {/* 编辑态隐藏关闭按钮，避免误点 */}
              {!isEditing && (
                <span
                  role="button"
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleClose(tab);
                  }}
                  className="text-[var(--c-text-dim)] hover:text-[var(--c-text-base)]"
                  aria-label={t("tabs.close")}
                >
                  ×
                </span>
              )}
            </div>
          );
        })}
        <button
          onClick={() => addTab()}
          className="ml-1 flex h-6 w-6 items-center justify-center rounded text-base text-[var(--c-text-muted)] hover:bg-[var(--c-bg-elev-2)] hover:text-[var(--c-text-base)]"
          aria-label={t("tabs.newTab")}
          title={t("tabs.newTabTitle")}
        >
          +
        </button>
        {/* 双击 TabBar 空白处也可新建标签 */}
        <div
          className="flex-1 h-full"
          onDoubleClick={() => addTab()}
          title={t("tabs.newTabDoubleClickHint")}
        />
      </div>
      <CloseTabConfirmDialog
        pendingTabTitle={pendingClose?.title ?? null}
        onConfirm={() => {
          if (pendingClose) {
            closeTab(pendingClose.tabId);
            setPendingClose(null);
          }
        }}
        onCancel={() => setPendingClose(null)}
      />
      {/* v0.9.0 T3 右键菜单：仅在 auto_title=false 时被触发显示 */}
      {contextMenu && (
        <div
          role="menu"
          aria-label={t("tabs.contextMenuAria")}
          style={{ top: contextMenu.y, left: contextMenu.x }}
          className="fixed z-50 min-w-[200px] rounded border border-[var(--c-border)] bg-[var(--c-bg-elev-2)] py-1 text-xs font-mono text-[var(--c-text-base)] shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            className="block w-full cursor-pointer px-3 py-1.5 text-left hover:bg-[var(--c-bg-elev-1)]"
            onClick={() => {
              setAutoTitle(contextMenu.tabId, true);
              setContextMenu(null);
            }}
          >
            {t("tabs.resetAutoTitle")}
          </button>
        </div>
      )}
    </>
  );
}

interface TabTitleInputProps {
  initial: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

/**
 * Tab 标题 inline 编辑输入框。
 *
 * - autoFocus + select 全文
 * - Enter / blur → onSubmit（空字符串由父组件兜底不更新）
 * - Escape → onCancel
 * - Enter / Escape 都 stopPropagation 防冒泡到外层 hotkey
 */
function TabTitleInput({ initial, onSubmit, onCancel }: TabTitleInputProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // 渲染后聚焦 + 全选
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, []);

  return (
    <input
      ref={inputRef}
      type="text"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          onSubmit(value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      onBlur={() => onSubmit(value)}
      aria-label={t("tabs.titleInputAria")}
      className="w-32 rounded border border-[var(--c-border-strong)] bg-[var(--c-bg-base)] px-1.5 py-0.5 font-mono text-xs text-[var(--c-text-base)] focus:border-[var(--c-text-muted)] focus:outline-none"
    />
  );
}
