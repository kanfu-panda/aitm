import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useShortcuts } from "../shortcuts";

/**
 * v0.9.1 HR3-5：浏览器快捷键 Cmd+Shift+B 单测。
 *
 * 覆盖：
 * - Cmd+Shift+B → 触发 toggleBrowser；其它快捷键（Cmd+T / Cmd+W / Cmd+,）保持
 * - Ctrl+Shift+B（Windows / Linux 等价键位）等价触发
 * - Cmd+B（无 Shift）→ 不触发 toggleBrowser（避免和 FileTree 占用冲突）
 *
 * 用一个小的"宿主组件"挂 useShortcuts；测试在 window 上 dispatch KeyboardEvent
 * 模拟全局按键。
 */

interface SpyHandlers {
  newTab: ReturnType<typeof vi.fn>;
  closeTab: ReturnType<typeof vi.fn>;
  nextTab: ReturnType<typeof vi.fn>;
  prevTab: ReturnType<typeof vi.fn>;
  openSettings: ReturnType<typeof vi.fn>;
  toggleSidebar: ReturnType<typeof vi.fn>;
  toggleBrowser: ReturnType<typeof vi.fn>;
  toggleFilePreview: ReturnType<typeof vi.fn>;
  splitVertical: ReturnType<typeof vi.fn>;
  splitHorizontal: ReturnType<typeof vi.fn>;
  closePane: ReturnType<typeof vi.fn>;
}

function makeSpies(): SpyHandlers {
  return {
    newTab: vi.fn(),
    closeTab: vi.fn(),
    nextTab: vi.fn(),
    prevTab: vi.fn(),
    openSettings: vi.fn(),
    toggleSidebar: vi.fn(),
    toggleBrowser: vi.fn(),
    toggleFilePreview: vi.fn(),
    splitVertical: vi.fn(),
    splitHorizontal: vi.fn(),
    closePane: vi.fn(),
  };
}

function Host({ h }: { h: SpyHandlers }) {
  useShortcuts(h);
  return null;
}

