import type { ReactNode } from "react";

/**
 * v0.6.0-A T3：包裹 FileTree / AiSidebar 的定宽 + relative 容器；
 * 子节点里嵌的 SplitDivider 用 position: absolute 锚定到 wrapper 边沿。
 *
 * 设计：
 * - 宽度由 props 传入（caller 从 useSettingsStore 读 file_tree_width / ai_sidebar_width）；
 * - borderSide 决定哪一侧画 1px 分隔线（FileTree 在左 → borderSide=right；
 *   AiSidebar 在右 → borderSide=left）；SplitDivider hit area 盖在 border 上。
 *
 * 抽到独立文件而非 App.tsx 内部，是为了单测能 import + 复用。
 */
export default function SidebarWrapper({
  width,
  borderSide,
  children,
  "data-testid": testId,
}: {
  width: number;
  borderSide: "left" | "right";
  children: ReactNode;
  "data-testid"?: string;
}) {
  return (
    <div
      className={`relative flex h-full flex-shrink-0 flex-col bg-[var(--c-bg-elev-1)] ${
        borderSide === "right" ? "border-r" : "border-l"
      } border-[var(--c-border)]`}
      style={{ width: `${width}px` }}
      data-testid={testId}
    >
      {children}
    </div>
  );
}
