/* =============================================================================
 * PaneDndContext.tsx —— v0.10.6 HR7-6 跨 group 拖拽 tab 顶层 DnD 协调
 * -----------------------------------------------------------------------------
 * 用 `@dnd-kit/core` 把整棵 layout tree 包成一个 DndContext，handleDragEnd 三态
 * 分发：
 *   1. 同 group 内 tab 重排 → reorderTabInGroup
 *   2. 跨 group bar 拖（drop 到另一个 group 的 tab bar 空白处） → moveTab
 *   3. group 边沿区拖（drop 到 group 上/下/左/右 ~20px 边沿条带） → splitGroupWithTab
 *
 * Drop zone 命名约定（dnd-kit `id` 字段）：
 *   - 单 tab itself：tabId 原值（来自 useSortable({ id: tab.id })）
 *   - group bar 空白：`group-bar-${groupId}`
 *   - group 边沿：`group-edge-${groupId}-${side}`，side ∈ {top,right,bottom,left}
 *
 * 暴露 `usePaneDragState()` hook 让子组件知道"现在是不是在拖一个 tab"，
 * 用于条件渲染边沿 droppable 条带（避免平时挡到 PanelResizeHandle）。
 *
 * 与 react-resizable-panels 的兼容性：
 *   - useSortable activator 用 distance=8 阈值，避免点击 tab 立刻触发拖拽
 *   - 边沿 droppable 只在 dragging 状态显示；平时不挡 PanelResizeHandle 点击
 *
 * ⚠️ Cmd+S 等 focus-aware 快捷键的影响：拖完后浏览器 focus 短暂落到 body，
 * 但很快用户点击 / xterm 接管会恢复；本期不强补 focus restore。
 * ========================================================================== */

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  collectAllGroups,
  usePaneLayoutStore,
  type SplitDirection,
} from "../../stores/pane-layout";

interface DragState {
  /** 是否正在拖 tab（用于子组件按需渲染 edge droppable 条带）。 */
  isDraggingTab: boolean;
  /** 正在拖的 tabId（null = 没拖）。供 TabBar 给 dragged tab 半透明视觉用。 */
  activeTabId: string | null;
}

const PaneDragContext = createContext<DragState>({
  isDraggingTab: false,
  activeTabId: null,
});

/** 子组件用：现在是不是在拖某个 tab？正在拖的 tabId 是什么？ */
export function usePaneDragState(): DragState {
  return useContext(PaneDragContext);
}

interface Props {
  children: ReactNode;
}

/** 解析 `group-edge-${groupId}-${side}` 这种 droppable id。 */
function parseEdgeId(
  id: string,
): { groupId: string; side: "top" | "right" | "bottom" | "left" } | null {
  const prefix = "group-edge-";
  if (!id.startsWith(prefix)) return null;
  const rest = id.slice(prefix.length);
  // side 只能是这四个固定字符串，从右匹配
  const sides = ["top", "right", "bottom", "left"] as const;
  for (const side of sides) {
    if (rest.endsWith(`-${side}`)) {
      return { groupId: rest.slice(0, rest.length - side.length - 1), side };
    }
  }
  return null;
}

/** 解析 `group-bar-${groupId}` —— 注意：groupId 可能含 `-`（如 `g-initial`）。 */
function parseGroupBarId(id: string): string | null {
  const prefix = "group-bar-";
  return id.startsWith(prefix) ? id.slice(prefix.length) : null;
}

/** 在 layout tree 里找 tabId 所属的 group.id；找不到返 null。 */
function findGroupContainingTab(tabId: string): string | null {
  const root = usePaneLayoutStore.getState().root;
  for (const g of collectAllGroups(root)) {
    if (g.tab_ids.includes(tabId)) return g.id;
  }
  return null;
}

