import {
  useEffect,
  useState,
  type ComponentProps,
  type MouseEvent,
} from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronRight,
  Plus,
  RotateCw,
  SquareTerminal,
} from "../icons";
import InputDialog from "../InputDialog";
import {
  sessionCurrentCwd,
  tmuxAttachCommand,
  tmuxCapturePane,
  type TmuxSession,
} from "../../lib/tauri";
import { hasNewOutput, useTmuxStore } from "../../stores/tmux";
import { useTabsStore } from "../../stores/tabs";

/**
 * tmux 会话管理器面板。
 *
 * 定位是"看见 + 一键进入 + 基本干预"，不接管 tmux 渲染：tmux 会吞掉终端转义
 * 序列，所以进到会话里之后目录跟踪 / AI 执行命令 / 通知都到不了外层——这是
 * 架构边界，不为它改 PTY 协议层。
 *
 * 接入方式：新开一个**普通 shell 标签页**，把 `tmux attach-session -t '<id>'`
 * 作为初始输入写进它的 PTY。这样 detach 之后用户落回一个可用的 shell，
 * 而且完全不需要改 `SessionConfig` 契约。
 *
 * **所有针对具体会话的操作都传 `session_id`，不传名字**：tmux 按名字定位时做前缀
 * 匹配，目标已被关掉时会误中名字以它开头的另一个会话。名字只用于显示。
 */
/**
 * 面板定宽（px）。不提供拖拽调宽：本期 YAGNI，等用户提了再加 SplitDivider
 * 与对应的 settings 字段。
 */
export const TMUX_PANEL_WIDTH = 280;

/**
 * 面板打开期间自动刷新列表的间隔。面板关闭时组件卸载，定时器随之清除。
 *
 * 3 秒是在"响应及时"与"不常驻进程"之间取的折中：列一次会话约 5 毫秒，每 3 秒一次
 * 开销可以忽略；而改用 tmux 控制模式做真正的事件推送，需要一个长期挂着的客户端，
 * 它会被算进「已连接」计数、所挂会话结束时还要重挂，没有会话时更是无处可挂。
 */
export const TMUX_REFRESH_INTERVAL_MS = 3_000;

/**
 * 会话名校验，与后端 `validate_session_name` 同一套规则，外加重名检查。
 *
 * 前端先校验是为了让输入框当场报错、不发请求；后端仍会再校验一遍。
 * 返回 i18n key；null 表示合法。
 */
export function sessionNameError(
  name: string,
  existing: string[],
  current?: string,
): string | null {
  if (name.trim() === "") return "tmux.nameEmpty";
  if (name.includes(".") || name.includes(":")) return "tmux.nameBadChar";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return "tmux.nameControl";
  if (name !== current && existing.includes(name)) return "tmux.nameTaken";
  return null;
}

/**
 * 由工作目录推一个默认会话名：取目录名，`.`/`:` 换成 `_`；和已有会话重名时
 * 依次追加 `-2`、`-3`……
 */