function fireMetaKey(
  key: string,
  opts: { shift?: boolean; meta?: boolean; ctrl?: boolean } = {},
) {
  const ev = new KeyboardEvent("keydown", {
    key,
    metaKey: opts.meta ?? true,
    ctrlKey: opts.ctrl ?? false,
    shiftKey: opts.shift ?? false,
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(ev);
}

describe("useShortcuts", () => {
  let h: SpyHandlers;

  beforeEach(() => {
    h = makeSpies();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("Cmd+Shift+B → 触发 toggleBrowser（不触发其它）", () => {
    render(<Host h={h} />);
    act(() => {
      fireMetaKey("B", { shift: true });
    });
    expect(h.toggleBrowser).toHaveBeenCalledTimes(1);
    expect(h.newTab).not.toHaveBeenCalled();
    expect(h.closeTab).not.toHaveBeenCalled();
    expect(h.openSettings).not.toHaveBeenCalled();
    expect(h.toggleSidebar).not.toHaveBeenCalled();
  });

  it("Cmd+B（无 Shift）不触发 toggleBrowser（FileTree 由 App.tsx 内联 effect 处理）", () => {
    render(<Host h={h} />);
    act(() => {
      fireMetaKey("b", { shift: false });
    });
    expect(h.toggleBrowser).not.toHaveBeenCalled();
  });

  it("Cmd+Shift+B 小写 key（'b'）也触发（防 shift 时 key 大小写差异）", () => {
    render(<Host h={h} />);
    act(() => {
      fireMetaKey("b", { shift: true });
    });
    expect(h.toggleBrowser).toHaveBeenCalledTimes(1);
  });

  it("Cmd+T → 触发 newTab（回归）", () => {
    render(<Host h={h} />);
    act(() => {
      fireMetaKey("t");
    });
    expect(h.newTab).toHaveBeenCalledTimes(1);
    expect(h.toggleBrowser).not.toHaveBeenCalled();
  });

  it("Cmd+W → 触发 closeTab（回归）", () => {
    render(<Host h={h} />);
    act(() => {
      fireMetaKey("w");
    });
    expect(h.closeTab).toHaveBeenCalledTimes(1);
  });

  it("Cmd+, → 触发 openSettings（回归）", () => {
    render(<Host h={h} />);
    act(() => {
      fireMetaKey(",");
    });
    expect(h.openSettings).toHaveBeenCalledTimes(1);
  });

  it("Cmd+/ → 触发 toggleSidebar（回归）", () => {
    render(<Host h={h} />);
    act(() => {
      fireMetaKey("/");
    });
    expect(h.toggleSidebar).toHaveBeenCalledTimes(1);
  });

  it("Cmd+Shift+E → 触发 toggleFilePreview（v0.10.0 HR9-6）", () => {
    render(<Host h={h} />);
    act(() => {
      fireMetaKey("E", { shift: true });
    });
    expect(h.toggleFilePreview).toHaveBeenCalledTimes(1);
    expect(h.toggleBrowser).not.toHaveBeenCalled();
    expect(h.toggleSidebar).not.toHaveBeenCalled();
  });

  it("Cmd+E（无 Shift）→ 不触发 toggleFilePreview", () => {
    render(<Host h={h} />);
    act(() => {
      fireMetaKey("e", { shift: false });
    });
    expect(h.toggleFilePreview).not.toHaveBeenCalled();
  });

  it("没有 meta 修饰键 → 全部 handler 不触发", () => {
    render(<Host h={h} />);
    act(() => {
      const ev = new KeyboardEvent("keydown", {
        key: "B",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(ev);
    });
    expect(h.toggleBrowser).not.toHaveBeenCalled();
  });

  // ============================================================
  // toggleBrowser 集成：模拟 App.tsx 内 useShortcuts 的 toggleBrowser
  // 实现（panelOpen 分支调 minimize / restore），断言 store 接口调对。
  // ============================================================

  it("toggleBrowser 集成：panelOpen=true → 调 minimizePanel", () => {
    const minimizePanel = vi.fn();
    const restorePanel = vi.fn();
    // 模拟 App.tsx 的 toggleBrowser 闭包；这里把 store 抽象成传入 getter
    const fakeStoreSnapshot = {
      panelOpen: true,
      minimizePanel,
      restorePanel,
    };
    const toggleBrowser = () => {
      if (fakeStoreSnapshot.panelOpen) {
        void fakeStoreSnapshot.minimizePanel();
      } else {
        void fakeStoreSnapshot.restorePanel({ x: 0, y: 0, w: 800, h: 600 });
      }
    };
    const spies: SpyHandlers = { ...makeSpies(), toggleBrowser: vi.fn(toggleBrowser) };
    render(<Host h={spies} />);
    act(() => {
      fireMetaKey("B", { shift: true });
    });
    expect(spies.toggleBrowser).toHaveBeenCalledTimes(1);
    expect(minimizePanel).toHaveBeenCalledTimes(1);
    expect(restorePanel).not.toHaveBeenCalled();
  });

  // ============================================================
  // v0.10.0 HR6-3d：Cmd+\\ / Cmd+Shift+\\ / Cmd+Shift+W 分屏快捷键
  // ============================================================

  it("Cmd+\\ → 触发 splitVertical（左右分屏，不触发 splitHorizontal / closePane）", () => {
    render(<Host h={h} />);
    act(() => {
      fireMetaKey("\\", { shift: false });
    });
    expect(h.splitVertical).toHaveBeenCalledTimes(1);
    expect(h.splitHorizontal).not.toHaveBeenCalled();
    expect(h.closePane).not.toHaveBeenCalled();
  });

  it("Cmd+Shift+\\ → 触发 splitHorizontal（上下分屏，不触发 splitVertical）", () => {
    render(<Host h={h} />);
    act(() => {
      fireMetaKey("\\", { shift: true });
    });
    expect(h.splitHorizontal).toHaveBeenCalledTimes(1);
    expect(h.splitVertical).not.toHaveBeenCalled();
    expect(h.closePane).not.toHaveBeenCalled();
  });

  it("Cmd+Shift+W → 触发 closePane（不触发 closeTab）", () => {
    render(<Host h={h} />);
    act(() => {
      fireMetaKey("W", { shift: true });
    });
    expect(h.closePane).toHaveBeenCalledTimes(1);
    expect(h.closeTab).not.toHaveBeenCalled();
  });

  it("Cmd+Shift+W 小写 'w' 也触发 closePane（兼容 shift 时 e.key 大小写差异）", () => {
    render(<Host h={h} />);
    act(() => {
      fireMetaKey("w", { shift: true });
    });
    expect(h.closePane).toHaveBeenCalledTimes(1);
    expect(h.closeTab).not.toHaveBeenCalled();
  });

  it("Cmd+W（无 Shift）仍走 closeTab 不触发 closePane（不冲突回归）", () => {
    render(<Host h={h} />);
    act(() => {
      fireMetaKey("w", { shift: false });
    });
    expect(h.closeTab).toHaveBeenCalledTimes(1);
    expect(h.closePane).not.toHaveBeenCalled();
  });

  it("Cmd+\\ 通过 e.code='Backslash' 也触发 splitVertical（备用键码识别）", () => {
    render(<Host h={h} />);
    act(() => {
      // 部分键盘布局 e.key 可能不是 "\\"，靠 e.code 兜底
      const ev = new KeyboardEvent("keydown", {
        key: "Dead", // 异常 key
        code: "Backslash",
        metaKey: true,
        shiftKey: false,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(ev);
    });
    expect(h.splitVertical).toHaveBeenCalledTimes(1);
  });

  it("没有 meta 修饰键 → Cmd+\\ / Cmd+Shift+W 都不触发", () => {
    render(<Host h={h} />);
    act(() => {
      fireMetaKey("\\", { meta: false, shift: false });
      fireMetaKey("\\", { meta: false, shift: true });
      fireMetaKey("w", { meta: false, shift: true });
    });
    expect(h.splitVertical).not.toHaveBeenCalled();
    expect(h.splitHorizontal).not.toHaveBeenCalled();
    expect(h.closePane).not.toHaveBeenCalled();
  });

  it("toggleBrowser 集成：panelOpen=false → 调 restorePanel（placeholder bounds）", () => {
    const minimizePanel = vi.fn();
    const restorePanel = vi.fn();
    const fakeStoreSnapshot = {
      panelOpen: false,
      minimizePanel,
      restorePanel,
    };
    const toggleBrowser = () => {
      if (fakeStoreSnapshot.panelOpen) {
        void fakeStoreSnapshot.minimizePanel();
      } else {
        void fakeStoreSnapshot.restorePanel({ x: 0, y: 0, w: 800, h: 600 });
      }
    };
    const spies: SpyHandlers = { ...makeSpies(), toggleBrowser: vi.fn(toggleBrowser) };
    render(<Host h={spies} />);
    act(() => {
      fireMetaKey("B", { shift: true });
    });
    expect(spies.toggleBrowser).toHaveBeenCalledTimes(1);
    expect(restorePanel).toHaveBeenCalledTimes(1);
    expect(restorePanel).toHaveBeenCalledWith({ x: 0, y: 0, w: 800, h: 600 });
    expect(minimizePanel).not.toHaveBeenCalled();
  });
});
