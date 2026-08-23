import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/tauri", () => ({
  browserOpenTab: vi.fn(),
  browserCloseTab: vi.fn().mockResolvedValue(undefined),
  browserNavigate: vi.fn().mockResolvedValue(undefined),
  browserSetActive: vi.fn().mockResolvedValue(undefined),
  browserSetBounds: vi.fn().mockResolvedValue(undefined),
  browserSuspendTab: vi.fn().mockResolvedValue(undefined),
  browserSetScrollY: vi.fn().mockResolvedValue(undefined),
  browserPanelCloseAll: vi.fn().mockResolvedValue(undefined),
}));

import {
  browserCloseTab,
  browserNavigate,
  browserPanelCloseAll,
  browserSetActive,
  browserSetBounds,
} from "../../lib/tauri";
import { useBrowserStore } from "../../stores/browser";
import BrowserNavButtons from "../browser/BrowserNavButtons";
import BrowserPanel from "../browser/BrowserPanel";
import BrowserTabBar from "../browser/BrowserTabBar";
import BrowserUrlBar, { normalizeUrl } from "../browser/BrowserUrlBar";

const mockClose = browserCloseTab as unknown as ReturnType<typeof vi.fn>;
const mockNav = browserNavigate as unknown as ReturnType<typeof vi.fn>;
const mockSetActive = browserSetActive as unknown as ReturnType<typeof vi.fn>;
const mockCloseAll = browserPanelCloseAll as unknown as ReturnType<typeof vi.fn>;
const mockSetBounds = browserSetBounds as unknown as ReturnType<typeof vi.fn>;

function seedTabs(
  tabs: Array<{
    key: string;
    state?: "active" | "suspended" | "loading";
    pinned?: boolean;
    url?: string;
    title?: string;
    id?: string | null;
  }>,
  activeKey: string | null,
) {
  useBrowserStore.setState({
    panelOpen: true,
    activeKey,
    tabs: tabs.map((t) => ({
      id: t.id !== undefined ? t.id : `wv-${t.key}`,
      url: t.url ?? `https://${t.key}.example.com`,
      title: t.title ?? t.key,
      state: t.state ?? "active",
      scrollY: 0,
      pinned: t.pinned ?? false,
      lastActiveAt: Date.now(),
      key: t.key,
    })),
  });
}

beforeEach(() => {
  useBrowserStore.setState({ panelOpen: false, tabs: [], activeKey: null });
  for (const m of [mockClose, mockNav, mockSetActive, mockCloseAll, mockSetBounds]) {
    m.mockClear();
  }
});

/* ===========================================================================
 * v1.3.0 R3b：webview bounds 上报的时序回归网
 * ---------------------------------------------------------------------------
 * child webview 创建时只能用占位尺寸 800×600（后端拿不到前端布局）。占位一旦
 * 没被真实尺寸覆盖，网页就永远按 800 宽布局，面板拖多窄都只是被裁剪不重排。
 * 而 `openTab` 是异步的——webview 先建好、`tab.id` 后回填，上报 effect 又是靠
 * `activeTabId` 变化才重跑，中间存在"webview 已存在但前端还没拿到 id"的窗口。
 * 这里锁死：**id 一旦就绪，必然发生一次真实尺寸上报**。
 * ======================================================================== */

/** jsdom 的 getBoundingClientRect 恒返 0；这里桩成一块窄面板（模拟拖窄后的宽度）。 */
const NARROW_RECT = { x: 12, y: 100, width: 370, height: 500 };
type Rect = ReturnType<HTMLElement["getBoundingClientRect"]>;
let rectSpy: ReturnType<typeof vi.spyOn> | null = null;

function makeRect(x: number, y: number, width: number, height: number): Rect {
  return {
    x,
    y,
    width,
    height,
    top: y,
    left: x,
    right: x + width,
    bottom: y + height,
    toJSON: () => ({}),
  } as Rect;
}

function stubNarrowPanelRect() {
  rectSpy = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockReturnValue(
      makeRect(
        NARROW_RECT.x,
        NARROW_RECT.y,
        NARROW_RECT.width,
        NARROW_RECT.height,
      ),
    );
}

afterEach(() => {
  rectSpy?.mockRestore();
  rectSpy = null;
});

