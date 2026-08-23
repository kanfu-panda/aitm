import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  appVersion,
  diagnosticsInfo,
  diagnosticsLogTail,
  shellOpen,
  shellReveal,
  updateCheck,
  type DiagnosticsInfo,
  type UpdateCheckResult,
} from "../../lib/tauri";
import { buildDiagnosticsText, buildIssueUrl } from "../../lib/diagnostics";
import { checkForUpdate, type PendingUpdate } from "../../lib/updater";

/** 项目主页（开源仓）。 */
const REPO_URL = "https://github.com/kanfu-panda/aitm";

/**
 * 检查/安装状态机。
 *
 * - `idle` 本次打开面板后还没点过检查
 * - `checking` 正在问服务器
 * - `upToDate` 已是最新
 * - `updatable` 有新版本，可**应用内**下载安装
 * - `manual` 有新版本，但装不了（无更新包 / 平台不支持）→ 给下载链接
 * - `installing` 正在下载安装，装完自动重启
 * - `failed` 检查或安装失败，把原因显示出来
 */
type Phase =
  | "idle"
  | "checking"
  | "upToDate"
  | "updatable"
  | "manual"
  | "installing"
  | "failed";

/**
 * SettingsModal 内的"关于"页。
 *
 * 三件事：
 * 1. 无网络也能立刻看到当前版本（`app_version` IPC，不等 GitHub）
 * 2. **手动**检查更新 —— 启动徽标只查一次且失败静默，用户主动问就要给明确答复
 * 3. 有更新时**应用内**下载安装并重启（tauri-plugin-updater）
 *
 * 为什么保留"手动下载"兜底：更新器要 release 里有 `latest.json` + 签名产物，
 * 老版本的 release 没有，Linux 也没有任何产物。这些情况下 plugin 的 check()
 * 会抛错，此时退回 GitHub Releases API，至少把下载链接给到用户。
 */
