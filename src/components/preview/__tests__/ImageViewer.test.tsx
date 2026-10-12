/* ImageViewer 单测：图片预览的读取、Blob URL 生命周期、缩放与失败提示。 */
/* global Blob */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/tauri", () => ({
  fsReadBinary: vi.fn(),
  shellOpen: vi.fn(),
}));

import { fsReadBinary, shellOpen } from "../../../lib/tauri";
import ImageViewer from "../ImageViewer";

const readMock = fsReadBinary as unknown as ReturnType<typeof vi.fn>;
const shellOpenMock = shellOpen as unknown as ReturnType<typeof vi.fn>;

const createUrl = vi.fn();
const revokeUrl = vi.fn();
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
let urlSeq = 0;

beforeEach(() => {
  urlSeq = 0;
  readMock.mockReset().mockResolvedValue(new ArrayBuffer(8));
  shellOpenMock.mockReset().mockResolvedValue(undefined);
  createUrl.mockReset().mockImplementation(() => `blob:mock-${++urlSeq}`);
  revokeUrl.mockReset();
  URL.createObjectURL = createUrl as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = revokeUrl as unknown as typeof URL.revokeObjectURL;
});

afterEach(() => {
  cleanup(); // 先卸载组件（触发 revoke），再还原 URL 方法
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
});

/** 渲染并等到 <img> 出现。 */
async function renderReady(path = "/w/pic.png") {
  const r = render(<ImageViewer path={path} reloadKey={1} />);
  const img = (await screen.findByTestId("image-content")) as HTMLImageElement;
  return { ...r, img };
}

/** 给 <img> 注入自然尺寸并触发 load。 */
function loadImage(img: HTMLImageElement, w = 640, h = 480) {
  Object.defineProperty(img, "naturalWidth", { value: w, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: h, configurable: true });
  fireEvent.load(img);
}

