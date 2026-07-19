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
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

// 重组件 stub：避免 xterm 在 jsdom 起重。F3：透传 isActive，用 data-active 属性
// 断言"TerminalPaneGroup 是否把正确的 isActive 传给 TerminalView"——真实
// term.focus() 调用行为由 TerminalView.tsx 自身的 effect 负责（不在本文件
// 覆盖范围内，本文件只测 TerminalPaneGroup → TerminalView 的 prop 传导契约）。
vi.mock("../../TerminalView", () => ({
  __esModule: true,
  default: ({
    sessionId,
    isActive,
  }: {
    sessionId: string | null;
    isActive?: boolean;
  }) => (
    <div
      data-testid={`terminal-view-stub-${sessionId ?? "none"}`}
      data-active={isActive ? "true" : "false"}
    >
      terminal
    </div>
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

// F1：默认 sessionHasRunningCommand 返 false（无运行中命令 → 直接关）；
// 单测内 mockResolvedValue(true) 模拟有运行中命令的分支。照搬 TabBar.test.tsx
// 的 partial mock 方式，保留 lib/tauri.ts 其它导出的真实实现（CloseTabConfirmDialog
// 内部 useBrowserModalGuard 也走这个模块，不希望被误覆盖）。
vi.mock("../../../lib/tauri", async (orig) => {
  const real = await orig<typeof import("../../../lib/tauri")>();
  return {
    ...real,
    sessionHasRunningCommand: vi.fn().mockResolvedValue(false),
  };
});

import { TerminalPaneGroup } from "../TerminalPaneGroup";
import {
  INITIAL_GROUP_ID,
  usePaneLayoutStore,
  type PaneGroup,
} from "../../../stores/pane-layout";
import { useTabsStore } from "../../../stores/tabs";
import { sessionHasRunningCommand } from "../../../lib/tauri";

const mockHasRunning = sessionHasRunningCommand as unknown as ReturnType<
  typeof vi.fn
>;

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

beforeEach(() => {
  resetAllStores();
  mockHasRunning.mockReset();
  mockHasRunning.mockResolvedValue(false);
});
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

  it("VS Code 风格：激活 tab 底部 emerald 绿条(inset shadow)、tab 间右侧分隔线、统一最小宽度", () => {
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
    // 激活：底部 emerald 绿条（inset shadow 画在内侧底边，最显眼）
    expect(activeTab.className).toContain(
      "shadow-[inset_0_-2px_0_0_var(--c-success)]",
    );
    // tab 间齐平 + 右侧 1px 分隔线 + 统一最小宽度（防误点关闭）
    expect(activeTab.className).toContain("border-r");
    expect(activeTab.className).toContain("min-w-[104px]");
    const inactiveTab = screen.getByTestId("terminal-pane-group-tab-t2");
    // 未激活：无绿条，亮一档灰背景
    expect(inactiveTab.className).not.toContain(
      "shadow-[inset_0_-2px_0_0_var(--c-success)]",
    );
    expect(inactiveTab.className).toContain("min-w-[104px]");
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

/* =============================================================================
 * F1（v1.1.0 回归修复）：关闭有运行中命令的 tab → 二次确认
 * ========================================================================== */
describe("TerminalPaneGroup — F1 关闭二次确认", () => {
  function renderSingleTabGroup() {
    useTabsStore.setState({
      tabs: [{ id: "t1", title: "跑命令的 tab", sessionId: "s1", auto_title: true }],
      activeId: "t1",
      unreadByTab: {},
    });
    const group = makeGroup({
      id: "g-close",
      tab_ids: ["t1"],
      active_tab_id: "t1",
    });
    usePaneLayoutStore.setState({
      root: { kind: "leaf", group },
      active_group_id: "g-close",
    });
    render(<TerminalPaneGroup group={group} />);
  }

  it("sessionId 为 null（session 未开）→ 点 × 直接关闭，不查后端", async () => {
    useTabsStore.setState({
      tabs: [{ id: "t1", title: "未开 session", sessionId: null, auto_title: true }],
      activeId: "t1",
      unreadByTab: {},
    });
    const group = makeGroup({ id: "g-nosess", tab_ids: ["t1"], active_tab_id: "t1" });
    usePaneLayoutStore.setState({
      root: { kind: "leaf", group },
      active_group_id: "g-nosess",
    });
    render(<TerminalPaneGroup group={group} />);

    fireEvent.click(screen.getByLabelText("关闭标签"));

    await waitFor(() => {
      expect(screen.queryByTestId("terminal-pane-group-tab-t1")).toBeNull();
    });
    expect(mockHasRunning).not.toHaveBeenCalled();
  });

  it("无运行中命令 → 直接关闭，不弹确认", async () => {
    mockHasRunning.mockResolvedValue(false);
    renderSingleTabGroup();

    fireEvent.click(screen.getByLabelText("关闭标签"));

    await waitFor(() => {
      expect(mockHasRunning).toHaveBeenCalledWith("s1");
    });
    await waitFor(() => {
      expect(screen.queryByTestId("terminal-pane-group-tab-t1")).toBeNull();
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("有运行中命令 → 弹确认弹窗含 tab title，tab 暂不关闭", async () => {
    mockHasRunning.mockResolvedValue(true);
    renderSingleTabGroup();

    fireEvent.click(screen.getByLabelText("关闭标签"));

    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("跑命令的 tab");
    // tab 还在（closeTabInGroup 尚未真正调用）
    expect(screen.getByTestId("terminal-pane-group-tab-t1")).toBeTruthy();
  });

  it("确认弹窗点取消 → tab 保留，弹窗关闭", async () => {
    mockHasRunning.mockResolvedValue(true);
    renderSingleTabGroup();

    fireEvent.click(screen.getByLabelText("关闭标签"));
    await screen.findByRole("dialog");

    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(screen.getByTestId("terminal-pane-group-tab-t1")).toBeTruthy();
  });

  it("确认弹窗点强制关闭 → PTY 销毁 + tab 消失", async () => {
    mockHasRunning.mockResolvedValue(true);
    renderSingleTabGroup();

    fireEvent.click(screen.getByLabelText("关闭标签"));
    await screen.findByRole("dialog");

    fireEvent.click(screen.getByRole("button", { name: "关闭" }));

    await waitFor(() => {
      expect(screen.queryByTestId("terminal-pane-group-tab-t1")).toBeNull();
    });
  });

  it("检测失败（IPC reject）→ 静默 fallback 直关，不阻塞用户", async () => {
    mockHasRunning.mockRejectedValue(new Error("ipc 炸了"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    renderSingleTabGroup();

    fireEvent.click(screen.getByLabelText("关闭标签"));

    await waitFor(() => {
      expect(screen.queryByTestId("terminal-pane-group-tab-t1")).toBeNull();
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    warnSpy.mockRestore();
  });
});

/* =============================================================================
 * F2（v1.1.0 回归修复）：双击 tab 标题 → inline 编辑改名
 * ========================================================================== */
describe("TerminalPaneGroup — F2 双击重命名", () => {
  function renderSingleTabGroup(title: string) {
    useTabsStore.setState({
      tabs: [{ id: "t1", title, sessionId: "s1", auto_title: true }],
      activeId: "t1",
      unreadByTab: {},
    });
    const group = makeGroup({
      id: "g-rename",
      tab_ids: ["t1"],
      active_tab_id: "t1",
    });
    usePaneLayoutStore.setState({
      root: { kind: "leaf", group },
      active_group_id: "g-rename",
    });
    render(<TerminalPaneGroup group={group} />);
  }

  it("双击标题 → 出现预填当前标题的 input", () => {
    renderSingleTabGroup("原始名");
    const tab = screen.getByTestId("terminal-pane-group-tab-t1");
    fireEvent.doubleClick(within(tab).getByText("原始名"));

    const input = screen.getByTestId(
      "terminal-pane-group-tab-title-input-t1",
    ) as HTMLInputElement;
    expect(input.value).toBe("原始名");
  });

  it("改值 + Enter → setTitle 生效，auto_title 转 false", () => {
    renderSingleTabGroup("旧名");
    const tab = screen.getByTestId("terminal-pane-group-tab-t1");
    fireEvent.doubleClick(within(tab).getByText("旧名"));

    const input = screen.getByTestId(
      "terminal-pane-group-tab-title-input-t1",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "新名" } });
    fireEvent.keyDown(input, { key: "Enter" });

    const updated = useTabsStore.getState().tabs.find((t) => t.id === "t1");
    expect(updated?.title).toBe("新名");
    expect(updated?.auto_title).toBe(false);
  });

  it("改值 + blur → setTitle 也生效", () => {
    renderSingleTabGroup("前");
    const tab = screen.getByTestId("terminal-pane-group-tab-t1");
    fireEvent.doubleClick(within(tab).getByText("前"));

    const input = screen.getByTestId(
      "terminal-pane-group-tab-title-input-t1",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "后" } });
    fireEvent.blur(input);

    expect(
      useTabsStore.getState().tabs.find((t) => t.id === "t1")?.title,
    ).toBe("后");
  });

  it("Escape → 取消编辑，标题不变", () => {
    renderSingleTabGroup("保留我");
    const tab = screen.getByTestId("terminal-pane-group-tab-t1");
    fireEvent.doubleClick(within(tab).getByText("保留我"));

    const input = screen.getByTestId(
      "terminal-pane-group-tab-title-input-t1",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "不该生效" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(
      useTabsStore.getState().tabs.find((t) => t.id === "t1")?.title,
    ).toBe("保留我");
    expect(
      screen.queryByTestId("terminal-pane-group-tab-title-input-t1"),
    ).toBeNull();
  });

  it("空字符串提交 → 不更新，保留原 title", () => {
    renderSingleTabGroup("别清空我");
    const tab = screen.getByTestId("terminal-pane-group-tab-t1");
    fireEvent.doubleClick(within(tab).getByText("别清空我"));

    const input = screen.getByTestId(
      "terminal-pane-group-tab-title-input-t1",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(
      useTabsStore.getState().tabs.find((t) => t.id === "t1")?.title,
    ).toBe("别清空我");
  });

  it("双击不触发 tab 切换以外的副作用（不误触拖拽 —— dnd listeners 被 stopPropagation 拦下）", () => {
    renderSingleTabGroup("标题");
    const tab = screen.getByTestId("terminal-pane-group-tab-t1");
    const titleSpan = within(tab).getByText("标题");
    // 双击直接进编辑态即代表 pointerDown 没被 dnd-kit 的 sortable listener
    // 抢先处理导致组件重渲染把 span 卸载（如果被吞，input 不会出现）。
    fireEvent.doubleClick(titleSpan);
    expect(
      screen.getByTestId("terminal-pane-group-tab-title-input-t1"),
    ).toBeTruthy();
  });
});

/* =============================================================================
 * F3（v1.1.0）：切 / 激活 tab 自动聚焦——TerminalPaneGroup → TerminalView 的
 * isActive prop 传导契约。真正调 term.focus() 是 TerminalView.tsx 自身 effect
 * 的职责（此文件用 stub 替身，不重复覆盖该内部行为）。
 * ========================================================================== */
describe("TerminalPaneGroup — F3 激活 tab 自动聚焦", () => {
  it("group 聚焦 + tab 是 active tab → isActive=true 透传给 TerminalView（对应 term.focus() 被触发）", () => {
    useTabsStore.setState({
      tabs: [
        { id: "t1", title: "1", sessionId: "s1", auto_title: true },
        { id: "t2", title: "2", sessionId: "s2", auto_title: true },
      ],
      activeId: "t1",
      unreadByTab: {},
    });
    const group = makeGroup({
      id: "g-focus",
      tab_ids: ["t1", "t2"],
      active_tab_id: "t1",
    });
    usePaneLayoutStore.setState({
      root: { kind: "leaf", group },
      active_group_id: "g-focus", // 本 group 持有焦点
    });
    render(<TerminalPaneGroup group={group} />);

    expect(
      screen.getByTestId("terminal-view-stub-s1").getAttribute("data-active"),
    ).toBe("true");
    // 非 active tab（t2）即使同 group 也不该聚焦
    expect(
      screen.getByTestId("terminal-view-stub-s2").getAttribute("data-active"),
    ).toBe("false");
  });

  it("group 未持有焦点（后台 group）→ 即便是 active tab 也不聚焦，不抢焦", () => {
    useTabsStore.setState({
      tabs: [{ id: "t1", title: "1", sessionId: "s1", auto_title: true }],
      activeId: "t1",
      unreadByTab: {},
    });
    const group = makeGroup({
      id: "g-background",
      tab_ids: ["t1"],
      active_tab_id: "t1",
    });
    usePaneLayoutStore.setState({
      root: { kind: "leaf", group },
      active_group_id: "g-other", // 焦点在别的 group
    });
    render(<TerminalPaneGroup group={group} />);

    expect(
      screen.getByTestId("terminal-view-stub-s1").getAttribute("data-active"),
    ).toBe("false");
  });

  it("点击 tab 切 active → 目标 tab 的 isActive 变 true，原 active tab 变 false", () => {
    useTabsStore.setState({
      tabs: [
        { id: "t1", title: "1", sessionId: "s1", auto_title: true },
        { id: "t2", title: "2", sessionId: "s2", auto_title: true },
      ],
      activeId: "t1",
      unreadByTab: {},
    });
    const group = makeGroup({
      id: "g-switch",
      tab_ids: ["t1", "t2"],
      active_tab_id: "t1",
    });
    usePaneLayoutStore.setState({
      root: { kind: "leaf", group },
      active_group_id: "g-switch",
    });
    // TerminalPaneGroup 的 group 是外部 prop（不是自己订阅 store），真实 App
    // 里由 LayoutNodeRenderer 订阅 usePaneLayoutStore.root 传入最新 leaf。
    // 这里用同样的订阅 wrapper 让"点击后 store 更新 → 重渲染拿到新 group"
    // 的链路在单测里也成立，而不是断言一个永远不变的 prop 引用。
    function LiveGroupHost() {
      const root = usePaneLayoutStore((s) => s.root);
      if (root.kind !== "leaf") return null;
      return <TerminalPaneGroup group={root.group} />;
    }
    render(<LiveGroupHost />);

    fireEvent.click(screen.getByTestId("terminal-pane-group-tab-t2"));

    expect(
      screen.getByTestId("terminal-view-stub-s2").getAttribute("data-active"),
    ).toBe("true");
    expect(
      screen.getByTestId("terminal-view-stub-s1").getAttribute("data-active"),
    ).toBe("false");
  });
});
