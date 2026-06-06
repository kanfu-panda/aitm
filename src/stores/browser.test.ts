import { beforeEach, describe, expect, it, vi } from "vitest";

// mock IPC：所有 browser_* 走 vi.fn，便于断言调用
vi.mock("../lib/tauri", () => ({
  browserOpenTab: vi.fn(),
  browserCloseTab: vi.fn().mockResolvedValue(undefined),
  browserNavigate: vi.fn().mockResolvedValue(undefined),
  browserSetActive: vi.fn().mockResolvedValue(undefined),
  browserSetBounds: vi.fn().mockResolvedValue(undefined),
  browserSuspendTab: vi.fn().mockResolvedValue(undefined),
  browserSetScrollY: vi.fn().mockResolvedValue(undefined),
  browserPanelCloseAll: vi.fn().mockResolvedValue(undefined),
}));

// v0.7.0-A：mock analytics
vi.mock("../lib/analytics", () => ({
  trackEvent: vi.fn(),
}));

import { trackEvent } from "../lib/analytics";
import {
  browserCloseTab,
  browserNavigate,
  browserOpenTab,
  browserPanelCloseAll,
  browserSetActive,
  browserSetScrollY,
  browserSuspendTab,
} from "../lib/tauri";
import { useBrowserStore } from "./browser";

const trackEventMock = trackEvent as unknown as ReturnType<typeof vi.fn>;

const BOUNDS = { x: 0, y: 0, w: 800, h: 600 };

const mocks = {
  open: browserOpenTab as unknown as ReturnType<typeof vi.fn>,
  close: browserCloseTab as unknown as ReturnType<typeof vi.fn>,
  navigate: browserNavigate as unknown as ReturnType<typeof vi.fn>,
  setActive: browserSetActive as unknown as ReturnType<typeof vi.fn>,
  suspend: browserSuspendTab as unknown as ReturnType<typeof vi.fn>,
  setScrollY: browserSetScrollY as unknown as ReturnType<typeof vi.fn>,
  closeAll: browserPanelCloseAll as unknown as ReturnType<typeof vi.fn>,
};

function resetStore() {
  useBrowserStore.setState({
    panelOpen: false,
    tabs: [],
    activeKey: null,
  });
  for (const m of Object.values(mocks)) m.mockClear();
  mocks.open.mockReset();
  trackEventMock.mockClear();
  // 默认每次调 open 返回递增 id
  let counter = 0;
  mocks.open.mockImplementation(async () => {
    counter += 1;
    return { tab_id: `mock-${counter}` };
  });
}

