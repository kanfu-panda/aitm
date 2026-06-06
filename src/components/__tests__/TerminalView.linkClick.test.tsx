import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * v0.9.1 HR3-4：终端 URL 单击 → 拉起内嵌浏览器单测。
 *
 * 只测 [`handleTerminalLinkClick`] 导出函数本身（不挂载 TerminalView，避免 mock
 * 整个 xterm 实例 + WebGL + ResizeObserver 这条又重又脆的链）。
 *
 * mock 策略：mock 整个 `@xterm/xterm` 包让 TerminalView import 不爆，但实际单测
 * 只调 handler；同时 mock `../../stores/browser` 把 useBrowserStore.getState 返回
 * 可控的 stub，断言 restorePanel / openTab / event.preventDefault 是否被正确调用。
 */

// 拦截所有 xterm 包，让 TerminalView 顶层 import 在 jsdom 下不爆（避免去 new
// Terminal 时尝试访问 canvas / WebGL 这类 jsdom 不实现的东西）。
vi.mock("@xterm/xterm", () => ({
  Terminal: vi.fn(),
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn(),
}));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: vi.fn(),
}));
vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: vi.fn(),
}));

// Mock browser store：getState 返回可被替换的 stub
const restorePanelMock = vi.fn().mockResolvedValue(undefined);
const openTabMock = vi.fn().mockResolvedValue(undefined);
let panelOpenStub = false;
vi.mock("../../stores/browser", () => ({
  useBrowserStore: {
    getState: () => ({
      panelOpen: panelOpenStub,
      restorePanel: restorePanelMock,
      openTab: openTabMock,
    }),
  },
}));

// tabs store / settings store 不参与该测；不需要 mock 它们的内部逻辑
// （TerminalView 顶层 import 它们，但 handler 函数路径不访问）

import {
  TERMINAL_LINK_FALLBACK_BOUNDS,
  handleTerminalLinkClick,
} from "../TerminalView";

function makeEvent(): MouseEvent {
  const e = new MouseEvent("click", { bubbles: true, cancelable: true });
  // jsdom 的 MouseEvent.preventDefault 是真实现，spyOn 包一层断言被调
  vi.spyOn(e, "preventDefault");
  return e;
}

describe("HR3-4 handleTerminalLinkClick", () => {
  beforeEach(() => {
    restorePanelMock.mockClear();
    openTabMock.mockClear();
    panelOpenStub = false;
  });

  it("总是阻止 addon 默认动作（避免走 window.open 系统浏览器）", () => {
    panelOpenStub = true;
    const e = makeEvent();
    handleTerminalLinkClick(e, "https://github.com");
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("panelOpen=false 时调 restorePanel + openTab（双调）", () => {
    panelOpenStub = false;
    const e = makeEvent();
    handleTerminalLinkClick(e, "https://example.com/foo");

    expect(restorePanelMock).toHaveBeenCalledTimes(1);
    expect(restorePanelMock).toHaveBeenCalledWith(
      TERMINAL_LINK_FALLBACK_BOUNDS,
    );

    expect(openTabMock).toHaveBeenCalledTimes(1);
    expect(openTabMock).toHaveBeenCalledWith(
      "https://example.com/foo",
      TERMINAL_LINK_FALLBACK_BOUNDS,
    );
  });

  it("panelOpen=true 时只调 openTab，不调 restorePanel", () => {
    panelOpenStub = true;
    const e = makeEvent();
    handleTerminalLinkClick(e, "https://github.com/aitm");

    expect(restorePanelMock).not.toHaveBeenCalled();
    expect(openTabMock).toHaveBeenCalledTimes(1);
    expect(openTabMock).toHaveBeenCalledWith(
      "https://github.com/aitm",
      TERMINAL_LINK_FALLBACK_BOUNDS,
    );
  });

  it("fallback bounds 是 placeholder 800x600（BrowserPanel ResizeObserver 兜底纠正）", () => {
    expect(TERMINAL_LINK_FALLBACK_BOUNDS).toEqual({
      x: 0,
      y: 0,
      w: 800,
      h: 600,
    });
  });
});
