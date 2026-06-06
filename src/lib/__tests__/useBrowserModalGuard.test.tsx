/**
 * v0.4.1 真机 smoke hotfix：useBrowserModalGuard 单测
 *
 * 覆盖：
 *  1. open=true 触发一次 hideAllActive；unmount cleanup 触发一次 showAllActive
 *  2. open=false 不触发 hide；切到 true 才触发；再切回 false 触发 show
 *  3. 多次 open ↔ close 切换 hide/show 计数正确成对
 *  4. IPC reject 时只 warn 不抛（避免 modal 因辅助逻辑挂掉）
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// mock IPC 包装层：两个函数都换成 vi.fn，可断言调用次数
vi.mock("../tauri", () => ({
  browserHideAllActive: vi.fn().mockResolvedValue(undefined),
  browserShowAllActive: vi.fn().mockResolvedValue(undefined),
}));

import { browserHideAllActive, browserShowAllActive } from "../tauri";
import { useBrowserModalGuard } from "../useBrowserModalGuard";

const hide = browserHideAllActive as unknown as ReturnType<typeof vi.fn>;
const show = browserShowAllActive as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  hide.mockReset();
  hide.mockResolvedValue(undefined);
  show.mockReset();
  show.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useBrowserModalGuard", () => {
  it("isOpen=true 时调用 hideAllActive；unmount 调用 showAllActive", () => {
    const { unmount } = renderHook(({ open }) => useBrowserModalGuard(open), {
      initialProps: { open: true },
    });

    expect(hide).toHaveBeenCalledTimes(1);
    expect(show).not.toHaveBeenCalled();

    unmount();
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("isOpen=false 不触发 hide；切到 true 才触发；切回 false 触发 show", () => {
    const { rerender } = renderHook(
      ({ open }) => useBrowserModalGuard(open),
      { initialProps: { open: false } },
    );

    expect(hide).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();

    rerender({ open: true });
    expect(hide).toHaveBeenCalledTimes(1);
    expect(show).not.toHaveBeenCalled();

    rerender({ open: false });
    expect(hide).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("多次切换：hide / show 成对计数", () => {
    const { rerender, unmount } = renderHook(
      ({ open }) => useBrowserModalGuard(open),
      { initialProps: { open: false } },
    );

    rerender({ open: true });
    rerender({ open: false });
    rerender({ open: true });
    rerender({ open: false });
    rerender({ open: true });

    // 3 次开 → 3 次 hide；2 次关 → 2 次 show
    expect(hide).toHaveBeenCalledTimes(3);
    expect(show).toHaveBeenCalledTimes(2);

    // 最后一次仍 open；unmount 触发第 3 次 show 配对
    unmount();
    expect(show).toHaveBeenCalledTimes(3);
  });

  it("IPC 失败时只 warn 不抛（不影响 modal 显示）", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    hide.mockRejectedValueOnce(new Error("ipc backend down"));

    const { unmount } = renderHook(() => useBrowserModalGuard(true));

    // hide 是 fire-and-forget；微任务跑完 catch handler 就 warn
    await act(async () => {
      await Promise.resolve();
    });

    expect(hide).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "[modal-guard] browserHideAllActive 失败",
      expect.any(Error),
    );

    show.mockRejectedValueOnce(new Error("ipc backend down 2"));
    unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(show).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "[modal-guard] browserShowAllActive 失败",
      expect.any(Error),
    );
  });
});