export function PaneDndContext({ children }: Props) {
  const [dragState, setDragState] = useState<DragState>({
    isDraggingTab: false,
    activeTabId: null,
  });

  // distance: 8 —— 鼠标按下后必须移动 8px 才触发拖拽，避免点击 tab 立刻误拖；
  // 也避开了"按 PanelResizeHandle 时被 dnd-kit 当成拖 tab"的连带误判
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
  );

  const handleDragStart = (event: DragStartEvent) => {
    const id = String(event.active.id);
    setDragState({ isDraggingTab: true, activeTabId: id });
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setDragState({ isDraggingTab: false, activeTabId: null });
    const { active, over } = event;
    if (!over) return;
    const tabId = String(active.id);
    const overId = String(over.id);
    const fromGroupId = findGroupContainingTab(tabId);
    if (!fromGroupId) return;

    const layout = usePaneLayoutStore.getState();

    // 3. group 边沿 → split（先判，因为 edge id 也含 `-` 容易混到 bar 解析）
    const edge = parseEdgeId(overId);
    if (edge) {
      const { groupId, side } = edge;
      // 拖回自己 group 的边沿 → 也允许（按 side 拆出去）
      const direction: SplitDirection =
        side === "left" || side === "right" ? "horizontal" : "vertical";
      // 注意：splitGroupWithTab 内部从 sourceGroupId（=fromGroupId）移除 tab，
      // 把新 group 创建到 groupId 这个**目标** group 上拼新 split——但 store
      // 的 splitGroupWithTab 签名是把新 group 创建在**源** group 旁边。
      // 这里 over 的 groupId 可能 ≠ fromGroupId：拖到别的 group 的边沿。
      // 期望语义："新 group 与 over.groupId 拼新 split，position 由 side 决定"。
      // 但 store 的 splitGroupWithTab 是基于 source（含 tab 的源）的 path 来
      // replace。要让新 group 出现在 over.groupId 旁边，需要：先 moveTab 把
      // tab 移到 over.groupId，再 splitGroupWithTab(over.groupId, ...)。
      // 简化：直接调 splitGroupWithTab 把新 group 拼到 over.groupId 旁边，
      // store 实现里源 group 用 over.groupId 作为 anchor，tab 来自 fromGroupId。
      // —— 但当前 store 的 splitGroupWithTab 设计是从 sourceGroupId 自己移除该
      // tab。所以这里要区分：
      //   - 同 group 边沿（fromGroupId === groupId） → 直接 splitGroupWithTab(fromGroupId, ...)
      //   - 跨 group 边沿（不同） → 先 moveTab(tabId, fromGroupId, groupId)，
      //                              再 splitGroupWithTab(groupId, ...)
      if (fromGroupId === groupId) {
        layout.splitGroupWithTab(groupId, direction, tabId, side);
      } else {
        const moved = layout.moveTab(tabId, fromGroupId, groupId);
        if (moved) {
          layout.splitGroupWithTab(groupId, direction, tabId, side);
        }
      }
      return;
    }

    // 2. 跨 group bar 空白 → moveTab
    const barGroupId = parseGroupBarId(overId);
    if (barGroupId) {
      if (barGroupId !== fromGroupId) {
        layout.moveTab(tabId, fromGroupId, barGroupId);
      }
      return;
    }

    // 1. drop 到另一个 tab：同 group 内重排 / 跨 group 移动到该 tab 位置
    // overId 此时是另一个 tabId
    const targetTabId = overId;
    if (targetTabId === tabId) return;
    const targetGroupId = findGroupContainingTab(targetTabId);
    if (!targetGroupId) return;

    if (targetGroupId === fromGroupId) {
      // 同 group 重排
      const root = usePaneLayoutStore.getState().root;
      const groups = collectAllGroups(root);
      const g = groups.find((x) => x.id === fromGroupId);
      if (!g) return;
      const fromIndex = g.tab_ids.indexOf(tabId);
      const toIndex = g.tab_ids.indexOf(targetTabId);
      if (fromIndex < 0 || toIndex < 0) return;
      layout.reorderTabInGroup(fromGroupId, fromIndex, toIndex);
    } else {
      // 跨 group：移到目标 group 末尾（不精确插入到 targetTab 位置，
      // moveTab 内部把新 tab 加到末尾，本期接受这个简化语义）
      layout.moveTab(tabId, fromGroupId, targetGroupId);
    }
  };

  const handleDragCancel = () => {
    setDragState({ isDraggingTab: false, activeTabId: null });
  };

  const ctxValue = useMemo(() => dragState, [dragState]);

  return (
    <PaneDragContext.Provider value={ctxValue}>
      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        {children}
      </DndContext>
    </PaneDragContext.Provider>
  );
}
