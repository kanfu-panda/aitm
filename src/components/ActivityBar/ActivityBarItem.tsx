import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  TOOLTIP_DELAY_MS,
  type ActivityBarPosition,
} from "./constants";
import { Tooltip } from "./Tooltip";

interface ActivityBarItemProps {
  /** 已包好尺寸的 lucide icon 元素，例如 `<Sparkles size={20} />`。 */
  icon: ReactNode;
  /** Tooltip 主文字 + a11y label。 */
  label: string;
  /** 可选快捷键提示，如 "⌘E"；显示在 tooltip chip 里。 */
  shortcut?: string;
  /** 是否高亮 active（emerald 文字 + emerald 边条）。 */
  isActive?: boolean;
  /** 是否禁用（灰显 + 不触发 onClick）。tooltip 仍可显示用于说明禁用原因。 */
  disabled?: boolean;
  /** 点击触发；ActivityBar 拼装时传 store action。disabled 时不触发。 */
  onClick: () => void;
  /**
   * 右下角红点 / 数字徽章。
   *
   * - undefined / 0：不显示
   * - >9：显示 "9+"
   *
   * T2 范围内浏览器 badge 由 T3 接进来；本组件 prop 兼容好。
   */
  badge?: number;
  /** ActivityBar 当前所在方向，控制 active 边条朝向 + tooltip 朝向。 */
  position: ActivityBarPosition;
  /** 测试 hook（默认根据 label 推断不稳定，要求显式传）。 */
  testId?: string;
}

/**
 * active 状态下 emerald 边条的 className（plan §4.5）。
 *
 * "边条永远朝内容区"——让激活的图标"指向它控制的内容"。
 *
 * - bar 在 right → 边条在按钮**左**侧
 * - bar 在 left  → 边条在按钮**右**侧
 * - bar 在 top   → 边条在按钮**底**部
 * - bar 在 bottom→ 边条在按钮**顶**部
 */
function indicatorClass(position: ActivityBarPosition): string {
  switch (position) {
    case "right":
      return "left-0 top-0 h-full w-[2px]";
    case "left":
      return "right-0 top-0 h-full w-[2px]";
    case "top":
      return "left-0 bottom-0 w-full h-[2px]";
    case "bottom":
      return "left-0 top-0 w-full h-[2px]";
  }
}

/**
 * v0.4.1 ActivityBar 单按钮。
 *
 * 视觉规格（plan §4.4 / §4.5）：
 * - default：text-[var(--c-text-muted)]，bg-transparent
 * - hover：bg-[var(--c-bg-elev-2)]，text-[var(--c-text-base)]
 * - active：text-[var(--c-success-fg)]，bg-[var(--c-bg-elev-2)]，--c-success 2px 边条朝内容区
 * - focus-visible：--c-focus-ring（key Tab 可达）
 *
 * 交互：
 * - hover 600ms 显示 tooltip；mouseleave 立即清掉 timer + 隐藏
 * - aria-label = label，方便屏读 + 测试
 * - badge prop 兼容 T3 的浏览器 tab 数字提示
 */
export function ActivityBarItem({
  icon,
  label,
  shortcut,
  isActive = false,
  disabled = false,
  onClick,
  badge,
  position,
  testId,
}: ActivityBarItemProps) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [tooltipVisible, setTooltipVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 卸载时清掉 timer，避免组件 unmount 后还触发 setState
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  const handleMouseEnter = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setTooltipVisible(true);
    }, TOOLTIP_DELAY_MS);
  };

  const handleMouseLeave = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setTooltipVisible(false);
  };

  // active 状态文字 --c-success-fg + bg --c-bg-elev-2；hover 同色叠加用同一 bg 不冲突
  // disabled 时降透明度 + 灰色 + 不响应 hover bg（cursor-not-allowed）
  const colorClass = disabled
    ? "text-[var(--c-text-faint)] opacity-50 cursor-not-allowed"
    : isActive
      ? "text-[var(--c-success-fg)] bg-[var(--c-bg-elev-2)]"
      : "text-[var(--c-text-muted)] hover:bg-[var(--c-bg-elev-2)] hover:text-[var(--c-text-base)]";

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={disabled ? undefined : onClick}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onFocus={handleMouseEnter}
        onBlur={handleMouseLeave}
        aria-label={label}
        aria-pressed={isActive}
        aria-disabled={disabled || undefined}
        data-active={isActive ? "true" : "false"}
        data-disabled={disabled ? "true" : undefined}
        data-testid={testId}
        className={
          "relative flex items-center justify-center " +
          "transition-colors duration-100 " +
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--c-focus-ring)] " +
          colorClass
        }
        style={{ width: "100%", height: "100%" }}
      >
        {/* active 2px 边条；内容区方向自适应（plan §4.5） */}
        {isActive && (
          <span
            data-testid="activity-bar-indicator"
            className={`absolute bg-[var(--c-success)] ${indicatorClass(position)}`}
            aria-hidden
          />
        )}
        {icon}
        {/* 数字 badge（plan §5.4 规格）— T2 prop 接好；T3 由 ActivityBar 拼装时传。 */}
        {typeof badge === "number" && badge > 0 && (
          <span
            data-testid="activity-bar-badge"
            className={
              "absolute -bottom-0.5 -right-0.5 " +
              "min-w-[14px] h-[14px] px-1 " +
              "rounded-full bg-[var(--c-success)] text-[var(--c-bg-base)] " +
              "text-[10px] font-semibold leading-[14px] text-center"
            }
          >
            {badge > 9 ? "9+" : badge}
          </span>
        )}
      </button>
      <Tooltip
        label={label}
        shortcut={shortcut}
        position={position}
        targetRef={buttonRef}
        visible={tooltipVisible}
      />
    </>
  );
}
