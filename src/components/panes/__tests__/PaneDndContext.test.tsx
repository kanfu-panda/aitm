/* =============================================================================
 * PaneDndContext 单测（v0.10.6 HR7-6）
 * -----------------------------------------------------------------------------
 * jsdom 里没法真的模拟 @dnd-kit 的指针拖拽手势，所以这里把 `@dnd-kit/core` 的
 * `DndContext` mock 成一个"透传 children + 把 onDragStart/onDragEnd/onDragCancel
 * 三个回调存到外部变量"的假组件，测试里直接调这三个回调，断言：
 *   1. usePaneDragState() 暴露的 isDraggingTab / activeTabId 状态机正确
 *   2. handleDragEnd 按 over.id 的命名约定（tabId / group-bar-* / group-edge-*）
 *      正确分派到 pane-layout store 的 reorderTabInGroup / moveTab /
 *      splitGroupWithTab，以及各种 no-op 边界
 *
 * id 命名约定见 PaneDndContext.tsx 顶部注释。
 * ========================================================================== */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

// 捕获 DndContext 收到的 props（用 vi.hoisted 让 mock 工厂能安全引用外部变量）。
const dndCapture = vi.hoisted(() => ({
  props: null as {
    onDragStart: (e: unknown) => void;
    onDragEnd: (e: unknown) => void;
    onDragCancel: () => void;
    children: unknown;
  } | null,
}));

vi.mock("@dnd-kit/core", () => ({
  DndContext: (props: {
    onDragStart: (e: unknown) => void;
    onDragEnd: (e: unknown) => void;
    onDragCancel: () => void;
    children: unknown;
  }) => {
    dndCapture.props = props;
    return props.children;
  },
  PointerSensor: class PointerSensor {},
  useSensor: (sensor: unknown, options?: unknown) => ({ sensor, options }),
  useSensors: (...sensors: unknown[]) => sensors,
}));

import { PaneDndContext, usePaneDragState } from "../PaneDndContext";
import {
  collectAllGroups,
  usePaneLayoutStore,
  type LayoutNode,
  type PaneGroup,
} from "../../../stores/pane-layout";

/** 探针组件：把 usePaneDragState() 的值渲染成文本，方便断言。 */
function DragStateProbe() {
  const { isDraggingTab, activeTabId } = usePaneDragState();
  return (
    <div data-testid="drag-state-probe">
      {String(isDraggingTab)}:{activeTabId ?? "none"}
    </div>
  );
}

function Harness() {
  return (
    <PaneDndContext>
      <DragStateProbe />
    </PaneDndContext>
  );
}

function makeGroup(id: string, tabIds: string[]): PaneGroup {
  return {
    id,
    type: "terminal",
    tab_ids: tabIds,
    active_tab_id: tabIds[0] ?? null,
  };
}

/** 双 group 布局：g-a（横向左侧） / g-b（横向右侧）。 */
function twoGroupLayout(aTabs: string[], bTabs: string[]): LayoutNode {
  return {
    kind: "split",
    direction: "horizontal",
    ratio: 0.5,
    left: { kind: "leaf", group: makeGroup("g-a", aTabs) },
    right: { kind: "leaf", group: makeGroup("g-b", bTabs) },
  };
}

function setLayout(root: LayoutNode, activeGroupId = "g-a") {
  usePaneLayoutStore.setState({ root, active_group_id: activeGroupId });
}

function probeText(): string {
  return screen.getByTestId("drag-state-probe").textContent ?? "";
}

/** 包一层 act()：这三个回调触发 setState，测试里直接调用需要在 act 内。 */
function dragStart(active: { id: string }) {
  act(() => {
    dndCapture.props!.onDragStart({ active });
  });
}
function dragEnd(event: {
  active: { id: string };
  over: { id: string } | null;
}) {
  act(() => {
    dndCapture.props!.onDragEnd(event);
  });
}
function dragCancel() {
  act(() => {
    dndCapture.props!.onDragCancel();
  });
}

beforeEach(() => {
  dndCapture.props = null;
  setLayout(twoGroupLayout(["t1", "t2", "t3"], ["t4"]));
});

