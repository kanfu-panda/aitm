/* =============================================================================
 * TerminalView 组件单测。
 * -----------------------------------------------------------------------------
 * TerminalView 真挂 @xterm/xterm，jsdom 里跑不动真实终端渲染（canvas / WebGL），
 * 所以这里对 @xterm/xterm、@xterm/addon-fit、@xterm/addon-web-links 三个包做
 * 假实现（记录调用 + 暴露触发 onData 的手段），让组件按真实生命周期挂载/卸载，
 * 只是底下换成一个可观察的假终端。
 *
 * IPC 一侧对 `../../lib/tauri` 做部分替换（保留其余真实导出，参考
 * StatusBar.test.tsx 的写法）；`openSessionWithOutput`（先订阅再开 PTY 的封装，
 * 已有独立单测 src/lib/__tests__/openSessionWithOutput.test.ts）整体 mock 掉，
 * 这里只关心 TerminalView 怎么用它的返回值/参数，不重复测它内部的时序保证。
 *
 * 覆盖点（对应任务要求）：
 * - 挂载后打开新会话并回调 onSessionOpened；已有 sessionId 时改走订阅而不重开
 * - 收到 PTY 输出写入 xterm；用户在 xterm 输入写回 PTY
 * - initialInput 打开后写入一次并回调 onInitialInputConsumed
 * - isActive 为真/假对应聚焦与否
 * - 容器尺寸变化触发 fit + sessionResize
 * - 会话退出事件触发 onExit
 * - 卸载时取消订阅 + dispose
 * - 额外：sessionOpen 失败时的错误 banner；StrictMode 双 mount race 的关闭路径；
 *   settings 热更新与 theme_mode=auto 的系统主题跟随
 * ========================================================================== */

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSettingsStore } from "../../stores/settings";

/** attachCustomWheelEventHandler 回调只读 deltaY/deltaMode，不用真 WheelEvent
 *  （jsdom 有实现，但 eslint 全局白名单没收它，用自定义最小形状规避 no-undef）。 */
interface FakeWheelEvent {
  deltaY: number;
  deltaMode: number;
}

// ============================================================================
// @xterm/* 假实现：记录调用 + 暴露触发 onData 的手段，避免在 jsdom 里起真终端。
// 用 vi.hoisted 定义，规避 vi.mock 工厂的临时性死区（TDZ）问题。
// ============================================================================
const xtermMocks = vi.hoisted(() => {
  class FakeTerminal {
    static instances: FakeTerminal[] = [];
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    buffer = {
      active: {
        type: "normal" as "normal" | "alternate",
        viewportY: 0,
        baseY: 0,
      },
    };
    modes = {
      mouseTrackingMode: "none" as "none" | "x10" | "vt200" | "drag" | "any",
      applicationCursorKeysMode: false,
    };
    writes: Uint8Array[] = [];
    disposed = false;
    focusCalls = 0;
    onDataCb: ((data: string) => void) | null = null;
    loadedAddons: unknown[] = [];
    openedWith: unknown = null;
    /** 断言用：Cmd+C 复制分支读的"当前选区"，测试里直接赋值模拟已选中文本。 */
    selectionValue = "";
    /** attachCustomKeyEventHandler 注册的回调，测试里直接调用模拟 keydown。 */
    customKeyHandler: ((e: KeyboardEvent) => boolean) | null = null;
    /** attachCustomWheelEventHandler 注册的回调，测试里直接调用模拟滚轮事件。 */
    customWheelHandler: ((e: FakeWheelEvent) => boolean) | null = null;

    constructor(options: Record<string, unknown>) {
      this.options = options;
      FakeTerminal.instances.push(this);
    }
    loadAddon(addon: unknown): void {
      this.loadedAddons.push(addon);
    }
    open(container: unknown): void {
      this.openedWith = container;
    }
    write(bytes: Uint8Array, cb?: () => void): void {
      this.writes.push(bytes);
      cb?.();
    }
    onData(cb: (data: string) => void): { dispose(): void } {
      this.onDataCb = cb;
      return { dispose() {} };
    }
    attachCustomKeyEventHandler(cb: (e: KeyboardEvent) => boolean): void {
      this.customKeyHandler = cb;
    }
    attachCustomWheelEventHandler(cb: (e: FakeWheelEvent) => boolean): void {
      this.customWheelHandler = cb;
    }
    getSelection(): string {
      return this.selectionValue;
    }
    scrollToLine(_line: number): void {}
    refresh(_start: number, _end: number): void {}
    focus(): void {
      this.focusCalls += 1;
    }
    dispose(): void {
      this.disposed = true;
    }
  }

  class FakeFitAddon {
    static instances: FakeFitAddon[] = [];
    fitCalls = 0;
    constructor() {
      FakeFitAddon.instances.push(this);
    }
    fit(): void {
      this.fitCalls += 1;
    }
  }

  class FakeWebLinksAddon {
    constructor(public handler: unknown) {}
  }

  return { FakeTerminal, FakeFitAddon, FakeWebLinksAddon };
});

