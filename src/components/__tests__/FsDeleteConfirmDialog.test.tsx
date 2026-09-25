/* =============================================================================
 * FsDeleteConfirmDialog 单测（补测，2026-09-24）
 * -----------------------------------------------------------------------------
 * 覆盖：
 *   - pending=null → dialog 不渲染
 *   - pending=文件/文件夹 → 标题/描述/路径按 isDir 区分渲染
 *   - 点"取消" → onCancel
 *   - 点"删除"成功 → onConfirm(path) 被调，过程中按钮 disabled，无错误提示
 *   - 点"删除"失败（Error 实例）→ 显示 error.message，按钮恢复可点
 *   - 点"删除"失败（非 Error，如字符串）→ 显示 String(e)
 *   - pending 切换（换成新的待删目标）→ 内部 error/submitting 状态被 reset
 *   - Esc / 点遮罩（onOpenChange(false)）→ onCancel
 * ========================================================================== */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

// useBrowserModalGuard 调 browserHideAllActive；jsdom 环境用 partial mock 静默
vi.mock("../../lib/tauri", async (orig) => {
  const real = await orig<typeof import("../../lib/tauri")>();
  return {
    ...real,
    browserHideAllActive: vi.fn().mockResolvedValue(undefined),
    browserShowAllActive: vi.fn().mockResolvedValue(undefined),
  };
});

import FsDeleteConfirmDialog from "../FsDeleteConfirmDialog";

afterEach(() => {
  cleanup();
});

describe("FsDeleteConfirmDialog", () => {
  let onConfirm: ReturnType<typeof vi.fn>;
  let onCancel: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onConfirm = vi.fn().mockResolvedValue(undefined);
    onCancel = vi.fn();
  });

  it("pending=null 时不渲染 dialog", () => {
    render(
      <FsDeleteConfirmDialog
        pending={null}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("pending=文件 时渲染文件标题/描述/路径", () => {
    render(
      <FsDeleteConfirmDialog
        pending={{ path: "/proj/src/foo.ts", name: "foo.ts", isDir: false }}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    const dialog = screen.getByTestId("fs-delete-dialog");
    expect(dialog.textContent).toContain("删除文件？");
    expect(dialog.textContent).toContain("foo.ts");
    expect(dialog.textContent).toContain("/proj/src/foo.ts");
  });

  it("pending=文件夹 时渲染文件夹标题/描述", () => {
    render(
      <FsDeleteConfirmDialog
        pending={{ path: "/proj/src/dir", name: "dir", isDir: true }}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    const dialog = screen.getByTestId("fs-delete-dialog");
    expect(dialog.textContent).toContain("删除文件夹？");
    expect(dialog.textContent).toContain("及其所有内容将被永久删除");
  });

  it("点'取消' → onCancel 调一次，onConfirm 不调", () => {
    render(
      <FsDeleteConfirmDialog
        pending={{ path: "/x/a.ts", name: "a.ts", isDir: false }}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByTestId("fs-delete-dialog-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("点'删除'成功 → onConfirm(path) 被调，过程中按钮 disabled，不显示错误", async () => {
    let resolveConfirm: () => void = () => {};
    onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveConfirm = resolve;
        }),
    );

    render(
      <FsDeleteConfirmDialog
        pending={{ path: "/x/a.ts", name: "a.ts", isDir: false }}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    const confirmBtn = screen.getByTestId("fs-delete-dialog-confirm");
    const cancelBtn = screen.getByTestId("fs-delete-dialog-cancel");
    fireEvent.click(confirmBtn);

    // 请求还没 resolve：submitting=true，两个按钮都应该 disabled
    await waitFor(() => expect(confirmBtn).toBeDisabled());
    expect(cancelBtn).toBeDisabled();
    expect(onConfirm).toHaveBeenCalledWith("/x/a.ts");
    expect(screen.queryByTestId("fs-delete-dialog-error")).toBeNull();

    // 成功分支不主动 setSubmitting(false)——源码注释写明"成功 → caller 应该
    // setPending(null) 关 dialog"，所以这里 resolve 后按钮仍保持 disabled，
    // 直到调用方把 pending 置空、组件整体不渲染为止。
    resolveConfirm();
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(confirmBtn).toBeDisabled();
  });

  it("点'删除'失败（Error 实例）→ 显示 error.message，按钮恢复可点", async () => {
    onConfirm = vi.fn().mockRejectedValue(new Error("磁盘只读，删除失败"));

    render(
      <FsDeleteConfirmDialog
        pending={{ path: "/x/a.ts", name: "a.ts", isDir: false }}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByTestId("fs-delete-dialog-confirm"));

    const errorBox = await screen.findByTestId("fs-delete-dialog-error");
    expect(errorBox.textContent).toBe("磁盘只读，删除失败");
    expect(screen.getByTestId("fs-delete-dialog-confirm")).not.toBeDisabled();
  });

  it("点'删除'失败（非 Error，如字符串）→ 显示 String(e)", async () => {
    onConfirm = vi.fn().mockRejectedValue("权限不足");

    render(
      <FsDeleteConfirmDialog
        pending={{ path: "/x/a.ts", name: "a.ts", isDir: false }}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByTestId("fs-delete-dialog-confirm"));

    const errorBox = await screen.findByTestId("fs-delete-dialog-error");
    expect(errorBox.textContent).toBe("权限不足");
  });

  it("pending 切换成新目标 → 之前的错误提示被清空（useEffect reset）", async () => {
    onConfirm = vi.fn().mockRejectedValue(new Error("第一次删除失败"));

    const { rerender } = render(
      <FsDeleteConfirmDialog
        pending={{ path: "/x/a.ts", name: "a.ts", isDir: false }}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByTestId("fs-delete-dialog-confirm"));
    await screen.findByTestId("fs-delete-dialog-error");

    // 切到新的待删目标：v0.10.2 hotfix 要求 error/submitting 都被 reset
    rerender(
      <FsDeleteConfirmDialog
        pending={{ path: "/y/b.ts", name: "b.ts", isDir: false }}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    expect(screen.queryByTestId("fs-delete-dialog-error")).toBeNull();
    expect(screen.getByTestId("fs-delete-dialog-confirm")).not.toBeDisabled();
    expect(screen.getByTestId("fs-delete-dialog").textContent).toContain(
      "b.ts",
    );
  });

  it("Esc 关闭（Radix onOpenChange(false)）→ onCancel", () => {
    render(
      <FsDeleteConfirmDialog
        pending={{ path: "/x/a.ts", name: "a.ts", isDir: false }}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    fireEvent.keyDown(document.activeElement || document.body, {
      key: "Escape",
    });
    expect(onCancel).toHaveBeenCalled();
  });
});
