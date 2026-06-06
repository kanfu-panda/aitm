/* =============================================================================
 * TerminalPaneGroup 单测（v0.10.0 HR9-1）
 * -----------------------------------------------------------------------------
 * 从原 PaneGroupRenderer.test.tsx 拆出 —— HR9-1 后 layout tree 只剩
 * terminal，PaneGroupRenderer 分派层已删，直接测 TerminalPaneGroup。
 *
 * 覆盖：
 *   - 渲染 group.tab_ids 对应 tabs + active tab 的 TerminalView
 *   - 点击 group 内 tab → 切 setActiveTabInGroup + 同步全局 activeId
 *   - MouseDown 容器 → 切 active_group_id
 *   - HR7-3 focus 视觉方案 A（tab bar 背景 + active tab 底边）
 *   - HR7-1 真独占 tabs（不 fallback 全局 tabs）
 * ========================================================================== */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// 重组件 stub：避免 xterm 在 jsdom 起重
vi.mock("../../TerminalView", () => ({
  __esModule: true,
  default: ({ sessionId }: { sessionId: string | null }) => (
    <div data-testid={`terminal-view-stub-${sessionId ?? "none"}`}>terminal</div>
  ),
}));
// TabMetadataIcons 内部走 IPC 拉 git status / port —— stub 静默掉
vi.mock("../../TabMetadataIcons", () => ({
  __esModule: true,
  default: () => null,
}));
vi.mock("../../StatusRing", () => ({
  __esModule: true,
  default: () => null,
}));

import { TerminalPaneGroup } from "../TerminalPaneGroup";
import {
  INITIAL_GROUP_ID,
  usePaneLayoutStore,
  type PaneGroup,
} from "../../../stores/pane-layout";
import { useTabsStore } from "../../../stores/tabs";

function resetAllStores() {
  usePaneLayoutStore.setState({
    root: {
      kind: "leaf",
      group: {
        id: INITIAL_GROUP_ID,
        type: "terminal",
        tab_ids: [],
        active_tab_id: null,
      },
    },
    active_group_id: INITIAL_GROUP_ID,
  });
  useTabsStore.setState({
    tabs: [],
    activeId: null,
    unreadByTab: {},
  });
}

beforeEach(resetAllStores);
afterEach(cleanup);

function makeGroup(overrides: Partial<PaneGroup> = {}): PaneGroup {
  return {
    id: "g-test",
    type: "terminal",
    tab_ids: [],
    active_tab_id: null,
    ...overrides,
  };
}

