import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { requestTerminalFocus, useTerminalFocusRequest } from "../terminalFocus";

describe("聚焦当前终端的请求", () => {
  it("应该_当终端是当前活动终端时_收到请求就聚焦", () => {
    const focus = vi.fn();
    renderHook(() => useTerminalFocusRequest(true, focus));

    requestTerminalFocus();

    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("应该_当终端不是活动终端时_不响应请求（避免后台分屏抢焦点）", () => {
    const focus = vi.fn();
    renderHook(() => useTerminalFocusRequest(false, focus));

    requestTerminalFocus();

    expect(focus).not.toHaveBeenCalled();
  });

  it("应该_在卸载后_不再响应请求", () => {
    const focus = vi.fn();
    const { unmount } = renderHook(() => useTerminalFocusRequest(true, focus));
    unmount();

    requestTerminalFocus();

    expect(focus).not.toHaveBeenCalled();
  });
});
