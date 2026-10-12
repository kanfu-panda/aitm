/* PdfViewer 单测：pdf.js 在 jsdom 里跑不起来，适配层 openPdfViewer 用假控制器代替。 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/tauri", () => ({
  fsReadPdf: vi.fn(),
  shellOpen: vi.fn(),
}));
vi.mock("../../../lib/pdfjs", () => ({
  openPdfViewer: vi.fn(),
}));

import { fsReadPdf, shellOpen } from "../../../lib/tauri";
import { openPdfViewer, type PdfController, type PdfEvents } from "../../../lib/pdfjs";
import PdfViewer from "../PdfViewer";

const fsReadPdfMock = fsReadPdf as unknown as ReturnType<typeof vi.fn>;
const shellOpenMock = shellOpen as unknown as ReturnType<typeof vi.fn>;
const openMock = openPdfViewer as unknown as ReturnType<typeof vi.fn>;

interface FakeController extends PdfController {
  events: PdfEvents;
}

function fakeController(events: PdfEvents, pageCount = 3): FakeController {
  return {
    events,
    pageCount,
    setPage: vi.fn(),
    setScale: vi.fn(),
    fitWidth: vi.fn(),
    find: vi.fn(),
    closeFind: vi.fn(),
    destroy: vi.fn(),
  };
}

let ctrl: FakeController;

beforeEach(() => {
  fsReadPdfMock.mockReset().mockResolvedValue(new ArrayBuffer(8));
  shellOpenMock.mockReset().mockResolvedValue(undefined);
  openMock.mockReset().mockImplementation(
    async (_c: HTMLElement, _d: ArrayBuffer, events: PdfEvents) => {
      ctrl = fakeController(events);
      return ctrl;
    },
  );
});

async function renderReady(path = "/w/doc.pdf") {
  const r = render(<PdfViewer path={path} reloadKey={1} />);
  await screen.findByTestId("pdf-toolbar");
  return r;
}

describe("PdfViewer", () => {
  it("应该_当加载完成时_按路径读取字节并显示第_1_页与总页数", async () => {
    await renderReady();
    expect(fsReadPdfMock).toHaveBeenCalledWith("/w/doc.pdf");
    expect(screen.getByTestId("pdf-page-input")).toHaveValue("1");
    expect(screen.getByTestId("pdf-page-count")).toHaveTextContent("3");
  });

  it("应该_当滚动到别的页时_页码随之更新", async () => {
    await renderReady();
    act(() => ctrl.events.onPageChange(3));
    expect(screen.getByTestId("pdf-page-input")).toHaveValue("3");
  });

  it("应该_当输入有效页码回车时_跳转_越界或非数字时恢复当前页", async () => {
    await renderReady();
    const input = screen.getByTestId("pdf-page-input");
    fireEvent.change(input, { target: { value: "2" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(ctrl.setPage).toHaveBeenCalledWith(2);

    fireEvent.change(input, { target: { value: "9" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(ctrl.setPage).toHaveBeenCalledTimes(1);
    expect(input).toHaveValue("1");

    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.blur(input);
    expect(input).toHaveValue("1");
  });

  it("应该_当缩放变化时_显示百分比_放大缩小按档位_适应宽度调用对应方法", async () => {
    await renderReady();
    act(() => ctrl.events.onScaleChange(1));
    expect(screen.getByTestId("pdf-zoom-level")).toHaveTextContent("100%");
    fireEvent.click(screen.getByTestId("pdf-zoom-in"));
    expect(ctrl.setScale).toHaveBeenCalledWith(1.25);
    fireEvent.click(screen.getByTestId("pdf-zoom-out"));
    expect(ctrl.setScale).toHaveBeenLastCalledWith(0.75);
    fireEvent.click(screen.getByTestId("pdf-fit-width"));
    expect(ctrl.fitWidth).toHaveBeenCalled();
  });

  it("应该_当缩放到边界时_对应按钮不可用", async () => {
    await renderReady();
    act(() => ctrl.events.onScaleChange(4));
    expect(screen.getByTestId("pdf-zoom-in")).toBeDisabled();
    expect(screen.getByTestId("pdf-zoom-out")).not.toBeDisabled();
    act(() => ctrl.events.onScaleChange(0.25));
    expect(screen.getByTestId("pdf-zoom-out")).toBeDisabled();
  });

  it("应该_当在预览内按_⌘F_时_打开搜索框_回车与⇧回车查找_显示计数_Esc_关闭", async () => {
    await renderReady();
    fireEvent.keyDown(screen.getByTestId("pdf-viewer"), { key: "f", metaKey: true });
    const box = await screen.findByTestId("pdf-search-input");
    expect(box).toHaveFocus();

    fireEvent.change(box, { target: { value: "hello" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(ctrl.find).toHaveBeenLastCalledWith("hello", false);
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(ctrl.find).toHaveBeenLastCalledWith("hello", true);

    act(() => ctrl.events.onFindResult({ current: 2, total: 5, notFound: false }));
    expect(screen.getByTestId("pdf-search-count")).toHaveTextContent("2 / 5");
    act(() => ctrl.events.onFindResult({ current: 0, total: 0, notFound: true }));
    expect(screen.getByTestId("pdf-search-count")).toHaveTextContent("无匹配");

    fireEvent.keyDown(box, { key: "Escape" });
    expect(ctrl.closeFind).toHaveBeenCalled();
    expect(screen.queryByTestId("pdf-search-input")).toBeNull();
  });

  it("应该_当按_Ctrl+F_时_同样打开搜索框", async () => {
    await renderReady();
    fireEvent.keyDown(screen.getByTestId("pdf-viewer"), { key: "f", ctrlKey: true });
    expect(await screen.findByTestId("pdf-search-input")).toBeInTheDocument();
  });

  it("应该_当文件超过上限时_显示超限提示并可用默认应用打开", async () => {
    fsReadPdfMock.mockRejectedValue(
      JSON.stringify({
        code: "fs.pdfTooLarge",
        params: { size: String(51 * 1024 * 1024), max: String(50 * 1024 * 1024) },
        message: "PDF 文件过大",
      }),
    );
    render(<PdfViewer path="/w/big.pdf" reloadKey={1} />);
    const box = await screen.findByTestId("pdf-too-large");
    expect(box).toHaveTextContent("51.0 MB");
    expect(box).toHaveTextContent("50.0 MB");
    expect(openMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("pdf-open-default"));
    await waitFor(() => expect(shellOpenMock).toHaveBeenCalledWith("/w/big.pdf"));
  });

  it("应该_当文件已加密时_显示加密提示", async () => {
    openMock.mockRejectedValue(Object.assign(new Error("x"), { name: "PasswordException" }));
    render(<PdfViewer path="/w/lock.pdf" reloadKey={1} />);
    expect(await screen.findByTestId("pdf-error")).toHaveTextContent("已加密");
  });

  it("应该_当文件无法解析时_显示无法解析提示", async () => {
    openMock.mockRejectedValue(Object.assign(new Error("bad"), { name: "InvalidPDFException" }));
    render(<PdfViewer path="/w/bad.pdf" reloadKey={1} />);
    expect(await screen.findByTestId("pdf-error")).toHaveTextContent("无法解析");
  });

  it("应该_当读取失败时_显示后端错误原文", async () => {
    fsReadPdfMock.mockRejectedValue("磁盘出错");
    render(<PdfViewer path="/w/x.pdf" reloadKey={1} />);
    expect(await screen.findByTestId("pdf-error")).toHaveTextContent("磁盘出错");
    expect(screen.getByTestId("pdf-open-default")).toBeInTheDocument();
  });

  it("应该_当_reloadKey_变化时_重新读取并销毁旧文档", async () => {
    const r = await renderReady();
    const first = ctrl;
    r.rerender(<PdfViewer path="/w/doc.pdf" reloadKey={2} />);
    await waitFor(() => expect(fsReadPdfMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(first.destroy).toHaveBeenCalled());
  });

  it("应该_当切换界面语言时_不重新加载文档_错误提示跟着换语言", async () => {
    const { default: i18n } = await import("../../../lib/i18n");
    openMock.mockRejectedValue(Object.assign(new Error("x"), { name: "PasswordException" }));
    render(<PdfViewer path="/w/lock.pdf" reloadKey={1} />);
    expect(await screen.findByTestId("pdf-error")).toHaveTextContent("已加密");
    await act(async () => {
      await i18n.changeLanguage("en");
    });
    try {
      expect(screen.getByTestId("pdf-error")).toHaveTextContent("encrypted");
      expect(fsReadPdfMock).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => {
        await i18n.changeLanguage("zh-CN");
      });
    }
  });

  it("应该_当卸载时_销毁文档", async () => {
    const r = await renderReady();
    r.unmount();
    expect(ctrl.destroy).toHaveBeenCalled();
  });
  describe("输入框", () => {
    it("应该_搜索框与页码框关闭自动更正_首字母大写与拼写检查", async () => {
      await renderReady();
      fireEvent.click(screen.getByTestId("pdf-search-button"));
      for (const id of ["pdf-search-input", "pdf-page-input"]) {
        const el = screen.getByTestId(id);
        expect(el).toHaveAttribute("autocomplete", "off");
        expect(el).toHaveAttribute("autocorrect", "off");
        expect(el).toHaveAttribute("autocapitalize", "off");
        expect(el).toHaveAttribute("spellcheck", "false");
      }
    });
  });
});
