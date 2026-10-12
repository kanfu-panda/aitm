/* DocxViewer 单测：docx-preview 适配层 renderDocx 用假实现代替，验证接线与链接拦截。 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/tauri", () => ({
  fsReadBinary: vi.fn(),
  shellOpen: vi.fn(),
}));
vi.mock("../../../lib/docx", () => ({
  renderDocx: vi.fn(),
}));

import { fsReadBinary, shellOpen } from "../../../lib/tauri";
import { renderDocx } from "../../../lib/docx";
import DocxViewer from "../DocxViewer";

const readMock = fsReadBinary as unknown as ReturnType<typeof vi.fn>;
const shellOpenMock = shellOpen as unknown as ReturnType<typeof vi.fn>;
const renderMock = renderDocx as unknown as ReturnType<typeof vi.fn>;

const LINKS_HTML = `
  <p id="content">正文</p>
  <a data-testid="l-https" href="https://example.com/x">外链</a>
  <a data-testid="l-mail" href="mailto:a@b.com">邮件</a>
  <a data-testid="l-hash" href="#bm1">书签</a>
  <a data-testid="l-file" href="file:///etc/passwd">本地</a>
  <a data-testid="l-js" href="javascript:alert(1)">脚本</a>
`;

beforeEach(() => {
  readMock.mockReset().mockResolvedValue(new ArrayBuffer(8));
  shellOpenMock.mockReset().mockResolvedValue(undefined);
  renderMock.mockReset().mockImplementation(async (body: HTMLElement) => {
    body.innerHTML = LINKS_HTML;
  });
});

async function renderReady(path = "/w/a.docx") {
  const r = render(<DocxViewer path={path} reloadKey={1} />);
  await waitFor(() => expect(screen.getByTestId("docx-body").querySelector("#content")).not.toBeNull());
  return r;
}

describe("DocxViewer", () => {
  it("应该_当读到字节时_在_docx-body_内的容器上调用_renderDocx", async () => {
    await renderReady();
    expect(readMock).toHaveBeenCalledWith("/w/a.docx");
    expect(renderMock).toHaveBeenCalledTimes(1);
    const [host, data] = renderMock.mock.calls[0];
    expect(screen.getByTestId("docx-body").contains(host)).toBe(true);
    expect(data).toBeInstanceOf(ArrayBuffer);
    expect(screen.getByTestId("docx-viewer")).toBeInTheDocument();
  });

  it("应该_当点击_https_链接时_阻止默认行为并交给_shellOpen", async () => {
    await renderReady();
    const notPrevented = fireEvent.click(screen.getByTestId("l-https"));
    expect(notPrevented).toBe(false);
    expect(shellOpenMock).toHaveBeenCalledTimes(1);
    expect(shellOpenMock).toHaveBeenCalledWith("https://example.com/x");
  });

  it("应该_当点击_mailto_链接时_阻止默认行为并交给_shellOpen", async () => {
    await renderReady();
    const notPrevented = fireEvent.click(screen.getByTestId("l-mail"));
    expect(notPrevented).toBe(false);
    expect(shellOpenMock).toHaveBeenCalledWith("mailto:a@b.com");
  });

  it("应该_当点击文内书签链接时_放行默认行为且不调用_shellOpen", async () => {
    await renderReady();
    const notPrevented = fireEvent.click(screen.getByTestId("l-hash"));
    expect(notPrevented).toBe(true);
    expect(shellOpenMock).not.toHaveBeenCalled();
  });

  it("应该_当点击_file_或_javascript_等其它协议链接时_阻止默认行为且不调用_shellOpen", async () => {
    await renderReady();
    expect(fireEvent.click(screen.getByTestId("l-file"))).toBe(false);
    expect(fireEvent.click(screen.getByTestId("l-js"))).toBe(false);
    expect(shellOpenMock).not.toHaveBeenCalled();
  });

  it("应该_当点击非链接内容时_不调用_shellOpen", async () => {
    await renderReady();
    fireEvent.click(document.getElementById("content")!);
    expect(shellOpenMock).not.toHaveBeenCalled();
  });

  it("应该_当_renderDocx_失败时_显示无法解析提示", async () => {
    renderMock.mockRejectedValue(new Error("bad zip"));
    render(<DocxViewer path="/w/bad.docx" reloadKey={1} />);
    const box = await screen.findByTestId("preview-error");
    expect(box).toHaveTextContent("无法解析此文件，它可能已损坏或格式不符");
  });

  it("应该_当文件超过上限时_显示超限提示且不渲染", async () => {
    readMock.mockRejectedValue(
      JSON.stringify({
        code: "fs.fileTooLarge",
        params: { size: String(51 * 1024 * 1024), max: String(50 * 1024 * 1024) },
        message: "文件过大",
      }),
    );
    render(<DocxViewer path="/w/big.docx" reloadKey={1} />);
    const box = await screen.findByTestId("preview-too-large");
    expect(box).toHaveTextContent("51.0 MB");
    expect(box).toHaveTextContent("50.0 MB");
    expect(renderMock).not.toHaveBeenCalled();
  });

  it("应该_当_reloadKey_变化时_重新读取并清空旧内容后重新渲染", async () => {
    let resolveSecond!: () => void;
    renderMock
      .mockImplementationOnce(async (body: HTMLElement) => {
        body.innerHTML = '<p id="old">旧内容</p>';
      })
      .mockImplementationOnce(
        (body: HTMLElement) =>
          new Promise<void>((resolve) => {
            resolveSecond = () => {
              body.innerHTML = '<p id="new">新内容</p>';
              resolve();
            };
          }),
      );
    const r = render(<DocxViewer path="/w/a.docx" reloadKey={1} />);
    await waitFor(() => expect(screen.getByTestId("docx-body").querySelector("#old")).not.toBeNull());

    r.rerender(<DocxViewer path="/w/a.docx" reloadKey={2} />);
    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(2));
    expect(readMock).toHaveBeenCalledTimes(2);
    // 新一轮渲染未完成时，旧内容必须已被清掉
    expect(document.getElementById("old")).toBeNull();

    resolveSecond();
    await waitFor(() => expect(document.getElementById("new")).not.toBeNull());
    expect(document.getElementById("old")).toBeNull();
  });

  it("应该_当重新加载后上一轮渲染才完成时_旧内容不出现在页面上", async () => {
    let finishFirst!: () => void;
    renderMock
      .mockImplementationOnce(
        (host: HTMLElement) =>
          new Promise<void>((resolve) => {
            finishFirst = () => {
              host.innerHTML = '<p id="stale">过期内容</p>';
              resolve();
            };
          }),
      )
      .mockImplementationOnce(async (host: HTMLElement) => {
        host.innerHTML = '<p id="fresh">新内容</p>';
      });
    const r = render(<DocxViewer path="/w/a.docx" reloadKey={1} />);
    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));
    r.rerender(<DocxViewer path="/w/a.docx" reloadKey={2} />);
    await waitFor(() => expect(document.getElementById("fresh")).not.toBeNull());

    finishFirst();
    await new Promise((res) => setTimeout(res, 20));
    expect(document.getElementById("stale")).toBeNull();
    expect(screen.getByTestId("docx-body").querySelectorAll("p")).toHaveLength(1);
  });

  it("应该_当卸载后_renderDocx_才返回时_不报错也不更新状态", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let rejectLate!: (e: Error) => void;
    renderMock.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectLate = reject;
        }),
    );
    const r = render(<DocxViewer path="/w/a.docx" reloadKey={1} />);
    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));
    r.unmount();
    rejectLate(new Error("late"));
    await new Promise((res) => setTimeout(res, 20));
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
