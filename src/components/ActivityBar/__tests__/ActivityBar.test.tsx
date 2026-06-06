import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityBar } from "../ActivityBar";
import { useBrowserStore } from "../../../stores/browser";
import { useSidebarStore } from "../../../stores/sidebar";
import {
  BAR_HEIGHT_HORIZONTAL,
  BAR_WIDTH_VERTICAL,
  TOOLTIP_DELAY_MS,
  type ActivityBarPosition,
} from "../constants";

// 浏览器 store 调 IPC（browserPanelCloseAll / browserOpenTab 等）— 全部 mock 掉
vi.mock("../../../lib/tauri", async (orig) => {
  const real = await orig<typeof import("../../../lib/tauri")>();
  return {
    ...real,
    browserPanelCloseAll: vi.fn().mockResolvedValue(undefined),
    browserOpenTab: vi.fn().mockResolvedValue({ tab_id: "wv-blank" }),
    browserSetActive: vi.fn().mockResolvedValue(undefined),
  };
});

/** 把所有用到的 zustand store 重置为初值。 */
function resetStores() {
  useSidebarStore.setState({
    open: false,
    fileTreeOpen: false,
  });
  useBrowserStore.setState({
    panelOpen: false,
    tabs: [],
    activeKey: null,
  });
}

