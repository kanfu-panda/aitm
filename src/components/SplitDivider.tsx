import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useTranslation } from "react-i18next";

/**
 * v0.6.0-A T2 通用分割条组件（plan §2.3）。
 *
 * 行为概要：
 * - 4px 宽 hit area（cursor: col-resize），中间 1px 默认线（--c-border-strong）。
 * - hover / 拖动中变 2px --c-info 视觉反馈。
 * - mousedown 进入拖动状态，监听 document mousemove / mouseup 全屏捕获。
 * - mousemove 用 requestAnimationFrame 节流到一帧一次，避免 React 多余 render。
 * - mouseup 调 onCommit（caller 拿来持久化到 settings TOML）。
 * - 双击 → onChange(defaultValue) + onCommit(defaultValue) 重置宽度。
 * - a11y：role="separator" + aria-orientation="vertical" + aria-valuenow/min/max + aria-label。
 *
 * direction 含义：
 * - "left"：caller 是位于左侧的面板（如 FileTree↔主区，FileTree 在左）；鼠标右移 → value 减小。
 * - "right"：caller 是位于右侧的面板（如 主区↔AiSidebar，AiSidebar 在右）；鼠标右移 → value 增加。
 */

interface Props {
  /** 当前宽度（px） */
  value: number;
  /** 拖动时的新宽度回调（节流；caller 用 zustand setState） */
  onChange: (next: number) => void;
  /** 拖动结束（mouseup）时回调，caller 这里持久化到 settings */
  onCommit?: (final: number) => void;
  /** 双击重置时使用的默认值 */
  defaultValue: number;
  /** 拖动方向（见模块注释） */
  direction: "left" | "right";
  /** 宽度上下限 */
  min: number;
  max: number;
  /** 可选 className 让 caller 加额外样式（如 z-index 调整） */
  className?: string;
  /** a11y 标题，screen reader 用 */
  ariaLabel?: string;
}

export default function SplitDivider({
  value,
  onChange,
  onCommit,
  defaultValue,
  direction,
  min,
  max,
  className,
  ariaLabel,
}: Props) {
  const { t } = useTranslation();
  const [dragging, setDragging] = useState(false);

  // 用 ref 而不是 state 缓存"拖动起点"与"最新 value"：
  // - mousemove handler 在 document 上注册一次，闭包要拿到实时数据
  // - rAF 节流时也只读 ref 不触发额外 render
  const startXRef = useRef(0);
  const startValueRef = useRef(value);
  const latestValueRef = useRef(value);
  const rafScheduledRef = useRef(false);
  const pendingClientXRef = useRef(0);

  // value prop 变化时同步到 latestValueRef，让 mouseup 拿得到最新值
  useEffect(() => {
    latestValueRef.current = value;
  }, [value]);

  const clamp = useCallback(
    (n: number) => Math.min(max, Math.max(min, n)),
    [min, max],
  );

  const computeNext = useCallback(
    (clientX: number) => {
      const delta = clientX - startXRef.current;
      const raw =
        direction === "left"
          ? startValueRef.current - delta
          : startValueRef.current + delta;
      return clamp(raw);
    },
    [direction, clamp],
  );

  // mousedown：记录起点，加 document 级监听
  const handleMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      // 仅响应左键
      if (e.button !== 0) return;
      e.preventDefault();
      startXRef.current = e.clientX;
      startValueRef.current = value;
      latestValueRef.current = value;
      setDragging(true);
    },
    [value],
  );

  // 拖动期间挂 document 监听（必须在 dragging=true 时挂；false 时清掉）
  useEffect(() => {
    if (!dragging) return;

    const flushFrame = () => {
      rafScheduledRef.current = false;
      const next = computeNext(pendingClientXRef.current);
      if (next !== latestValueRef.current) {
        latestValueRef.current = next;
        onChange(next);
      }
    };

    const handleMove = (e: MouseEvent) => {
      pendingClientXRef.current = e.clientX;
      if (rafScheduledRef.current) return;
      rafScheduledRef.current = true;
      requestAnimationFrame(flushFrame);
    };

    const handleUp = () => {
      setDragging(false);
      // mouseup 时同步 flush 一次最后位置，确保 commit 拿到最终值（避免 rAF 还没跑）
      if (rafScheduledRef.current) {
        rafScheduledRef.current = false;
        const next = computeNext(pendingClientXRef.current);
        if (next !== latestValueRef.current) {
          latestValueRef.current = next;
          onChange(next);
        }
      }
      onCommit?.(latestValueRef.current);
    };

    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);

    return () => {
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
    };
  }, [dragging, computeNext, onChange, onCommit]);

  // 双击：恢复默认宽度
  const handleDoubleClick = useCallback(() => {
    latestValueRef.current = defaultValue;
    onChange(defaultValue);
    onCommit?.(defaultValue);
  }, [defaultValue, onChange, onCommit]);

  // 4px hit area 居中包裹 1px 视觉线；视觉线宽 1px（默认）/ 2px（hover/拖动）
  // 容器用 absolute 由 caller 控制位置：caller 给 left 或 right 偏移
  const containerStyle: CSSProperties = {
    cursor: "col-resize",
    userSelect: "none",
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-label={ariaLabel ?? t("splitDivider.defaultAria")}
      data-dragging={dragging ? "true" : undefined}
      data-testid="split-divider"
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
      style={containerStyle}
      className={`group absolute top-0 bottom-0 w-1 -mx-0.5 z-10 ${className ?? ""}`}
    >
      {/* 视觉线：默认 1px --c-border-strong；hover 或 dragging 时 2px --c-info */}
      <div
        aria-hidden="true"
        className={[
          "absolute top-0 bottom-0 left-1/2 -translate-x-1/2 pointer-events-none transition-colors",
          dragging
            ? "w-0.5 bg-[var(--c-info)]"
            : "w-px bg-[var(--c-border-strong)] group-hover:w-0.5 group-hover:bg-[var(--c-info)]",
        ].join(" ")}
      />
    </div>
  );
}