export function defaultSessionName(
  cwd: string | null,
  existing: string[],
): string {
  const base =
    (cwd ?? "")
      .replace(/\/+$/, "")
      .split("/")
      .pop()
      // eslint-disable-next-line no-control-regex
      ?.replace(/[.:\u0000-\u001f\u007f]/g, "_") || "session";
  if (!existing.includes(base)) return base;
  let n = 2;
  while (existing.includes(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/** 当前标签页的工作目录：优先实时查 shell 的 cwd，拿不到再退回标签页记下的。 */
async function activeTabCwd(): Promise<string | null> {
  const { tabs, activeId } = useTabsStore.getState();
  const tab = tabs.find((t) => t.id === activeId);
  if (!tab) return null;
  if (tab.sessionId) {
    try {
      const live = await sessionCurrentCwd(tab.sessionId);
      if (live) return live;
    } catch {
      // 查不到就用下面的兜底值，不打断新建流程
    }
  }
  return tab.cwd ?? tab.last_cwd ?? null;
}

/** 单个会话的预览状态。 */
interface Preview {
  loading: boolean;
  text: string | null;
  error: string | null;
}

export default function TmuxPanel() {
  const { t } = useTranslation();
  const sessions = useTmuxStore((s) => s.sessions);
  const loading = useTmuxStore((s) => s.loading);
  const error = useTmuxStore((s) => s.error);
  const available = useTmuxStore((s) => s.available);
  const seen = useTmuxStore((s) => s.seen);
  const refresh = useTmuxStore((s) => s.refresh);
  const interruptSession = useTmuxStore((s) => s.interruptSession);
  const killSession = useTmuxStore((s) => s.killSession);
  const newSession = useTmuxStore((s) => s.newSession);
  const renameSession = useTmuxStore((s) => s.renameSession);
  const markSeen = useTmuxStore((s) => s.markSeen);
  const addTab = useTabsStore((s) => s.addTab);

  /** 当前右键菜单对应的会话 id；null 表示没有打开的菜单。 */
  const [menuFor, setMenuFor] = useState<string | null>(null);
  /** 已展开预览的会话 id。按 id 记，改名后展开状态自然保留。 */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [previews, setPreviews] = useState<Record<string, Preview>>({});
  const [dialog, setDialog] =
    useState<ComponentProps<typeof InputDialog>["open"]>(null);

  // 挂载时拉一次，之后每 3 秒静默刷新一次。面板只在打开时挂载，关掉面板定时器就
  // 清掉了，不需要额外的开关——"关闭即停止刷新"是结构上保证的。
  useEffect(() => {
    void refresh();
    const timer = setInterval(
      () => void refresh({ silent: true }),
      TMUX_REFRESH_INTERVAL_MS,
    );
    return () => clearInterval(timer);
  }, [refresh]);

  const names = sessions.map((s) => s.name);

  /**
   * 接入会话：取一条转义好的 attach 命令，随新标签页一起创建。
   * `takeover=false` 是默认的**共享接入**——不踢掉已连接的其它客户端。
   */
  const attach = async (id: string, name: string, takeover: boolean) => {
    setMenuFor(null);
    markSeen(id);
    try {
      const cmd = await tmuxAttachCommand(id, takeover);
      addTab({ title: `tmux: ${name}`, initialInput: `${cmd}\n` });
    } catch (e) {
      useTmuxStore.setState({
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const loadPreview = async (id: string) => {
    setPreviews((p) => ({
      ...p,
      [id]: { loading: true, text: p[id]?.text ?? null, error: null },
    }));
    try {
      const text = await tmuxCapturePane(id);
      setPreviews((p) => ({ ...p, [id]: { loading: false, text, error: null } }));
    } catch (e) {
      setPreviews((p) => ({
        ...p,
        [id]: {
          loading: false,
          text: null,
          error: e instanceof Error ? e.message : String(e),
        },
      }));
    }
  };

  const toggleExpand = (id: string) => {
    const opening = !expanded.has(id);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (opening) next.add(id);
      else next.delete(id);
      return next;
    });
    if (opening) {
      // 展开即视为"看过了"：清掉新输出标记，并按需拉一次预览
      markSeen(id);
      void loadPreview(id);
    }
  };

  const openNewDialog = async () => {
    const cwd = await activeTabCwd();
    setDialog({
      title: t("tmux.newTitle"),
      label: cwd ? t("tmux.newCwdHint", { cwd }) : undefined,
      initialValue: defaultSessionName(cwd, names),
      okLabel: t("tmux.newOk"),
      validate: (v) => {
        const key = sessionNameError(v, names);
        return key ? t(key) : null;
      },
      onSubmit: async (v) => {
        const id = await newSession(v, cwd);
        await attach(id, v, false);
      },
    });
  };

  const openRenameDialog = (s: TmuxSession) => {
    setMenuFor(null);
    setDialog({
      title: t("tmux.renameTitle"),
      initialValue: s.name,
      okLabel: t("tmux.renameOk"),
      validate: (v) => {
        const key = sessionNameError(v, names, s.name);
        return key ? t(key) : null;
      },
      onSubmit: async (v) => {
        if (v === s.name) return;
        await renameSession(s.id, v);
      },
    });
  };

  const handleInterrupt = (id: string) => {
    setMenuFor(null);
    void interruptSession(id);
  };

  const handleKill = (s: TmuxSession) => {
    setMenuFor(null);
    // 二次确认走原生 confirm，与 ActivityBar 关闭全部浏览器标签的做法一致
    if (!window.confirm(t("tmux.killConfirm", { name: s.name }))) return;
    void killSession(s.id);
  };

  const openMenu = (e: MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuFor(id);
  };

  return (
    <div
      data-testid="tmux-panel"
      className="flex h-full flex-col overflow-hidden text-[var(--c-text-base)]"
      onClick={() => menuFor !== null && setMenuFor(null)}
    >
      {/* 标题栏：标题 + 新建 + 刷新 */}
      <div className="flex items-center justify-between border-b border-[var(--c-border)] px-3 py-2">
        <div className="flex items-center gap-1.5 text-xs font-medium">
          <SquareTerminal size={12} aria-hidden />
          {t("tmux.title")}
        </div>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            data-testid="tmux-new"
            title={t("tmux.new")}
            aria-label={t("tmux.new")}
            onClick={() => void openNewDialog()}
            disabled={!available}
            className="rounded p-1 text-[var(--c-text-muted)] hover:bg-[var(--c-bg-elev-2)] hover:text-[var(--c-text-base)] disabled:opacity-50"
          >
            <Plus size={12} aria-hidden />
          </button>
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
                key={s.id}
                session={s}
                isNew={hasNewOutput(s, seen)}
                expanded={expanded.has(s.id)}
                preview={previews[s.id]}
                menuOpen={menuFor === s.id}
                onToggle={() => toggleExpand(s.id)}
                onReloadPreview={() => void loadPreview(s.id)}
                onAttach={() => void attach(s.id, s.name, false)}
                onContextMenu={(e) => openMenu(e, s.id)}
                onTakeover={() => void attach(s.id, s.name, true)}
                onRename={() => openRenameDialog(s)}
                onInterrupt={() => handleInterrupt(s.id)}
                onKill={() => handleKill(s)}
              />
            ))}
          </ul>
        )}
      </div>

      <InputDialog open={dialog} onClose={() => setDialog(null)} />
    </div>
  );
}

