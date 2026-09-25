import { beforeEach, describe, expect, it, vi } from "vitest";

// mock IPC：所有 browser_* 走 vi.fn，便于断言调用
vi.mock("../lib/tauri", () => ({
  browserOpenTab: vi.fn(),
  browserCloseTab: vi.fn().mockResolvedValue(undefined),
  browserNavigate: vi.fn().mockResolvedValue(undefined),
  browserSetActive: vi.fn().mockResolvedValue(undefined),
  browserClearActive: vi.fn().mockResolvedValue(undefined),
  browserSetBounds: vi.fn().mockResolvedValue(undefined),
  browserSuspendTab: vi.fn().mockResolvedValue(undefined),
  browserSetScrollY: vi.fn().mockResolvedValue(undefined),
  browserPanelCloseAll: vi.fn().mockResolvedValue(undefined),
  browserSetZoom: vi.fn().mockResolvedValue(undefined),
}));

// v0.7.0-A：mock analytics
vi.mock("../lib/analytics", () => ({
  trackEvent: vi.fn(),
}));

import { trackEvent } from "../lib/analytics";
import {
  browserClearActive,
  browserCloseTab,
  browserNavigate,
  browserOpenTab,
  browserPanelCloseAll,
  browserSetActive,
  browserSetScrollY,
  browserSetZoom,
  browserSuspendTab,
} from "../lib/tauri";
import { useBrowserStore } from "./browser";
import { DEFAULT_ZOOM, stepZoom } from "../lib/browserZoom";

const trackEventMock = trackEvent as unknown as ReturnType<typeof vi.fn>;

const BOUNDS = { x: 0, y: 0, w: 800, h: 600 };

const mocks = {
  open: browserOpenTab as unknown as ReturnType<typeof vi.fn>,
  close: browserCloseTab as unknown as ReturnType<typeof vi.fn>,
  navigate: browserNavigate as unknown as ReturnType<typeof vi.fn>,
  setActive: browserSetActive as unknown as ReturnType<typeof vi.fn>,
  clearActive: browserClearActive as unknown as ReturnType<typeof vi.fn>,
  suspend: browserSuspendTab as unknown as ReturnType<typeof vi.fn>,
  setScrollY: browserSetScrollY as unknown as ReturnType<typeof vi.fn>,
  closeAll: browserPanelCloseAll as unknown as ReturnType<typeof vi.fn>,
  setZoom: browserSetZoom as unknown as ReturnType<typeof vi.fn>,
};

