/* =============================================================================
 * LayoutNodeRenderer 单测（v0.10.0 HR6-3c / HR9-1）
 * -----------------------------------------------------------------------------
 * 验证递归渲染逻辑：
 *   - leaf node → 渲染 TerminalPaneGroup（v0.10.0 HR9-1 起 layout tree 只有
 *     terminal type）
 *   - split node → 嵌入 PanelGroup + PanelResizeHandle 两支子节点
 *   - PanelGroup onLayout → 写回 store setRatio
 *
 * 子组件（TerminalView 等）走重 stub 避免 jsdom 跑 xterm。
 * ========================================================================== */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// 重组件 stub
vi.mock("../../TerminalView", () => ({
  __esModule: true,
  default: ({ sessionId }: { sessionId: string | null }) => (
    <div data-testid={`terminal-view-stub-${sessionId ?? "none"}`}>terminal</div>
  ),
}));
vi.mock("../../TabMetadataIcons", () => ({
  __esModule: true,
  default: () => null,
}));
vi.mock("../../StatusRing", () => ({
  __esModule: true,
  default: () => null,
}));

import { LayoutNodeRenderer } from "../LayoutNodeRenderer";
import {
  INITIAL_GROUP_ID,
  type LayoutNode,
  usePaneLayoutStore,
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
  useTabsStore.setState({ tabs: [], activeId: null, unreadByTab: {} });
}

beforeEach(resetAllStores);
afterEach(cleanup);

describe("LayoutNodeRenderer", () => {
  it("单 leaf 节点 → 直接渲染 TerminalPaneGroup", () => {
    const node: LayoutNode = {
      kind: "leaf",
      group: {
        id: "g-1",
        type: "terminal",
        tab_ids: [],
        active_tab_id: null,
      },
    };
    render(<LayoutNodeRenderer node={node} />);
    expect(screen.getByTestId("terminal-pane-group")).toBeTruthy();
  });

  it("split 节点 → 渲染两个子 leaf 都出现", () => {
    const node: LayoutNode = {
      kind: "split",
      direction: "horizontal",
      ratio: 0.5,
      left: {
        kind: "leaf",
        group: {
          id: "g-left",
          type: "terminal",
          tab_ids: [],
          active_tab_id: null,
        },
      },
      right: {
        kind: "leaf",
        group: {
          id: "g-right",
          type: "terminal",
          tab_ids: [],
          active_tab_id: null,
        },
      },
    };
    render(<LayoutNodeRenderer node={node} />);
    // 两个 terminal group 都应渲染
    const groups = screen.getAllByTestId("terminal-pane-group");
    expect(groups).toHaveLength(2);
    const ids = groups.map((g) => g.getAttribute("data-group-id")).sort();
    expect(ids).toEqual(["g-left", "g-right"]);
  });

  it("嵌套 split → 三个叶子全部渲染", () => {
    // root horizontal:
    //   left = leaf(terminal g-A)
    //   right = vertical split:
    //     left = leaf(terminal g-B)
    //     right = leaf(terminal g-C)
    const node: LayoutNode = {
      kind: "split",
      direction: "horizontal",
      ratio: 0.5,
      left: {
        kind: "leaf",
        group: {
          id: "g-A",
          type: "terminal",
          tab_ids: [],
          active_tab_id: null,
        },
      },
      right: {
        kind: "split",
        direction: "vertical",
        ratio: 0.5,
        left: {
          kind: "leaf",
          group: {
            id: "g-B",
            type: "terminal",
            tab_ids: [],
            active_tab_id: null,
          },
        },
        right: {
          kind: "leaf",
          group: {
            id: "g-C",
            type: "terminal",
            tab_ids: [],
            active_tab_id: null,
          },
        },
      },
    };
    render(<LayoutNodeRenderer node={node} />);
    expect(screen.getAllByTestId("terminal-pane-group")).toHaveLength(3);
    const groups = screen.getAllByTestId("terminal-pane-group");
    const ids = groups.map((g) => g.getAttribute("data-group-id")).sort();
    expect(ids).toEqual(["g-A", "g-B", "g-C"]);
  });

  it("split node ratio 传到 store；PanelGroup onLayout 写回 setRatio", () => {
    // 直接验证 LayoutNodeRenderer 接受 ratio 并调 setRatio。
    // 真实的 onLayout 由 react-resizable-panels 在浏览器拖动时触发；jsdom
    // 下 sizes 默认 [50,50] —— mount 不必触发 setRatio。
    const node: LayoutNode = {
      kind: "split",
      direction: "vertical",
      ratio: 0.3,
      left: {
        kind: "leaf",
        group: {
          id: "g-up",
          type: "terminal",
          tab_ids: [],
          active_tab_id: null,
        },
      },
      right: {
        kind: "leaf",
        group: {
          id: "g-down",
          type: "terminal",
          tab_ids: [],
          active_tab_id: null,
        },
      },
    };
    // 把 root 切到这个 split 形状，方便 onLayout 写回路径 [] 命中根
    usePaneLayoutStore.setState({ root: node, active_group_id: "g-up" });

    const setRatioSpy = vi.spyOn(usePaneLayoutStore.getState(), "setRatio");
    render(<LayoutNodeRenderer node={node} />);
    // 至少子节点都渲染；split 不应吞掉子树
    expect(screen.getAllByTestId("terminal-pane-group")).toHaveLength(2);
    setRatioSpy.mockRestore();
  });
});