/** 单个会话行 + 预览区 + 它的右键菜单。 */
function SessionRow({
  session,
  isNew,
  expanded,
  preview,
  menuOpen,
  onToggle,
  onReloadPreview,
  onAttach,
  onContextMenu,
  onTakeover,
  onRename,
  onInterrupt,
  onKill,
}: {
  session: TmuxSession;
  isNew: boolean;
  expanded: boolean;
  preview: Preview | undefined;
  menuOpen: boolean;
  onToggle: () => void;
  onReloadPreview: () => void;
  onAttach: () => void;
  onContextMenu: (e: MouseEvent) => void;
  onTakeover: () => void;
  onRename: () => void;
  onInterrupt: () => void;
  onKill: () => void;
}) {
  const { t } = useTranslation();

  return (
    <li className="relative border-b border-[var(--c-border)]">
      <div className="flex">
        <button
          type="button"
          data-testid={`tmux-expand-${session.name}`}
          aria-label={t(expanded ? "tmux.collapse" : "tmux.expand")}
          aria-expanded={expanded}
          title={t(expanded ? "tmux.collapse" : "tmux.expand")}
          onClick={onToggle}
          className="shrink-0 self-start px-1.5 pt-2.5 text-[var(--c-text-faint)] hover:text-[var(--c-text-base)]"
        >
          {expanded ? (
            <ChevronDown size={12} aria-hidden />
          ) : (
            <ChevronRight size={12} aria-hidden />
          )}
        </button>
        <button
          type="button"
          data-testid={`tmux-session-item-${session.name}`}
          onClick={onAttach}
          onContextMenu={onContextMenu}
          title={`${t("tmux.attachHint", { name: session.name })}${
            session.current_path !== null ? `\n${session.current_path}` : ""
          }`}
          className="flex min-w-0 flex-1 flex-col gap-0.5 py-2 pr-3 text-left hover:bg-[var(--c-bg-elev-2)]"
        >
          <div className="flex w-full items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-xs font-medium">
              {session.name}
            </span>
            {isNew && (
              <span
                data-testid={`tmux-new-output-${session.name}`}
                title={t("tmux.newOutputHint")}
                className="flex shrink-0 items-center gap-1 text-[10px] text-[var(--c-info)]"
              >
                <span
                  aria-hidden
                  className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--c-info)]"
                />
                {t("tmux.newOutput")}
              </span>
            )}
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
      </div>

      {expanded && (
        <div
          data-testid={`tmux-preview-${session.name}`}
          className="mx-2 mb-2 rounded border border-[var(--c-border)] bg-[var(--c-bg-base)]"
        >
          <div className="flex items-center justify-between px-2 py-1 text-[10px] text-[var(--c-text-faint)]">
            <span>{t("tmux.previewTitle")}</span>
            <button
              type="button"
              data-testid={`tmux-preview-reload-${session.name}`}
              title={t("tmux.previewReload")}
              aria-label={t("tmux.previewReload")}
              onClick={onReloadPreview}
              disabled={preview?.loading}
              className="rounded p-0.5 hover:text-[var(--c-text-base)] disabled:opacity-50"
            >
              <RotateCw size={10} aria-hidden />
            </button>
          </div>
          {preview?.error ? (
            <p className="px-2 pb-2 text-[11px] text-[var(--c-error)]">
              {preview.error}
            </p>
          ) : preview?.text === null || preview === undefined ? (
            <p className="px-2 pb-2 text-[11px] text-[var(--c-text-faint)]">
              {t("tmux.previewLoading")}
            </p>
          ) : preview.text === "" ? (
            <p className="px-2 pb-2 text-[11px] text-[var(--c-text-faint)]">
              {t("tmux.previewEmpty")}
            </p>
          ) : (
            // 纯文本渲染：capture-pane 不带 -e，不含转义序列；React 自动转义
            <pre className="max-h-64 overflow-auto whitespace-pre px-2 pb-2 font-mono text-[10px] leading-snug text-[var(--c-text-muted)]">
              {preview.text}
            </pre>
          )}
        </div>
      )}

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
            testId="tmux-menu-rename"
            label={t("tmux.menuRename")}
            onClick={onRename}
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