vi.mock("@xterm/xterm", () => ({ Terminal: xtermMocks.FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: xtermMocks.FakeFitAddon }));
vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: xtermMocks.FakeWebLinksAddon,
}));

// ============================================================================
// session IPC 假实现：sessionOpen/Write/Resize/Close + onSessionData/onSessionExit
// 走 `../../lib/tauri` 部分替换；openSessionWithOutput 整体 mock。
// ============================================================================
const sessionMocks = vi.hoisted(() => ({
  openSessionWithOutputMock: vi.fn<
    (
      open: () => Promise<string>,
      onBytes: (bytes: Uint8Array) => void,
    ) => Promise<{ id: string; unlisten: () => void }>
  >(),
  sessionOpenMock: vi.fn<
    (cfg: { cols: number; rows: number; cwd?: string | null }) => Promise<string>
  >(),
  sessionWriteMock: vi.fn<(id: string, bytes: Uint8Array) => Promise<void>>(),
  sessionResizeMock: vi.fn<
    (id: string, cols: number, rows: number) => Promise<void>
  >(),
  sessionCloseMock: vi.fn<(id: string) => Promise<void>>(),
  onSessionDataMock: vi.fn<
    (id: string, cb: (bytes: Uint8Array) => void) => Promise<() => void>
  >(),
  onSessionExitMock: vi.fn<(id: string, cb: () => void) => Promise<() => void>>(),
}));

vi.mock("../../lib/openSessionWithOutput", () => ({
  openSessionWithOutput: sessionMocks.openSessionWithOutputMock,
}));

vi.mock("../../lib/tauri", async (orig) => {
  const real = await orig<typeof import("../../lib/tauri")>();
  return {
    ...real,
    sessionOpen: sessionMocks.sessionOpenMock,
    sessionWrite: sessionMocks.sessionWriteMock,
    sessionResize: sessionMocks.sessionResizeMock,
    sessionClose: sessionMocks.sessionCloseMock,
    onSessionData: sessionMocks.onSessionDataMock,
    onSessionExit: sessionMocks.onSessionExitMock,
  };
});

import TerminalView from "../TerminalView";

// ============================================================================
// ResizeObserver 假实现：暴露 trigger() 手动触发一次 resize 回调。
// 不放进 vi.hoisted —— 不在任何 vi.mock 工厂里引用，直接挂到 globalThis 即可。
// ============================================================================
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  callback: ResizeObserverCallback;
  observed: Element[] = [];
  disconnectMock = vi.fn();

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    FakeResizeObserver.instances.push(this);
  }
  observe(el: Element): void {
    this.observed.push(el);
  }
  unobserve(): void {}
  disconnect(): void {
    this.disconnectMock();
  }
  trigger(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
}

const originalSettings = useSettingsStore.getState().settings;
const originalMatchMedia = window.matchMedia;
const originalResizeObserver = globalThis.ResizeObserver;

