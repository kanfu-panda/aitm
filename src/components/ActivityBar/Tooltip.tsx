import { useEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { ActivityBarPosition } from "./constants";

interface TooltipProps {
  /** 文字主体。 */
  label: string;
  /** 可选的快捷键提示，如 "⌘E"；显示成 chip 风格。 */
  shortcut?: string;
  /** ActivityBar 当前所在方向（决定 tooltip 出现在按钮哪一侧）。 */
  position: ActivityBarPosition;
  /** 触发 tooltip 的元素引用，用于 getBoundingClientRect 算位置。 */
  targetRef: RefObject<HTMLElement | null>;
  /** 是否显示。父组件控制 hover delay 后翻这个 flag。 */
  visible: boolean;
}

interface ScreenPos {
  /** CSS top（px，相对 viewport）。 */
  top: number;
  /** CSS left（px，相对 viewport）。 */
  left: number;
  /** transform 控制 tooltip 自身锚点，让 (top, left) 命中按钮中线。 */
  transform: string;
}

/** ActivityBar tooltip 与按钮之间的 gap。 */
const TOOLTIP_GAP_PX = 8;

/** 按钮 getBoundingClientRect 的最小子集。 */
interface BtnRect {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/**
 * 根据按钮 rect + bar 方向，算 tooltip 应该出现在按钮的哪一侧。
 *
 * 规则（plan §4.7 表）：
 *   right → 按钮**左**侧 8px
 *   left  → 按钮**右**侧 8px
 *   top   → 按钮**下**方 8px
 *   bottom→ 按钮**上**方 8px
 *
 * tooltip 永远朝 ActivityBar 的"内容区一侧"，避免挡屏幕边缘。
 */
function computePos(
  rect: BtnRect,
  position: ActivityBarPosition,
): ScreenPos {
  switch (position) {
    case "right":
      // bar 在屏幕右 → tooltip 在按钮左
      return {
        top: rect.top + rect.height / 2,
        left: rect.left - TOOLTIP_GAP_PX,
        transform: "translate(-100%, -50%)",
      };
    case "left":
      // bar 在屏幕左 → tooltip 在按钮右
      return {
        top: rect.top + rect.height / 2,
        left: rect.right + TOOLTIP_GAP_PX,
        transform: "translate(0, -50%)",
      };
    case "top":
      // bar 在屏幕上 → tooltip 在按钮下方
      return {
        top: rect.bottom + TOOLTIP_GAP_PX,
        left: rect.left + rect.width / 2,
        transform: "translate(-50%, 0)",
      };
    case "bottom":
      // bar 在屏幕下 → tooltip 在按钮上方
      return {
        top: rect.top - TOOLTIP_GAP_PX,
        left: rect.left + rect.width / 2,
        transform: "translate(-50%, -100%)",
      };
  }
}

/**
 * v0.4.1 ActivityBar 自实现轻量 tooltip。
 *
 * 设计要点（plan §4.7）：
 * - 通过 portal 渲染到 document.body，避开父级 overflow / z-index 干扰
 * - 出现位置根据 ActivityBar position 自适应（始终朝内容区一侧，不挡屏幕边缘）
 * - shortcut chip 风格内嵌；样式跟着 token（--c-bg-elev-2 bg / --c-text-base fg）
 * - 不依赖 Radix —— Radix Tooltip 在 ActivityBar 这种"4 向锚定"场景下设置 portal
 *   /side 比较绕，自实现更直接
 *
 * 显示流程由 ActivityBarItem 控制：hover 600ms → setVisible(true)；
 * mouseleave → 立即 setVisible(false)。本组件只负责"被 visible 时画出来"。
 */
export function Tooltip({
  label,
  shortcut,
  position,
  targetRef,
  visible,
}: TooltipProps) {
  const [pos, setPos] = useState<ScreenPos | null>(null);

  useEffect(() => {
    if (!visible) {
      setPos(null);
      return;
    }
    const compute = () => {
      const el = targetRef.current;
      if (!el) return;
      setPos(computePos(el.getBoundingClientRect(), position));
    };
    compute();
    // 窗口 resize / scroll 时重算（用户拖窗口的瞬间 tooltip 也要跟着按钮走）
    window.addEventListener("resize", compute);
    window.addEventListener("scroll", compute, true);
    return () => {
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute, true);
    };
  }, [visible, position, targetRef]);

  if (!visible || !pos) return null;

  // jsdom 测试环境也有 document.body；portal 在 SSR 环境才需要兜底。
  return createPortal(
    <div
      role="tooltip"
      data-testid="activity-bar-tooltip"
      data-position={position}
      style={{
        position: "fixed",
        top: pos.top,
        left: pos.left,
        transform: pos.transform,
        // z-overlay = 30（plan §2.6），高于 ActivityBar 的 sticky 层
        zIndex: 30,
        pointerEvents: "none",
      }}
      className="whitespace-nowrap rounded-md bg-[var(--c-bg-elev-2)] px-2 py-1 text-xs text-[var(--c-text-base)] shadow-lg"
    >
      <span>{label}</span>
      {shortcut && (
        <kbd className="ml-2 rounded bg-[var(--c-bg-elev-3)] px-1.5 py-0.5 text-[12px] font-semibold text-[var(--c-text-base)] tracking-wide">
          {shortcut}
        </kbd>
      )}
    </div>,
    document.body,
  );
}
