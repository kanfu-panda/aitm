import { useTranslation } from "react-i18next";

import type { NotificationLevel } from "../stores/notifications";

/**
 * v0.5.0-A Tab 状态环：4 色对应 NotificationLevel（plan §1.2）。
 *
 * 颜色语义（沿用 v0.4.1 设计系统 zinc + emerald/amber/sky/rose 调色）：
 * - emerald (done)：AI / 命令完成
 * - amber (waiting)：AI 等审批 / 警告 — **pulse 动画**强调"需要你"
 * - sky (running)：AI streaming / 命令运行中
 * - rose (error)：AI 工具失败 / 命令出错
 *
 * 跟 v0.2.0 已有的 unread 圆点（emerald 表"有 PTY 输出"）并存，互不冲突。
 */

const LEVEL_TO_CLASS: Record<NotificationLevel, string> = {
  running: "bg-[var(--c-info)]",
  done: "bg-[var(--c-success)]",
  waiting: "bg-[var(--c-warn)] animate-pulse",
  error: "bg-[var(--c-error)]",
};

interface Props {
  level: NotificationLevel;
}

export default function StatusRing({ level }: Props) {
  const { t } = useTranslation();
  const title = t(`notify.level.${level}`);
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${LEVEL_TO_CLASS[level]}`}
      role="status"
      aria-label={t("tabs.notification", { level: title })}
      title={title}
      data-testid={`tab-status-${level}`}
    />
  );
}
