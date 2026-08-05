import { beforeEach, describe, expect, it, vi } from "vitest";

// mock IPC：store 会调的 browser_* + 新增的 browserOpenResult
vi.mock("../tauri", () => ({
  browserOpenTab: vi.fn(),
  browserCloseTab: vi.fn().mockResolvedValue(undefined),
  browserNavigate: vi.fn().mockResolvedValue(undefined),
  browserSetActive: vi.fn().mockResolvedValue(undefined),
  browserClearActive: vi.fn().mockResolvedValue(undefined),
  browserSetBounds: vi.fn().mockResolvedValue(undefined),
  browserSuspendTab: vi.fn().mockResolvedValue(undefined),
  browserSetScrollY: vi.fn().mockResolvedValue(undefined),
  browserPanelCloseAll: vi.fn().mockResolvedValue(undefined),
  browserOpenResult: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../analytics", () => ({ trackEvent: vi.fn() }));

import {
  browserNavigate,
  browserOpenResult,
  browserOpenTab,
  browserPanelCloseAll,
  browserSetActive,
} from "../tauri";
import { useBrowserStore } from "../../stores/browser";
import {
  PLACEHOLDER_BROWSER_BOUNDS,
  handleBrowserOpenRequested,
  __resetHandledOpenRequests,
} from "../browserOpenRequest";

const openTabMock = browserOpenTab as unknown as ReturnType<typeof vi.fn>;
const navigateMock = browserNavigate as unknown as ReturnType<typeof vi.fn>;
const openResultMock = browserOpenResult as unknown as ReturnType<typeof vi.fn>;
const closeAllMock = browserPanelCloseAll as unknown as ReturnType<typeof vi.fn>;
const setActiveMock = browserSetActive as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  useBrowserStore.setState({
    panelOpen: false,
    tabs: [],
    activeKey: null,
    activeSyncError: null,
  });
  openTabMock.mockReset();
  setActiveMock.mockReset();
  setActiveMock.mockResolvedValue(undefined);
  navigateMock.mockClear();
  openResultMock.mockClear();
  closeAllMock.mockClear();
  __resetHandledOpenRequests();
  let n = 0;
  openTabMock.mockImplementation(async () => {
    n += 1;
    return { tab_id: `mock-tab-${n}` };
  });
});

describe("handleBrowserOpenRequested（AI 请求打开内嵌浏览器）", () => {
  it("没有任何 tab 时新建 tab 并把 tab_id 回报后端", async () => {
    await handleBrowserOpenRequested({
      request_id: "open-1",
      url: "https://example.com",
    });

    expect(openTabMock).toHaveBeenCalledTimes(1);
    expect(openTabMock).toHaveBeenCalledWith(
      "https://example.com",
      PLACEHOLDER_BROWSER_BOUNDS,
    );
    // 面板打开 + tab 变 active
    expect(useBrowserStore.getState().panelOpen).toBe(true);
    expect(openResultMock).toHaveBeenCalledWith("open-1", true, "mock-tab-1", null);
  });

  it("url 为 null 时开 about:blank", async () => {
    await handleBrowserOpenRequested({ request_id: "open-2", url: null });
    expect(openTabMock).toHaveBeenCalledWith(
      "about:blank",
      PLACEHOLDER_BROWSER_BOUNDS,
    );
    expect(openResultMock).toHaveBeenCalledWith("open-2", true, "mock-tab-1", null);
  });

  it("已有 suspended tab（面板收起）时走 restorePanel 恢复并导航到目标 url", async () => {
    useBrowserStore.setState({
      panelOpen: false,
      activeKey: "k1",
      tabs: [
        {
          id: null,
          url: "https://old.example",
          title: "old",
          state: "suspended",
          scrollY: 0,
          pinned: false,
          lastActiveAt: 0,
          key: "k1",
        },
      ],
    });

    await handleBrowserOpenRequested({
      request_id: "open-3",
      url: "https://new.example",
    });

    // restorePanel → resumeTab 重建 webview（复用既有 tab，不新建第二个 tab）
    expect(openTabMock).toHaveBeenCalledTimes(1);
    expect(useBrowserStore.getState().tabs).toHaveLength(1);
    expect(useBrowserStore.getState().panelOpen).toBe(true);
    // 恢复后导航到 AI 指定的 url
    expect(navigateMock).toHaveBeenCalledWith("mock-tab-1", "https://new.example");
    expect(openResultMock).toHaveBeenCalledWith("open-3", true, "mock-tab-1", null);
  });

  it("已有 tab 但 AI 没给 url 时只恢复面板不导航", async () => {
    useBrowserStore.setState({
      panelOpen: false,
      activeKey: "k1",
      tabs: [
        {
          id: null,
          url: "https://old.example",
          title: "old",
          state: "suspended",
          scrollY: 0,
          pinned: false,
          lastActiveAt: 0,
          key: "k1",
        },
      ],
    });

    await handleBrowserOpenRequested({ request_id: "open-4", url: null });

    expect(navigateMock).not.toHaveBeenCalled();
    expect(openResultMock).toHaveBeenCalledWith("open-4", true, "mock-tab-1", null);
  });

  it("后端 openTab 失败时回报 ok=false（绝不谎报成功）", async () => {
    openTabMock.mockRejectedValue(new Error("add_child 失败"));

    await handleBrowserOpenRequested({
      request_id: "open-5",
      url: "https://example.com",
    });

    expect(openResultMock).toHaveBeenCalledTimes(1);
    const call = openResultMock.mock.calls[0];
    expect(call[0]).toBe("open-5");
    expect(call[1]).toBe(false);
    expect(call[2]).toBeNull();
    expect(String(call[3])).not.toBe("");
  });

  it("前后端 active tab 失步时回报 ok=false（绝不把可能是 ghost 的 tab_id 交给 AI）", async () => {
    // v1.3.0 P7：set_active 反复失败 → 后端不知道哪个 webview 可见；
    // 这时候把 tab_id 交给 AI，AI 很可能操作到用户看不见的 webview。
    setActiveMock.mockRejectedValue(new Error("set_active 炸了"));

    await handleBrowserOpenRequested({
      request_id: "open-7",
      url: "https://example.com",
    });

    expect(openResultMock).toHaveBeenCalledTimes(1);
    const call = openResultMock.mock.calls[0];
    expect(call[1]).toBe(false);
    expect(call[2]).toBeNull();
    expect(String(call[3])).toContain("失步");
  });

  it("同一 request_id 重复触发只处理一次（防 StrictMode 双订阅重复开 tab）", async () => {
    const ev = { request_id: "open-6", url: "https://example.com" };
    await Promise.all([
      handleBrowserOpenRequested(ev),
      handleBrowserOpenRequested(ev),
    ]);
    expect(openTabMock).toHaveBeenCalledTimes(1);
    expect(openResultMock).toHaveBeenCalledTimes(1);
  });
});
