import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockIsPermissionGranted = vi.fn();
const mockRequestPermission = vi.fn();
const mockSendNotification = vi.fn();

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: () => mockIsPermissionGranted(),
  requestPermission: () => mockRequestPermission(),
  sendNotification: (opts: unknown) => mockSendNotification(opts),
}));

import type { NotificationEvent } from "../../stores/notifications";
import { useSettingsStore } from "../../stores/settings";
import {
  _resetPermissionStateForTest,
  ensureNotificationPermission,
  sendSystemNotification,
} from "../systemNotification";

const baseEvent = (
  overrides: Partial<NotificationEvent> = {},
): NotificationEvent => ({
  session_id: "s1",
  level: "done",
  message: "hello",
  source: "ai_tool_loop",
  timestamp_ms: 1_000,
  ...overrides,
});

describe("systemNotification", () => {
  beforeEach(() => {
    _resetPermissionStateForTest();
    mockIsPermissionGranted.mockReset();
    mockRequestPermission.mockReset();
    mockSendNotification.mockReset();
    // 默认 settings 声音开
    useSettingsStore.setState((s) => ({
      ...s,
      settings: {
        ...s.settings,
        notifications: { sound: true },
      },
    }));
  });

  afterEach(() => {
    _resetPermissionStateForTest();
  });

  describe("ensureNotificationPermission", () => {
    it("已授权 → 不再调 requestPermission", async () => {
      mockIsPermissionGranted.mockResolvedValueOnce(true);
      await ensureNotificationPermission();
      expect(mockRequestPermission).not.toHaveBeenCalled();
    });

    it("未授权 → 调 requestPermission 一次", async () => {
      mockIsPermissionGranted.mockResolvedValueOnce(false);
      mockRequestPermission.mockResolvedValueOnce("granted");
      await ensureNotificationPermission();
      expect(mockRequestPermission).toHaveBeenCalledTimes(1);
    });

    it("idempotent — 多次调只触发一次申请（plan §7 决策 #4 不打扰）", async () => {
      mockIsPermissionGranted.mockResolvedValueOnce(false);
      mockRequestPermission.mockResolvedValueOnce("denied");
      await ensureNotificationPermission();
      await ensureNotificationPermission();
      await ensureNotificationPermission();
      expect(mockIsPermissionGranted).toHaveBeenCalledTimes(1);
      expect(mockRequestPermission).toHaveBeenCalledTimes(1);
    });

    it("plugin 抛错 → 静默降级（不影响主功能）", async () => {
      mockIsPermissionGranted.mockRejectedValueOnce(new Error("plugin fail"));
      await expect(ensureNotificationPermission()).resolves.not.toThrow();
    });
  });

  describe("sendSystemNotification", () => {
    it("权限未授予 → 不调 sendNotification（noop 降级）", async () => {
      // 没调 ensureNotificationPermission，permissionGranted 仍 false
      await sendSystemNotification(baseEvent());
      expect(mockSendNotification).not.toHaveBeenCalled();
    });

    it("权限授予 + 声音开 → 不传 silent", async () => {
      mockIsPermissionGranted.mockResolvedValueOnce(true);
      await ensureNotificationPermission();
      await sendSystemNotification(baseEvent({ level: "waiting" }));
      expect(mockSendNotification).toHaveBeenCalledTimes(1);
      const call = mockSendNotification.mock.calls[0][0];
      expect(call.silent).toBeUndefined();
      expect(call.title).toBe("aitm — 等待审批");
    });

    it("权限授予 + 声音关 → 传 silent: true", async () => {
      mockIsPermissionGranted.mockResolvedValueOnce(true);
      await ensureNotificationPermission();
      useSettingsStore.setState((s) => ({
        ...s,
        settings: { ...s.settings, notifications: { sound: false } },
      }));
      await sendSystemNotification(baseEvent({ level: "error" }));
      const call = mockSendNotification.mock.calls[0][0];
      expect(call.silent).toBe(true);
      expect(call.title).toBe("aitm — 出错");
    });

    it("event.message 优先 body", async () => {
      mockIsPermissionGranted.mockResolvedValueOnce(true);
      await ensureNotificationPermission();
      await sendSystemNotification(baseEvent({ message: "my custom" }));
      expect(mockSendNotification.mock.calls[0][0].body).toBe("my custom");
    });

    it("event.message 空 → fallback 到 level default body", async () => {
      mockIsPermissionGranted.mockResolvedValueOnce(true);
      await ensureNotificationPermission();
      await sendSystemNotification(baseEvent({ message: "", level: "waiting" }));
      expect(mockSendNotification.mock.calls[0][0].body).toBe("AI 等待你的审批");
    });

    it("sendNotification 抛错 → 静默不抛", async () => {
      mockIsPermissionGranted.mockResolvedValueOnce(true);
      await ensureNotificationPermission();
      mockSendNotification.mockRejectedValueOnce(new Error("send fail"));
      await expect(sendSystemNotification(baseEvent())).resolves.not.toThrow();
    });
  });
});