afterEach(() => {
  cleanup();
});

describe("PaneDndContext", () => {
  describe("拖拽状态机（usePaneDragState）", () => {
    it("初始状态：未在拖拽", () => {
      render(<Harness />);
      expect(probeText()).toBe("false:none");
    });

    it("onDragStart → isDraggingTab=true + activeTabId=拖动的 tab", () => {
      render(<Harness />);
      dragStart({ id: "t1" });
      expect(probeText()).toBe("true:t1");
    });

    it("onDragCancel → 重置为未拖拽", () => {
      render(<Harness />);
      dragStart({ id: "t1" });
      expect(probeText()).toBe("true:t1");
      dragCancel();
      expect(probeText()).toBe("false:none");
    });

    it("onDragEnd 无论落到哪个分支都会先重置拖拽状态", () => {
      render(<Harness />);
      dragStart({ id: "t1" });
      dragEnd({ active: { id: "t1" }, over: { id: "t2" } });
      expect(probeText()).toBe("false:none");
    });
  });

  describe("handleDragEnd：no-op 边界", () => {
    it("over 为 null（松手时没落在任何 droppable 上）→ 不改 layout", () => {
      render(<Harness />);
      const before = usePaneLayoutStore.getState().root;
      dragEnd({ active: { id: "t1" }, over: null });
      expect(usePaneLayoutStore.getState().root).toBe(before);
    });

    it("拖动的 tab 不属于任何 group（幽灵 tabId）→ 不改 layout", () => {
      render(<Harness />);
      const before = usePaneLayoutStore.getState().root;
      dragEnd({ active: { id: "ghost-tab" }, over: { id: "t2" } });
      expect(usePaneLayoutStore.getState().root).toBe(before);
    });

    it("drop 到自己身上 → 不改 layout", () => {
      render(<Harness />);
      const before = usePaneLayoutStore.getState().root;
      dragEnd({ active: { id: "t1" }, over: { id: "t1" } });
      expect(usePaneLayoutStore.getState().root).toBe(before);
    });

    it("over.id 既不是合法 tabId 也不是 bar/edge id → 不改 layout", () => {
      render(<Harness />);
      const before = usePaneLayoutStore.getState().root;
      dragEnd({ active: { id: "t1" }, over: { id: "totally-unknown-id" } });
      expect(usePaneLayoutStore.getState().root).toBe(before);
    });
  });

  describe("handleDragEnd：drop 到另一个 tab", () => {
    it("同 group 内 → reorderTabInGroup 重排", () => {
      render(<Harness />);
      // g-a: [t1, t2, t3]；把 t1 拖到 t3 上
      dragEnd({ active: { id: "t1" }, over: { id: "t3" } });
      const groups = collectAllGroups(usePaneLayoutStore.getState().root);
      const ga = groups.find((g) => g.id === "g-a")!;
      expect(ga.tab_ids).toEqual(["t2", "t3", "t1"]);
    });

    it("跨 group → moveTab 移到目标 group 末尾", () => {
      render(<Harness />);
      // g-a: [t1,t2,t3]，g-b: [t4]；把 t1 拖到 t4 上
      dragEnd({ active: { id: "t1" }, over: { id: "t4" } });
      const groups = collectAllGroups(usePaneLayoutStore.getState().root);
      const ga = groups.find((g) => g.id === "g-a")!;
      const gb = groups.find((g) => g.id === "g-b")!;
      expect(ga.tab_ids).toEqual(["t2", "t3"]);
      expect(gb.tab_ids).toEqual(["t4", "t1"]);
      expect(gb.active_tab_id).toBe("t1");
    });
  });

  describe("handleDragEnd：drop 到 group-bar-*（tab bar 空白处）", () => {
    it("bar 属于源 group 自己 → no-op", () => {
      render(<Harness />);
      const before = usePaneLayoutStore.getState().root;
      dragEnd({ active: { id: "t1" }, over: { id: "group-bar-g-a" } });
      expect(usePaneLayoutStore.getState().root).toBe(before);
    });

    it("bar 属于别的 group → moveTab 加到该 group 末尾", () => {
      render(<Harness />);
      dragEnd({ active: { id: "t1" }, over: { id: "group-bar-g-b" } });
      const groups = collectAllGroups(usePaneLayoutStore.getState().root);
      const ga = groups.find((g) => g.id === "g-a")!;
      const gb = groups.find((g) => g.id === "g-b")!;
      expect(ga.tab_ids).toEqual(["t2", "t3"]);
      expect(gb.tab_ids).toEqual(["t4", "t1"]);
    });
  });

  describe("handleDragEnd：drop 到 group-edge-*-{side}（拆 split）", () => {
    it("同 group 边沿（right → horizontal）→ splitGroupWithTab 拆出新 group", () => {
      render(<Harness />);
      const beforeCount = collectAllGroups(
        usePaneLayoutStore.getState().root,
      ).length;

      dragEnd({ active: { id: "t1" }, over: { id: "group-edge-g-a-right" } });

      const state = usePaneLayoutStore.getState();
      const groups = collectAllGroups(state.root);
      expect(groups.length).toBe(beforeCount + 1);
      // t1 被拆到新 group，g-a 剩下 t2/t3
      const ga = groups.find((g) => g.id === "g-a")!;
      expect(ga.tab_ids).toEqual(["t2", "t3"]);
      const newGroup = groups.find((g) => g.id !== "g-a" && g.id !== "g-b")!;
      expect(newGroup.tab_ids).toEqual(["t1"]);
      // 新 group 立刻 active
      expect(state.active_group_id).toBe(newGroup.id);
    });

    it("同 group 边沿（top → vertical split）", () => {
      render(<Harness />);
      dragEnd({ active: { id: "t1" }, over: { id: "group-edge-g-a-top" } });
      const root = usePaneLayoutStore.getState().root;
      expect(root.kind).toBe("split");
      if (root.kind === "split") {
        // 原 root 本身是横向 split(g-a|g-b)；g-a 这一支被替换成纵向 split
        expect(root.left.kind).toBe("split");
        if (root.left.kind === "split") {
          expect(root.left.direction).toBe("vertical");
        }
      }
    });

    it("跨 group 边沿 → 先 moveTab 再 splitGroupWithTab（tab 最终落在新第三个 group）", () => {
      render(<Harness />);
      const beforeCount = collectAllGroups(
        usePaneLayoutStore.getState().root,
      ).length;

      dragEnd({ active: { id: "t1" }, over: { id: "group-edge-g-b-right" } });

      const state = usePaneLayoutStore.getState();
      const groups = collectAllGroups(state.root);
      // g-a 少了 t1；g-b 还是只有 t4（t1 被 split 拆出到第三个 group，不留在 g-b）
      const ga = groups.find((g) => g.id === "g-a")!;
      const gb = groups.find((g) => g.id === "g-b")!;
      expect(ga.tab_ids).toEqual(["t2", "t3"]);
      expect(gb.tab_ids).toEqual(["t4"]);
      expect(groups.length).toBe(beforeCount + 1);
      // 总 tab 数守恒
      const allTabs = groups.flatMap((g) => g.tab_ids);
      expect(allTabs.sort()).toEqual(["t1", "t2", "t3", "t4"]);
    });

    it("拖到不存在的 group 边沿（moveTab 失败）→ 不 splitGroupWithTab，group 数不变", () => {
      render(<Harness />);
      const beforeCount = collectAllGroups(
        usePaneLayoutStore.getState().root,
      ).length;

      dragEnd({
        active: { id: "t1" },
        over: { id: "group-edge-g-ghost-left" },
      });

      const state = usePaneLayoutStore.getState();
      const groups = collectAllGroups(state.root);
      expect(groups.length).toBe(beforeCount);
      const ga = groups.find((g) => g.id === "g-a")!;
      // moveTab 内部找不到 to group 直接返 false，g-a 不受影响
      expect(ga.tab_ids).toEqual(["t1", "t2", "t3"]);
    });
  });
});
