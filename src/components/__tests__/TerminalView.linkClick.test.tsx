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

  it("panelOpen=false 时**只**调 openTab —— 绝不再叠一次 restorePanel", () => {
    // 回归：旧实现两句都发且都不 await，restorePanel 在无 tab 时会兜底建一个
    // about:blank。两条链路各建一个 webview 又各自 set_active，谁后到谁赢；
    // 输的那个停在占位 (0,0,800,600) 且没人纠正 → 屏幕上一块错位黑块。
    panelOpenStub = false;
    const e = makeEvent();
    handleTerminalLinkClick(e, "https://example.com/foo");

    expect(restorePanelMock).not.toHaveBeenCalled();
    expect(openTabMock).toHaveBeenCalledTimes(1);
    expect(openTabMock).toHaveBeenCalledWith(
      "https://example.com/foo",
      TERMINAL_LINK_FALLBACK_BOUNDS,
    );
  });

  it("面板开着还是关着，行为完全一致（都只建一个 tab）", () => {
    panelOpenStub = false;
    handleTerminalLinkClick(makeEvent(), "https://example.com/a");
    const 关着时的调用 = openTabMock.mock.calls.length;
    openTabMock.mockClear();

    panelOpenStub = true;
    handleTerminalLinkClick(makeEvent(), "https://example.com/a");
    expect(openTabMock.mock.calls.length).toBe(关着时的调用);
    expect(restorePanelMock).not.toHaveBeenCalled();
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
