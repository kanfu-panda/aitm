import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  fsDiskUsage,
  gitCurrentBranch,
  onSystemMetrics,
  type DiskUsage,
  type SystemMetricsEvent,
} from "../lib/tauri";
import { useSettingsStore } from "../stores/settings";
import { useFileEditorStore } from "../stores/file-editor";
import { useTabsStore } from "../stores/tabs";
import { useActiveSurface } from "../lib/useActiveSurface";
import { languageLabel } from "../lib/cm-lang";
import UpdateBadge from "./UpdateBadge";
import {
  Copy,
  GitBranch,
  HardDrive,
  Wifi,
  WifiOff,
} from "./icons";

/**
 * 底部窄 status bar — v0.9.1 HR3-3 重排为三段式：
 *
 *   左：UpdateBadge + 当前焦点资源（编辑器文件路径优先；否则 active terminal cwd），
 *       点击复制到剪贴板，100ms 闪绿反馈。
 *   中：当前 cwd 的 git 分支（1s 轮询；非 git repo 时隐藏整段）。
 *   右：网络在线图标 + 磁盘使用率（10s 轮询）+ T5d 编辑器段（Ln/Col/编码/语言/EOL）+
 *       aitm 全部进程 RSS / CPU / sessions。
 *
 * 关键约束：
 * - 整个 footer 高 h-5；文字 11px tabular-nums；颜色用 var(--c-*) token（不硬编码 zinc-*）
 * - 路径段最大宽度限制（max-w-[360px]）+ truncate，过长用 dir="rtl" 让尾部可见
 * - 网络 / 磁盘 / git 段在没数据 / 失败时隐藏；不弹错也不留占位（避免视觉噪音）
 * - editor info（T5d）保留原位置（焦点在 editor 时才出现），不改原契约
 * - statusBarEnabled = false → 返 null（不渲染 footer）
 */
