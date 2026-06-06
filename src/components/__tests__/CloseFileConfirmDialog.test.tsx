/* =============================================================================
 * CloseFileConfirmDialog 单测（v0.9.0 T5b）
 * -----------------------------------------------------------------------------
 * 覆盖：
 *   - pendingPath=null → dialog 不渲染
 *   - pendingPath=path → dialog 渲染，标题显示 basename
 *   - 点"保存并关闭" → onSaveAndClose
 *   - 点"丢弃改动" → onDiscard
 *   - 点"取消" → onCancel
 *   - Esc / 点遮罩（onOpenChange(false)）→ onCancel
 * ========================================================================== */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
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

import CloseFileConfirmDialog from "../CloseFileConfirmDialog";

afterEach(() => {
  cleanup();
});

describe("CloseFileConfirmDialog", () => {
  let onSave: ReturnType<typeof vi.fn>;
  let onDiscard: ReturnType<typeof vi.fn>;
  let onCancel: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onSave = vi.fn();
    onDiscard = vi.fn();
    onCancel = vi.fn();
  });

  it("pendingPath=null 时不渲染 dialog", () => {
    render(
      <CloseFileConfirmDialog
        pendingPath={null}
        onSaveAndClose={onSave}
        onDiscard={onDiscard}
        onCancel={onCancel}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("pendingPath=path 时 dialog 渲染，标题显示 basename", () => {
    render(
      <CloseFileConfirmDialog
        pendingPath="/proj/src/foo.ts"
        onSaveAndClose={onSave}
        onDiscard={onDiscard}
        onCancel={onCancel}
      />,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("foo.ts");
    expect(dialog.textContent).not.toContain("/proj/src/foo.ts");
  });

  it("点 '保存并关闭' → onSaveAndClose 调一次", () => {
    render(
      <CloseFileConfirmDialog
        pendingPath="/x/a.ts"
        onSaveAndClose={onSave}
        onDiscard={onDiscard}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByTestId("close-file-btn-save"));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onDiscard).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("点 '丢弃改动' → onDiscard 调一次", () => {
    render(
      <CloseFileConfirmDialog
        pendingPath="/x/a.ts"
        onSaveAndClose={onSave}
        onDiscard={onDiscard}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByTestId("close-file-btn-discard"));
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("点 '取消' → onCancel 调一次", () => {
    render(
      <CloseFileConfirmDialog
        pendingPath="/x/a.ts"
        onSaveAndClose={onSave}
        onDiscard={onDiscard}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByTestId("close-file-btn-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("Esc 关闭（Radix onOpenChange(false)）→ onCancel", () => {
    render(
      <CloseFileConfirmDialog
        pendingPath="/x/a.ts"
        onSaveAndClose={onSave}
        onDiscard={onDiscard}
        onCancel={onCancel}
      />,
    );
    // Radix Dialog 默认 Esc 触发 onOpenChange(false)；用 keyDown 模拟
    fireEvent.keyDown(document.activeElement || document.body, {
      key: "Escape",
    });
    expect(onCancel).toHaveBeenCalled();
  });
});
