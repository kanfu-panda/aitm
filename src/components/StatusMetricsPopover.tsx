import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { SystemMetricsEvent } from "../lib/tauri";
import { useBrowserModalGuard } from "../lib/useBrowserModalGuard";

interface Props {
  metrics: SystemMetricsEvent | null;
}

/**
 * 状态栏右下角的资源显示：常驻摘要 + 点击展开明细。
 *
 * ## 两次返工的教训
 *
 * **第一版把常驻的 `RSS xx MB · CPU xx% · N sessions` 换成了一个光秃秃的 `● 1`。**
 * 那是理解错了需求——要的是"加一个可点开的明细面板"，不是"把已有信息藏起来"。
 * 一个不带标签的圆点谁也看不懂，比原来差。所以摘要按原样保留，只是整体变成可点击。
 *
 * **第一版的面板还点不开**：浏览器面板的 native WKWebView 在 OS 合成层之上，
 * **CSS z-index 对它无效**；而这个面板是向上弹的，正好落进 webview 覆盖的区域——
 * 它其实渲染出来了，只是被原生层盖住。项目里早有 [`useBrowserModalGuard`] 处理
 * 这件事（每个 Radix Dialog 都在用），这里照用。
 */
export default function StatusMetricsPopover({ metrics }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 面板展开时让浏览器 webview 让位，否则会被原生层盖住（见上方注释）
  useBrowserModalGuard(open);

  // 点击面板外部 / 按 Esc 关闭。挂 document 而不是加全屏遮罩——
  // 状态栏的小浮层加遮罩会挡住终端点击，代价太大。
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as HTMLElement)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!metrics) {
    return <span aria-label={t("statusBar.loadingPlaceholderAria")}>—</span>;
  }

  const busy = metrics.cpu_pct > 50;

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={t("metricsPopover.triggerAria")}
        title={t("metricsPopover.triggerAria")}
        data-testid="status-metrics-trigger"
        className="flex items-center gap-3 rounded px-1 tabular-nums hover:bg-[var(--c-bg-elev-2)]"
      >
        {/* 摘要维持改版前的样子——用户认得这三段，不该为了"折叠"把它们藏掉 */}
        <span title={t("statusBar.rssTitle")}>
          RSS <span className="text-[var(--c-text-base)]">{metrics.rss_mb}</span> MB
        </span>
        <span title={t("statusBar.cpuTitle")}>
          CPU{" "}
          <span
            className={busy ? "text-[var(--c-warn)]" : "text-[var(--c-text-base)]"}
          >
            {metrics.cpu_pct.toFixed(0)}
          </span>
          %
        </span>
        <span title={t("statusBar.sessionsTitle")}>
          <span className="text-[var(--c-text-base)]">{metrics.active_sessions}</span>{" "}
          sessions
        </span>
      </button>

      {open && (
        <div
          role="group"
          aria-label={t("metricsPopover.title")}
          data-testid="status-metrics-panel"
          // 向**上**弹：状态栏贴着窗口底边，向下会被裁掉。
          // right-0 让右缘与触发器对齐，避免越出窗口右边界。
          className="absolute bottom-full right-0 z-50 mb-1 w-[196px] rounded border border-[var(--c-border-strong)] bg-[var(--c-bg-elev-1)] p-2 text-[11px] shadow-lg"
        >
          <p className="mb-1 font-medium text-[var(--c-text-base)]">
            {t("metricsPopover.title")}
          </p>
          <Row
            label={t("metricsPopover.sessions")}
            value={String(metrics.active_sessions)}
          />
          <Row
            label={t("metricsPopover.cpu")}
            value={`${metrics.cpu_pct.toFixed(0)}%`}
            warn={busy}
          />
          <Row label={t("metricsPopover.memory")} value={`${metrics.rss_mb} MB`} />
          <p className="mt-1.5 border-t border-[var(--c-border)] pt-1.5 text-[10px] leading-snug text-[var(--c-text-dim)]">
            {t("metricsPopover.rssNote")}
          </p>
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  warn,
}: {
  label: string;
  value: string;
  warn?: boolean;
}) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-[var(--c-text-muted)]">{label}</span>
      <span
        className={`tabular-nums ${warn ? "text-[var(--c-warn)]" : "text-[var(--c-text-base)]"}`}
      >
        {value}
      </span>
    </div>
  );
}
