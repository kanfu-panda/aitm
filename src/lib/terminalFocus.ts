import { useEffect, useRef } from "react";

/** 「把键盘焦点交给当前活动终端」的请求事件名。 */
const FOCUS_REQUEST_EVENT = "aitm:focus-active-terminal";

/**
 * 请求把键盘焦点交给当前活动终端（焦点分屏里选中的那个标签）。
 *
 * 用于对话框关闭后：对话框开着时新建的终端即使调了 `focus()`，也会被对话框的焦点
 * 锁拉回去；对话框关闭后 Radix 默认又把焦点还给触发按钮，终端就一直没拿到焦点。
 */
export function requestTerminalFocus(): void {
  window.dispatchEvent(new Event(FOCUS_REQUEST_EVENT));
}

/**
 * 终端一侧：`enabled`（本终端是当前活动终端）时响应 [`requestTerminalFocus`]。
 * 只让活动终端响应，避免后台分屏抢走焦点。
 */
export function useTerminalFocusRequest(
  enabled: boolean,
  focus: () => void,
): void {
  const focusRef = useRef(focus);
  focusRef.current = focus;
  useEffect(() => {
    if (!enabled) return;
    const handler = () => focusRef.current();
    window.addEventListener(FOCUS_REQUEST_EVENT, handler);
    return () => window.removeEventListener(FOCUS_REQUEST_EVENT, handler);
  }, [enabled]);
}
