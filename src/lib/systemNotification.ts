import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

import type {
  NotificationEvent,
  NotificationLevel,
} from "../stores/notifications";
import { useSettingsStore } from "../stores/settings";

/**
 * v0.5.0-A 系统通知 wrapper。
 *
 * 设计要点（plan §5.4）：
 * - 启动时 `ensureNotificationPermission` 调一次申请权限（用户拒绝后**不重弹**）
 * - `sendSystemNotification` 由 notifications store 的 emitNotification 路径调，
 *   level=running 已在 store 层跳过；这里只处理 waiting/done/error
 * - 声音开关从 settings.notifications.sound 实时读
 * - 权限未授予 → 静默 noop（tab 状态环仍工作，是更稳的通道）
 */

let permissionGranted = false;
let permissionRequested = false;

/**
 * 启动时调一次。idempotent — 多次调只弹一次权限 dialog（plan §7 决策 #4：
 * 启动自动弹一次，不频繁打扰）。
 */
export async function ensureNotificationPermission(): Promise<void> {
  if (permissionRequested) return;
  permissionRequested = true;
  try {
    if (await isPermissionGranted()) {
      permissionGranted = true;
      return;
    }
    const result = await requestPermission();
    permissionGranted = result === "granted";
  } catch {
    // Tauri plugin 初始化失败 / 用户系统拒绝 → 通知降级（tab ring 仍工作）
    permissionGranted = false;
  }
}

/** 单测重置用 */
export function _resetPermissionStateForTest(): void {
  permissionGranted = false;
  permissionRequested = false;
}

const LEVEL_TO_TITLE: Record<NotificationLevel, string> = {
  running: "运行中",
  waiting: "等待审批",
  done: "完成",
  error: "出错",
};

const LEVEL_TO_DEFAULT_BODY: Record<NotificationLevel, string> = {
  running: "AI 正在处理",
  waiting: "AI 等待你的审批",
  done: "AI 完成",
  error: "AI 出错",
};

/**
 * 把 NotificationEvent 转成系统通知。
 *
 * - 权限未授予 → noop
 * - 声音读 settings.notifications.sound（plan §7 决策 #1：默认开）
 * - title 固定 "aitm — {level title}"，body 优先 event.message（OSC 通知带消息），
 *   fallback 到 level default body（AI 工具循环触发时可能 message="" 用 fallback）
 */
export async function sendSystemNotification(
  event: NotificationEvent,
): Promise<void> {
  if (!permissionGranted) return;

  const { sound } = useSettingsStore.getState().settings.notifications;
  const title = `aitm — ${LEVEL_TO_TITLE[event.level]}`;
  const body =
    event.message && event.message.length > 0
      ? event.message
      : LEVEL_TO_DEFAULT_BODY[event.level];

  try {
    await sendNotification({
      title,
      body,
      ...(sound ? {} : { silent: true }),
    });
  } catch {
    // 单条通知失败不致命，静默
  }
}
