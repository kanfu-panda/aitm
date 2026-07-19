import { beforeEach, describe, expect, it, vi } from "vitest";

// v0.7.0-A：mock analytics 以便断言 trackEvent 调用
vi.mock("../lib/analytics", () => ({
  trackEvent: vi.fn(),
}));

import { trackEvent } from "../lib/analytics";
import { basenameOrRoot, useTabsStore } from "./tabs";

const trackEventMock = trackEvent as unknown as ReturnType<typeof vi.fn>;

describe("useTabsStore", () => {
  beforeEach(() => {
    useTabsStore.setState({
      tabs: [],
      activeId: null,
      unreadByTab: {},
      windowFocused: true,
    });
    trackEventMock.mockClear();
  });

  it("初始无 tab", () => {
    expect(useTabsStore.getState().tabs).toEqual([]);
    expect(useTabsStore.getState().activeId).toBeNull();
  });

  it("addTab 后激活新 tab", () => {
    const { addTab } = useTabsStore.getState();
    const id = addTab();
    const state = useTabsStore.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0].id).toBe(id);
    expect(state.activeId).toBe(id);
  });

  it("addTab 多次后总激活最新", () => {
    const { addTab } = useTabsStore.getState();
    const a = addTab();
    const b = addTab();
    expect(useTabsStore.getState().activeId).toBe(b);
    expect(a).not.toBe(b);
  });

  it("closeTab 移除并切到相邻", () => {
    const { addTab, closeTab } = useTabsStore.getState();
    const a = addTab();
    const b = addTab();
    const c = addTab();
    // 关 b：active 切到 c（如果在 b 右侧有 tab，优先右侧）
    closeTab(b);
    const state = useTabsStore.getState();
    expect(state.tabs.map((t) => t.id)).toEqual([a, c]);
    expect(state.activeId).toBe(c);
  });

  it("closeTab 关最后一个 → activeId 为 null", () => {
    const { addTab, closeTab } = useTabsStore.getState();
    const a = addTab();
    closeTab(a);
    const state = useTabsStore.getState();
    expect(state.tabs).toEqual([]);
    expect(state.activeId).toBeNull();
  });

  it("setActive 切换激活 tab", () => {
    const { addTab, setActive } = useTabsStore.getState();
    const a = addTab();
    const b = addTab();
    setActive(a);
    expect(useTabsStore.getState().activeId).toBe(a);
    setActive(b);
    expect(useTabsStore.getState().activeId).toBe(b);
  });

  describe("未读通知 (unreadByTab)", () => {
    it("markUnread 打到 active tab 且窗口聚焦 → 不计数（用户正看着，噪声不 badge）", () => {
      const { addTab, markUnread, setWindowFocused } = useTabsStore.getState();
      const a = addTab(); // a 自动 active
      setWindowFocused(true);
      markUnread(a);
      // v1.1.0 R1：活跃 tab + 窗口聚焦 = 用户正看着，tab 补全响铃等噪声不点角标
      expect(useTabsStore.getState().unreadByTab[a]).toBeUndefined();
    });

    it("markUnread 打到 active tab 但窗口失焦 → 计数（切到别的 app 完成要 badge）", () => {
      const { addTab, markUnread, setWindowFocused } = useTabsStore.getState();
      const a = addTab(); // a 自动 active
      setWindowFocused(false); // 用户切到别的 app
      markUnread(a);
      // claude 在 active tab 完成、用户已切走 → 必须能亮角标
      expect(useTabsStore.getState().unreadByTab[a]).toBe(1);
    });

    it("markUnread 打到非 active tab → +1", () => {
      const { addTab, markUnread, setActive } = useTabsStore.getState();
      const a = addTab();
      const b = addTab(); // b 当前 active
      setActive(a); // 切到 a，b 现在非 active
      markUnread(b);
      expect(useTabsStore.getState().unreadByTab[b]).toBe(1);
    });

    it("多次 markUnread 同一非 active tab → 节流后累加", () => {
      vi.useFakeTimers();
      try {
        const { addTab, markUnread, setActive } = useTabsStore.getState();
        const a = addTab();
        const b = addTab();
        setActive(a);
        // 第 1 次 mark
        markUnread(b);
        // 200ms 内立即 mark：节流吃掉
        markUnread(b);
        expect(useTabsStore.getState().unreadByTab[b]).toBe(1);
        // 跨过节流窗口
        vi.advanceTimersByTime(250);
        // 真实时钟也要推进（实现用 performance.now）
        vi.setSystemTime(Date.now() + 250);
        markUnread(b);
        expect(useTabsStore.getState().unreadByTab[b]).toBeGreaterThanOrEqual(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("setActive(id) → 自动 clearUnread 该 id", () => {
      const { addTab, markUnread, setActive } = useTabsStore.getState();
      const a = addTab();
      const b = addTab();
      setActive(a);
      markUnread(b);
      expect(useTabsStore.getState().unreadByTab[b]).toBe(1);
      // 切到 b → 它的未读应被清零
      setActive(b);
      expect(useTabsStore.getState().unreadByTab[b]).toBeUndefined();
    });

    it("clearUnread 直接调 → 该 tab 计数清零", () => {
      const { addTab, markUnread, setActive, clearUnread } =
        useTabsStore.getState();
      const a = addTab();
      const b = addTab();
      setActive(a);
      markUnread(b);
      expect(useTabsStore.getState().unreadByTab[b]).toBe(1);
      clearUnread(b);
      expect(useTabsStore.getState().unreadByTab[b]).toBeUndefined();
    });

    it("closeTab 顺手清理被关 tab 的 unread", () => {
      const { addTab, markUnread, setActive, closeTab } =
        useTabsStore.getState();
      const a = addTab();
      const b = addTab();
      setActive(a);
      markUnread(b);
      expect(useTabsStore.getState().unreadByTab[b]).toBe(1);
      closeTab(b);
      expect(useTabsStore.getState().unreadByTab[b]).toBeUndefined();
    });
  });

  describe("v1.1.0 R1：未读 badge 焦点门控 (bell-badge)", () => {
    it("窗口聚焦时：active tab 不计、后台 tab 照计（补全响铃不误 badge active）", () => {
      const { addTab, markUnread, setWindowFocused } = useTabsStore.getState();
      const a = addTab();
      const b = addTab(); // b 当前 active
      setWindowFocused(true); // 用户正看着窗口
      markUnread(b); // active + 聚焦 → 跳过（真机反馈：cd 补全响铃不该 badge）
      markUnread(a); // 后台 tab → 计数
      expect(useTabsStore.getState().unreadByTab[b]).toBeUndefined();
      expect(useTabsStore.getState().unreadByTab[a]).toBe(1);
    });

    it("窗口失焦时：active tab 也计数（切到别的 app，claude 完成要 badge）", () => {
      const { addTab, markUnread, setActive, setWindowFocused } =
        useTabsStore.getState();
      const a = addTab();
      const b = addTab(); // b 当前 active
      setWindowFocused(false); // 用户切到别的 app
      markUnread(b);
      markUnread(a);
      expect(useTabsStore.getState().unreadByTab[b]).toBe(1);
      expect(useTabsStore.getState().unreadByTab[a]).toBe(1);
      // 清零仍靠 setActive：点 / 切回该 tab 才已读
      setActive(b);
      expect(useTabsStore.getState().unreadByTab[b]).toBeUndefined();
      expect(useTabsStore.getState().unreadByTab[a]).toBe(1);
    });
  });

  describe("v0.9.0 T3：auto_title + applyCwdChange (OSC 7)", () => {
    it("addTab 默认 auto_title=true 且 cwd undefined", () => {
      const id = useTabsStore.getState().addTab();
      const tab = useTabsStore.getState().tabs.find((t) => t.id === id);
      expect(tab?.auto_title).toBe(true);
      expect(tab?.cwd).toBeUndefined();
    });

    it("applyCwdChange 在 auto_title=true 时刷 title 为 basename", () => {
      const { addTab, setSessionId, applyCwdChange } = useTabsStore.getState();
      const id = addTab();
      setSessionId(id, "sid-1");
      applyCwdChange("sid-1", "/Users/leo/proj/aitm");
      const tab = useTabsStore.getState().tabs.find((t) => t.id === id);
      expect(tab?.cwd).toBe("/Users/leo/proj/aitm");
      expect(tab?.title).toBe("aitm");
      expect(tab?.auto_title).toBe(true);
    });

    it("applyCwdChange 根目录时 title=/", () => {
      const { addTab, setSessionId, applyCwdChange } = useTabsStore.getState();
      const id = addTab();
      setSessionId(id, "sid-root");
      applyCwdChange("sid-root", "/");
      expect(
        useTabsStore.getState().tabs.find((t) => t.id === id)?.title,
      ).toBe("/");
    });

    it("setTitle 手改后 auto_title 自动转 false", () => {
      const { addTab, setTitle } = useTabsStore.getState();
      const id = addTab();
      setTitle(id, "my-custom");
      const tab = useTabsStore.getState().tabs.find((t) => t.id === id);
      expect(tab?.title).toBe("my-custom");
      expect(tab?.auto_title).toBe(false);
    });

    it("applyCwdChange 在 auto_title=false 时只更新 cwd 不动 title", () => {
      const { addTab, setSessionId, setTitle, applyCwdChange } =
        useTabsStore.getState();
      const id = addTab();
      setSessionId(id, "sid-2");
      setTitle(id, "我命名的"); // auto_title → false
      applyCwdChange("sid-2", "/Users/leo/proj/aitm");
      const tab = useTabsStore.getState().tabs.find((t) => t.id === id);
      expect(tab?.title).toBe("我命名的");
      expect(tab?.cwd).toBe("/Users/leo/proj/aitm");
      expect(tab?.auto_title).toBe(false);
    });

    it("setAutoTitle(true) + 已有 cwd → 立刻按 cwd 刷 title", () => {
      const { addTab, setSessionId, setTitle, applyCwdChange, setAutoTitle } =
        useTabsStore.getState();
      const id = addTab();
      setSessionId(id, "sid-3");
      applyCwdChange("sid-3", "/x/y/z"); // 此时 auto_title=true 已经把 title 改成 z
      setTitle(id, "我命名的"); // 切到手动 false
      expect(useTabsStore.getState().tabs.find((t) => t.id === id)?.title).toBe(
        "我命名的",
      );
      // 右键菜单 → setAutoTitle(true)
      setAutoTitle(id, true);
      const tab = useTabsStore.getState().tabs.find((t) => t.id === id);
      expect(tab?.auto_title).toBe(true);
      expect(tab?.title).toBe("z");
    });

    it("setAutoTitle(true) 但还没收过 cwd → 不动 title", () => {
      const { addTab, setTitle, setAutoTitle } = useTabsStore.getState();
      const id = addTab();
      setTitle(id, "x"); // auto_title=false
      setAutoTitle(id, true); // 无 cwd 缓存，不改 title
      const tab = useTabsStore.getState().tabs.find((t) => t.id === id);
      expect(tab?.auto_title).toBe(true);
      expect(tab?.title).toBe("x");
    });

    it("applyCwdChange 找不到对应 sessionId → noop（其他 tab 不受影响）", () => {
      const { addTab, setSessionId, applyCwdChange } = useTabsStore.getState();
      const a = addTab();
      setSessionId(a, "sid-a");
      applyCwdChange("sid-不存在", "/whatever");
      const tab = useTabsStore.getState().tabs.find((t) => t.id === a);
      // a 的 cwd 不应被错填
      expect(tab?.cwd).toBeUndefined();
      expect(tab?.title).toBe("新建标签");
    });

    it("v0.9.1 HR3-1：applyCwdChange 同步刷 last_cwd（持久化用）", () => {
      const { addTab, setSessionId, applyCwdChange } = useTabsStore.getState();
      const id = addTab();
      setSessionId(id, "sid-hr31");
      // 新 tab 默认 last_cwd undefined
      expect(
        useTabsStore.getState().tabs.find((t) => t.id === id)?.last_cwd,
      ).toBeUndefined();
      applyCwdChange("sid-hr31", "/Users/leo/proj/aitm");
      const tab = useTabsStore.getState().tabs.find((t) => t.id === id);
      expect(tab?.cwd).toBe("/Users/leo/proj/aitm");
      // last_cwd 与 cwd 同步，重启时由 snapshot 写盘
      expect(tab?.last_cwd).toBe("/Users/leo/proj/aitm");
    });

    it("v0.9.1 HR3-1：setLastCwd 直接写 last_cwd（restore 路径用）", () => {
      const { addTab, setLastCwd } = useTabsStore.getState();
      const id = addTab();
      // restore 时 App.tsx 把 snapshot.cwd 喂回 store
      setLastCwd(id, "/old/session/path");
      const tab = useTabsStore.getState().tabs.find((t) => t.id === id);
      expect(tab?.last_cwd).toBe("/old/session/path");
      // 不应影响实时 cwd（PTY 还没 OSC 7 上报呢）
      expect(tab?.cwd).toBeUndefined();
    });

    it("v0.9.1 HR3-1：setLastCwd(undefined) 清空 last_cwd", () => {
      const { addTab, setLastCwd } = useTabsStore.getState();
      const id = addTab();
      setLastCwd(id, "/x");
      setLastCwd(id, undefined);
      expect(
        useTabsStore.getState().tabs.find((t) => t.id === id)?.last_cwd,
      ).toBeUndefined();
    });

    it("basenameOrRoot helper 边界", () => {
      expect(basenameOrRoot("/Users/leo/code")).toBe("code");
      expect(basenameOrRoot("/")).toBe("/");
      expect(basenameOrRoot("")).toBe("/");
      expect(basenameOrRoot("/a/b/")).toBe("b");
      expect(basenameOrRoot("aitm")).toBe("aitm");
    });
  });

  describe("匿名统计 (v0.7.0-A)", () => {
    it("addTab 触发 tab_opened 事件 (无 props)", () => {
      useTabsStore.getState().addTab();
      expect(trackEventMock).toHaveBeenCalledTimes(1);
      expect(trackEventMock).toHaveBeenCalledWith("tab_opened");
    });

    it("addTab 多次每次都触发", () => {
      const { addTab } = useTabsStore.getState();
      addTab();
      addTab();
      addTab();
      expect(trackEventMock).toHaveBeenCalledTimes(3);
      expect(trackEventMock.mock.calls.every((c) => c[0] === "tab_opened")).toBe(
        true,
      );
    });

    it("closeTab / setActive 不触发 tab_opened", () => {
      const { addTab, closeTab, setActive } = useTabsStore.getState();
      const a = addTab();
      const b = addTab();
      trackEventMock.mockClear();
      setActive(a);
      closeTab(b);
      expect(trackEventMock).not.toHaveBeenCalled();
    });
  });
});
