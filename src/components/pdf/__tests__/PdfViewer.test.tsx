/* PdfViewer 单测：pdf.js 在 jsdom 里跑不起来，适配层 openPdfViewer 用假控制器代替。 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/tauri", () => ({
  fsReadBinary: vi.fn(),
  shellOpen: vi.fn(),
}));
vi.mock("../../../lib/pdfjs", () => ({
  openPdfViewer: vi.fn(),
}));

import { fsReadBinary, shellOpen } from "../../../lib/tauri";
import { openPdfViewer, type PdfController, type PdfEvents } from "../../../lib/pdfjs";
import PdfViewer from "../PdfViewer";

const fsReadBinaryMock = fsReadBinary as unknown as ReturnType<typeof vi.fn>;
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
  fsReadBinaryMock.mockReset().mockResolvedValue(new ArrayBuffer(8));
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
    expect(fsReadBinaryMock).toHaveBeenCalledWith("/w/doc.pdf");
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
    fsReadBinaryMock.mockRejectedValue(
      JSON.stringify({
        code: "fs.fileTooLarge",
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

  describe("加密 PDF 密码输入", () => {
    const pwErr = (code: number) =>
      Object.assign(new Error("pw"), { name: "PasswordException", code });

    async function renderPrompt() {
      openMock.mockRejectedValueOnce(pwErr(1));
      const r = render(<PdfViewer path="/w/lock.pdf" reloadKey={1} />);
      await screen.findByTestId("pdf-password");
      return r;
    }

    it("应该_当首次加载抛出需要密码时_显示密码表单并聚焦输入框_不显示工具栏", async () => {
      await renderPrompt();
      expect(screen.getByTestId("pdf-password")).toHaveTextContent("此 PDF 已加密，请输入密码");
      expect(screen.getByTestId("pdf-password-input")).toHaveFocus();
      expect(screen.queryByTestId("pdf-toolbar")).toBeNull();
      expect(screen.queryByTestId("pdf-error")).toBeNull();
      expect(screen.queryByTestId("pdf-password-error")).toBeNull();
    });

    it("应该_当输入密码点击提交时_用同一份字节和该密码再次打开并进入就绪", async () => {
      await renderPrompt();
      fireEvent.change(screen.getByTestId("pdf-password-input"), { target: { value: "abc" } });
      fireEvent.click(screen.getByTestId("pdf-password-submit"));
      await screen.findByTestId("pdf-toolbar");
      expect(fsReadBinaryMock).toHaveBeenCalledTimes(1);
      expect(openMock).toHaveBeenCalledTimes(2);
      expect(openMock.mock.calls[1][1]).toBe(openMock.mock.calls[0][1]);
      expect(openMock.mock.calls[1][3]).toBe("abc");
      expect(screen.queryByTestId("pdf-password")).toBeNull();
    });

    it("应该_当在密码框按回车时_同样提交密码", async () => {
      await renderPrompt();
      const input = screen.getByTestId("pdf-password-input");
      fireEvent.change(input, { target: { value: "enter-pw" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await screen.findByTestId("pdf-toolbar");
      expect(openMock.mock.calls[1][3]).toBe("enter-pw");
      expect(fsReadBinaryMock).toHaveBeenCalledTimes(1);
    });

    it("应该_当密码错误时_显示错误提示并清空输入框_可再次输入", async () => {
      await renderPrompt();
      openMock.mockRejectedValueOnce(pwErr(2));
      const input = screen.getByTestId("pdf-password-input");
      fireEvent.change(input, { target: { value: "wrong" } });
      fireEvent.click(screen.getByTestId("pdf-password-submit"));
      expect(await screen.findByTestId("pdf-password-error")).toHaveTextContent("密码错误，请重试");
      expect(screen.getByTestId("pdf-password-input")).toHaveValue("");
      expect(screen.queryByTestId("pdf-toolbar")).toBeNull();

      fireEvent.change(screen.getByTestId("pdf-password-input"), { target: { value: "right" } });
      fireEvent.click(screen.getByTestId("pdf-password-submit"));
      await screen.findByTestId("pdf-toolbar");
      expect(openMock.mock.calls[2][3]).toBe("right");
      expect(screen.queryByTestId("pdf-password")).toBeNull();
      expect(screen.queryByTestId("pdf-password-error")).toBeNull();
      expect(fsReadBinaryMock).toHaveBeenCalledTimes(1);
    });

    it("应该_当校验密码期间与密码错误后_输入框始终是同一个节点_焦点不丢", async () => {
      await renderPrompt();
      let failCheck!: () => void;
      openMock.mockImplementationOnce(
        () => new Promise((_res, rej) => (failCheck = () => rej(pwErr(2)))),
      );
      const input = screen.getByTestId("pdf-password-input");
      fireEvent.change(input, { target: { value: "wrong" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(openMock).toHaveBeenCalledTimes(2));
      // 校验中：表单不卸载，提交按钮不可用，重复回车不会再次提交
      expect(screen.getByTestId("pdf-password-input")).toBe(input);
      expect(screen.getByTestId("pdf-password-submit")).toBeDisabled();
      fireEvent.keyDown(input, { key: "Enter" });
      expect(openMock).toHaveBeenCalledTimes(2);

      failCheck();
      await screen.findByTestId("pdf-password-error");
      expect(screen.getByTestId("pdf-password-input")).toBe(input);
      expect(input).toHaveFocus();
    });

    it("应该_当密码为空时_提交按钮不可用", async () => {
      await renderPrompt();
      expect(screen.getByTestId("pdf-password-submit")).toBeDisabled();
      fireEvent.change(screen.getByTestId("pdf-password-input"), { target: { value: "x" } });
      expect(screen.getByTestId("pdf-password-submit")).not.toBeDisabled();
    });

    it("应该_当_reloadKey_变化时_重新读取字节并回到无密码的首次加载", async () => {
      const r = await renderPrompt();
      openMock.mockRejectedValueOnce(pwErr(1));
      r.rerender(<PdfViewer path="/w/lock.pdf" reloadKey={2} />);
      await waitFor(() => expect(fsReadBinaryMock).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(openMock).toHaveBeenCalledTimes(2));
      expect(openMock.mock.calls[1][3]).toBeUndefined();
      expect(await screen.findByTestId("pdf-password")).toBeInTheDocument();
      expect(screen.queryByTestId("pdf-password-error")).toBeNull();
    });
  });

  it("应该_当文件无法解析时_显示无法解析提示", async () => {
    openMock.mockRejectedValue(Object.assign(new Error("bad"), { name: "InvalidPDFException" }));
    render(<PdfViewer path="/w/bad.pdf" reloadKey={1} />);
    expect(await screen.findByTestId("pdf-error")).toHaveTextContent("无法解析");
  });

  it("应该_当读取失败时_显示后端错误原文", async () => {
    fsReadBinaryMock.mockRejectedValue("磁盘出错");
    render(<PdfViewer path="/w/x.pdf" reloadKey={1} />);
    expect(await screen.findByTestId("pdf-error")).toHaveTextContent("磁盘出错");
    expect(screen.getByTestId("pdf-open-default")).toBeInTheDocument();
  });

  it("应该_当_reloadKey_变化时_重新读取并销毁旧文档", async () => {
    const r = await renderReady();
    const first = ctrl;
    r.rerender(<PdfViewer path="/w/doc.pdf" reloadKey={2} />);
    await waitFor(() => expect(fsReadBinaryMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(first.destroy).toHaveBeenCalled());
  });

  it("应该_当切换界面语言时_不重新加载文档_错误提示跟着换语言", async () => {
    const { default: i18n } = await import("../../../lib/i18n");
    openMock.mockRejectedValue(Object.assign(new Error("x"), { name: "InvalidPDFException" }));
    render(<PdfViewer path="/w/lock.pdf" reloadKey={1} />);
    expect(await screen.findByTestId("pdf-error")).toHaveTextContent("无法解析");
    await act(async () => {
      await i18n.changeLanguage("en");
    });
    try {
      expect(screen.getByTestId("pdf-error")).toHaveTextContent("can't be read");
      expect(fsReadBinaryMock).toHaveBeenCalledTimes(1);
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