export default function AboutSection() {
  const { t } = useTranslation();
  const [version, setVersion] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  /** 应用内可装的更新（updatable / installing 时非空） */
  const [pending, setPending] = useState<PendingUpdate | null>(null);
  /** 手动下载兜底信息（manual 时非空） */
  const [fallback, setFallback] = useState<UpdateCheckResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  /** 0..1 下载进度；null = 服务端没给总长度，显示不确定进度 */
  const [progress, setProgress] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    appVersion()
      .then((v) => {
        if (alive) setVersion(v);
      })
      .catch(() => {
        // 拿不到版本号不该让整页空白；下面用 "—" 占位
        if (alive) setVersion(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  const handleCheck = useCallback(async () => {
    setPhase("checking");
    setFailure(null);
    setPending(null);
    setFallback(null);

    try {
      const update = await checkForUpdate();
      if (update) {
        setPending(update);
        setPhase("updatable");
      } else {
        setPhase("upToDate");
      }
      return;
    } catch (e) {
      // 更新服务器不可用（老 release 没有 latest.json / 平台无产物）→ 退手动
      console.warn("应用内更新检查失败，回退手动下载", e);
    }

    try {
      const r = await updateCheck();
      if (r.error) {
        setFailure(r.error);
        setPhase("failed");
      } else if (r.available) {
        setFallback(r);
        setPhase("manual");
      } else {
        setPhase("upToDate");
      }
    } catch (e) {
      setFailure(String(e));
      setPhase("failed");
    }
  }, []);

  const handleInstall = useCallback(async () => {
    if (!pending) return;
    setPhase("installing");
    setProgress(0);
    try {
      // 成功路径不会返回——install 末尾会重启应用
      await pending.install((ratio) => setProgress(ratio));
    } catch (e) {
      setFailure(String(e));
      setPhase("failed");
    }
  }, [pending]);

  // 必须走 shell_open IPC：Tauri webview 里 window.open 不会打开系统浏览器
  // （同 MarkdownLink 的处理）
  const openUrl = (url: string) => void shellOpen(url);

  const busy = phase === "checking" || phase === "installing";

  return (
    <div className="space-y-4">
      <section>
        <h3 className="text-sm font-medium text-[var(--c-text-base)]">aitm</h3>
        <p className="mt-1 text-[13px] text-[var(--c-text-muted)]">
          {t("about.version", { version: version ?? "—" })}
        </p>
      </section>

      <section className="space-y-2">
        <button
          type="button"
          onClick={handleCheck}
          disabled={busy}
          data-testid="about-check-update"
          className="rounded border border-[var(--c-border)] bg-[var(--c-bg-elev-2)] px-3 py-1.5 text-[13px] text-[var(--c-text-base)] hover:border-[var(--c-success)] hover:text-[var(--c-success-fg)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {phase === "checking" ? t("about.checking") : t("about.checkUpdate")}
        </button>

        {phase === "upToDate" && (
          <p className="text-[13px] text-[var(--c-text-muted)]" data-testid="about-up-to-date">
            {t("about.upToDate")}
          </p>
        )}

        {phase === "updatable" && pending && (
          <div className="space-y-2" data-testid="about-update-available">
            <p className="text-[13px] text-[var(--c-success-fg)]">
              {t("about.newVersion", { version: pending.version })}
            </p>
            <button
              type="button"
              onClick={handleInstall}
              data-testid="about-install"
              className="rounded border border-[var(--c-success)] px-3 py-1.5 text-[13px] text-[var(--c-success-fg)] hover:bg-[var(--c-bg-elev-2)]"
            >
              {t("about.installNow")}
            </button>
            <p className="text-[11px] text-[var(--c-text-muted)]">{t("about.installHint")}</p>
            {pending.notes && <ReleaseNotes notes={pending.notes} label={t("about.releaseNotes")} />}
          </div>
        )}

        {phase === "installing" && (
          <div className="space-y-1" data-testid="about-installing">
            <p className="text-[13px] text-[var(--c-text-base)]">
              {progress === null
                ? t("about.downloading")
                : t("about.downloadingPercent", { percent: Math.round(progress * 100) })}
            </p>
            <div className="h-1 w-full overflow-hidden rounded bg-[var(--c-bg-elev-2)]">
              <div
                className="h-full bg-[var(--c-success)] transition-[width]"
                style={{ width: `${Math.round((progress ?? 0) * 100)}%` }}
              />
            </div>
          </div>
        )}

        {phase === "manual" && fallback && (
          <div className="space-y-2" data-testid="about-update-manual">
            <p className="text-[13px] text-[var(--c-success-fg)]">
              {t("about.newVersion", { version: fallback.latest_version })}
            </p>
            {fallback.release_url && (
              <button
                type="button"
                onClick={() => openUrl(fallback.release_url as string)}
                className="rounded border border-[var(--c-success)] px-3 py-1.5 text-[13px] text-[var(--c-success-fg)] hover:bg-[var(--c-bg-elev-2)]"
              >
                {t("about.download")}
              </button>
            )}
            {fallback.release_notes && (
              <ReleaseNotes notes={fallback.release_notes} label={t("about.releaseNotes")} />
            )}
          </div>
        )}

        {phase === "failed" && (
          <p className="text-[13px] text-[var(--c-error)]" data-testid="about-check-failed">
            {t("about.checkFailed", { error: failure ?? "" })}
          </p>
        )}
      </section>

      <TroubleshootingSection />

      <section>
        <button
          type="button"
          onClick={() => openUrl(REPO_URL)}
          className="text-[12px] text-[var(--c-success-fg)] underline-offset-2 hover:underline"
        >
          {t("about.repo")}
        </button>
      </section>
    </div>
  );
}

/**
 * 故障排查：出问题时用户能自己做的三件事。
 *
 * 之前用户遇到崩溃 / 异常，能做的只有截图描述——日志在哪没人知道，版本号
 * 要翻设置，报 issue 还得手打环境信息。这三个按钮把这条路铺平：
 *
 * 1. **打开日志目录** —— 直接进 Finder / 资源管理器，捞文件不用查路径
 * 2. **复制诊断信息** —— 版本 / 平台 / 目录一次性到剪贴板
 * 3. **报告问题** —— 开 GitHub issue 且诊断信息已预填进正文
 *
 * 诊断文本同时明文展示在下面：剪贴板在 webview 里权限时灵时不灵，复制失败
 * 时用户至少还能自己选中复制。
 */
function TroubleshootingSection() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<DiagnosticsInfo | null>(null);
  /** 复制结果提示；null = 还没点过 */
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);
  const [openFailure, setOpenFailure] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    diagnosticsInfo()
      .then((d) => {
        if (alive) setInfo(d);
      })
      .catch((e) => {
        // 拿不到诊断信息不该让整页报错；按钮会保持 disabled
        console.warn("诊断信息获取失败", e);
      });
    return () => {
      alive = false;
    };
  }, []);

  const text = info ? buildDiagnosticsText(info, navigator.userAgent) : "";

  const handleOpenLogDir = useCallback(async () => {
    const target = info?.log_file ?? info?.log_dir;
    if (!target) return;
    setOpenFailure(null);
    try {
      // 必须 reveal（`open -R`）不能 open：日志目录叫 `com.aitm.app`，目录名
      // 以 `.app` 结尾，macOS `open` 会当成应用程序包去启动然后失败——而
      // shell_open 不等退出码，失败会被整个吞掉（点了没反应也没报错）。
      await shellReveal(target);
    } catch (e) {
      setOpenFailure(String(e));
    }
  }, [info]);

  const handleReportIssue = useCallback(async () => {
    // 日志按需读：只有环境信息的 issue 对排查几乎没用，真正有用的是报错现场。
    // 读不到日志也照常开 issue，不因为捞不到日志就把这条路堵死。
    let tail: string | null = null;
    try {
      tail = await diagnosticsLogTail();
    } catch (e) {
      console.warn("读日志尾部失败，issue 正文只带环境信息", e);
    }
    await shellOpen(buildIssueUrl(text, tail));
  }, [text]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied("ok");
    } catch {
      setCopied("failed");
    }
  }, [text]);

  const btn =
    "rounded border border-[var(--c-border)] bg-[var(--c-bg-elev-2)] px-3 py-1.5 text-[13px] text-[var(--c-text-base)] hover:border-[var(--c-success)] hover:text-[var(--c-success-fg)] disabled:cursor-not-allowed disabled:opacity-60";

  return (
    <section className="space-y-2" data-testid="about-troubleshooting">
      <h4 className="text-[13px] font-medium text-[var(--c-text-base)]">
        {t("about.troubleshooting")}
      </h4>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void handleOpenLogDir()}
          disabled={!info?.log_file && !info?.log_dir}
          data-testid="about-open-log-dir"
          className={btn}
        >
          {t("about.openLogDir")}
        </button>
        <button
          type="button"
          onClick={() => void handleCopy()}
          disabled={!info}
          data-testid="about-copy-diagnostics"
          className={btn}
        >
          {t("about.copyDiagnostics")}
        </button>
        <button
          type="button"
          onClick={() => void handleReportIssue()}
          disabled={!info}
          data-testid="about-report-issue"
          className={btn}
        >
          {t("about.reportIssue")}
        </button>
      </div>

      <p className="text-[11px] text-[var(--c-text-dim)]">
        {t("about.reportIssueHint")}
      </p>

      {copied === "ok" && (
        <p className="text-[12px] text-[var(--c-success-fg)]" data-testid="about-copied">
          {t("about.copied")}
        </p>
      )}
      {copied === "failed" && (
        <p className="text-[12px] text-[var(--c-warn)]" data-testid="about-copy-failed">
          {t("about.copyFailed")}
        </p>
      )}
      {openFailure && (
        <p className="text-[12px] text-[var(--c-error)]" data-testid="about-open-log-dir-failed">
          {t("about.openLogDirFailed", { error: openFailure })}
        </p>
      )}

      {info && (
        <details className="rounded border border-[var(--c-border)] bg-[var(--c-bg-base)] p-3">
          <summary className="cursor-pointer text-[12px] text-[var(--c-text-muted)]">
            {t("about.diagnostics")}
          </summary>
          <pre
            className="mt-2 select-text whitespace-pre-wrap break-words text-[11px] leading-relaxed text-[var(--c-text-muted)]"
            data-testid="about-diagnostics-text"
          >
            {text}
          </pre>
        </details>
      )}
    </section>
  );
}

/** 折叠的更新说明。应用内更新与手动下载两条路都用它。 */
function ReleaseNotes({ notes, label }: { notes: string; label: string }) {
  return (
    <details className="rounded border border-[var(--c-border)] bg-[var(--c-bg-base)] p-3">
      <summary className="cursor-pointer text-[12px] text-[var(--c-text-muted)]">{label}</summary>
      <pre className="mt-2 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-[var(--c-text-muted)]">
        {notes}
      </pre>
    </details>
  );
}
