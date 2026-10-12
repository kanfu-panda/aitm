/* PreviewFallback / PreviewLoading 单测：预览失败兜底与加载提示。 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/tauri", () => ({
  shellOpen: vi.fn(),
}));

import { shellOpen } from "../../../lib/tauri";
import PreviewFallback, { PreviewLoading } from "../PreviewFallback";

const shellOpenMock = shellOpen as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  shellOpenMock.mockReset().mockResolvedValue(undefined);
});

describe("PreviewFallback", () => {
  it("应该_当渲染时_显示提示文案与用默认应用打开按钮", () => {
    render(<PreviewFallback testId="preview-error" message="出错了" path="/w/a.docx" />);
    expect(screen.getByTestId("preview-error")).toHaveTextContent("出错了");
    expect(screen.getByTestId("preview-open-default")).toHaveTextContent("用默认应用打开");
  });

  it("应该_当点击按钮时_用该路径调用_shellOpen", async () => {
    render(<PreviewFallback testId="preview-error" message="出错了" path="/w/a.docx" />);
    fireEvent.click(screen.getByTestId("preview-open-default"));
    await waitFor(() => expect(shellOpenMock).toHaveBeenCalledWith("/w/a.docx"));
  });

  it("应该_当_shellOpen_失败时_提示换成错误文案", async () => {
    shellOpenMock.mockRejectedValue("无法打开");
    render(<PreviewFallback testId="preview-error" message="出错了" path="/w/a.docx" />);
    fireEvent.click(screen.getByTestId("preview-open-default"));
    await waitFor(() =>
      expect(screen.getByTestId("preview-error")).toHaveTextContent("无法打开"),
    );
    expect(screen.getByTestId("preview-error")).not.toHaveTextContent("出错了");
  });

  it("应该_当_message_属性变化时_显示新的文案", () => {
    const r = render(<PreviewFallback testId="preview-error" message="旧" path="/w/a.docx" />);
    r.rerender(<PreviewFallback testId="preview-error" message="新" path="/w/a.docx" />);
    expect(screen.getByTestId("preview-error")).toHaveTextContent("新");
  });
});

describe("PreviewLoading", () => {
  it("应该_当渲染时_显示正在加载提示", () => {
    render(<PreviewLoading />);
    expect(screen.getByTestId("preview-loading")).toHaveTextContent("正在加载…");
  });
});
