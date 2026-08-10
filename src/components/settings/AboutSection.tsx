import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { appVersion, shellOpen, updateCheck, type UpdateCheckResult } from "../../lib/tauri";
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
