import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type NotificationEvent,
  type NotificationLevel,
  priority,
  setSystemNotificationHook,
  useNotificationsStore,
} from "./notifications";

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

describe("useNotificationsStore", () => {
  beforeEach(() => {
    useNotificationsStore.setState({ byTab: {} });
    setSystemNotificationHook(null);
  });

  afterEach(() => {
    setSystemNotificationHook(null);
  });

  describe("setTabState 优先级保护", () => {
    it("初次设置 running → state 写入", () => {
      useNotificationsStore.getState().setTabState("tab-1", "running");
      const s = useNotificationsStore.getState().byTab["tab-1"];
      expect(s.level).toBe("running");
      expect(s.lastMessage).toBeNull();
      expect(s.lastTimestampMs).toBeGreaterThan(0);
    });

    it("waiting 不被后续 done 覆盖（高优先级保护）", () => {
      const { setTabState } = useNotificationsStore.getState();
      setTabState("tab-1", "waiting", "需要审批");
      setTabState("tab-1", "done", "完成了");
      const s = useNotificationsStore.getState().byTab["tab-1"];
      expect(s.level).toBe("waiting");
      // message 仍会更新（用户希望看到最新文案，状态不变）
      expect(s.lastMessage).toBe("完成了");
    });

    it("done 被后续 error 覆盖（升级）", () => {
      const { setTabState } = useNotificationsStore.getState();
      setTabState("tab-1", "done", "ok");
      setTabState("tab-1", "error", "崩了");
      const s = useNotificationsStore.getState().byTab["tab-1"];
      expect(s.level).toBe("error");
      expect(s.lastMessage).toBe("崩了");
    });

    it("不传 message 保留原 message（无新 message）", () => {
      const { setTabState } = useNotificationsStore.getState();
      setTabState("tab-1", "done", "first");
      setTabState("tab-1", "error"); // 不传 message
      const s = useNotificationsStore.getState().byTab["tab-1"];
      expect(s.level).toBe("error");
      expect(s.lastMessage).toBe("first");
    });

    it("不同 tab 互不影响", () => {
      const { setTabState } = useNotificationsStore.getState();
      setTabState("tab-1", "waiting");
      setTabState("tab-2", "done");
      const state = useNotificationsStore.getState().byTab;
      expect(state["tab-1"].level).toBe("waiting");
      expect(state["tab-2"].level).toBe("done");
    });
  });

  describe("clearTab", () => {
    it("完全删除该 tab entry（非置 null）", () => {
      const { setTabState, clearTab } = useNotificationsStore.getState();
      setTabState("tab-1", "waiting");
      clearTab("tab-1");
      expect(useNotificationsStore.getState().byTab["tab-1"]).toBeUndefined();
    });

    it("不影响其他 tab", () => {
      const { setTabState, clearTab } = useNotificationsStore.getState();
      setTabState("tab-1", "waiting");
      setTabState("tab-2", "done");
      clearTab("tab-1");
      const byTab = useNotificationsStore.getState().byTab;
      expect(byTab["tab-1"]).toBeUndefined();
      expect(byTab["tab-2"]?.level).toBe("done");
    });

    it("清不存在的 tab 是 noop", () => {
      useNotificationsStore.getState().clearTab("ghost");
      expect(useNotificationsStore.getState().byTab).toEqual({});
    });
  });

  describe("jumpToLatestUnread", () => {
    it("空 store → null", () => {
      expect(
        useNotificationsStore.getState().jumpToLatestUnread(),
      ).toBeNull();
    });

    it("多 tab 按 lastTimestampMs 倒序返最新", async () => {
      const { setTabState } = useNotificationsStore.getState();
      setTabState("tab-1", "done");
      await new Promise((r) => setTimeout(r, 5)); // 确保时间戳不同
      setTabState("tab-2", "waiting");
      await new Promise((r) => setTimeout(r, 5));
      setTabState("tab-3", "error");
      expect(useNotificationsStore.getState().jumpToLatestUnread()).toBe(
        "tab-3",
      );
    });

    it("clearTab 后该 tab 不再被 jump", async () => {
      const { setTabState, clearTab } = useNotificationsStore.getState();
      setTabState("tab-1", "done");
      await new Promise((r) => setTimeout(r, 5));
      setTabState("tab-2", "waiting"); // 最新
      clearTab("tab-2");
      expect(useNotificationsStore.getState().jumpToLatestUnread()).toBe(
        "tab-1",
      );
    });
  });

  describe("emitNotification + systemNotificationHook 注入", () => {
    it("level=running 不调 systemNotificationHook（plan §7 决策 #2）", () => {
      const hook = vi.fn();
      setSystemNotificationHook(hook);
      useNotificationsStore
        .getState()
        .emitNotification("tab-1", baseEvent({ level: "running" }));
      expect(hook).not.toHaveBeenCalled();
      // 但 state 仍更新
      expect(useNotificationsStore.getState().byTab["tab-1"].level).toBe(
        "running",
      );
    });

    it.each<NotificationLevel>(["waiting", "done", "error"])(
      "level=%s 调 systemNotificationHook 1 次",
      (level) => {
        const hook = vi.fn();
        setSystemNotificationHook(hook);
        const event = baseEvent({ level, message: `level-${level}` });
        useNotificationsStore.getState().emitNotification("tab-1", event);
        expect(hook).toHaveBeenCalledTimes(1);
        expect(hook).toHaveBeenCalledWith(event);
      },
    );

    it("hook 未注入时 emitNotification 不炸（safe call）", () => {
      setSystemNotificationHook(null);
      expect(() => {
        useNotificationsStore
          .getState()
          .emitNotification("tab-1", baseEvent());
      }).not.toThrow();
      // state 仍更新
      expect(useNotificationsStore.getState().byTab["tab-1"]).toBeDefined();
    });
  });

  describe("priority 函数（独立 export）", () => {
    it("waiting > error > done > running > null（plan §7 决策 #1）", () => {
      expect(priority("waiting")).toBeGreaterThan(priority("error"));
      expect(priority("error")).toBeGreaterThan(priority("done"));
      expect(priority("done")).toBeGreaterThan(priority("running"));
      expect(priority("running")).toBeGreaterThan(priority(null));
    });

    it("null → 0", () => {
      expect(priority(null)).toBe(0);
    });
  });
});