let unlistenDataMock: ReturnType<typeof vi.fn>;
let unlistenExitMock: ReturnType<typeof vi.fn>;
let matchMediaAddEventListenerMock: ReturnType<typeof vi.fn>;
let matchMediaRemoveEventListenerMock: ReturnType<typeof vi.fn>;
let matchMediaChangeHandlers: Array<() => void>;
/** jsdom 默认不实现 navigator.clipboard；Cmd+C 复制分支需要它存在。 */
const clipboardWriteTextMock = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: clipboardWriteTextMock },
    configurable: true,
  });
  clipboardWriteTextMock.mockClear();

  xtermMocks.FakeTerminal.instances.length = 0;
  xtermMocks.FakeFitAddon.instances.length = 0;
  FakeResizeObserver.instances.length = 0;

  unlistenDataMock = vi.fn();
  unlistenExitMock = vi.fn();

  sessionMocks.openSessionWithOutputMock.mockReset();
  sessionMocks.sessionOpenMock.mockReset();
  sessionMocks.sessionWriteMock.mockReset();
  sessionMocks.sessionResizeMock.mockReset();
  sessionMocks.sessionCloseMock.mockReset();
  sessionMocks.onSessionDataMock.mockReset();
  sessionMocks.onSessionExitMock.mockReset();

  sessionMocks.sessionOpenMock.mockResolvedValue("session-1");
  sessionMocks.sessionWriteMock.mockResolvedValue(undefined);
  sessionMocks.sessionResizeMock.mockResolvedValue(undefined);
  sessionMocks.sessionCloseMock.mockResolvedValue(undefined);
  sessionMocks.onSessionDataMock.mockImplementation(async () => unlistenDataMock);
  sessionMocks.onSessionExitMock.mockImplementation(async () => unlistenExitMock);
  sessionMocks.openSessionWithOutputMock.mockImplementation(async (open) => {
    const id = await open();
    return { id, unlisten: unlistenDataMock };
  });

  matchMediaChangeHandlers = [];
  matchMediaAddEventListenerMock = vi.fn((event: string, cb: () => void) => {
    if (event === "change") matchMediaChangeHandlers.push(cb);
  });
  matchMediaRemoveEventListenerMock = vi.fn();
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    addEventListener: matchMediaAddEventListenerMock,
    removeEventListener: matchMediaRemoveEventListenerMock,
  })) as unknown as typeof window.matchMedia;

  (globalThis as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
});

afterEach(() => {
  cleanup();
  useSettingsStore.setState({ settings: originalSettings });
  window.matchMedia = originalMatchMedia;
  (globalThis as { ResizeObserver: unknown }).ResizeObserver =
    originalResizeObserver;
});