describe("ActivityBar", () => {
  beforeEach(() => {
    resetStores();
  });

  afterEach(() => {
    resetStores();
  });

  // ============================================================
  // 1. 4 向布局（layout / 总尺寸）
  // ============================================================

  it.each<[ActivityBarPosition, "vertical" | "horizontal"]>([
    ["right", "vertical"],
    ["left", "vertical"],
    ["top", "horizontal"],
    ["bottom", "horizontal"],
  ])("position=%s 渲染为 %s bar", (position, kind) => {
    render(<ActivityBar position={position} onSettingsOpen={() => {}} />);
    const nav = screen.getByTestId("activity-bar");
    expect(nav.dataset.position).toBe(position);
    if (kind === "vertical") {
      expect(nav.className).toContain("flex-col");
      expect((nav as HTMLElement).style.width).toBe(`${BAR_WIDTH_VERTICAL}px`);
    } else {
      expect(nav.className).toContain("flex-row");
      expect((nav as HTMLElement).style.height).toBe(
        `${BAR_HEIGHT_HORIZONTAL}px`,
      );
    }
  });

  // ============================================================
  // 2. 项目顺序（AI → Browser → spacer → Settings）
  // ============================================================

  it("项目顺序：Sparkles → Globe → Folder → FilePreview → spacer → Settings", () => {
    render(<ActivityBar position="right" onSettingsOpen={() => {}} />);
    const ai = screen.getByTestId("activity-bar-item-ai");
    const browser = screen.getByTestId("activity-bar-item-browser");
    const fileTree = screen.getByTestId("activity-bar-item-file-tree");
    const filePreview = screen.getByTestId("activity-bar-item-file-preview");
    const spacer = screen.getByTestId("activity-bar-spacer");
    const settings = screen.getByTestId("activity-bar-item-settings");

    // 同一父容器（nav）下的 DOM 顺序
    // v0.10.0 HR9-6：文件预览按钮常驻（之前条件渲染——只有 openFiles>0 才显示），
    //   跟浏览器按钮一致；没文件时 disabled 灰显但仍占位。
    const nav = screen.getByTestId("activity-bar");
    const items = Array.from(nav.children) as HTMLElement[];
    expect(items[0].contains(ai)).toBe(true);
    expect(items[1].contains(browser)).toBe(true);
    expect(items[2].contains(fileTree)).toBe(true);
    expect(items[3].contains(filePreview)).toBe(true);
    expect(items[4]).toBe(spacer);
    expect(items[5].contains(settings)).toBe(true);
  });

  // ============================================================
  // 2.1 文件树按钮（v0.4.2 patch T1）
  // ============================================================

  it("渲染文件树按钮（testId=activity-bar-item-file-tree）", () => {
    render(<ActivityBar position="right" onSettingsOpen={() => {}} />);
    const btn = screen.getByTestId("activity-bar-item-file-tree");
    expect(btn).toBeTruthy();
    expect(btn.getAttribute("aria-label")).toBe("文件树");
  });

  it("点文件树按钮触发 toggleFileTree", () => {
    render(<ActivityBar position="right" onSettingsOpen={() => {}} />);
    expect(useSidebarStore.getState().fileTreeOpen).toBe(false);
    fireEvent.click(screen.getByTestId("activity-bar-item-file-tree"));
    expect(useSidebarStore.getState().fileTreeOpen).toBe(true);
    fireEvent.click(screen.getByTestId("activity-bar-item-file-tree"));
    expect(useSidebarStore.getState().fileTreeOpen).toBe(false);
  });

  it("fileTreeOpen=true 时文件树按钮 emerald active", () => {
    act(() => {
      useSidebarStore.setState({ fileTreeOpen: true });
    });
    render(<ActivityBar position="right" onSettingsOpen={() => {}} />);
    const btn = screen.getByTestId("activity-bar-item-file-tree");
    expect(btn.dataset.active).toBe("true");
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(btn.className).toContain("text-[var(--c-success-fg)]");
  });

  // ============================================================
  // 3. 点击行为（toggleAi / browser open|close / onSettingsOpen）
  // ============================================================

  it("点 AI 按钮触发 toggleAi", () => {
    render(<ActivityBar position="right" onSettingsOpen={() => {}} />);
    expect(useSidebarStore.getState().open).toBe(false);
    fireEvent.click(screen.getByTestId("activity-bar-item-ai"));
    expect(useSidebarStore.getState().open).toBe(true);
    fireEvent.click(screen.getByTestId("activity-bar-item-ai"));
    expect(useSidebarStore.getState().open).toBe(false);
  });

  it("点浏览器按钮（panelOpen=false 且 tabs 为空）触发 restorePanel：自动新建 about:blank（v0.9.1 HR3-7）", async () => {
    render(<ActivityBar position="right" onSettingsOpen={() => {}} />);
    expect(useBrowserStore.getState().panelOpen).toBe(false);
    expect(useBrowserStore.getState().tabs).toEqual([]);
    fireEvent.click(screen.getByTestId("activity-bar-item-browser"));
    // restorePanel 是 async；等 microtask 队列让 openTab 跑完
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const s = useBrowserStore.getState();
    expect(s.panelOpen).toBe(true);
    // 兜底新建 about:blank tab，保证浏览器打开时至少 1 个 tab（不再出现空 URL 栏壳）
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0].url).toBe("about:blank");
    expect(s.activeKey).toBe(s.tabs[0].key);
  });

  it("点浏览器按钮（panelOpen=true）触发 minimizePanel：保留 tabs，仅 destroy webview（v0.4.1 T3）", async () => {
    // 准备 panelOpen=true + 1 个 active tab
    act(() => {
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
    });
    render(<ActivityBar position="right" onSettingsOpen={() => {}} />);
    fireEvent.click(screen.getByTestId("activity-bar-item-browser"));
    // minimizePanel 是 async；等 microtask 队列让它跑完
    await Promise.resolve();
    await Promise.resolve();
    const s = useBrowserStore.getState();
    // panelOpen 关闭，但 tabs 保留
    expect(s.panelOpen).toBe(false);
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0].state).toBe("suspended");
    expect(s.tabs[0].id).toBeNull();
    expect(s.activeKey).toBe("k1");
  });

  it("点浏览器按钮（panelOpen=false 且 tabs 非空）触发 restorePanel：resume active tab（v0.4.1 T3）", async () => {
    // 准备 minimize 后的 state
    act(() => {
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
            lastActiveAt: 0,
            key: "k1",
          },
        ],
        activeKey: "k1",
      });
    });
    render(<ActivityBar position="right" onSettingsOpen={() => {}} />);
    fireEvent.click(screen.getByTestId("activity-bar-item-browser"));
    await Promise.resolve();
    await Promise.resolve();
    const s = useBrowserStore.getState();
    expect(s.panelOpen).toBe(true);
    expect(s.activeKey).toBe("k1");
  });

  // ============================================================
  // 3.1 浏览器 badge（plan §5.4：仅 panelOpen=false 且 tabs > 0 显示）
  // ============================================================

  it("浏览器 badge：panelOpen=false 且 tabs > 0 → 显示数字 badge", () => {
    act(() => {
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
            lastActiveAt: 0,
            key: "k1",
          },
          {
            id: null,
            url: "https://b",
            title: "B",
            state: "suspended",
            scrollY: 0,
            pinned: false,
            lastActiveAt: 0,
            key: "k2",
          },
        ],
        activeKey: "k1",
      });
    });
    render(<ActivityBar position="right" onSettingsOpen={() => {}} />);
    const badge = screen.getByTestId("activity-bar-badge");
    expect(badge.textContent).toBe("2");
  });

  it("浏览器 badge：panelOpen=true → 不显示（即使 tabs > 0）", () => {
    act(() => {
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
    });
    render(<ActivityBar position="right" onSettingsOpen={() => {}} />);
    expect(screen.queryByTestId("activity-bar-badge")).toBeNull();
  });

  it("浏览器 badge：tabs.length=0 → 不显示", () => {
    render(<ActivityBar position="right" onSettingsOpen={() => {}} />);
    expect(screen.queryByTestId("activity-bar-badge")).toBeNull();
  });

  // ============================================================
  // 3.2 浏览器右键菜单 → 关闭所有标签（destructive）
  // ============================================================

  it("浏览器按钮右键 → 弹 context menu，显示标签数", () => {
    act(() => {
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
            lastActiveAt: 0,
            key: "k1",
          },
          {
            id: null,
            url: "https://b",
            title: "B",
            state: "suspended",
            scrollY: 0,
            pinned: false,
            lastActiveAt: 0,
            key: "k2",
          },
        ],
        activeKey: "k1",
      });
    });
    render(<ActivityBar position="right" onSettingsOpen={() => {}} />);
    // 右键浏览器按钮的 wrapper（onContextMenu 在 wrapper 上）
    const browserBtn = screen.getByTestId("activity-bar-item-browser");
    const wrapper = browserBtn.parentElement!;
    fireEvent.contextMenu(wrapper);
    const menu = screen.getByTestId("activity-bar-browser-context-menu");
    expect(menu).toBeTruthy();
    expect(menu.textContent).toContain("关闭所有标签 (2)");
  });

  it("点 context menu 关闭所有标签 → 弹 confirm；确认 → closePanel 清空", async () => {
    act(() => {
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
            lastActiveAt: 0,
            key: "k1",
          },
        ],
        activeKey: "k1",
      });
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<ActivityBar position="right" onSettingsOpen={() => {}} />);
    const browserBtn = screen.getByTestId("activity-bar-item-browser");
    fireEvent.contextMenu(browserBtn.parentElement!);
    fireEvent.click(screen.getByTestId("activity-bar-browser-close-all"));
    await Promise.resolve();
    await Promise.resolve();
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const s = useBrowserStore.getState();
    // closePanel：tabs 全清空
    expect(s.tabs).toEqual([]);
    expect(s.activeKey).toBeNull();
    confirmSpy.mockRestore();
  });

  it("context menu 关闭所有标签 confirm 取消 → state 不变", async () => {
    act(() => {
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
            lastActiveAt: 0,
            key: "k1",
          },
        ],
        activeKey: "k1",
      });
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<ActivityBar position="right" onSettingsOpen={() => {}} />);
    const browserBtn = screen.getByTestId("activity-bar-item-browser");
    fireEvent.contextMenu(browserBtn.parentElement!);
    fireEvent.click(screen.getByTestId("activity-bar-browser-close-all"));
    await Promise.resolve();
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    // tabs 不变
    expect(useBrowserStore.getState().tabs).toHaveLength(1);
    confirmSpy.mockRestore();
  });

  it("点设置按钮触发 onSettingsOpen prop", () => {
    const onOpen = vi.fn();
    render(<ActivityBar position="right" onSettingsOpen={onOpen} />);
    fireEvent.click(screen.getByTestId("activity-bar-item-settings"));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  // ============================================================
  // 4. active 状态视觉
  // ============================================================

  it("AI sidebar 打开时 AI 按钮 emerald active", () => {
    act(() => {
      useSidebarStore.setState({ open: true });
    });
    render(<ActivityBar position="right" onSettingsOpen={() => {}} />);
    const ai = screen.getByTestId("activity-bar-item-ai");
    expect(ai.dataset.active).toBe("true");
    expect(ai.getAttribute("aria-pressed")).toBe("true");
    expect(ai.className).toContain("text-[var(--c-success-fg)]");
  });

  it("浏览器 panelOpen 时 Globe 按钮 emerald active", () => {
    act(() => {
      useBrowserStore.setState({ panelOpen: true });
    });
    render(<ActivityBar position="right" onSettingsOpen={() => {}} />);
    const browser = screen.getByTestId("activity-bar-item-browser");
    expect(browser.dataset.active).toBe("true");
    expect(browser.className).toContain("text-[var(--c-success-fg)]");
  });

  // ============================================================
  // 5. active 边条方向（plan §4.5）
  // ============================================================

  it.each<[ActivityBarPosition, string]>([
    ["right", "left-0"],
    ["left", "right-0"],
    ["top", "bottom-0"],
    ["bottom", "top-0"],
  ])(
    "position=%s 时 active 边条 className 含 %s（朝内容区）",
    (position, expectedClass) => {
      act(() => {
        useSidebarStore.setState({ open: true });
      });
      render(<ActivityBar position={position} onSettingsOpen={() => {}} />);
      const indicators = screen.getAllByTestId("activity-bar-indicator");
      // AI 按钮 active → 至少 1 个 indicator
      expect(indicators.length).toBeGreaterThan(0);
      indicators.forEach((ind) => {
        expect(ind.className).toContain(expectedClass);
      });
    },
  );

  // ============================================================
  // 6. Tooltip hover 600ms 显示
  // ============================================================

  it("hover 600ms 后 tooltip 出现，mouseleave 立即消失", () => {
    vi.useFakeTimers();
    try {
      render(<ActivityBar position="right" onSettingsOpen={() => {}} />);
      const ai = screen.getByTestId("activity-bar-item-ai");

      // 没 hover：tooltip 不存在
      expect(screen.queryByTestId("activity-bar-tooltip")).toBeNull();

      // hover 进入但没到 600ms：仍不存在
      fireEvent.mouseEnter(ai);
      act(() => {
        vi.advanceTimersByTime(TOOLTIP_DELAY_MS - 1);
      });
      expect(screen.queryByTestId("activity-bar-tooltip")).toBeNull();

      // 跨过 delay → 出现
      act(() => {
        vi.advanceTimersByTime(2);
      });
      const tip = screen.getByTestId("activity-bar-tooltip");
      expect(tip.textContent).toContain("AI 助手");
      // v0.10.0 HR7-5：AI 助手快捷键 ⌘E → ⌘/ 对齐 useShortcuts 实际绑定。
      expect(tip.textContent).toContain("⌘/"); // shortcut chip

      // 离开立即消失
      fireEvent.mouseLeave(ai);
      expect(screen.queryByTestId("activity-bar-tooltip")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // ============================================================
  // 6.1 浏览器 tooltip 含快捷键 ⌘⇧B（v0.9.1 HR3-5）
  // ============================================================

  it("浏览器按钮 hover tooltip 含 ⌘⇧B 快捷键（v0.9.1 HR3-5）", () => {
    vi.useFakeTimers();
    try {
      render(<ActivityBar position="right" onSettingsOpen={() => {}} />);
      const browserBtn = screen.getByTestId("activity-bar-item-browser");
      fireEvent.mouseEnter(browserBtn);
      act(() => {
        vi.advanceTimersByTime(TOOLTIP_DELAY_MS + 1);
      });
      const tip = screen.getByTestId("activity-bar-tooltip");
      expect(tip.textContent).toContain("浏览器");
      expect(tip.textContent).toContain("⌘⇧B"); // shortcut chip
    } finally {
      vi.useRealTimers();
    }
  });

  // ============================================================
  // 7. Tooltip 方向 data attribute（确保 portal 标 position）
  // ============================================================

  it.each<ActivityBarPosition>(["right", "left", "top", "bottom"])(
    "position=%s 时 tooltip 标 data-position 与 bar 一致",
    (position) => {
      vi.useFakeTimers();
      try {
        render(<ActivityBar position={position} onSettingsOpen={() => {}} />);
        const ai = screen.getByTestId("activity-bar-item-ai");
        fireEvent.mouseEnter(ai);
        act(() => {
          vi.advanceTimersByTime(TOOLTIP_DELAY_MS + 1);
        });
        const tip = screen.getByTestId("activity-bar-tooltip");
        expect(tip.dataset.position).toBe(position);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  // ============================================================
  // 8. a11y：aria-label 命中
  // ============================================================

  it("4 个按钮都有 aria-label", () => {
    render(<ActivityBar position="right" onSettingsOpen={() => {}} />);
    expect(screen.getByLabelText("AI 助手")).toBeInTheDocument();
    expect(screen.getByLabelText("浏览器")).toBeInTheDocument();
    expect(screen.getByLabelText("文件树")).toBeInTheDocument();
    expect(screen.getByLabelText("设置")).toBeInTheDocument();
  });
});