describe("TerminalPaneGroup", () => {
  it("渲染 group 内 tab + active tab 的 TerminalView", () => {
    useTabsStore.setState({
      tabs: [
        {
          id: "t1",
          title: "tab-1",
          sessionId: "sess-1",
          auto_title: true,
        },
        {
          id: "t2",
          title: "tab-2",
          sessionId: "sess-2",
          auto_title: true,
        },
      ],
      activeId: "t1",
      unreadByTab: {},
    });
    const group = makeGroup({
      id: "g-terminal",
      type: "terminal",
      tab_ids: ["t1", "t2"],
      active_tab_id: "t1",
    });
    render(<TerminalPaneGroup group={group} />);
    expect(screen.getByTestId("terminal-pane-group")).toBeTruthy();
    expect(screen.getByTestId("terminal-pane-group-tab-t1")).toBeTruthy();
    expect(screen.getByTestId("terminal-pane-group-tab-t2")).toBeTruthy();
    // active 是 t1 → 对应 TerminalView stub mount
    expect(screen.getByTestId("terminal-view-stub-sess-1")).toBeTruthy();
  });

  it("点 group 内 tab → 切 setActiveTabInGroup + 同步全局 activeId", () => {
    useTabsStore.setState({
      tabs: [
        { id: "t1", title: "1", sessionId: "s1", auto_title: true },
        { id: "t2", title: "2", sessionId: "s2", auto_title: true },
      ],
      activeId: "t1",
      unreadByTab: {},
    });
    usePaneLayoutStore.setState({
      root: {
        kind: "leaf",
        group: {
          id: "g-x",
          type: "terminal",
          tab_ids: ["t1", "t2"],
          active_tab_id: "t1",
        },
      },
      active_group_id: "g-x",
    });
    const root = usePaneLayoutStore.getState().root;
    if (root.kind !== "leaf") throw new Error("expected leaf");
    render(<TerminalPaneGroup group={root.group} />);
    fireEvent.click(screen.getByTestId("terminal-pane-group-tab-t2"));
    // pane-layout 内 active 切到 t2
    const newRoot = usePaneLayoutStore.getState().root;
    if (newRoot.kind !== "leaf") throw new Error("expected leaf");
    expect(newRoot.group.active_tab_id).toBe("t2");
    // 全局 activeId 同步
    expect(useTabsStore.getState().activeId).toBe("t2");
  });

  it("MouseDown 容器 → 切 active_group_id", () => {
    useTabsStore.setState({
      tabs: [{ id: "t1", title: "1", sessionId: "s1", auto_title: true }],
      activeId: "t1",
      unreadByTab: {},
    });
    usePaneLayoutStore.setState({
      root: {
        kind: "leaf",
        group: {
          id: "g-other",
          type: "terminal",
          tab_ids: ["t1"],
          active_tab_id: "t1",
        },
      },
      active_group_id: "g-different", // 当前焦点在别的 group
    });
    const root = usePaneLayoutStore.getState().root;
    if (root.kind !== "leaf") throw new Error("expected leaf");
    render(<TerminalPaneGroup group={root.group} />);
    const container = screen.getByTestId("terminal-pane-group");
    expect(container.getAttribute("data-focused")).toBe("false");
    fireEvent.mouseDown(container);
    expect(usePaneLayoutStore.getState().active_group_id).toBe("g-other");
  });

  it("active group 的 tab bar 含 bg-[var(--c-bg-elev-2)]", () => {
    useTabsStore.setState({
      tabs: [{ id: "t1", title: "1", sessionId: "s1", auto_title: true }],
      activeId: "t1",
      unreadByTab: {},
    });
    usePaneLayoutStore.setState({
      root: {
        kind: "leaf",
        group: {
          id: "g-active",
          type: "terminal",
          tab_ids: ["t1"],
          active_tab_id: "t1",
        },
      },
      active_group_id: "g-active",
    });
    const root = usePaneLayoutStore.getState().root;
    if (root.kind !== "leaf") throw new Error("expected leaf");
    render(<TerminalPaneGroup group={root.group} />);
    const tabbar = screen.getByTestId("terminal-pane-group-tabbar");
    expect(tabbar.className).toContain("bg-[var(--c-bg-elev-2)]");
    expect(tabbar.className).not.toContain("bg-[var(--c-bg-elev-1)]");
  });

  it("非 active group 的 tab bar 含 bg-[var(--c-bg-elev-1)]", () => {
    useTabsStore.setState({
      tabs: [{ id: "t1", title: "1", sessionId: "s1", auto_title: true }],
      activeId: "t1",
      unreadByTab: {},
    });
    usePaneLayoutStore.setState({
      root: {
        kind: "leaf",
        group: {
          id: "g-inactive",
          type: "terminal",
          tab_ids: ["t1"],
          active_tab_id: "t1",
        },
      },
      active_group_id: "g-other",
    });
    const root = usePaneLayoutStore.getState().root;
    if (root.kind !== "leaf") throw new Error("expected leaf");
    render(<TerminalPaneGroup group={root.group} />);
    const tabbar = screen.getByTestId("terminal-pane-group-tabbar");
    expect(tabbar.className).toContain("bg-[var(--c-bg-elev-1)]");
    expect(tabbar.className).not.toContain("bg-[var(--c-bg-elev-2)]");
  });

  it("active terminal tab 含 border-b-2 border-[var(--c-success)]", () => {
    useTabsStore.setState({
      tabs: [
        { id: "t1", title: "1", sessionId: "s1", auto_title: true },
        { id: "t2", title: "2", sessionId: "s2", auto_title: true },
      ],
      activeId: "t1",
      unreadByTab: {},
    });
    usePaneLayoutStore.setState({
      root: {
        kind: "leaf",
        group: {
          id: "g-x",
          type: "terminal",
          tab_ids: ["t1", "t2"],
          active_tab_id: "t1",
        },
      },
      active_group_id: "g-x",
    });
    const root = usePaneLayoutStore.getState().root;
    if (root.kind !== "leaf") throw new Error("expected leaf");
    render(<TerminalPaneGroup group={root.group} />);
    const activeTab = screen.getByTestId("terminal-pane-group-tab-t1");
    expect(activeTab.className).toContain("border-b-2");
    expect(activeTab.className).toContain("border-[var(--c-success)]");
    const inactiveTab = screen.getByTestId("terminal-pane-group-tab-t2");
    expect(inactiveTab.className).not.toContain("border-b-2");
  });

  it("group.tab_ids=[t1]，全局 tabs=[t1,t2] → 仅显示 t1（真独占，不 fallback）", () => {
    useTabsStore.setState({
      tabs: [
        { id: "t1", title: "1", sessionId: "s1", auto_title: true },
        { id: "t2", title: "2", sessionId: "s2", auto_title: true },
      ],
      activeId: "t2",
      unreadByTab: {},
    });
    const group = makeGroup({
      id: "g-only-t1",
      type: "terminal",
      tab_ids: ["t1"],
      active_tab_id: "t1",
    });
    render(<TerminalPaneGroup group={group} />);
    expect(screen.getByTestId("terminal-pane-group-tab-t1")).toBeTruthy();
    expect(screen.queryByTestId("terminal-pane-group-tab-t2")).toBeNull();
  });

  it("group.tab_ids=[] → 显示空 group 占位（不 fallback 全局 tabs）", () => {
    useTabsStore.setState({
      tabs: [{ id: "t1", title: "1", sessionId: "s1", auto_title: true }],
      activeId: "t1",
      unreadByTab: {},
    });
    const group = makeGroup({
      id: "g-empty",
      type: "terminal",
      tab_ids: [],
      active_tab_id: null,
    });
    render(<TerminalPaneGroup group={group} />);
    expect(screen.queryByTestId("terminal-pane-group-tab-t1")).toBeNull();
    expect(screen.getByText(/点击新建标签/)).toBeTruthy();
  });

  it("group outer container 不含 c-success 满边框（HR7-3 方案 A）", () => {
    useTabsStore.setState({
      tabs: [{ id: "t1", title: "1", sessionId: "s1", auto_title: true }],
      activeId: "t1",
      unreadByTab: {},
    });
    usePaneLayoutStore.setState({
      root: {
        kind: "leaf",
        group: {
          id: "g-y",
          type: "terminal",
          tab_ids: ["t1"],
          active_tab_id: "t1",
        },
      },
      active_group_id: "g-y",
    });
    const root = usePaneLayoutStore.getState().root;
    if (root.kind !== "leaf") throw new Error("expected leaf");
    render(<TerminalPaneGroup group={root.group} />);
    const outer = screen.getByTestId("terminal-pane-group");
    expect(outer.className).not.toContain("c-success");
    expect(outer.className).toContain("border-[var(--c-border)]");
  });
});
