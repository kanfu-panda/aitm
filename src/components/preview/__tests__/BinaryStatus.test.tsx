/* BinaryStatus 单测：把 useBinaryFile 的四种状态映射为统一的提示界面。 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/tauri", () => ({
  shellOpen: vi.fn(),
}));

import BinaryStatus from "../BinaryStatus";

const MB = 1024 * 1024;

describe("BinaryStatus", () => {
  it("应该_当状态为_loading_时_显示加载提示", () => {
    render(<BinaryStatus state={{ status: "loading" }} path="/w/a.xlsx" />);
    expect(screen.getByTestId("preview-loading")).toHaveTextContent("正在加载…");
  });

  it("应该_当状态为_tooLarge_时_显示带_MB_大小的超限提示与打开按钮", () => {
    render(
      <BinaryStatus state={{ status: "tooLarge", size: 51 * MB, max: 50 * MB }} path="/w/a.xlsx" />,
    );
    const box = screen.getByTestId("preview-too-large");
    expect(box).toHaveTextContent("文件过大，无法在此预览");
    expect(box).toHaveTextContent("51.0 MB");
    expect(box).toHaveTextContent("50.0 MB");
    expect(screen.getByTestId("preview-open-default")).toBeInTheDocument();
  });

  it("应该_当状态为_error_时_显示后端错误原文与打开按钮", () => {
    render(<BinaryStatus state={{ status: "error", error: "磁盘出错" }} path="/w/a.xlsx" />);
    expect(screen.getByTestId("preview-error")).toHaveTextContent("磁盘出错");
    expect(screen.getByTestId("preview-open-default")).toBeInTheDocument();
  });

  it("应该_当状态为_ready_时_不渲染任何内容", () => {
    const { container } = render(
      <BinaryStatus state={{ status: "ready", data: new ArrayBuffer(1) }} path="/w/a.xlsx" />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