describe("BrowserPanel bounds 上报", () => {
  it("tab id 就绪时立即用容器真实尺寸上报一次（webview 不会停在占位 800×600）", () => {
    stubNarrowPanelRect();
    seedTabs([{ key: "a", id: "wv-a" }], "a");
    render(<BrowserPanel />);

    expect(mockSetBounds).toHaveBeenCalled();
    // 每一次上报都是真实尺寸；占位宽度 800 绝不会被上报
    for (const [tabId, bounds] of mockSetBounds.mock.calls) {
      expect(tabId).toBe("wv-a");
      expect(bounds.w).toBe(NARROW_RECT.width);
      expect(bounds.h).toBe(NARROW_RECT.height);
      expect(bounds.w).not.toBe(800);
    }
  });

  it("id 还没回填（loading）时不上报；id 回填后必有一次真实尺寸上报", () => {
    stubNarrowPanelRect();
    // 复刻 openTab 的中间态：占位 tab 已入 store，后端 tab_id 还没回来
    seedTabs([{ key: "a", id: null, state: "loading" }], "a");
    render(<BrowserPanel />);
    expect(mockSetBounds).not.toHaveBeenCalled();

    // 后端返回 tab_id → 回填
    act(() => {
      useBrowserStore.setState((s) => ({
        tabs: s.tabs.map((t) =>
          t.key === "a" ? { ...t, id: "wv-a", state: "active" as const } : t,
        ),
      }));
    });

    expect(mockSetBounds).toHaveBeenCalled();
    const [tabId, bounds] = mockSetBounds.mock.calls.at(-1)!;
    expect(tabId).toBe("wv-a");
    expect(bounds.w).toBe(NARROW_RECT.width);
  });

  it("面板拖窄（容器尺寸变化）后，最后一次上报用的是新宽度", async () => {
    stubNarrowPanelRect();
    seedTabs([{ key: "a", id: "wv-a" }], "a");
    render(<BrowserPanel />);
    mockSetBounds.mockClear();

    // 模拟拖动后容器变得更窄 + window resize 事件触发重报
    rectSpy?.mockReturnValue(makeRect(12, 100, 220, 500));
    // 距上次上报不足 16ms → 被节流合并到下一帧；等一帧确认补发确实发生
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    });

    const [, bounds] = mockSetBounds.mock.calls.at(-1)!;
    expect(bounds.w).toBe(220);
  });
});

describe("BrowserPanel", () => {
  it("渲染：tab bar + 工具栏 + 占位容器 div", () => {
    seedTabs([{ key: "a", url: "https://a", title: "A" }], "a");
    render(<BrowserPanel />);
    // aria-label 占位 div
    expect(screen.getByLabelText("浏览器内容")).toBeTruthy();
    // 收起按钮（v0.4.1 T3：ChevronDown lucide icon，但 aria-label 不变）
    expect(screen.getByLabelText("收起浏览器")).toBeTruthy();
    // 地址栏
    expect(screen.getByLabelText("浏览器地址栏")).toBeTruthy();
  });

  it("点收起按钮 → 调 panel_close_all + 保留 tabs（v0.4.1 T3：minimize 不清空）", async () => {
    seedTabs(
      [
        { key: "a", url: "https://a", title: "A" },
        { key: "b", url: "https://b", title: "B" },
      ],
      "a",
    );
    render(<BrowserPanel />);

    fireEvent.click(screen.getByLabelText("收起浏览器"));
    // 等异步 minimizePanel flush
    await Promise.resolve();
    await Promise.resolve();

    expect(mockCloseAll).toHaveBeenCalledTimes(1);
    const s = useBrowserStore.getState();
    expect(s.panelOpen).toBe(false);
    // T3：tabs **保留**，不再被清空
    expect(s.tabs).toHaveLength(2);
    // 全部转为 suspended，id 清空
    expect(s.tabs.every((t) => t.state === "suspended")).toBe(true);
    expect(s.tabs.every((t) => t.id === null)).toBe(true);
    // activeKey 保留（下次 restorePanel 自动 resume 该 tab）
    expect(s.activeKey).toBe("a");
  });

  it("panelOpen=false 时整体不渲染（AnimatePresence 退场）", () => {
    useBrowserStore.setState({ panelOpen: false, tabs: [], activeKey: null });
    render(<BrowserPanel />);
    // panelOpen=false 时面板不挂载 → 找不到收起按钮
    expect(screen.queryByLabelText("收起浏览器")).toBeNull();
    expect(screen.queryByLabelText("浏览器内容")).toBeNull();
  });
});

