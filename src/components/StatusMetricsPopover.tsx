import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { SystemMetricsEvent } from "../lib/tauri";

interface Props {
  metrics: SystemMetricsEvent | null;
}

/**
 * 状态栏右下角的资源指示器：平时只占一个很窄的位置，点开才显示明细。
 *
 * 换掉原来常驻的 `RSS xx MB · CPU xx% · N sessions` 三段文字——状态栏右侧已经挤了
 * 编辑器信息、网络、磁盘，再摊开三段资源数据会把它变成一条噪音带。折叠成一个
 * 带会话数的小触发器，需要时再点开。
 *
 * **不用 Radix**：项目里装的是 DropdownMenu，语义上要求内容是 menuitem，拿来放
 * 只读面板 a11y 是错的；而单独为此引入 Popover 违反依赖最小化。这个面板只需要
 * "点外面关掉 + Esc 关掉 + 定位在触发器上方"，手写反而更小更可控。
 */
export default function StatusMetricsPopover({ metrics }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 点击面板外部 / 按 Esc 关闭。挂在 document 上而不是给遮罩层——
  // 状态栏浮层加全屏遮罩会挡住终端点击，代价太大。
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
    return (
      <span aria-label={t("statusBar.loadingPlaceholderAria")}>—</span>
    );
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
        className="flex items-center gap-1 rounded px-1 tabular-nums hover:bg-[var(--c-bg-elev-2)] hover:text-[var(--c-text-base)]"
      >
        <span
          aria-hidden
          className={busy ? "text-[var(--c-warn)]" : "text-[var(--c-success-fg)]"}
        >
          ●
        </span>
        <span className="text-[var(--c-text-base)]">{metrics.active_sessions}</span>
      </button>

      {open && (
        <div
          role="group"
          aria-label={t("metricsPopover.title")}
          data-testid="status-metrics-panel"
          // 定位在触发器**上方**：状态栏贴着窗口底边，向下弹会被裁掉。
          // right-0 让面板右缘与触发器对齐，避免越出窗口右边界。
          className="absolute bottom-full right-0 z-50 mb-1 w-[168px] rounded border border-[var(--c-border-strong)] bg-[var(--c-bg-elev-1)] p-2 text-[11px] shadow-lg"
        >
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