function resetStore() {
  useBrowserStore.setState({
    panelOpen: false,
    tabs: [],
    activeKey: null,
    activeSyncError: null,
  });
  for (const m of Object.values(mocks)) m.mockClear();
  mocks.open.mockReset();
  mocks.setActive.mockReset();
  mocks.setActive.mockResolvedValue(undefined);
  mocks.closeAll.mockReset();
  mocks.closeAll.mockResolvedValue(undefined);
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
      expect(mocks.open).toHaveBeenCalledWith("https://b", BOUNDS, false);
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
      expect(mocks.open).toHaveBeenCalledWith("about:blank", BOUNDS, false);
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
      expect(mocks.open).toHaveBeenCalledWith("https://x", BOUNDS, false);
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
      expect(mocks.open).toHaveBeenCalledWith("https://example.com", BOUNDS, false);
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

  // =====================================================================
  // v1.3.0 P7：ghost webview —— set_active 失败绝不静默吞
  // =====================================================================
  describe("前后端 active tab 同步（ghost webview 防线）", () => {
    it("openTab：set_active 失败会重试一次", async () => {
      mocks.setActive.mockRejectedValueOnce(new Error("IPC 抖动"));
      await useBrowserStore.getState().openTab("https://a", BOUNDS);
      expect(mocks.setActive).toHaveBeenCalledTimes(2);
      // 重试成功 → 不算失步
      expect(useBrowserStore.getState().activeSyncError).toBeNull();
      expect(mocks.clearActive).not.toHaveBeenCalled();
    });

    it("openTab：set_active 重试后仍失败 → 清空后端 active + 记失步（不静默吞）", async () => {
      mocks.setActive.mockRejectedValue(new Error("set_active 炸了"));
      await useBrowserStore.getState().openTab("https://a", BOUNDS);

      expect(mocks.setActive).toHaveBeenCalledTimes(2);
      // 后端宁可"不知道 active 是谁"，也不能拿过期 id 给 AI 用
      expect(mocks.clearActive).toHaveBeenCalledTimes(1);
      expect(useBrowserStore.getState().activeSyncError).toBeTruthy();
    });

    it("setActive：成功后清掉之前的失步标记", async () => {
      await useBrowserStore.getState().openTab("https://a", BOUNDS);
      useBrowserStore.setState({ activeSyncError: "旧的失步" });
      const k = useBrowserStore.getState().tabs[0].key;

      await useBrowserStore.getState().setActive(k, BOUNDS);

      expect(useBrowserStore.getState().activeSyncError).toBeNull();
    });

    it("setActive：后端说 webview 已不存在 → 自愈重建（resume），不留下失步", async () => {
      await useBrowserStore.getState().openTab("https://a", BOUNDS);
      const k = useBrowserStore.getState().tabs[0].key;
      mocks.setActive.mockClear();
      // 后端 webview 已被 destroy（前端 state 却还是 active）
      mocks.setActive.mockRejectedValueOnce(new Error("tab mock-1 不存在或已 suspend"));

      await useBrowserStore.getState().setActive(k, BOUNDS);

      const t = useBrowserStore.getState().tabs[0];
      expect(t.state).toBe("active");
      expect(t.id).toBe("mock-2"); // 重建出的新 webview
      expect(useBrowserStore.getState().activeSyncError).toBeNull();
    });

    it("closeTab：关掉 active tab 后要把新 active 同步给后端", async () => {
      await useBrowserStore.getState().openTab("https://a", BOUNDS);
      await useBrowserStore.getState().openTab("https://b", BOUNDS);
      const k1 = useBrowserStore.getState().tabs[0].key;
      useBrowserStore.setState({ activeKey: k1 });
      mocks.setActive.mockClear();

      await useBrowserStore.getState().closeTab(k1);

      // 关掉 active 后后端 current_active_id 被清空，必须补一次 set_active，
      // 否则后端"有 webview 但不知道哪个可见" → AI 无从下手 / 面板空白
      expect(mocks.setActive).toHaveBeenCalledWith("mock-2");
    });

    it("closeTab：关掉非 active tab 不重复同步 active", async () => {
      await useBrowserStore.getState().openTab("https://a", BOUNDS);
      await useBrowserStore.getState().openTab("https://b", BOUNDS);
      const k1 = useBrowserStore.getState().tabs[0].key;
      // active 是第 2 个
      mocks.setActive.mockClear();

      await useBrowserStore.getState().closeTab(k1);

      expect(mocks.setActive).not.toHaveBeenCalled();
      expect(mocks.clearActive).not.toHaveBeenCalled();
    });

    it("closeTab：新 active 是 suspended tab → 清空后端 active（不留猜测空间）", async () => {
      await useBrowserStore.getState().openTab("https://a", BOUNDS);
      await useBrowserStore.getState().openTab("https://b", BOUNDS);
      const k1 = useBrowserStore.getState().tabs[0].key;
      const k2 = useBrowserStore.getState().tabs[1].key;
      await useBrowserStore.getState().suspendTab(k1);
      useBrowserStore.setState({ activeKey: k2 });
      mocks.clearActive.mockClear();

      await useBrowserStore.getState().closeTab(k2);

      expect(mocks.clearActive).toHaveBeenCalledTimes(1);
    });

    it("resumeTab：set_active 失败 → 清空后端 active + 记失步", async () => {
      await useBrowserStore.getState().openTab("https://a", BOUNDS);
      const k = useBrowserStore.getState().tabs[0].key;
      await useBrowserStore.getState().suspendTab(k);
      mocks.setActive.mockRejectedValue(new Error("boom"));

      await useBrowserStore.getState().resumeTab(k, BOUNDS);

      expect(mocks.clearActive).toHaveBeenCalled();
      expect(useBrowserStore.getState().activeSyncError).toBeTruthy();
    });

    it("minimizePanel：close_all 失败 → 重试 + 清空后端 active + 记失步", async () => {
      await useBrowserStore.getState().openTab("https://a", BOUNDS);
      mocks.closeAll.mockRejectedValue(new Error("close all 炸了"));
      mocks.clearActive.mockClear();

      await useBrowserStore.getState().minimizePanel();

      expect(mocks.closeAll).toHaveBeenCalledTimes(2);
      expect(mocks.clearActive).toHaveBeenCalledTimes(1);
      expect(useBrowserStore.getState().activeSyncError).toBeTruthy();
      // UI 语义不变：仍然收起 + 全部标 suspended
      expect(useBrowserStore.getState().panelOpen).toBe(false);
      expect(useBrowserStore.getState().tabs[0].state).toBe("suspended");
    });

    it("reassertActive：把当前 active tab 重新告诉后端（dialog 让位恢复后用）", async () => {
      await useBrowserStore.getState().openTab("https://a", BOUNDS);
      mocks.setActive.mockClear();

      await useBrowserStore.getState().reassertActive();

      expect(mocks.setActive).toHaveBeenCalledWith("mock-1");
    });

    it("reassertActive：没有任何 tab 时不发任何 IPC", async () => {
      await useBrowserStore.getState().reassertActive();
      expect(mocks.setActive).not.toHaveBeenCalled();
      expect(mocks.clearActive).not.toHaveBeenCalled();
    });

    it("reassertActive：active tab 已 suspend → 清空后端 active", async () => {
      await useBrowserStore.getState().openTab("https://a", BOUNDS);
      const k = useBrowserStore.getState().tabs[0].key;
      await useBrowserStore.getState().suspendTab(k);
      mocks.setActive.mockClear();
      mocks.clearActive.mockClear();

      await useBrowserStore.getState().reassertActive();

      expect(mocks.setActive).not.toHaveBeenCalled();
      expect(mocks.clearActive).toHaveBeenCalledTimes(1);
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

describe("applyTitleChanged", () => {
  it("按后端 tab_id 把标签文字从 URL 换成真实标题", () => {
    const s = useBrowserStore.getState();
    useBrowserStore.setState({
      tabs: [
        { id: "browser-1", key: "k1", url: "https://example.com", title: "https://example.com", state: "active", scrollY: 0, pinned: false, lastActiveAt: 0 },
        { id: "browser-2", key: "k2", url: "https://b.com", title: "https://b.com", state: "active", scrollY: 0, pinned: false, lastActiveAt: 0 },
      ],
    });
    s.applyTitleChanged("browser-1", "Example Domain");

    const tabs = useBrowserStore.getState().tabs;
    expect(tabs[0].title).toBe("Example Domain");
    expect(tabs[1].title).toBe("https://b.com");
  });

  it("空标题忽略 —— 宁可继续显示 URL，也不要一个没文字的标签", () => {
    useBrowserStore.setState({
      tabs: [
        { id: "browser-1", key: "k1", url: "https://example.com", title: "https://example.com", state: "active", scrollY: 0, pinned: false, lastActiveAt: 0 },
      ],
    });
    useBrowserStore.getState().applyTitleChanged("browser-1", "   ");
    expect(useBrowserStore.getState().tabs[0].title).toBe("https://example.com");
  });

  it("tab_id 对不上时不动任何标签", () => {
    useBrowserStore.setState({
      tabs: [
        { id: "browser-1", key: "k1", url: "https://example.com", title: "orig", state: "active", scrollY: 0, pinned: false, lastActiveAt: 0 },
      ],
    });
    useBrowserStore.getState().applyTitleChanged("browser-ghost", "新标题");
    expect(useBrowserStore.getState().tabs[0].title).toBe("orig");
  });
});

describe("toggleMobile", () => {
  beforeEach(() => {
    mocks.open.mockClear();
  });

  it("切到移动版：写标志 → 销毁重建 webview（UA 只能创建时定）", async () => {
    mocks.open.mockResolvedValue({ tab_id: "browser-new" });
    useBrowserStore.setState({
      tabs: [
        { id: "browser-1", key: "k1", url: "https://news.163.com", title: "网易", state: "active", scrollY: 0, pinned: false, lastActiveAt: 0 },
      ],
      activeKey: "k1",
    });

    await useBrowserStore.getState().toggleMobile({ x: 0, y: 0, w: 800, h: 600 });

    const tab = useBrowserStore.getState().tabs[0];
    expect(tab.mobile).toBe(true);
    // 重建时必须把 mobile=true 传下去，否则拿到的还是桌面 UA
    expect(mocks.open).toHaveBeenCalledWith(
      "https://news.163.com",
      expect.anything(),
      true,
    );
  });

  it("再切一次回桌面版", async () => {
    mocks.open.mockResolvedValue({ tab_id: "browser-new2" });
    useBrowserStore.setState({
      tabs: [
        { id: "browser-1", key: "k1", url: "https://news.163.com", title: "网易", state: "active", scrollY: 0, pinned: false, mobile: true, lastActiveAt: 0 },
      ],
      activeKey: "k1",
    });

    await useBrowserStore.getState().toggleMobile({ x: 0, y: 0, w: 800, h: 600 });

    expect(useBrowserStore.getState().tabs[0].mobile).toBe(false);
    expect(mocks.open).toHaveBeenCalledWith(
      "https://news.163.com",
      expect.anything(),
      false,
    );
  });

  it("没有 active tab 时什么都不做", async () => {
    useBrowserStore.setState({ tabs: [], activeKey: null });
    await useBrowserStore.getState().toggleMobile({ x: 0, y: 0, w: 800, h: 600 });
    expect(mocks.open).not.toHaveBeenCalled();
  });
});

describe("restoreTabs（跨重启恢复浏览器标签）", () => {
  beforeEach(() => {
    useBrowserStore.setState({ tabs: [], activeKey: null, panelOpen: false });
    mocks.open.mockClear();
  });

  const SNAP = [
    { url: "https://example.com", title: "Example", zoom: 1.25, mobile: false },
    { url: "https://news.163.com", title: "网易", zoom: null, mobile: true },
  ];

  it("恢复成 suspended，启动时**不建 webview**", async () => {
    useBrowserStore.getState().restoreTabs(SNAP, 0);

    const { tabs } = useBrowserStore.getState();
    expect(tabs).toHaveLength(2);
    expect(tabs.every((t) => t.state === "suspended")).toBe(true);
    expect(tabs.every((t) => t.id === null)).toBe(true);
    // 启动就给每个 tab 建一个 native webview 会拖慢冷启动，也白占内存；
    // 面板真被打开时 restorePanel 会 resume active 那个。
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("URL / 标题 / 缩放 / 移动版开关都还原", () => {
    useBrowserStore.getState().restoreTabs(SNAP, 0);

    const [a, b] = useBrowserStore.getState().tabs;
    expect(a.url).toBe("https://example.com");
    expect(a.title).toBe("Example");
    expect(a.zoom).toBe(1.25);
    expect(a.mobile).toBe(false);
    expect(b.mobile).toBe(true);
    expect(b.zoom).toBe(DEFAULT_ZOOM); // null → 默认 100%
  });

  it("按下标定位 active tab", () => {
    useBrowserStore.getState().restoreTabs(SNAP, 1);
    const { tabs, activeKey } = useBrowserStore.getState();
    expect(activeKey).toBe(tabs[1].key);
  });

  it("下标越界 / 缺省时兜底第一个，不留空 activeKey", () => {
    useBrowserStore.getState().restoreTabs(SNAP, 99);
    expect(useBrowserStore.getState().activeKey).toBe(
      useBrowserStore.getState().tabs[0].key,
    );
    useBrowserStore.setState({ tabs: [], activeKey: null });
    useBrowserStore.getState().restoreTabs(SNAP, null);
    expect(useBrowserStore.getState().activeKey).toBe(
      useBrowserStore.getState().tabs[0].key,
    );
  });

  it("**不自动展开面板**：上次收着的面板不该因为恢复就弹出来", () => {
    useBrowserStore.getState().restoreTabs(SNAP, 0);
    expect(useBrowserStore.getState().panelOpen).toBe(false);
  });

  it("已经有 tab 时不重复恢复", () => {
    useBrowserStore.getState().restoreTabs(SNAP, 0);
    useBrowserStore.getState().restoreTabs(SNAP, 0);
    expect(useBrowserStore.getState().tabs).toHaveLength(2);
  });

  it("空列表 no-op", () => {
    useBrowserStore.getState().restoreTabs([], null);
    expect(useBrowserStore.getState().tabs).toHaveLength(0);
  });
});

describe("restorePanel：目标 tab 已是 active 状态（容错分支）", () => {
  beforeEach(() => {
    resetStore();
  });

  it("sync 成功（ok）→ 仅切 activeKey，不重建 webview", async () => {
    useBrowserStore.setState({
      panelOpen: false,
      tabs: [
        {
          id: "wv-1",
          url: "https://a",
          title: "A",
          state: "active",
          scrollY: 0,
          pinned: false,
          lastActiveAt: 1,
          key: "k1",
        },
      ],
      activeKey: "k1",
    });
    mocks.open.mockClear();

    await useBrowserStore.getState().restorePanel(BOUNDS);

    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.setActive).toHaveBeenCalledWith("wv-1");
    const s = useBrowserStore.getState();
    expect(s.panelOpen).toBe(true);
    expect(s.activeKey).toBe("k1");
    expect(s.activeSyncError).toBeNull();
  });

  it("sync 报 webview 已不存在（gone）→ 标 suspended 后自愈 resume", async () => {
    useBrowserStore.setState({
      panelOpen: false,
      tabs: [
        {
          id: "wv-1",
          url: "https://a",
          title: "A",
          state: "active",
          scrollY: 0,
          pinned: false,
          lastActiveAt: 1,
          key: "k1",
        },
      ],
      activeKey: "k1",
    });
    mocks.open.mockClear();
    mocks.setActive.mockRejectedValueOnce(
      new Error("tab wv-1 不存在或已 suspend"),
    );

    await useBrowserStore.getState().restorePanel(BOUNDS);

    // 自愈：重建 webview
    expect(mocks.open).toHaveBeenCalledTimes(1);
    const s = useBrowserStore.getState();
    expect(s.tabs[0].state).toBe("active");
    expect(s.tabs[0].id).toBe("mock-1");
  });

  it("sync 重试后仍失败（failed）→ 清空后端 active + 记失步，但仍切 activeKey", async () => {
    useBrowserStore.setState({
      panelOpen: false,
      tabs: [
        {
          id: "wv-1",
          url: "https://a",
          title: "A",
          state: "active",
          scrollY: 0,
          pinned: false,
          lastActiveAt: 1,
          key: "k1",
        },
      ],
      activeKey: "k1",
    });
    mocks.open.mockClear();
    mocks.setActive.mockRejectedValue(new Error("set_active 炸了"));

    await useBrowserStore.getState().restorePanel(BOUNDS);

    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.clearActive).toHaveBeenCalledTimes(1);
    const s = useBrowserStore.getState();
    expect(s.activeSyncError).toBe("恢复面板时无法把 active tab 同步给后端");
    expect(s.activeKey).toBe("k1");
  });
});

describe("openTab：失败时机序竞态（activeKey 已被切走）", () => {
  beforeEach(() => {
    resetStore();
  });

  it("创建失败时若 activeKey 已被切到别处 → 不覆盖成 null，保留当前 activeKey", async () => {
    let rejectOpen: ((e: unknown) => void) | null = null;
    mocks.open.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectOpen = reject;
        }),
    );

    const p = useBrowserStore.getState().openTab("https://b", BOUNDS);
    const failedKey = useBrowserStore.getState().activeKey;
    expect(failedKey).not.toBeNull();

    // 极端时序：IPC 还没返回时用户已经手动切到了别的 tab
    useBrowserStore.setState({ activeKey: "manually-switched" });
    rejectOpen!(new Error("create failed"));
    await p;

    const s = useBrowserStore.getState();
    expect(s.tabs.find((t) => t.key === failedKey)).toBeUndefined();
    // activeKey 不该被失败的这次创建覆盖回 null
    expect(s.activeKey).toBe("manually-switched");
  });
});

describe("closeTab / setActive：resync 失败分支", () => {
  beforeEach(() => {
    resetStore();
  });

  it("closeTab：关掉 active tab 后新 active 同步失败 → 清空后端 active + 记失步", async () => {
    await useBrowserStore.getState().openTab("https://a", BOUNDS);
    await useBrowserStore.getState().openTab("https://b", BOUNDS);
    const k1 = useBrowserStore.getState().tabs[0].key;
    useBrowserStore.setState({ activeKey: k1 });
    mocks.setActive.mockClear();
    mocks.setActive.mockRejectedValue(new Error("boom"));

    await useBrowserStore.getState().closeTab(k1);

    expect(mocks.clearActive).toHaveBeenCalled();
    expect(useBrowserStore.getState().activeSyncError).toBe(
      "关闭 tab 后无法把新 active 同步给后端",
    );
  });

  it("setActive：sync 重试后仍失败（非 gone）→ 清空后端 active + 记失步，仍切 activeKey", async () => {
    await useBrowserStore.getState().openTab("https://a", BOUNDS);
    await useBrowserStore.getState().openTab("https://b", BOUNDS);
    const k1 = useBrowserStore.getState().tabs[0].key;
    mocks.setActive.mockClear();
    mocks.setActive.mockRejectedValue(new Error("boom"));

    await useBrowserStore.getState().setActive(k1, BOUNDS);

    expect(mocks.clearActive).toHaveBeenCalled();
    const s = useBrowserStore.getState();
    expect(s.activeSyncError).toBe("切换 tab 后无法把 active 同步给后端");
    expect(s.activeKey).toBe(k1);
  });
});

describe("adjustZoom", () => {
  beforeEach(() => {
    resetStore();
    mocks.setZoom.mockClear();
    mocks.setZoom.mockReset();
    mocks.setZoom.mockResolvedValue(undefined);
  });

  it("direction=1 → 放大到下一档，调 browser_set_zoom", async () => {
    await useBrowserStore.getState().openTab("https://a", BOUNDS);
    const k = useBrowserStore.getState().tabs[0].key;

    await useBrowserStore.getState().adjustZoom(1);

    const expected = stepZoom(DEFAULT_ZOOM, 1);
    const t = useBrowserStore.getState().tabs.find((x) => x.key === k)!;
    expect(t.zoom).toBe(expected);
    expect(mocks.setZoom).toHaveBeenCalledWith("mock-1", expected);
  });

  it("direction=-1 → 缩小到上一档", async () => {
    await useBrowserStore.getState().openTab("https://a", BOUNDS);

    await useBrowserStore.getState().adjustZoom(-1);

    const expected = stepZoom(DEFAULT_ZOOM, -1);
    const t = useBrowserStore.getState().tabs[0];
    expect(t.zoom).toBe(expected);
    expect(mocks.setZoom).toHaveBeenCalledWith("mock-1", expected);
  });

  it("direction='reset' → 回到 DEFAULT_ZOOM", async () => {
    await useBrowserStore.getState().openTab("https://a", BOUNDS);
    await useBrowserStore.getState().adjustZoom(1);
    mocks.setZoom.mockClear();

    await useBrowserStore.getState().adjustZoom("reset");

    const t = useBrowserStore.getState().tabs[0];
    expect(t.zoom).toBe(DEFAULT_ZOOM);
    expect(mocks.setZoom).toHaveBeenCalledWith("mock-1", DEFAULT_ZOOM);
  });

  it("IPC 失败 → 回滚 store 里的 zoom 值", async () => {
    await useBrowserStore.getState().openTab("https://a", BOUNDS);
    mocks.setZoom.mockRejectedValueOnce(new Error("set_zoom 炸了"));

    await useBrowserStore.getState().adjustZoom(1);

    // 失败后回滚回原值（DEFAULT_ZOOM），不留一个假的百分比
    const t = useBrowserStore.getState().tabs[0];
    expect(t.zoom).toBe(DEFAULT_ZOOM);
  });

  it("没有 active tab（或无 id）→ 不调 IPC", async () => {
    useBrowserStore.setState({ tabs: [], activeKey: null });

    await useBrowserStore.getState().adjustZoom(1);

    expect(mocks.setZoom).not.toHaveBeenCalled();
  });
});

describe("applyUrlChanged", () => {
  beforeEach(() => {
    resetStore();
  });

  it("按后端 tab_id 更新 url + title（AI 工具 navigate 后 emit）", () => {
    useBrowserStore.setState({
      tabs: [
        {
          id: "browser-1",
          key: "k1",
          url: "https://old.com",
          title: "旧标题",
          state: "active",
          scrollY: 0,
          pinned: false,
          lastActiveAt: 0,
        },
      ],
    });

    useBrowserStore.getState().applyUrlChanged("browser-1", "https://new.com");

    const t = useBrowserStore.getState().tabs[0];
    expect(t.url).toBe("https://new.com");
    expect(t.title).toBe("https://new.com");
  });

  it("tab_id 对不上 → 不动任何 tab", () => {
    useBrowserStore.setState({
      tabs: [
        {
          id: "browser-1",
          key: "k1",
          url: "https://old.com",
          title: "旧标题",
          state: "active",
          scrollY: 0,
          pinned: false,
          lastActiveAt: 0,
        },
      ],
    });

    useBrowserStore.getState().applyUrlChanged("browser-ghost", "https://new.com");

    const t = useBrowserStore.getState().tabs[0];
    expect(t.url).toBe("https://old.com");
    expect(t.title).toBe("旧标题");
  });
});

describe("suspendTab：后端 suspend 失败也不阻塞前端状态切换", () => {
  beforeEach(() => {
    resetStore();
  });

  it("browser_suspend_tab 失败（已被后端 destroy）→ 前端仍转 suspended", async () => {
    await useBrowserStore.getState().openTab("https://a", BOUNDS);
    const k = useBrowserStore.getState().tabs[0].key;
    mocks.suspend.mockRejectedValueOnce(new Error("已经 destroy"));

    await useBrowserStore.getState().suspendTab(k);

    const t = useBrowserStore.getState().tabs[0];
    expect(t.state).toBe("suspended");
    expect(t.id).toBeNull();
  });
});

describe("resumeTab：缩放恢复 + 失败回退", () => {
  beforeEach(() => {
    resetStore();
    mocks.setZoom.mockClear();
    mocks.setZoom.mockReset();
    mocks.setZoom.mockResolvedValue(undefined);
  });

  it("非默认缩放的 tab resume 后重新下发 set_zoom", async () => {
    await useBrowserStore.getState().openTab("https://a", BOUNDS);
    const k = useBrowserStore.getState().tabs[0].key;
    // 手动给 tab 设一个非默认缩放（模拟之前调过 adjustZoom）
    useBrowserStore.setState((s) => ({
      tabs: s.tabs.map((t) => (t.key === k ? { ...t, zoom: 1.5 } : t)),
    }));
    await useBrowserStore.getState().suspendTab(k);
    mocks.setZoom.mockClear();

    await useBrowserStore.getState().resumeTab(k, BOUNDS);

    expect(mocks.setZoom).toHaveBeenCalledWith("mock-2", 1.5);
  });

  it("默认缩放的 tab resume 后不重复下发 set_zoom", async () => {
    await useBrowserStore.getState().openTab("https://a", BOUNDS);
    const k = useBrowserStore.getState().tabs[0].key;
    await useBrowserStore.getState().suspendTab(k);
    mocks.setZoom.mockClear();

    await useBrowserStore.getState().resumeTab(k, BOUNDS);

    expect(mocks.setZoom).not.toHaveBeenCalled();
  });

  it("resume 时后端 open 失败 → 回退回 suspended 状态", async () => {
    await useBrowserStore.getState().openTab("https://a", BOUNDS);
    const k = useBrowserStore.getState().tabs[0].key;
    await useBrowserStore.getState().suspendTab(k);
    mocks.open.mockRejectedValueOnce(new Error("open 炸了"));

    await useBrowserStore.getState().resumeTab(k, BOUNDS);

    expect(useBrowserStore.getState().tabs[0].state).toBe("suspended");
  });
});

describe("reassertActive：sync 失败分支", () => {
  beforeEach(() => {
    resetStore();
  });

  it("active tab 同步失败（非 gone）→ 清空后端 active + 记失步", async () => {
    await useBrowserStore.getState().openTab("https://a", BOUNDS);
    mocks.setActive.mockClear();
    mocks.setActive.mockRejectedValue(new Error("boom"));

    await useBrowserStore.getState().reassertActive();

    expect(mocks.clearActive).toHaveBeenCalled();
    expect(useBrowserStore.getState().activeSyncError).toBe(
      "重新同步 active tab 失败（failed）",
    );
  });
});

describe("clearBackendActive 自身失败（连清空都失败）", () => {
  beforeEach(() => {
    resetStore();
  });

  it("minimizePanel：close_all 与 clear_active 都失败 → 仍不抛错，state 照常收起", async () => {
    await useBrowserStore.getState().openTab("https://a", BOUNDS);
    mocks.closeAll.mockRejectedValue(new Error("close all 炸了"));
    mocks.clearActive.mockRejectedValueOnce(new Error("clear active 也炸了"));

    await expect(
      useBrowserStore.getState().minimizePanel(),
    ).resolves.toBeUndefined();

    const s = useBrowserStore.getState();
    expect(s.panelOpen).toBe(false);
    expect(s.tabs[0].state).toBe("suspended");
    expect(s.activeSyncError).toBeTruthy();
  });
});
