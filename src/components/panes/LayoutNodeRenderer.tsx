/* =============================================================================
 * LayoutNodeRenderer.tsx —— v0.10.0 HR6-3c / HR9-1 递归渲染 layout tree
 * -----------------------------------------------------------------------------
 * 根据 usePaneLayoutStore.root 递归出 PanelGroup + PanelResizeHandle 嵌套结构：
 *   - leaf  → <TerminalPaneGroup group={node.group} />
 *   - split → <PanelGroup direction>...<PanelResizeHandle>...</PanelGroup>
 *
 * 每层 PanelGroup 用 `pathFromRoot` 拼一个稳定的 `autoSaveId`，让
 * react-resizable-panels 内部 storage 不冲突。
 *
 * `setRatio` 通过 PanelGroup 的 onLayout 回调写回 layout store（数组 [a,b]
 * 之和恒等 100，取第一个 / 100 即新 ratio）；clamp 已在 store 内做。
 *
 * v0.10.0 HR9-1：layout tree 已简化为 terminal-only。原本 PaneGroupRenderer
 * 的分派层（terminal / browser / editor）整层删掉，叶子直接渲染
 * TerminalPaneGroup。文件预览 / 浏览器 / AI 侧栏全是 App.tsx 直接渲染的全局
 * 单例，跟 layout tree 解耦。
 * ========================================================================== */

import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import type { LayoutNode, PathStep } from "../../stores/pane-layout";
import { usePaneLayoutStore } from "../../stores/pane-layout";
import { TerminalPaneGroup } from "./TerminalPaneGroup";

interface Props {
  node: LayoutNode;
  /** 从根到当前 node 的路径；根节点 [] 即可。 */
  pathFromRoot?: PathStep[];
}

/** 把路径序列化为稳定 key（用于 PanelGroup autoSaveId 防冲突）。 */
function pathKey(path: PathStep[]): string {
  return path.length === 0 ? "root" : path.join("-");
}

export function LayoutNodeRenderer({ node, pathFromRoot = [] }: Props) {
  const setRatio = usePaneLayoutStore((s) => s.setRatio);

  if (node.kind === "leaf") {
    // v0.10.0 HR9-1：layout tree 只剩 terminal type，直接渲染 TerminalPaneGroup。
    return <TerminalPaneGroup group={node.group} />;
  }

  const leftPct = node.ratio * 100;
  const rightPct = (1 - node.ratio) * 100;
  // autoSaveId 用路径区分 —— 但同时 ratio 由 store 控制（受控模式），
  // react-resizable-panels 的 autoSave 会覆盖我们的 defaultSize；
  // 给个稳定 id 即可，真正的"持久化"留给 HR6-3e（写 settings.ui.pane_layout）。
  const saveId = `aitm-pane-${pathKey(pathFromRoot)}`;

  return (
    <PanelGroup
      direction={node.direction}
      autoSaveId={saveId}
      className={node.direction === "horizontal" ? "flex flex-1 min-w-0" : "flex flex-col flex-1 min-h-0"}
      onLayout={(sizes) => {
        // sizes = [leftPct, rightPct]；写回 store 让 ratio 真正可持久化。
        if (sizes.length !== 2) return;
        const next = sizes[0] / 100;
        // 避免 onLayout 在 mount 阶段反复写同值；store 内 setRatio 不做
        // 比较，这里也无所谓，zustand setState 同值不触发订阅。
        setRatio(pathFromRoot, next);
      }}
    >
      <Panel
        defaultSize={leftPct}
        minSize={10}
        data-testid={`pane-${pathKey(pathFromRoot)}-left`}
      >
        <LayoutNodeRenderer
          node={node.left}
          pathFromRoot={[...pathFromRoot, "left"]}
        />
      </Panel>
      {/* v0.10.0 HR8-3：分屏 resize handle 视觉强化
       *  - 视觉宽度 1px（保持紧凑）；hit area 用 negative margin 扩 3px each side（容易抓）
       *  - hover/drag 状态变 emerald（明显反馈）；非 hover 显灰边框色（看得见但不抢戏）
       *  - data-resize-handle-active="true" 是 react-resizable-panels 拖拽时加的，
       *    用 CSS 选 [data-panel-resize-handle-active] 也行；className 已含 group/dnd helper 让 hover 同窗 */}
      <PanelResizeHandle
        className={
          node.direction === "horizontal"
            ? // 左右切分：竖向 handle
              "group relative w-px bg-[var(--c-border-strong)] hover:bg-[var(--c-success)] data-[resize-handle-state=drag]:bg-[var(--c-success)] transition-colors before:absolute before:inset-y-0 before:-left-1 before:-right-1 before:content-['']"
            : // 上下切分：水平 handle
              "group relative h-px bg-[var(--c-border-strong)] hover:bg-[var(--c-success)] data-[resize-handle-state=drag]:bg-[var(--c-success)] transition-colors before:absolute before:inset-x-0 before:-top-1 before:-bottom-1 before:content-['']"
        }
        aria-label={
          node.direction === "horizontal"
            ? "拖拽调整左右分屏比例"
            : "拖拽调整上下分屏比例"
        }
      />
      <Panel
        defaultSize={rightPct}
        minSize={10}
        data-testid={`pane-${pathKey(pathFromRoot)}-right`}
      >
        <LayoutNodeRenderer
          node={node.right}
          pathFromRoot={[...pathFromRoot, "right"]}
        />
      </Panel>
    </PanelGroup>
  );
}
