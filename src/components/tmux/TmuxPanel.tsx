import { useEffect, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { RotateCw, SquareTerminal } from "../icons";
import { tmuxAttachCommand, type TmuxSession } from "../../lib/tauri";
import { useTmuxStore } from "../../stores/tmux";
import { useTabsStore } from "../../stores/tabs";

/**
 * tmux 会话管理器面板。
 *
 * 定位是"看见 + 一键进入 + 基本干预"，不接管 tmux 渲染：tmux 会吞掉终端转义
 * 序列，所以进到会话里之后目录跟踪 / AI 执行命令 / 通知都到不了外层——这是
 * 架构边界，不为它改 PTY 协议层。
 *
 * 接入方式：新开一个**普通 shell 标签页**，把 `tmux attach-session -t '<name>'`
 * 作为初始输入写进它的 PTY。这样 detach 之后用户落回一个可用的 shell，
 * 而且完全不需要改 `SessionConfig` 契约。
 */
/**
 * 面板定宽（px）。不提供拖拽调宽：本期 YAGNI，等用户提了再加 SplitDivider
 * 与对应的 settings 字段。
 */
export const TMUX_PANEL_WIDTH = 280;

export default function TmuxPanel() {
  const { t } = useTranslation();
  const sessions = useTmuxStore((s) => s.sessions);
  const loading = useTmuxStore((s) => s.loading);
  const error = useTmuxStore((s) => s.error);
  const available = useTmuxStore((s) => s.available);
  const refresh = useTmuxStore((s) => s.refresh);
  const interruptSession = useTmuxStore((s) => s.interruptSession);
  const killSession = useTmuxStore((s) => s.killSession);
  const addTab = useTabsStore((s) => s.addTab);

  /** 当前右键菜单对应的会话名；null 表示没有打开的菜单。 */
  const [menuFor, setMenuFor] = useState<string | null>(null);

  // 面板挂载时拉一次。不做轮询（每次拉取都 fork 一个 tmux 进程）。
  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * 接入会话：取一条转义好的 attach 命令，随新标签页一起创建。
   * `takeover=false` 是默认的**共享接入**——不踢掉已连接的其它客户端。
   */
  const attach = async (name: string, takeover: boolean) => {
    setMenuFor(null);
    try {
      const cmd = await tmuxAttachCommand(name, takeover);
      addTab({ title: `tmux: ${name}`, initialInput: `${cmd}\n` });
    } catch (e) {
      useTmuxStore.setState({
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const handleInterrupt = (name: string) => {
    setMenuFor(null);
    void interruptSession(name);
  };

  const handleKill = (name: string) => {
    setMenuFor(null);
    // 二次确认走原生 confirm，与 ActivityBar 关闭全部浏览器标签的做法一致
    if (!window.confirm(t("tmux.killConfirm", { name }))) return;
    void killSession(name);
  };

  const openMenu = (e: MouseEvent, name: string) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuFor(name);
  };

  return (
    <div
      data-testid="tmux-panel"
      className="flex h-full flex-col overflow-hidden text-[var(--c-text-base)]"
      onClick={() => menuFor !== null && setMenuFor(null)}
    >
      {/* 标题栏：标题 + 刷新 */}
      <div className="flex items-center justify-between border-b border-[var(--c-border)] px-3 py-2">
        <div className="flex items-center gap-1.5 text-xs font-medium">
          <SquareTerminal size={12} aria-hidden />
          {t("tmux.title")}
        </div>
        <button
          type="button"
          data-testid="tmux-refresh"
          title={t("tmux.refresh")}
          aria-label={t("tmux.refresh")}
          onClick={() => void refresh()}
          disabled={loading}
          className="rounded p-1 text-[var(--c-text-muted)] hover:bg-[var(--c-bg-elev-2)] hover:text-[var(--c-text-base)] disabled:opacity-50"
        >
          <RotateCw size={12} aria-hidden />
        </button>
      </div>

      {error !== null && (
        <div
          data-testid="tmux-error"
          className="border-b border-[var(--c-border)] px-3 py-2 text-xs text-[var(--c-error)]"
        >
          {error}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!available ? (
          <p
            data-testid="tmux-empty-unavailable"
            className="px-3 py-4 text-xs text-[var(--c-text-muted)]"
          >
            {t("tmux.emptyUnavailable")}
          </p>
        ) : sessions.length === 0 ? (
          <p
            data-testid="tmux-empty-no-sessions"
            className="px-3 py-4 text-xs text-[var(--c-text-muted)]"
          >
            {t("tmux.emptyNoSessions")}
          </p>
        ) : (
          <ul>
            {sessions.map((s) => (
              <SessionRow
                key={s.name}
                session={s}
                menuOpen={menuFor === s.name}
                onAttach={() => void attach(s.name, false)}
                onContextMenu={(e) => openMenu(e, s.name)}
                onTakeover={() => void attach(s.name, true)}
                onInterrupt={() => handleInterrupt(s.name)}
                onKill={() => handleKill(s.name)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** 单个会话行 + 它的右键菜单。 */
function SessionRow({
  session,
  menuOpen,
  onAttach,
  onContextMenu,
  onTakeover,
  onInterrupt,
  onKill,
}: {
  session: TmuxSession;
  menuOpen: boolean;
  onAttach: () => void;
  onContextMenu: (e: MouseEvent) => void;
  onTakeover: () => void;
  onInterrupt: () => void;
  onKill: () => void;
}) {
  const { t } = useTranslation();

  return (
    <li className="relative">
      <button
        type="button"
        data-testid={`tmux-session-item-${session.name}`}
        onClick={onAttach}
        onContextMenu={onContextMenu}
        title={`${t("tmux.attachHint", { name: session.name })}${
          session.current_path !== null ? `\n${session.current_path}` : ""
        }`}
        className="flex w-full flex-col gap-0.5 border-b border-[var(--c-border)] px-3 py-2 text-left hover:bg-[var(--c-bg-elev-2)]"
      >
        <div className="flex w-full items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs font-medium">
            {session.name}
          </span>
          {session.attached > 0 && (
            <span
              data-testid={`tmux-attached-badge-${session.name}`}
              title={t("tmux.attachedHint", { count: session.attached })}
              className="shrink-0 rounded bg-[var(--c-bg-elev-2)] px-1 text-[10px] text-[var(--c-success)]"
            >
              {t("tmux.attachedBadge", { count: session.attached })}
            </span>
          )}
          <span className="shrink-0 text-[10px] text-[var(--c-text-faint)]">
            {t("tmux.windows", { count: session.windows })}
          </span>
        </div>
        {session.title !== null && (
          <span className="truncate text-[11px] text-[var(--c-text-muted)]">
            {session.title}
          </span>
        )}
        {session.current_path !== null && (
          // 不用 dir="rtl" 那个"保留尾部"的技巧：路径开头的 `/` 是方向中性字符，
          // 在 rtl 上下文里会被渲染到视觉末尾（`/home/dev` 显示成 `home/dev/`）。
          // 完整路径挂在整行的 title 里，鼠标悬停可见。
          <span className="truncate text-[10px] text-[var(--c-text-faint)]">
            {session.current_path}
          </span>
        )}
      </button>

      {menuOpen && (
        <div
          role="menu"
          data-testid={`tmux-menu-${session.name}`}
          className="absolute right-2 top-2 z-50 min-w-[160px] rounded border border-[var(--c-border-strong)] bg-[var(--c-bg-elev-1)] py-1 text-xs shadow-lg"
        >
          <MenuItem
            testId="tmux-menu-takeover"
            label={t("tmux.menuTakeover")}
            onClick={onTakeover}
          />
          <MenuItem
            testId="tmux-menu-interrupt"
            label={t("tmux.menuInterrupt")}
            onClick={onInterrupt}
          />
          <MenuItem
            testId="tmux-menu-kill"
            label={t("tmux.menuKill")}
            onClick={onKill}
            danger
          />
        </div>
      )}
    </li>
  );
}

function MenuItem({
  testId,
  label,
  onClick,
  danger = false,
}: {
  testId: string;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={testId}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={
        "block w-full px-3 py-1.5 text-left hover:bg-[var(--c-bg-elev-2)] " +
        (danger
          ? "text-[var(--c-text-base)] hover:text-[var(--c-error)]"
          : "text-[var(--c-text-base)]")
      }
    >
      {label}
    </button>
  );
}