export default function StatusBar() {
  const { t } = useTranslation();
  const enabled = useSettingsStore((s) => s.statusBarEnabled);
  const [m, setM] = useState<SystemMetricsEvent | null>(null);

  // T5d：编辑器段所需 state
  const activeFile = useFileEditorStore((s) =>
    s.openFiles.find((f) => f.id === s.activeId) ?? null,
  );
  const surface = useActiveSurface();
  const showEditorInfo = surface === "editor" && activeFile !== null;

  // HR3-3：左段 / 中段 / 磁盘段需要的"当前焦点资源 path / cwd"
  const activeTabCwd = useTabsStore((s) => {
    if (!s.activeId) return null;
    const t = s.tabs.find((x) => x.id === s.activeId);
    return t?.cwd ?? null;
  });

  // 左段显示路径：优先 active 编辑器文件；否则 active terminal cwd
  const focusPath = useMemo(
    () => activeFile?.path ?? activeTabCwd ?? "",
    [activeFile, activeTabCwd],
  );

  // 中 / 右段 git / disk 都基于 cwd；优先用 editor 文件的父目录（更贴合用户当前定位），
  // 没有 editor 文件时用 terminal cwd
  const activeCwd = useMemo(() => {
    if (activeFile?.path) {
      const idx = Math.max(
        activeFile.path.lastIndexOf("/"),
        activeFile.path.lastIndexOf("\\"),
      );
      return idx > 0 ? activeFile.path.slice(0, idx) : activeFile.path;
    }
    return activeTabCwd ?? null;
  }, [activeFile, activeTabCwd]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let alive = true;
    onSystemMetrics((e) => {
      if (alive) setM(e);
    })
      .then((u) => {
        if (alive) {
          unlisten = u;
        } else {
          u();
        }
      })
      .catch(() => {
        // 静默：mock 环境 / 启动早期 listen 失败不应破坏 UI
      });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  if (!enabled) return null;

  /**
   * 点击行列号段 → 弹"跳转到行号"输入框。
   * T5d 范围内仅做 stub：window.prompt 拿数字 + console.log，
   * 真正 CodeMirror EditorView.dispatch(selectLine) 接入留给后续 task。
   */
  const onClickGoto = () => {
    if (!activeFile) return;
    const input = window.prompt(t("statusBar.gotoLinePrompt"));
    if (!input) return;
    const line = Number.parseInt(input, 10);
    if (!Number.isFinite(line) || line <= 0) return;
    console.log(
      `[StatusBar] goto line stub: file=${activeFile.path} line=${line}`,
    );
  };

  return (
    <footer
      className="flex h-6 flex-shrink-0 items-center gap-4 border-t border-[var(--c-border)] bg-[var(--c-bg-elev-1)] px-3 text-[11px] tabular-nums text-[var(--c-text-dim)]"
      aria-label={t("statusBar.ariaLabel")}
      data-testid="status-bar"
    >
      {/* === 左段：升级提示 + 文件路径复制 === */}
      <div className="flex min-w-0 items-center gap-2">
        <UpdateBadge />
        {focusPath && <FilePathDisplay path={focusPath} />}
      </div>

      {/* === 中段：git 分支 === */}
      {activeCwd && (
        <div className="flex items-center">
          <GitBranchDisplay cwd={activeCwd} />
        </div>
      )}

      {/* === 右段：编辑器 / 网络 / 磁盘 / 进程 metrics === */}
      <div className="ml-auto flex items-center gap-3">
        {showEditorInfo && activeFile && (
          <span
            data-testid="status-bar-editor-info"
            className="flex items-center gap-2 text-[var(--c-text-muted)]"
          >
            <button
              type="button"
              onClick={onClickGoto}
              className="cursor-pointer tabular-nums hover:text-[var(--c-text-base)] focus:outline-none"
              title={t("statusBar.gotoLineTitle")}
              data-testid="status-bar-goto-line"
            >
              Ln {activeFile.cursorLine}, Col {activeFile.cursorCol}
            </button>
            <span aria-hidden="true" className="text-[var(--c-text-faint)]">
              |
            </span>
            <span>UTF-8</span>
            <span aria-hidden="true" className="text-[var(--c-text-faint)]">
              |
            </span>
            <span data-testid="status-bar-language">
              {languageLabel(activeFile.language)}
            </span>
            <span aria-hidden="true" className="text-[var(--c-text-faint)]">
              |
            </span>
            <span>LF</span>
          </span>
        )}
        <NetworkStatus />
        {activeCwd && <DiskUsageDisplay cwd={activeCwd} />}
        {m === null ? (
          <span aria-label={t("statusBar.loadingPlaceholderAria")}>—</span>
        ) : (
          <>
            <span title={t("statusBar.rssTitle")}>
              RSS <span className="text-[var(--c-text-base)]">{m.rss_mb}</span> MB
            </span>
            <span title={t("statusBar.cpuTitle")}>
              CPU{" "}
              <span
                className={
                  m.cpu_pct > 50 ? "text-[var(--c-warn)]" : "text-[var(--c-text-base)]"
                }
              >
                {m.cpu_pct.toFixed(0)}
              </span>
              %
            </span>
            <span title={t("statusBar.sessionsTitle")}>
              <span className="text-[var(--c-text-base)]">{m.active_sessions}</span> sessions
            </span>
          </>
        )}
      </div>
    </footer>
  );
}

/**
 * 左段：当前焦点资源（编辑器文件路径 / 终端 cwd），点击复制到剪贴板。
 *
 * - 长路径用 dir="rtl" 让尾部（文件名）可见，结合 truncate 截前缀
 * - 复制成功后 100ms 内图标变 emerald 提示反馈
 * - clipboard API 不可用 / reject 时静默（不弹错）
 */
function FilePathDisplay({ path }: { path: string }) {
  const { t } = useTranslation();
  const [justCopied, setJustCopied] = useState(false);

  const onCopy = () => {
    if (!path) return;
    void navigator.clipboard
      ?.writeText(path)
      .then(() => {
        setJustCopied(true);
        // 600ms 闪绿 → 还原（之前 100ms 看不见）
        window.setTimeout(() => setJustCopied(false), 600);
      })
      .catch(() => {
        // 静默：unsecure context / 用户拒权时不弹错
      });
  };

  // v0.9.1 HR4-5：path 末尾去除多余 `/`，避免 RTL 渲染拼出"... pnpm-lock.yaml /" 假象
  const cleaned = path.replace(/[/\\]+$/, "");
  // 拆 parent dir + basename：只截 parent，保 basename 全显
  const lastSep = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
  const parent = lastSep > 0 ? cleaned.slice(0, lastSep + 1) : "";
  const basename = lastSep >= 0 ? cleaned.slice(lastSep + 1) : cleaned;

  return (
    <button
      type="button"
      onClick={onCopy}
      className="flex max-w-[360px] min-w-0 items-center gap-1 text-[var(--c-text-muted)] hover:text-[var(--c-text-base)] focus:outline-none"
      title={t("statusBar.copyPathTitle", { path: cleaned })}
      data-testid="status-bar-file-path"
    >
      {parent && (
        <span className="truncate text-[var(--c-text-dim)]">{parent}</span>
      )}
      <span className="flex-shrink-0">{basename}</span>
      <Copy
        size={11}
        className={`flex-shrink-0 transition-colors ${
          justCopied
            ? "text-[var(--c-success)]"
            : "text-[var(--c-text-faint)]"
        }`}
      />
    </button>
  );
}

/**
 * 中段：当前 cwd 的 git 分支。
 *
 * - 1.5s 轮询；非 git repo 时（IPC 返 null）整段隐藏
 * - cwd 变化立刻刷一次，不等下个 tick
 * - IPC 失败也隐藏（不弹错，保持安静）
 */
function GitBranchDisplay({ cwd }: { cwd: string }) {
  const { t } = useTranslation();
  const [branch, setBranch] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setBranch(null);

    const refresh = () => {
      gitCurrentBranch(cwd)
        .then((b) => {
          if (alive) setBranch(b);
        })
        .catch(() => {
          if (alive) setBranch(null);
        });
    };
    refresh();
    const id = window.setInterval(refresh, 1500);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [cwd]);

  if (!branch) return null;

  return (
    <span
      className="flex items-center gap-1 text-[var(--c-text-muted)]"
      title={t("statusBar.gitBranchTitle", { name: branch })}
      data-testid="status-bar-git-branch"
    >
      <GitBranch size={11} className="flex-shrink-0" />
      {/* v0.10.1：max-w 从 160px 拉到 320px。维护者 真机长分支名（feat/v0.10.x-...）被截断。
       *  hover tooltip 仍显示完整名兜底。 */}
      <span className="max-w-[320px] truncate">{branch}</span>
    </span>
  );
}

