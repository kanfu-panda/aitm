import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { ScopeDto } from "../../lib/tauri";

/**
 * 作用域徽章。
 *
 * 用途：
 * - ConversationSwitcher trigger 标题前 / dropdown 头部
 * - （未来）TabBar 每个 tab 标题前
 *
 * 设计（spec §7.5 / plan §7.5）：
 * - Project → --c-success 圆点 + 项目名（root_path basename，截断 12 字符）
 * - Global → --c-text-dim 圆点 + "全局"
 * - NeedsInit → --c-warn 圆点，文案 "未决议"（启动间隙的占位）
 * - null → 不渲染
 *
 * 三层 fallback 文案放 title 属性给 hover tooltip：完整 root_path / 完整 cwd /
 * "全局桶（无项目）"。
 */
export interface ScopeBadgeProps {
  scope: ScopeDto | null;
  /** 仅显圆点不显文字（TabBar 用）。 */
  compact?: boolean;
  /** 文字截断长度，默认 12 字符。 */
  maxNameChars?: number;
  className?: string;
}

export default function ScopeBadge({
  scope,
  compact = false,
  maxNameChars = 12,
  className,
}: ScopeBadgeProps) {
  const { t } = useTranslation();
  if (!scope) return null;

  const view = scopeView(scope, maxNameChars, t);

  const baseCls =
    "inline-flex items-center gap-1 text-[11px] leading-none whitespace-nowrap";
  return (
    <span
      className={baseCls + (className ? " " + className : "")}
      title={view.tooltip}
      aria-label={view.ariaLabel}
      data-scope-kind={scope.kind}
    >
      <span
        className={"h-1.5 w-1.5 rounded-full " + view.dotCls}
        aria-hidden
      />
      {!compact && (
        <span className={view.textCls}>{view.label}</span>
      )}
    </span>
  );
}

interface ScopeView {
  label: string;
  tooltip: string;
  ariaLabel: string;
  dotCls: string;
  textCls: string;
}

function scopeView(
  scope: ScopeDto,
  maxNameChars: number,
  t: TFunction,
): ScopeView {
  if (scope.kind === "project") {
    const name = basename(scope.root_path) || scope.root_path;
    const trimmed = truncate(name, maxNameChars);
    return {
      label: trimmed,
      tooltip: t("scope.projectTooltip", { name, path: scope.root_path }),
      ariaLabel: t("scope.projectAria", { name }),
      dotCls: "bg-[var(--c-success)]",
      textCls: "text-[var(--c-success-fg)]",
    };
  }
  if (scope.kind === "global") {
    return {
      label: t("scope.global"),
      tooltip: t("scope.globalTooltip"),
      ariaLabel: t("scope.globalAria"),
      dotCls: "bg-[var(--c-text-dim)]",
      textCls: "text-[var(--c-text-muted)]",
    };
  }
  // needs_init —— store load 间隙的占位；不长留
  return {
    label: t("scope.needsInit"),
    tooltip: t("scope.needsInitTooltip", { cwd: scope.cwd }),
    ariaLabel: t("scope.needsInitAria"),
    dotCls: "bg-[var(--c-warn)]",
    textCls: "text-[var(--c-warn)]",
  };
}

/** 提取路径最后一段；空 / 末尾 `/` 时回到上一段。 */
function basename(p: string): string {
  if (!p) return "";
  // 去末尾分隔符
  const trimmed = p.replace(/[\\/]+$/u, "");
  if (!trimmed) return p; // 全是分隔符
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

/** 中英混排截断（按字符数，不区分宽度）。 */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(1, max - 1)) + "…";
}
