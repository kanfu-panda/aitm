import { useState } from "react";
import type { ComponentType } from "react";
import type { LucideProps } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  ChevronDown,
  FileText,
  Folder,
  Globe,
  History,
  Loader2,
  Terminal,
  Wrench,
  X,
} from "./icons";
import type { ToolCallEntry } from "../stores/chat";

interface Props {
  entry: ToolCallEntry;
  /** 默认折叠（VS Code Copilot Chat 风格）；测试或外部需要可强制展开。 */
  defaultExpanded?: boolean;
}

type LucideIcon = ComponentType<LucideProps>;

/**
 * 工具调用状态 → i18n key 映射；运行时通过 useTranslation 渲染。
 * v0.10.5 i18n：原本是顶层 const，迁移到 hook 内动态读 t()。
 */
const STATUS_I18N_KEY: Record<ToolCallEntry["status"], string> = {
  awaiting_approval: "toolCallBubble.status.awaitingApproval",
  running: "toolCallBubble.status.running",
  done: "toolCallBubble.status.done",
  error: "toolCallBubble.status.error",
  rejected: "toolCallBubble.status.rejected",
};

const STATUS_COLOR: Record<ToolCallEntry["status"], string> = {
  awaiting_approval: "text-[var(--c-warn)]",
  running: "text-[var(--c-info)]",
  done: "text-[var(--c-success)]",
  error: "text-[var(--c-error)]",
  rejected: "text-[var(--c-text-dim)]",
};

/**
 * 工具名 → Lucide 图标
 *
 * 规则：
 * - browser_*  → Globe
 * - read_file  → FileText
 * - list_files → Folder
 * - run_command → Terminal
 * - 名字包含 "history" → History（如 terminal_history）
 * - 兜底 → Wrench（扳手）
 */
export function inferToolIcon(name: string): LucideIcon {
  if (name.startsWith("browser_")) return Globe;
  if (name === "read_file") return FileText;
  if (name === "list_files") return Folder;
  if (name === "run_command") return Terminal;
  if (name.includes("history")) return History;
  return Wrench;
}

/**
 * 参数预览：取首参数 key=value，超过 40 字符 truncate。
 *
 * 接受两种输入：
 * 1. 已序列化的 JSON 字符串（ToolCallEntry.args_preview 当前实现）
 * 2. 原生 Record<string, unknown>（向后兼容 plan 中的 ToolCall 接口）
 * 3. 任意非 JSON 字符串（直接 truncate 当作"摘要"）
 */