describe("ImageViewer", () => {
  it("应该_当读取到字节时_按路径读取并把_Blob_URL_设为图片_src", async () => {
    const { img } = await renderReady("/w/pic.png");
    expect(readMock).toHaveBeenCalledWith("/w/pic.png");
    expect(img).toHaveAttribute("src", "blob:mock-1");
    expect(screen.getByTestId("image-viewer")).toBeInTheDocument();
  });

  it("应该_当读取中时_显示加载提示", () => {
    readMock.mockReturnValue(new Promise(() => {}));
    render(<ImageViewer path="/w/pic.png" reloadKey={1} />);
    expect(screen.getByTestId("preview-loading")).toBeInTheDocument();
  });

  it("应该_当扩展名为_svg_时_Blob_的_type_是_image/svg+xml", async () => {
    await renderReady("/w/logo.svg");
    const blob = createUrl.mock.calls[0][0] as Blob;
    expect(blob).toBeInstanceOf(window.Blob);
    expect(blob.type).toBe("image/svg+xml");
  });

  it("应该_当扩展名为_png_时_Blob_的_type_是_image/png", async () => {
    await renderReady("/w/pic.png");
    expect((createUrl.mock.calls[0][0] as Blob).type).toBe("image/png");
  });

  it("应该_当卸载时_释放_Blob_URL", async () => {
    const r = await renderReady();
    expect(revokeUrl).not.toHaveBeenCalled();
    r.unmount();
    expect(revokeUrl).toHaveBeenCalledWith("blob:mock-1");
  });

  it("应该_当图片加载完成时_显示原始宽高", async () => {
    const { img } = await renderReady();
    expect(screen.getByTestId("image-size")).not.toHaveTextContent("640");
    loadImage(img, 640, 480);
    expect(screen.getByTestId("image-size")).toHaveTextContent("640 × 480");
  });

  it("应该_当默认状态时_为适应窗口_缩放比例显示为空串", async () => {
    await renderReady();
    expect(screen.getByTestId("image-zoom-level")).toHaveTextContent(/^$/);
  });

  it("应该_当适应窗口时_图片容器占满预览区高度_固定倍率时随图片撑开", async () => {
    await renderReady();
    expect(screen.getByTestId("image-stage")).toHaveClass("h-full", "w-full");
    fireEvent.click(screen.getByTestId("image-actual"));
    expect(screen.getByTestId("image-stage")).toHaveClass("min-h-full", "min-w-full");
    expect(screen.getByTestId("image-stage")).not.toHaveClass("h-full");
  });

  it("应该_当点击实际大小时_显示_100%", async () => {
    await renderReady();
    fireEvent.click(screen.getByTestId("image-actual"));
    expect(screen.getByTestId("image-zoom-level")).toHaveTextContent("100%");
  });

  it("应该_当在_100%_点击放大时_变为_125%_缩小时变为_75%", async () => {
    await renderReady();
    fireEvent.click(screen.getByTestId("image-actual"));
    fireEvent.click(screen.getByTestId("image-zoom-in"));
    expect(screen.getByTestId("image-zoom-level")).toHaveTextContent("125%");
    fireEvent.click(screen.getByTestId("image-zoom-out"));
    fireEvent.click(screen.getByTestId("image-zoom-out"));
    expect(screen.getByTestId("image-zoom-level")).toHaveTextContent("75%");
  });

  it("应该_当适应窗口时点击放大_以_100%_为起点变为_125%", async () => {
    await renderReady();
    fireEvent.click(screen.getByTestId("image-zoom-in"));
    expect(screen.getByTestId("image-zoom-level")).toHaveTextContent("125%");
  });

  it("应该_当大图适应窗口后显示为_40%_时_放大从实际显示比例出发变为_50%", async () => {
    const { img } = await renderReady();
    loadImage(img, 2000, 1000);
    Object.defineProperty(img, "clientWidth", { value: 800, configurable: true });
    fireEvent.click(screen.getByTestId("image-zoom-in"));
    expect(screen.getByTestId("image-zoom-level")).toHaveTextContent("50%");
  });

  it("应该_当大图适应窗口后显示为_40%_时_缩小变为_25%", async () => {
    const { img } = await renderReady();
    loadImage(img, 2000, 1000);
    Object.defineProperty(img, "clientWidth", { value: 800, configurable: true });
    fireEvent.click(screen.getByTestId("image-zoom-out"));
    expect(screen.getByTestId("image-zoom-level")).toHaveTextContent("25%");
  });

  it("应该_当缩小到_25%_时_缩小按钮不可用", async () => {
    await renderReady();
    fireEvent.click(screen.getByTestId("image-actual"));
    expect(screen.getByTestId("image-zoom-out")).not.toBeDisabled();
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByTestId("image-zoom-out"));
    expect(screen.getByTestId("image-zoom-level")).toHaveTextContent("25%");
    expect(screen.getByTestId("image-zoom-out")).toBeDisabled();
    expect(screen.getByTestId("image-zoom-in")).not.toBeDisabled();
  });

  it("应该_当放大到_400%_时_放大按钮不可用", async () => {
    await renderReady();
    fireEvent.click(screen.getByTestId("image-actual"));
    for (let i = 0; i < 5; i++) fireEvent.click(screen.getByTestId("image-zoom-in"));
    expect(screen.getByTestId("image-zoom-level")).toHaveTextContent("400%");
    expect(screen.getByTestId("image-zoom-in")).toBeDisabled();
    expect(screen.getByTestId("image-zoom-out")).not.toBeDisabled();
  });

  it("应该_当点击适应窗口时_缩放比例回到空串", async () => {
    await renderReady();
    fireEvent.click(screen.getByTestId("image-actual"));
    fireEvent.click(screen.getByTestId("image-zoom-in"));
    fireEvent.click(screen.getByTestId("image-fit"));
    expect(screen.getByTestId("image-zoom-level")).toHaveTextContent(/^$/);
  });

  it("应该_当图片无法解码时_显示无法解析提示", async () => {
    const { img } = await renderReady();
    fireEvent.error(img);
    expect(await screen.findByTestId("preview-error")).toHaveTextContent(
      "无法解析此文件，它可能已损坏或格式不符",
    );
    expect(screen.getByTestId("preview-open-default")).toBeInTheDocument();
  });

  it("应该_当文件超过上限时_显示超限提示且不创建_Blob_URL", async () => {
    readMock.mockRejectedValue(
      JSON.stringify({
        code: "fs.fileTooLarge",
        params: { size: String(51 * 1024 * 1024), max: String(50 * 1024 * 1024) },
        message: "文件过大",
      }),
    );
    render(<ImageViewer path="/w/big.png" reloadKey={1} />);
    const box = await screen.findByTestId("preview-too-large");
    expect(box).toHaveTextContent("51.0 MB");
    expect(box).toHaveTextContent("50.0 MB");
    expect(createUrl).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("preview-open-default"));
    await waitFor(() => expect(shellOpenMock).toHaveBeenCalledWith("/w/big.png"));
  });

  it("应该_当读取失败时_显示后端错误原文", async () => {
    readMock.mockRejectedValue("磁盘出错");
    render(<ImageViewer path="/w/x.png" reloadKey={1} />);
    expect(await screen.findByTestId("preview-error")).toHaveTextContent("磁盘出错");
  });

  it("应该_当_reloadKey_变化时_重新读取并释放旧_Blob_URL", async () => {
    const r = await renderReady();
    r.rerender(<ImageViewer path="/w/pic.png" reloadKey={2} />);
    await waitFor(() => expect(readMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(revokeUrl).toHaveBeenCalledWith("blob:mock-1"));
    await waitFor(() =>
      expect(screen.getByTestId("image-content")).toHaveAttribute("src", "blob:mock-2"),
    );
  });

  it("应该_当重新加载后_缩放回到适应窗口", async () => {
    const r = await renderReady();
    fireEvent.click(screen.getByTestId("image-actual"));
    expect(screen.getByTestId("image-zoom-level")).toHaveTextContent("100%");
    r.rerender(<ImageViewer path="/w/other.png" reloadKey={1} />);
    await screen.findByTestId("image-content");
    await act(async () => {});
    expect(screen.getByTestId("image-zoom-level")).toHaveTextContent(/^$/);
  });
});