describe("useBrowserStore", () => {
  beforeEach(() => {
    resetStore();
  });

  describe("openPanel / closePanel", () => {
    it("openPanel 仅切 panelOpen=true", () => {
      useBrowserStore.getState().openPanel();
      expect(useBrowserStore.getState().panelOpen).toBe(true);
    });

    it("closePanel（v0.4.1 T3 destructive）：调 panel_close_all + 清空 tabs + activeKey=null + panelOpen=false", async () => {
      // 先放点 state
      useBrowserStore.setState({
        panelOpen: true,
        tabs: [
          {
            id: "wv-1",
            url: "https://a",
            title: "A",
            state: "active",
            scrollY: 0,
            pinned: false,
            lastActiveAt: 0,
            key: "k1",
          },
        ],
        activeKey: "k1",
      });

      await useBrowserStore.getState().closePanel();

      expect(mocks.closeAll).toHaveBeenCalledTimes(1);
      const s = useBrowserStore.getState();
      expect(s.panelOpen).toBe(false);
      expect(s.tabs).toEqual([]);
      expect(s.activeKey).toBeNull();
    });
  });

  describe("minimizePanel / restorePanel（v0.4.1 T3）", () => {
    it("minimizePanel：调 panel_close_all + 保留 tabs + 全 suspended + activeKey 保留", async () => {
      // 先开 3 tab
      await useBrowserStore.getState().openTab("https://a", BOUNDS);
      await useBrowserStore.getState().openTab("https://b", BOUNDS);
      await useBrowserStore.getState().openTab("https://c", BOUNDS);
      const k1 = useBrowserStore.getState().tabs[0].key;
      const k2 = useBrowserStore.getState().tabs[1].key;
      const k3 = useBrowserStore.getState().tabs[2].key;
      // 切到第 2 个 tab 为 active
      useBrowserStore.setState({ activeKey: k2 });
      mocks.closeAll.mockClear();

      await useBrowserStore.getState().minimizePanel();

      // IPC：destroy 全部 webview
      expect(mocks.closeAll).toHaveBeenCalledTimes(1);
      const s = useBrowserStore.getState();
      // panelOpen → false
      expect(s.panelOpen).toBe(false);
      // tabs 保留 3 个；不清空
      expect(s.tabs).toHaveLength(3);
      expect(s.tabs.map((t) => t.key)).toEqual([k1, k2, k3]);
      // 每个 tab：state=suspended，id=null
      expect(s.tabs.every((t) => t.state === "suspended")).toBe(true);
      expect(s.tabs.every((t) => t.id === null)).toBe(true);
      // url/title/scrollY/pinned 都不变
      expect(s.tabs[0].url).toBe("https://a");
      expect(s.tabs[1].url).toBe("https://b");
      expect(s.tabs[2].url).toBe("https://c");
      // activeKey 保留
      expect(s.activeKey).toBe(k2);
    });

    it("minimizePanel：后端 close_all 失败也保证 state 标 suspended", async () => {
      await useBrowserStore.getState().openTab("https://a", BOUNDS);
      const k = useBrowserStore.getState().tabs[0].key;
      mocks.closeAll.mockRejectedValueOnce(new Error("close failed"));

      await useBrowserStore.getState().minimizePanel();

      const s = useBrowserStore.getState();
      expect(s.panelOpen).toBe(false);
      expect(s.tabs).toHaveLength(1);
      expect(s.tabs[0].state).toBe("suspended");
      expect(s.tabs[0].id).toBeNull();
      expect(s.activeKey).toBe(k);
    });

    it("restorePanel：从 minimize 状态 → activeKey tab resume + panelOpen=true", async () => {
      // 准备 minimize 后的 state：panelOpen=false, tabs 都是 suspended
      useBrowserStore.setState({
        panelOpen: false,
        tabs: [
          {
            id: null,
            url: "https://a",
            title: "A",
            state: "suspended",
            scrollY: 0,
            pinned: false,
            lastActiveAt: 100,
            key: "k1",
          },
          {
            id: null,
            url: "https://b",
            title: "B",
            state: "suspended",
            scrollY: 0,
            pinned: false,
            lastActiveAt: 200,
            key: "k2",
          },
        ],
        activeKey: "k2",
      });
      mocks.open.mockClear();

      await useBrowserStore.getState().restorePanel(BOUNDS);

      const s = useBrowserStore.getState();
      // panelOpen=true
      expect(s.panelOpen).toBe(true);
      // activeKey 仍为 k2
      expect(s.activeKey).toBe("k2");
      // 仅 active tab 被 resume：调 1 次 open
      expect(mocks.open).toHaveBeenCalledTimes(1);
      expect(mocks.open).toHaveBeenCalledWith("https://b", BOUNDS);
      // k2 现 active；k1 保持 suspended
      const t1 = s.tabs.find((t) => t.key === "k1");
      const t2 = s.tabs.find((t) => t.key === "k2");
      expect(t1?.state).toBe("suspended");
      expect(t2?.state).toBe("active");
    });

    it("restorePanel：tabs 为空 → fallback 创建 about:blank", async () => {
      useBrowserStore.setState({
        panelOpen: false,
        tabs: [],
        activeKey: null,
      });
      mocks.open.mockClear();

      await useBrowserStore.getState().restorePanel(BOUNDS);

      const s = useBrowserStore.getState();
      expect(s.panelOpen).toBe(true);
      // 调 openTab 创建 blank
      expect(mocks.open).toHaveBeenCalledWith("about:blank", BOUNDS);
      expect(s.tabs).toHaveLength(1);
      expect(s.tabs[0].url).toBe("about:blank");
    });

    it("restorePanel：activeKey 不存在但 tabs 非空 → 选第一个 tab resume", async () => {
      useBrowserStore.setState({
        panelOpen: false,
        tabs: [
          {
            id: null,
            url: "https://x",
            title: "X",
            state: "suspended",
            scrollY: 0,
            pinned: false,
            lastActiveAt: 100,
            key: "kx",
          },
        ],
        // activeKey 指向不存在的 key
        activeKey: "ghost",
      });
      mocks.open.mockClear();

      await useBrowserStore.getState().restorePanel(BOUNDS);

      const s = useBrowserStore.getState();
      expect(s.panelOpen).toBe(true);
      // 选第一个 tab resume
      expect(mocks.open).toHaveBeenCalledWith("https://x", BOUNDS);
      expect(s.activeKey).toBe("kx");
    });

    it("minimize → restore 全流程：tabs 数量保持 + active 被恢复", async () => {
      // 先开 2 tab
      await useBrowserStore.getState().openTab("https://a", BOUNDS);
      await useBrowserStore.getState().openTab("https://b", BOUNDS);
      const k1 = useBrowserStore.getState().tabs[0].key;
      const k2 = useBrowserStore.getState().tabs[1].key;
      // 切回第 1 个 active
      await useBrowserStore.getState().setActive(k1, BOUNDS);
      mocks.open.mockClear();
      mocks.closeAll.mockClear();

      // minimize
      await useBrowserStore.getState().minimizePanel();
      expect(useBrowserStore.getState().panelOpen).toBe(false);
      expect(useBrowserStore.getState().tabs).toHaveLength(2);

      // restore
      await useBrowserStore.getState().restorePanel(BOUNDS);

      const s = useBrowserStore.getState();
      expect(s.panelOpen).toBe(true);
      expect(s.tabs).toHaveLength(2);
      // active tab resume；non-active 仍 suspended
      const ta = s.tabs.find((t) => t.key === k1);
      const tb = s.tabs.find((t) => t.key === k2);
      expect(ta?.state).toBe("active");
      expect(tb?.state).toBe("suspended");
    });
  });

  describe("openTab", () => {
    it("调后端 open + 加到 tabs 末尾 + 设为 active + panelOpen=true", async () => {
      await useBrowserStore.getState().openTab("https://example.com", BOUNDS);
      expect(mocks.open).toHaveBeenCalledWith("https://example.com", BOUNDS);
      const s = useBrowserStore.getState();
      expect(s.tabs).toHaveLength(1);
      expect(s.tabs[0].id).toBe("mock-1");
      expect(s.tabs[0].state).toBe("active");
      expect(s.tabs[0].url).toBe("https://example.com");
      expect(s.activeKey).toBe(s.tabs[0].key);
      expect(s.panelOpen).toBe(true);
      // 自动 setActive 让别的 hide
      expect(mocks.setActive).toHaveBeenCalledWith("mock-1");
    });

    it("后端 open 失败 → 撤销占位 tab，activeKey 回退", async () => {
      mocks.open.mockRejectedValueOnce(new Error("create failed"));
      await useBrowserStore.getState().openTab("https://x", BOUNDS);
      const s = useBrowserStore.getState();
      expect(s.tabs).toEqual([]);
      expect(s.activeKey).toBeNull();
    });
  });

  describe("closeTab", () => {
    it("调后端 close + 从列表删 + 切 active 到右侧", async () => {
      // 准备 3 个 tab，active = 第 2 个
      await useBrowserStore.getState().openTab("https://a", BOUNDS);
      await useBrowserStore.getState().openTab("https://b", BOUNDS);
      await useBrowserStore.getState().openTab("https://c", BOUNDS);
      const tabs = useBrowserStore.getState().tabs;
      const k1 = tabs[0].key;
      const k2 = tabs[1].key;
      const k3 = tabs[2].key;
      // active 当前是第 3 个；切回第 2 个
      useBrowserStore.setState({ activeKey: k2 });

      await useBrowserStore.getState().closeTab(k2);

      expect(mocks.close).toHaveBeenCalledTimes(1);
      const s = useBrowserStore.getState();
      expect(s.tabs.map((t) => t.key)).toEqual([k1, k3]);
      // 切到右侧（k3）
      expect(s.activeKey).toBe(k3);
    });

    it("关闭最后一个 tab → activeKey=null", async () => {
      await useBrowserStore.getState().openTab("https://a", BOUNDS);
      const k = useBrowserStore.getState().tabs[0].key;
      await useBrowserStore.getState().closeTab(k);
      expect(useBrowserStore.getState().tabs).toEqual([]);
      expect(useBrowserStore.getState().activeKey).toBeNull();
    });

    it("关闭非 active tab → activeKey 不变", async () => {
      await useBrowserStore.getState().openTab("https://a", BOUNDS);
      await useBrowserStore.getState().openTab("https://b", BOUNDS);
      const k1 = useBrowserStore.getState().tabs[0].key;
      const k2 = useBrowserStore.getState().tabs[1].key;
      await useBrowserStore.getState().closeTab(k1);
      expect(useBrowserStore.getState().activeKey).toBe(k2);
    });
  });

  describe("setActive", () => {
    it("active tab 切换：调 set_active + 更新 lastActiveAt", async () => {
      await useBrowserStore.getState().openTab("https://a", BOUNDS);
      await useBrowserStore.getState().openTab("https://b", BOUNDS);
      const k1 = useBrowserStore.getState().tabs[0].key;
      mocks.setActive.mockClear();

      await useBrowserStore.getState().setActive(k1, BOUNDS);

      expect(mocks.setActive).toHaveBeenCalledWith("mock-1");
      const s = useBrowserStore.getState();
      expect(s.activeKey).toBe(k1);
      expect(s.tabs[0].lastActiveAt).toBeGreaterThan(0);
    });

    it("setActive 到 suspended tab → 自动 resume", async () => {
      await useBrowserStore.getState().openTab("https://a", BOUNDS);
      const k = useBrowserStore.getState().tabs[0].key;
      await useBrowserStore.getState().suspendTab(k);
      expect(useBrowserStore.getState().tabs[0].state).toBe("suspended");

      await useBrowserStore.getState().setActive(k, BOUNDS);

      const t = useBrowserStore.getState().tabs[0];
      expect(t.state).toBe("active");
      expect(t.id).toBe("mock-2"); // 新 webview id
    });
  });

  describe("navigate", () => {
    it("调后端 navigate + 更新 url", async () => {
      await useBrowserStore.getState().openTab("https://a", BOUNDS);
      const k = useBrowserStore.getState().tabs[0].key;

      await useBrowserStore.getState().navigate(k, "https://b");

      expect(mocks.navigate).toHaveBeenCalledWith("mock-1", "https://b");
      expect(useBrowserStore.getState().tabs[0].url).toBe("https://b");
    });
  });

  describe("suspendTab / resumeTab", () => {
    it("suspendTab：调后端 suspend + state=suspended + id=null + 保留 url/scrollY/pinned", async () => {
      await useBrowserStore.getState().openTab("https://a", BOUNDS);
      const k = useBrowserStore.getState().tabs[0].key;
      useBrowserStore.getState().updateScroll(k, 1234);
      useBrowserStore.getState().pinTab(k, true);

      await useBrowserStore.getState().suspendTab(k);

      expect(mocks.suspend).toHaveBeenCalledWith("mock-1");
      const t = useBrowserStore.getState().tabs[0];
      expect(t.state).toBe("suspended");
      expect(t.id).toBeNull();
      expect(t.url).toBe("https://a");
      expect(t.scrollY).toBe(1234);
      expect(t.pinned).toBe(true);
    });

    it("resumeTab：重建 webview + 标 active + 恢复滚动（500ms 后调 set_scroll_y）", async () => {
      vi.useFakeTimers();
      try {
        await useBrowserStore.getState().openTab("https://a", BOUNDS);
        const k = useBrowserStore.getState().tabs[0].key;
        useBrowserStore.getState().updateScroll(k, 999);
        await useBrowserStore.getState().suspendTab(k);

        await useBrowserStore.getState().resumeTab(k, BOUNDS);

        const t = useBrowserStore.getState().tabs[0];
        expect(t.state).toBe("active");
        expect(t.id).toBe("mock-2");
        expect(useBrowserStore.getState().activeKey).toBe(k);
        // scrollY 还没调（要等 500ms）
        expect(mocks.setScrollY).not.toHaveBeenCalled();

        vi.advanceTimersByTime(600);
        expect(mocks.setScrollY).toHaveBeenCalledWith("mock-2", 999);
      } finally {
        vi.useRealTimers();
      }
    });

    it("resumeTab：scrollY=0 时不调 set_scroll_y", async () => {
      vi.useFakeTimers();
      try {
        await useBrowserStore.getState().openTab("https://a", BOUNDS);
        const k = useBrowserStore.getState().tabs[0].key;
        await useBrowserStore.getState().suspendTab(k);

        await useBrowserStore.getState().resumeTab(k, BOUNDS);
        vi.advanceTimersByTime(600);

        expect(mocks.setScrollY).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("非 suspended tab 调 resumeTab → noop", async () => {
      await useBrowserStore.getState().openTab("https://a", BOUNDS);
      const k = useBrowserStore.getState().tabs[0].key;
      const beforeId = useBrowserStore.getState().tabs[0].id;
      mocks.open.mockClear();

      await useBrowserStore.getState().resumeTab(k, BOUNDS);

      expect(mocks.open).not.toHaveBeenCalled();
      expect(useBrowserStore.getState().tabs[0].id).toBe(beforeId);
    });
  });

  describe("pinTab / updateScroll / updateTitle", () => {
    it("pinTab 切换 pinned 标志（不调 IPC）", async () => {
      await useBrowserStore.getState().openTab("https://a", BOUNDS);
      const k = useBrowserStore.getState().tabs[0].key;
      useBrowserStore.getState().pinTab(k, true);
      expect(useBrowserStore.getState().tabs[0].pinned).toBe(true);
      useBrowserStore.getState().pinTab(k, false);
      expect(useBrowserStore.getState().tabs[0].pinned).toBe(false);
    });

    it("updateScroll / updateTitle 写入 store", async () => {
      await useBrowserStore.getState().openTab("https://a", BOUNDS);
      const k = useBrowserStore.getState().tabs[0].key;
      useBrowserStore.getState().updateScroll(k, 500);
      useBrowserStore.getState().updateTitle(k, "标题");
      const t = useBrowserStore.getState().tabs[0];
      expect(t.scrollY).toBe(500);
      expect(t.title).toBe("标题");
    });
  });

  describe("匿名统计 (v0.7.0-A)", () => {
    it("openPanel 触发 browser_opened 事件 (无 props)", () => {
      useBrowserStore.getState().openPanel();
      expect(trackEventMock).toHaveBeenCalledTimes(1);
      expect(trackEventMock).toHaveBeenCalledWith("browser_opened");
    });

    it("openPanel 多次每次都触发", () => {
      const { openPanel } = useBrowserStore.getState();
      openPanel();
      openPanel();
      expect(trackEventMock).toHaveBeenCalledTimes(2);
      expect(
        trackEventMock.mock.calls.every((c) => c[0] === "browser_opened"),
      ).toBe(true);
    });

    it("openTab / closePanel 不触发 browser_opened", async () => {
      trackEventMock.mockClear();
      await useBrowserStore.getState().openTab("https://a", BOUNDS);
      await useBrowserStore.getState().closePanel();
      expect(
        trackEventMock.mock.calls.some((c) => c[0] === "browser_opened"),
      ).toBe(false);
    });
  });
});
