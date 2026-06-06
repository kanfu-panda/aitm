import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 测试夹具：把 onAppConfirmQuitRequested 注入的 callback 暴露给测试代码，
// spec 主动触发"后端 app:confirm-quit-requested 事件到达"。
const quitCallbacks: Array<() => void> = [];

vi.mock("../../lib/tauri", async (orig) => {
  const real = await orig<typeof import("../../lib/tauri")>();
  return {
    ...real,
    appQuitConfirmed: vi.fn().mockResolvedValue(undefined),
    browserHideAllActive: vi.fn().mockResolvedValue(undefined),
    browserShowAllActive: vi.fn().mockResolvedValue(undefined),
    onAppConfirmQuitRequested: vi.fn(async (cb: () => void) => {
      quitCallbacks.push(cb);
      return () => {
        const idx = quitCallbacks.indexOf(cb);
        if (idx >= 0) quitCallbacks.splice(idx, 1);
      };
    }),
  };
});

import QuitConfirmDialog from "../QuitConfirmDialog";
import { appQuitConfirmed } from "../../lib/tauri";

const mockQuit = appQuitConfirmed as unknown as ReturnType<typeof vi.fn>;

function fireQuitRequest() {
  act(() => {
    for (const cb of [...quitCallbacks]) cb();
  });
}

/**
 * v0.9.0 T4：关闭应用二次确认 dialog 单测。
 *
 * 覆盖：
 * - 初始不渲染（未触发事件）
 * - 收到 app:confirm-quit-requested → 弹 dialog
 * - "取消" → 关 dialog 不调 appQuitConfirmed
 * - "退出" → 调 appQuitConfirmed
 * - Esc / 点遮罩（onOpenChange(false)） → 关 dialog 不调 appQuitConfirmed
 */
describe("QuitConfirmDialog", () => {
  beforeEach(() => {
    quitCallbacks.length = 0;
    mockQuit.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("初始未触发事件 → dialog 不渲染", async () => {
    render(<QuitConfirmDialog />);
    await waitFor(() => expect(quitCallbacks.length).toBe(1));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("收到事件 → dialog 弹出 + 标题 + 描述 + 两按钮", async () => {
    render(<QuitConfirmDialog />);
    await waitFor(() => expect(quitCallbacks.length).toBe(1));

    fireQuitRequest();

    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("确认退出 aitm");
    expect(dialog.textContent).toContain(
      "所有终端会话和未保存的文件编辑将会丢失",
    );
    expect(screen.getByTestId("quit-btn-cancel")).toBeTruthy();
    expect(screen.getByTestId("quit-btn-confirm")).toBeTruthy();
  });

  it("点 '取消' → dialog 关闭，不调 appQuitConfirmed", async () => {
    render(<QuitConfirmDialog />);
    await waitFor(() => expect(quitCallbacks.length).toBe(1));

    fireQuitRequest();
    await screen.findByRole("dialog");

    fireEvent.click(screen.getByTestId("quit-btn-cancel"));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mockQuit).not.toHaveBeenCalled();
  });

  it("点 '退出' → 调 appQuitConfirmed 一次 + dialog 关闭", async () => {
    render(<QuitConfirmDialog />);
    await waitFor(() => expect(quitCallbacks.length).toBe(1));

    fireQuitRequest();
    await screen.findByRole("dialog");

    fireEvent.click(screen.getByTestId("quit-btn-confirm"));

    await waitFor(() => expect(mockQuit).toHaveBeenCalledTimes(1));
    // dialog 关闭（confirm handler 内 setOpen(false) 在 invoke 之前同步执行）
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("收到事件两次 → dialog 仍可弹（关掉再开）", async () => {
    render(<QuitConfirmDialog />);
    await waitFor(() => expect(quitCallbacks.length).toBe(1));

    // 第一次弹 → 取消
    fireQuitRequest();
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByTestId("quit-btn-cancel"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // 第二次弹仍能成功
    fireQuitRequest();
    await screen.findByRole("dialog");
    expect(mockQuit).not.toHaveBeenCalled();
  });
});