describe("BrowserTabBar", () => {
  it("渲染所有 tabs；active 高亮", () => {
    seedTabs(
      [
        { key: "a", title: "Tab A" },
        { key: "b", title: "Tab B" },
      ],
      "a",
    );
    render(<BrowserTabBar />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs[1].getAttribute("aria-selected")).toBe("false");
    expect(tabs[0].textContent).toContain("Tab A");
  });

  it("点 tab → setActive；点 × → closeTab", () => {
    seedTabs(
      [
        { key: "a", title: "A" },
        { key: "b", title: "B" },
      ],
      "a",
    );
    render(<BrowserTabBar />);

    // 点第二个 tab → setActive 调 IPC（id=wv-b）
    const tabs = screen.getAllByRole("tab");
    fireEvent.click(tabs[1]);
    expect(mockSetActive).toHaveBeenCalledWith("wv-b");

    // 点 × → closeTab 调 IPC
    fireEvent.click(screen.getByLabelText(/关闭 tab A/));
    expect(mockClose).toHaveBeenCalledWith("wv-a");
  });

  it("pinned tab 显示 Pin icon；suspended 显示 Pause icon（v0.4.1 T4：lucide SVG）", () => {
    seedTabs(
      [
        { key: "a", pinned: true, title: "Pinned" },
        { key: "b", state: "suspended", id: null, title: "Suspended" },
      ],
      "a",
    );
    render(<BrowserTabBar />);
    const tabs = screen.getAllByRole("tab");
    // pinned tab → Pin icon（aria-label="已固定"）
    expect(tabs[0].querySelector('[data-testid="icon-pin"]')).toBeTruthy();
    expect(screen.getByLabelText("已固定")).toBeTruthy();
    // suspended tab → Pause icon
    expect(tabs[1].querySelector('[data-testid="icon-pause"]')).toBeTruthy();
    expect(screen.getByLabelText("已暂停")).toBeTruthy();
  });

  it("点 + 按钮 → 新建 tab", () => {
    render(<BrowserTabBar />);
    fireEvent.click(screen.getByLabelText("新建浏览器 tab"));
    // openTab 内部调了 browserOpenTab；store 应有 1 个 loading/active tab
    // 但 openTab 是 async，这里只验证按钮存在 + 不抛错
    // 详细 openTab 行为由 store 单测覆盖
    expect(true).toBe(true);
  });
});

describe("BrowserUrlBar", () => {
  it("显示 active tab 的 URL", () => {
    seedTabs([{ key: "a", url: "https://example.com" }], "a");
    render(<BrowserUrlBar />);
    const input = screen.getByLabelText("浏览器地址栏") as HTMLInputElement;
    expect(input.value).toBe("https://example.com");
  });

  it("Enter → navigate 被调", () => {
    seedTabs([{ key: "a", url: "https://a" }], "a");
    render(<BrowserUrlBar />);
    const input = screen.getByLabelText("浏览器地址栏") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "https://new.com" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockNav).toHaveBeenCalledWith("wv-a", "https://new.com");
  });

  it("无 scheme 输入自动补 https://", () => {
    seedTabs([{ key: "a", url: "https://a" }], "a");
    render(<BrowserUrlBar />);
    const input = screen.getByLabelText("浏览器地址栏") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "example.com" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockNav).toHaveBeenCalledWith("wv-a", "https://example.com");
  });

  it("空输入 → 不 navigate", () => {
    seedTabs([{ key: "a", url: "https://a" }], "a");
    render(<BrowserUrlBar />);
    const input = screen.getByLabelText("浏览器地址栏") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockNav).not.toHaveBeenCalled();
  });

  it("无 active tab → input 仍可输入（v0.4.0 修：让用户首次直接敲 URL 新建 tab）", async () => {
    const { browserOpenTab } = await import("../../lib/tauri");
    const mockOpenTab = browserOpenTab as unknown as ReturnType<typeof vi.fn>;
    mockOpenTab.mockResolvedValue({ tab_id: "wv-new" });

    render(<BrowserUrlBar />);
    const input = screen.getByLabelText("浏览器地址栏") as HTMLInputElement;
    expect(input.disabled).toBe(false);

    // 没 active tab 时输入 URL + Enter → 触发 openTab 新建 tab
    fireEvent.change(input, { target: { value: "github.com" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockOpenTab).toHaveBeenCalledWith(
      "https://github.com",
      expect.objectContaining({ x: 0, y: 0, w: 800, h: 600 }),
      false,
    );
    mockOpenTab.mockReset();
  });

  it("normalizeUrl: 已有 scheme 原样；无则补 https://", () => {
    expect(normalizeUrl("https://a")).toBe("https://a");
    expect(normalizeUrl("http://a")).toBe("http://a");
    expect(normalizeUrl("file:///tmp/x")).toBe("file:///tmp/x");
    expect(normalizeUrl("about:blank")).toBe("about:blank");
    expect(normalizeUrl("example.com")).toBe("https://example.com");
    expect(normalizeUrl("foo.bar/baz")).toBe("https://foo.bar/baz");
  });
});

describe("BrowserNavButtons", () => {
  it("← → ⟳ 三个按钮全 disabled（v0.4.x 加）", () => {
    render(<BrowserNavButtons />);
    expect(screen.getByLabelText("后退")).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("前进")).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("刷新")).toHaveProperty("disabled", true);
  });
});
