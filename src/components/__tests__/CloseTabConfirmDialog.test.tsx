import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// v0.4.2 T3：mock 浏览器 webview 让位 IPC（保留其它 real 实现）
vi.mock("../../lib/tauri", async (orig) => {
  const real = await orig<typeof import("../../lib/tauri")>();
  return {
    ...real,
    browserHideAllActive: vi.fn().mockResolvedValue(undefined),
    browserShowAllActive: vi.fn().mockResolvedValue(undefined),
  };
});

import CloseTabConfirmDialog from "../CloseTabConfirmDialog";
import { browserHideAllActive, browserShowAllActive } from "../../lib/tauri";

const mockHide = browserHideAllActive as unknown as ReturnType<typeof vi.fn>;
const mockShow = browserShowAllActive as unknown as ReturnType<typeof vi.fn>;

/**
 * Phase 3A T5：关闭 tab 二次确认 dialog 单测。
 * - pendingTabTitle=null → 不渲染 dialog
 * - 有 title → 渲染并含 title 文案
 * - 取消按钮 / 强制关闭按钮分别触发 onCancel / onConfirm
 *
 * 注意 Radix Dialog 通过 Portal 渲染到 document.body，jsdom 用
 * screen.getByRole("dialog") 全局查找，不限定 render container。
 */
describe("CloseTabConfirmDialog", () => {
  beforeEach(() => {
    mockHide.mockClear();
    mockShow.mockClear();
  });

  it("pendingTabTitle=null → dialog 不出现", () => {
    render(
      <CloseTabConfirmDialog
        pendingTabTitle={null}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("有 title → dialog 出现且文案含 title", () => {
    render(
      <CloseTabConfirmDialog
        pendingTabTitle="我的 npm install"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeTruthy();
    expect(dialog.textContent).toContain("我的 npm install");
    // v1.1.0 R2：文案简化为"有任务正在运行，确定关闭吗？"
    expect(dialog.textContent).toContain("确定关闭");
  });

  it("点取消 → onCancel 被调，onConfirm 不被调", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <CloseTabConfirmDialog
        pendingTabTitle="t"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("点强制关闭 → onConfirm 被调，onCancel 不被调", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <CloseTabConfirmDialog
        pendingTabTitle="t"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "关闭" }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  // v0.4.2 T3：useBrowserModalGuard 接入验证（WKWebView 让位）
  it("dialog 弹起（pendingTabTitle 非 null）调 browserHideAllActive", async () => {
    render(
      <CloseTabConfirmDialog
        pendingTabTitle="busy-tab"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    await waitFor(() => expect(mockHide).toHaveBeenCalledTimes(1));
  });

  it("pendingTabTitle=null 不调 browserHideAllActive", () => {
    render(
      <CloseTabConfirmDialog
        pendingTabTitle={null}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(mockHide).not.toHaveBeenCalled();
  });

  it("dialog 关闭（rerender 把 title 改 null）调 browserShowAllActive", async () => {
    const { rerender } = render(
      <CloseTabConfirmDialog
        pendingTabTitle="busy-tab"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    await waitFor(() => expect(mockHide).toHaveBeenCalledTimes(1));

    rerender(
      <CloseTabConfirmDialog
        pendingTabTitle={null}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    await waitFor(() => expect(mockShow).toHaveBeenCalledTimes(1));
  });
});