/**
 * 右段：网络在线状态。
 *
 * - navigator.onLine + window online/offline 事件
 * - 离线时图标变 rose（错误色），title 提示
 */
function NetworkStatus() {
  const { t } = useTranslation();
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  return (
    <span
      className={`flex items-center ${
        online ? "text-[var(--c-text-muted)]" : "text-[var(--c-error)]"
      }`}
      title={online ? t("statusBar.networkOnline") : t("statusBar.networkOffline")}
      data-testid="status-bar-network"
      data-online={online ? "true" : "false"}
    >
      {online ? <Wifi size={11} /> : <WifiOff size={11} />}
    </span>
  );
}

/**
 * 右段：磁盘使用率。
 *
 * - 10s 轮询；首次失败 / cwd 变化失败时隐藏整段
 * - 显示形式：`<HardDrive icon> 32%`（hover title 显示剩余 GB）
 * - used_pct ≥ 90% 用 warn（amber）色提醒
 */
function DiskUsageDisplay({ cwd }: { cwd: string }) {
  const { t } = useTranslation();
  const [usage, setUsage] = useState<DiskUsage | null>(null);

  useEffect(() => {
    let alive = true;
    setUsage(null);

    const refresh = () => {
      fsDiskUsage(cwd)
        .then((u) => {
          if (alive) setUsage(u);
        })
        .catch(() => {
          if (alive) setUsage(null);
        });
    };
    refresh();
    const id = window.setInterval(refresh, 10_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [cwd]);

  if (!usage) return null;

  const pct = Math.round(usage.used_pct);
  const freeGb = (usage.free_bytes / (1024 ** 3)).toFixed(1);
  const totalGb = (usage.total_bytes / (1024 ** 3)).toFixed(1);
  const warn = pct >= 90;

  return (
    <span
      className={`flex items-center gap-1 ${
        warn ? "text-[var(--c-warn)]" : "text-[var(--c-text-muted)]"
      }`}
      title={t("statusBar.diskUsageTitle", {
        pct,
        free: freeGb,
        total: totalGb,
      })}
      data-testid="status-bar-disk"
    >
      <HardDrive size={11} className="flex-shrink-0" />
      <span className="tabular-nums">{pct}%</span>
    </span>
  );
}