export function formatArgsPreview(
  args: Record<string, unknown> | string | undefined | null,
): string {
  if (args == null) return "";

  // 字符串入参：先试 JSON.parse，失败则直接当摘要 truncate
  let record: Record<string, unknown> | null = null;
  if (typeof args === "string") {
    const trimmed = args.trim();
    if (!trimmed) return "";
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        record = parsed as Record<string, unknown>;
      } else {
        return truncate(trimmed, 40);
      }
    } catch {
      return truncate(trimmed, 40);
    }
  } else {
    record = args;
  }

  const keys = Object.keys(record);
  if (keys.length === 0) return "";
  const firstKey = keys[0];
  const firstVal = record[firstKey];
  const valueStr =
    typeof firstVal === "string" ? firstVal : JSON.stringify(firstVal);
  if (valueStr === undefined) return firstKey;
  if (valueStr.length > 40) {
    return `${firstKey}="${valueStr.slice(0, 40)}..."`;
  }
  return `${firstKey}=${valueStr}`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}...`;
}

/** 状态 icon（小尺寸，inline 显示在右侧）。 */
function StatusIcon({ status }: { status: ToolCallEntry["status"] }) {
  const { t } = useTranslation();
  const label = t(STATUS_I18N_KEY[status]);
  const color = STATUS_COLOR[status];
  switch (status) {
    case "awaiting_approval":
      return (
        <AlertTriangle
          size={12}
          aria-label={label}
          className={`${color} shrink-0`}
        />
      );
    case "running":
      return (
        <Loader2
          size={12}
          aria-label={label}
          className={`${color} shrink-0 animate-spin`}
        />
      );
    case "done":
      return (
        <Check
          size={12}
          aria-label={label}
          className={`${color} shrink-0`}
        />
      );
    case "error":
      return (
        <AlertCircle
          size={12}
          aria-label={label}
          className={`${color} shrink-0`}
        />
      );
    case "rejected":
      return (
        <X size={12} aria-label={label} className={`${color} shrink-0`} />
      );
  }
}

/**
 * 把 args_preview（一般是 JSON 字符串）pretty print；解析失败原样回显。
 *
 * `noArgsLabel` 由调用方注入（hook 拿到的 t() 结果），保持函数纯净便于复用。
 */
function prettyArgs(raw: string | undefined | null, noArgsLabel: string): string {
  if (raw == null) return noArgsLabel;
  const trimmed = raw.trim();
  if (!trimmed) return noArgsLabel;
  try {
    const parsed = JSON.parse(trimmed);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return trimmed;
  }
}

/**
 * VS Code Copilot Chat 风格的工具调用气泡。
 *
 * - 默认折叠：单行展示 [icon] tool_name args_preview status_icon chevron
 * - 点击 toggle 展开：参数 JSON pretty + 结果（成功 / 失败）
 * - 错误状态自动展开 + 红框，方便用户立刻看错因
 * - 错误状态下用户仍可手动折叠（state 独立维护，shouldExpand = expanded || isError）
 */
export default function ToolCallBubble({ entry, defaultExpanded }: Props) {
  const { t } = useTranslation();
  // 错误状态默认展开（让用户立刻看错因）
  const isError = entry.status === "error";
  const initialExpanded = defaultExpanded ?? isError;
  const [expanded, setExpanded] = useState(initialExpanded);
  // 错误强制展开（即便用户折过，也要展开 — 与 VS Code 一致）
  const shouldExpand = expanded || isError;

  const ToolIcon = inferToolIcon(entry.name);
  const argsPreview = formatArgsPreview(entry.args_preview);
  const statusLabel = t(STATUS_I18N_KEY[entry.status]);
  const statusColor = STATUS_COLOR[entry.status];

  const containerClass = isError
    ? "border-[var(--c-error)] bg-[var(--c-error-bg,rgba(244,63,94,0.06))]"
    : "border-[var(--c-border)] bg-[var(--c-bg-elev-1)]";

  return (
    <div
      className={`my-1 min-w-0 rounded-md border text-xs ${containerClass}`}
      data-testid="tool-call-bubble"
      data-status={entry.status}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={shouldExpand}
        data-testid="tool-call-toggle"
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-[var(--c-bg-elev-2)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--c-focus,#3b82f6)]"
      >
        <ToolIcon
          size={14}
          aria-hidden
          className="shrink-0 text-[var(--c-text-muted)]"
        />
        <code className="font-mono text-[var(--c-text-base)]">
          {entry.name}
        </code>
        {argsPreview && (
          <span
            className="min-w-0 flex-1 truncate font-mono text-[var(--c-text-dim)]"
            title={argsPreview}
          >
            {argsPreview}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <span
            className={`${statusColor} flex items-center gap-1`}
            role="status"
            aria-label={statusLabel}
          >
            <StatusIcon status={entry.status} />
          </span>
          <ChevronDown
            size={12}
            aria-hidden
            className={`text-[var(--c-text-muted)] transition-transform ${
              shouldExpand ? "rotate-180" : ""
            }`}
          />
        </span>
      </button>

      {shouldExpand && (
        <div className="space-y-2 border-t border-[var(--c-border)] p-2 text-xs">
          {entry.auto_approved_reason && (
            <div
              className="inline-flex items-center gap-1 rounded bg-[var(--c-success-bg)] px-2 py-0.5 text-[10px] text-[var(--c-success-fg)]"
              aria-label={t("toolCallBubble.autoApprovedAria")}
              title={entry.auto_approved_reason}
            >
              <span>{t("toolCallBubble.autoApproved")}</span>
              <span className="text-[var(--c-success)] opacity-80">·</span>
              <span className="max-w-[260px] truncate opacity-80">
                {entry.auto_approved_reason}
              </span>
            </div>
          )}

          <div>
            <div className="mb-1 text-[var(--c-text-dim)]">
              {t("toolCallBubble.argsLabel")}
            </div>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-[var(--c-bg-base)] p-2 font-mono text-[11px] text-[var(--c-text-muted)]">
              {prettyArgs(entry.args_preview, t("toolCallBubble.noArgs"))}
            </pre>
          </div>

          {entry.result && (
            <div>
              <div
                className={`mb-1 ${
                  entry.result.is_error
                    ? "text-[var(--c-error)]"
                    : "text-[var(--c-text-dim)]"
                }`}
              >
                {entry.result.is_error
                  ? t("toolCallBubble.errorResultLabel")
                  : t("toolCallBubble.resultLabel")}
              </div>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-[var(--c-bg-base)] p-2 font-mono text-[11px] text-[var(--c-text-muted)]">
                {entry.result.content}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
