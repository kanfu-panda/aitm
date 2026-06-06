/* aiContext.test.ts —— HR5-1 单测
 *
 * 各 store 状态组合下 collectRuntimeContext 输出结构正确。
 * 各 store 用真实 zustand 实例（不 mock），通过 setState 改 active；
 * 唯一 mock：navigator.userAgent（OS 检测 3 个分支）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { collectRuntimeContext, detectOs, type RuntimeContext } from "./aiContext";
import { useBrowserStore } from "../stores/browser";
import { useFileEditorStore } from "../stores/file-editor";
import { useSettingsStore } from "../stores/settings";
import { useTabsStore } from "../stores/tabs";

/** 把所有 store 重置到空态，避免 case 间污染。 */
function resetStores(): void {
  useTabsStore.setState({ tabs: [], activeId: null, unreadByTab: {} });
  useBrowserStore.setState({ tabs: [], activeKey: null, panelOpen: false });
  useFileEditorStore.setState({ openFiles: [], activeId: null, maximized: false });
  // settings 保持默认（default_shell 空字符串），其它 case 显式 set
  const s = useSettingsStore.getState();
  useSettingsStore.setState({
    ...s,
    settings: { ...s.settings, shell: { default_shell: "" } },
  });
}

describe("aiContext.detectOs", () => {
  it("Mac userAgent 识别为 macos", () => {
    expect(
      detectOs(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605",
      ),
    ).toBe("macos");
  });

  it("Windows userAgent 识别为 windows", () => {
    expect(detectOs("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows");
  });

  it("Linux userAgent 识别为 linux", () => {
    expect(detectOs("Mozilla/5.0 (X11; Linux x86_64)")).toBe("linux");
  });

  it("未知 UA 兜底 linux", () => {
    expect(detectOs("totally-unknown-runtime/1.0")).toBe("linux");
  });
});

describe("aiContext.collectRuntimeContext", () => {
  beforeEach(() => {
    resetStores();
    // 锁 UA 让 OS 字段稳定（jsdom 默认 Mozilla/5.0 ...）
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605",
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("全空 store 仅返回 os 字段", () => {
    const ctx = collectRuntimeContext();
    expect(ctx).toEqual<RuntimeContext>({ os: "macos" });
  });

  it("仅 active terminal + cwd + shell", () => {
    useTabsStore.setState({
      tabs: [
        {
          id: "t1",
          title: "aitm",
          sessionId: "sess-uuid-1",
          auto_title: true,
          cwd: "/tmp/aitm",
        },
      ],
      activeId: "t1",
      unreadByTab: {},
    });
    const s = useSettingsStore.getState();
    useSettingsStore.setState({
      ...s,
      settings: { ...s.settings, shell: { default_shell: "/bin/zsh" } },
    });

    const ctx = collectRuntimeContext();
    expect(ctx.active_terminal).toEqual({
      session_id: "sess-uuid-1",
      cwd: "/tmp/aitm",
      shell: "/bin/zsh",
    });
    expect(ctx.active_browser).toBeUndefined();
    expect(ctx.active_editor).toBeUndefined();
  });

  it("active terminal 无 cwd / 无 shell 时省略对应字段", () => {
    useTabsStore.setState({
      tabs: [
        { id: "t1", title: "新", sessionId: "sess-2", auto_title: true },
      ],
      activeId: "t1",
      unreadByTab: {},
    });
    const ctx = collectRuntimeContext();
    expect(ctx.active_terminal).toEqual({ session_id: "sess-2" });
  });

  it("activeId 对应的 tab 还没开 session 时不上报 active_terminal", () => {
    useTabsStore.setState({
      tabs: [{ id: "t1", title: "新", sessionId: null, auto_title: true }],
      activeId: "t1",
      unreadByTab: {},
    });
    const ctx = collectRuntimeContext();
    expect(ctx.active_terminal).toBeUndefined();
  });

  it("仅 active browser tab（panelOpen + state=active）", () => {
    useBrowserStore.setState({
      panelOpen: true,
      activeKey: "k1",
      tabs: [
        {
          id: "wv-1",
          key: "k1",
          url: "https://github.com",
          title: "GitHub",
          state: "active",
          scrollY: 0,
          pinned: false,
          lastActiveAt: Date.now(),
        },
      ],
    });
    const ctx = collectRuntimeContext();
    expect(ctx.active_browser).toEqual({
      tab_id: "wv-1",
      url: "https://github.com",
      title: "GitHub",
    });
  });

  it("浏览器 panel 关着不上报 active_browser（即使 tab 有数据）", () => {
    useBrowserStore.setState({
      panelOpen: false,
      activeKey: "k1",
      tabs: [
        {
          id: "wv-1",
          key: "k1",
          url: "https://x.com",
          title: "X",
          state: "active",
          scrollY: 0,
          pinned: false,
          lastActiveAt: Date.now(),
        },
      ],
    });
    const ctx = collectRuntimeContext();
    expect(ctx.active_browser).toBeUndefined();
  });

  it("浏览器 tab 在 suspended 状态时不上报 active_browser", () => {
    useBrowserStore.setState({
      panelOpen: true,
      activeKey: "k1",
      tabs: [
        {
          id: null,
          key: "k1",
          url: "https://x.com",
          title: "X",
          state: "suspended",
          scrollY: 0,
          pinned: false,
          lastActiveAt: Date.now(),
        },
      ],
    });
    const ctx = collectRuntimeContext();
    expect(ctx.active_browser).toBeUndefined();
  });

  it("title === url 时省略 title 字段（避免冗余传输）", () => {
    useBrowserStore.setState({
      panelOpen: true,
      activeKey: "k1",
      tabs: [
        {
          id: "wv-1",
          key: "k1",
          url: "https://github.com",
          title: "https://github.com",
          state: "active",
          scrollY: 0,
          pinned: false,
          lastActiveAt: Date.now(),
        },
      ],
    });
    const ctx = collectRuntimeContext();
    expect(ctx.active_browser).toEqual({
      tab_id: "wv-1",
      url: "https://github.com",
    });
  });

  it("仅 active editor，含 dirty + language", () => {
    useFileEditorStore.setState({
      openFiles: [
        {
          id: "/tmp/proj/src/lib.rs",
          path: "/tmp/proj/src/lib.rs",
          content: "fn main() {",
          original: "fn main() {}",
          dirty: true,
          language: "rs",
          cursorLine: 1,
          cursorCol: 1,
        },
      ],
      activeId: "/tmp/proj/src/lib.rs",
      maximized: false,
    });
    const ctx = collectRuntimeContext();
    expect(ctx.active_editor).toEqual({
      path: "/tmp/proj/src/lib.rs",
      language: "rs",
      dirty: true,
    });
  });

  it("editor language 缺失时省略字段，dirty=false 保留", () => {
    useFileEditorStore.setState({
      openFiles: [
        {
          id: "/tmp/x.unknown",
          path: "/tmp/x.unknown",
          content: "x",
          original: "x",
          dirty: false,
          cursorLine: 1,
          cursorCol: 1,
        },
      ],
      activeId: "/tmp/x.unknown",
      maximized: false,
    });
    const ctx = collectRuntimeContext();
    expect(ctx.active_editor).toEqual({
      path: "/tmp/x.unknown",
      dirty: false,
    });
  });

  it("三类 active 同时存在 → 全部上报", () => {
    useTabsStore.setState({
      tabs: [
        {
          id: "t1",
          title: "aitm",
          sessionId: "sess-A",
          auto_title: true,
          cwd: "/tmp/aitm",
        },
      ],
      activeId: "t1",
      unreadByTab: {},
    });
    useBrowserStore.setState({
      panelOpen: true,
      activeKey: "k1",
      tabs: [
        {
          id: "wv-1",
          key: "k1",
          url: "https://example.com",
          title: "Example",
          state: "active",
          scrollY: 0,
          pinned: false,
          lastActiveAt: Date.now(),
        },
      ],
    });
    useFileEditorStore.setState({
      openFiles: [
        {
          id: "/a/b.md",
          path: "/a/b.md",
          content: "x",
          original: "x",
          dirty: false,
          language: "md",
          cursorLine: 1,
          cursorCol: 1,
          mdMode: "preview",
        },
      ],
      activeId: "/a/b.md",
      maximized: false,
    });

    const ctx = collectRuntimeContext();
    expect(ctx.os).toBe("macos");
    expect(ctx.active_terminal?.session_id).toBe("sess-A");
    expect(ctx.active_terminal?.cwd).toBe("/tmp/aitm");
    expect(ctx.active_browser?.url).toBe("https://example.com");
    expect(ctx.active_editor?.path).toBe("/a/b.md");
  });
});