describe("TerminalView", () => {
  it("挂载后应该打开新会话，用 term 尺寸与 initialCwd 调 sessionOpen，并回调 onSessionOpened", async () => {
    const onOpened = vi.fn();
    render(
      <TerminalView
        sessionId={null}
        initialCwd="/tmp/work"
        onSessionOpened={onOpened}
      />,
    );

    await waitFor(() => expect(onOpened).toHaveBeenCalledWith("session-1"));

    expect(sessionMocks.openSessionWithOutputMock).toHaveBeenCalledTimes(1);
    expect(sessionMocks.sessionOpenMock).toHaveBeenCalledWith({
      cols: 80,
      rows: 24,
      cwd: "/tmp/work",
    });
  });

  it("已有 sessionId 时不应重新打开会话，而应直接订阅其输出", async () => {
    const onOpened = vi.fn();
    render(
      <TerminalView sessionId="existing-session" onSessionOpened={onOpened} />,
    );

    await waitFor(() =>
      expect(sessionMocks.onSessionDataMock).toHaveBeenCalledWith(
        "existing-session",
        expect.any(Function),
      ),
    );

    expect(sessionMocks.openSessionWithOutputMock).not.toHaveBeenCalled();
    expect(sessionMocks.sessionOpenMock).not.toHaveBeenCalled();
    expect(onOpened).not.toHaveBeenCalled();
  });

  it("收到 PTY 输出应该写入 xterm", async () => {
    render(<TerminalView sessionId={null} />);

    await waitFor(() =>
      expect(sessionMocks.openSessionWithOutputMock).toHaveBeenCalledTimes(1),
    );
    const onBytes = sessionMocks.openSessionWithOutputMock.mock.calls[0][1];

    act(() => {
      onBytes(new TextEncoder().encode("hello from pty\r\n"));
    });

    const term = xtermMocks.FakeTerminal.instances[0];
    expect(term.writes).toHaveLength(1);
    expect(new TextDecoder().decode(term.writes[0])).toBe("hello from pty\r\n");
  });

  it("用户在终端里输入应该写回 PTY", async () => {
    render(<TerminalView sessionId={null} />);

    await waitFor(() =>
      expect(xtermMocks.FakeTerminal.instances[0]?.onDataCb).not.toBeNull(),
    );

    act(() => {
      xtermMocks.FakeTerminal.instances[0].onDataCb!("ls\n");
    });

    await waitFor(() =>
      expect(sessionMocks.sessionWriteMock).toHaveBeenCalledWith(
        "session-1",
        new TextEncoder().encode("ls\n"),
      ),
    );
  });

  it("initialInput 应该在会话打开后写入一次，并回调 onInitialInputConsumed", async () => {
    const onConsumed = vi.fn();
    render(
      <TerminalView
        sessionId={null}
        initialInput={"tmux attach -t foo\n"}
        onInitialInputConsumed={onConsumed}
      />,
    );

    await waitFor(() => expect(onConsumed).toHaveBeenCalledTimes(1));

    expect(sessionMocks.sessionWriteMock).toHaveBeenCalledTimes(1);
    expect(sessionMocks.sessionWriteMock).toHaveBeenCalledWith(
      "session-1",
      new TextEncoder().encode("tmux attach -t foo\n"),
    );
  });

  it("isActive 为 true 时应该聚焦终端", async () => {
    render(<TerminalView sessionId="s1" isActive={true} />);

    await waitFor(() =>
      expect(xtermMocks.FakeTerminal.instances[0]?.focusCalls).toBeGreaterThan(0),
    );
  });

  it("isActive 为 false 时不应聚焦终端", async () => {
    render(<TerminalView sessionId="s1" isActive={false} />);

    await waitFor(() => expect(sessionMocks.onSessionDataMock).toHaveBeenCalled());
    // 再走一轮微任务，确认真的没有异步聚焦（而不是还没来得及触发）
    await act(async () => {
      await Promise.resolve();
    });

    expect(xtermMocks.FakeTerminal.instances[0].focusCalls).toBe(0);
  });

  it("容器尺寸变化时应该 fit 并调用 sessionResize", async () => {
    render(<TerminalView sessionId={null} />);

    await waitFor(() => expect(FakeResizeObserver.instances).toHaveLength(1));

    const fitCallsBefore = xtermMocks.FakeFitAddon.instances[0].fitCalls;

    act(() => {
      FakeResizeObserver.instances[0].trigger();
    });

    expect(xtermMocks.FakeFitAddon.instances[0].fitCalls).toBe(fitCallsBefore + 1);
    expect(sessionMocks.sessionResizeMock).toHaveBeenCalledWith(
      "session-1",
      80,
      24,
    );
  });

  it("会话退出事件应该触发 onExit 回调", async () => {
    const onExit = vi.fn();
    render(<TerminalView sessionId={null} onExit={onExit} />);

    await waitFor(() => expect(sessionMocks.onSessionExitMock).toHaveBeenCalled());
    const exitCb = sessionMocks.onSessionExitMock.mock.calls[0][1];

    act(() => {
      exitCb();
    });

    expect(onExit).toHaveBeenCalledWith("session-1");
  });

  it("卸载组件应该取消订阅并 dispose 终端", async () => {
    const { unmount } = render(<TerminalView sessionId={null} />);

    await waitFor(() => expect(FakeResizeObserver.instances).toHaveLength(1));

    const term = xtermMocks.FakeTerminal.instances[0];
    const resizeObserverInstance = FakeResizeObserver.instances[0];

    unmount();

    expect(unlistenDataMock).toHaveBeenCalledTimes(1);
    expect(unlistenExitMock).toHaveBeenCalledTimes(1);
    expect(resizeObserverInstance.disconnectMock).toHaveBeenCalledTimes(1);
    expect(term.disposed).toBe(true);
  });

  it("sessionOpen 失败时应该显示错误提示，不留空终端", async () => {
    sessionMocks.openSessionWithOutputMock.mockImplementationOnce(async () => {
      throw new Error("PTY 资源耗尽");
    });
    const onOpened = vi.fn();

    const { findByTestId } = render(
      <TerminalView sessionId={null} onSessionOpened={onOpened} />,
    );

    const banner = await findByTestId("terminal-spawn-error");
    expect(banner.textContent).toContain("PTY 资源耗尽");
    expect(onOpened).not.toHaveBeenCalled();
  });

  it("StrictMode 双 mount race：effect 在 sessionOpen 结果返回前被清理时应关闭该会话且不回调 onSessionOpened", async () => {
    let resolveOpen: (id: string) => void = () => {};
    sessionMocks.sessionOpenMock.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveOpen = resolve;
        }),
    );
    const onOpened = vi.fn();

    const { unmount } = render(
      <TerminalView sessionId={null} onSessionOpened={onOpened} />,
    );
    unmount();

    resolveOpen("late-session");

    await waitFor(() =>
      expect(sessionMocks.sessionCloseMock).toHaveBeenCalledWith("late-session"),
    );
    expect(unlistenDataMock).toHaveBeenCalledTimes(1);
    expect(onOpened).not.toHaveBeenCalled();
  });

  it("settings store 变化时应该热更新已挂载 xterm 的字体与主题", async () => {
    render(<TerminalView sessionId="s1" />);
    await waitFor(() => expect(xtermMocks.FakeTerminal.instances).toHaveLength(1));

    const term = xtermMocks.FakeTerminal.instances[0];
    const fitCallsBefore = xtermMocks.FakeFitAddon.instances[0].fitCalls;

    act(() => {
      const current = useSettingsStore.getState().settings;
      useSettingsStore.setState({
        settings: {
          ...current,
          terminal: {
            ...current.terminal,
            font_family: "Fira Code",
            font_size: 16,
            line_height: 1.5,
            cursor_style: "bar",
            theme: "dracula",
          },
        },
      });
    });

    expect(term.options.fontFamily).toBe("Fira Code");
    expect(term.options.fontSize).toBe(16);
    expect(term.options.lineHeight).toBe(1.5);
    expect(term.options.cursorStyle).toBe("bar");
    expect(term.options.theme).toBeTruthy();
    expect(xtermMocks.FakeFitAddon.instances[0].fitCalls).toBe(
      fitCallsBefore + 1,
    );
  });

  it("theme_mode=auto 时系统主题变化应该更新 xterm theme", async () => {
    act(() => {
      const current = useSettingsStore.getState().settings;
      useSettingsStore.setState({
        settings: {
          ...current,
          ui: { ...current.ui, theme_mode: "auto" },
        },
      });
    });

    render(<TerminalView sessionId="s1" />);
    await waitFor(() =>
      expect(matchMediaAddEventListenerMock).toHaveBeenCalled(),
    );

    const term = xtermMocks.FakeTerminal.instances[0];

    act(() => {
      matchMediaChangeHandlers.forEach((cb) => cb());
    });

    expect(term.options.theme).toBeTruthy();
  });

  it("Cmd+C 有选区时应该复制选区到剪贴板并阻止默认（不让 ^C 中断命令）", async () => {
    render(<TerminalView sessionId="s1" />);
    await waitFor(() => expect(xtermMocks.FakeTerminal.instances).toHaveLength(1));

    const term = xtermMocks.FakeTerminal.instances[0];
    term.selectionValue = "selected text";

    let handled: boolean | undefined;
    act(() => {
      handled = term.customKeyHandler!(
        new KeyboardEvent("keydown", { key: "c", metaKey: true }),
      );
    });

    expect(handled).toBe(false);
    expect(clipboardWriteTextMock).toHaveBeenCalledWith("selected text");
  });

  it("Ctrl+C 无选区时不复制，交给默认路径中断命令", async () => {
    render(<TerminalView sessionId="s1" />);
    await waitFor(() => expect(xtermMocks.FakeTerminal.instances).toHaveLength(1));

    const term = xtermMocks.FakeTerminal.instances[0];
    term.selectionValue = "";

    let handled: boolean | undefined;
    act(() => {
      handled = term.customKeyHandler!(
        new KeyboardEvent("keydown", { key: "c", ctrlKey: true }),
      );
    });

    expect(handled).toBe(true);
    expect(clipboardWriteTextMock).not.toHaveBeenCalled();
  });

  it("非 keydown 类型的按键事件应该直接放行", async () => {
    render(<TerminalView sessionId="s1" />);
    await waitFor(() => expect(xtermMocks.FakeTerminal.instances).toHaveLength(1));

    const term = xtermMocks.FakeTerminal.instances[0];
    let handled: boolean | undefined;
    act(() => {
      handled = term.customKeyHandler!(new KeyboardEvent("keyup", { key: "a" }));
    });

    expect(handled).toBe(true);
  });

  it("WKWebView Shift+标点第一次被吞时应该主动补发该按键（issue #5374 workaround）", async () => {
    render(<TerminalView sessionId={null} />);
    await waitFor(() =>
      expect(sessionMocks.sessionOpenMock).toHaveBeenCalled(),
    );
    // 等 onSessionOpened 落地，保证 idRef.current 已就绪
    await waitFor(() => expect(xtermMocks.FakeTerminal.instances[0]).toBeDefined());

    const term = xtermMocks.FakeTerminal.instances[0];
    let handled: boolean | undefined;
    act(() => {
      // Shift + `_`：非字母单字符，且距上次 onData（初值极早）已远超 50ms
      handled = term.customKeyHandler!(
        new KeyboardEvent("keydown", { key: "_", shiftKey: true }),
      );
    });

    expect(handled).toBe(false);
    expect(sessionMocks.sessionWriteMock).toHaveBeenCalledWith(
      "session-1",
      new TextEncoder().encode("_"),
    );
  });

  it("滚轮事件：非备用屏（普通屏）时不转换为方向键，交给默认滚动", async () => {
    render(<TerminalView sessionId="s1" />);
    await waitFor(() => expect(xtermMocks.FakeTerminal.instances).toHaveLength(1));

    const term = xtermMocks.FakeTerminal.instances[0];
    // 默认 buffer.active.type = "normal"（非备用屏）
    let handled: boolean | undefined;
    act(() => {
      handled = term.customWheelHandler!({ deltaY: -100, deltaMode: 0 });
    });

    expect(handled).toBe(true);
    expect(sessionMocks.sessionWriteMock).not.toHaveBeenCalled();
  });

  it("滚轮事件：备用屏且未开启鼠标追踪时应该把滚轮转成方向键发给 PTY", async () => {
    render(<TerminalView sessionId="s1" />);
    await waitFor(() => expect(xtermMocks.FakeTerminal.instances).toHaveLength(1));

    const term = xtermMocks.FakeTerminal.instances[0];
    term.buffer.active.type = "alternate";
    term.modes.mouseTrackingMode = "none";

    let handled: boolean | undefined;
    act(() => {
      handled = term.customWheelHandler!({ deltaY: -100, deltaMode: 0 });
    });

    expect(handled).toBe(false);
    expect(sessionMocks.sessionWriteMock).toHaveBeenCalledWith(
      "s1",
      new TextEncoder().encode("\x1b[A\x1b[A\x1b[A"),
    );
  });
});
