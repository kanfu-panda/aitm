/* PptxViewer 单测：parsePptx 适配层与 tauri 读取用 mock 代替，只验证渲染、转义、Blob URL 回收与错误态。 */
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/tauri", () => ({
  fsReadBinary: vi.fn(),
  shellOpen: vi.fn(),
}));
vi.mock("../../../lib/pptx", () => ({
  parsePptx: vi.fn(),
}));

import { fsReadBinary, shellOpen } from "../../../lib/tauri";
import { parsePptx, type Presentation } from "../../../lib/pptx";
import PptxViewer from "../PptxViewer";

const readMock = fsReadBinary as unknown as ReturnType<typeof vi.fn>;
const shellOpenMock = shellOpen as unknown as ReturnType<typeof vi.fn>;
const parseMock = parsePptx as unknown as ReturnType<typeof vi.fn>;

const createUrl = vi.fn();
const revokeUrl = vi.fn();

function presentation(): Presentation {
  return {
    width: 960,
    height: 540,
    slides: [
      {
        background: "#112233",
        elements: [
          {
            type: "shape",
            x: 10,
            y: 20,
            w: 300,
            h: 100,
            fill: "#ff0000",
            anchor: "middle",
            inset: { l: 7.2, t: 3.6, r: 7.2, b: 3.6 },
            paragraphs: [
              {
                align: "center",
                runs: [
                  { text: "加粗红字", sizePt: 24, bold: true, italic: false, underline: false, color: "#00ff00" },
                  { text: "<script>alert(1)</script>", sizePt: 18, bold: false, italic: false, underline: false, color: null },
                ],
              },
            ],
          },
          { type: "picture", x: 0, y: 0, w: 100, h: 80, mime: "image/png", data: new Uint8Array([1, 2, 3]) },
        ],
      },
      { background: "#ffffff", elements: [] },
    ],
  };
}

beforeEach(() => {
  readMock.mockReset().mockResolvedValue(new ArrayBuffer(8));
  shellOpenMock.mockReset().mockResolvedValue(undefined);
  parseMock.mockReset().mockResolvedValue(presentation());
  let n = 0;
  createUrl.mockReset().mockImplementation(() => `blob:fake-${++n}`);
  revokeUrl.mockReset();
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: revokeUrl }));
});

async function renderReady(path = "/w/deck.pptx") {
  const r = render(<PptxViewer path={path} reloadKey={1} />);
  await screen.findByTestId("pptx-slide-0");
  return r;
}

describe("PptxViewer", () => {
  it("应该_当解析完成时_按路径读取字节并渲染每一张幻灯片与标注", async () => {
    await renderReady();
    expect(readMock).toHaveBeenCalledWith("/w/deck.pptx");
    expect(parseMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("pptx-viewer")).toBeInTheDocument();
    expect(screen.getByTestId("pptx-slide-0")).toBeInTheDocument();
    expect(screen.getByTestId("pptx-slide-1")).toBeInTheDocument();
    expect(screen.queryByTestId("pptx-slide-2")).toBeNull();
    expect(screen.getByTestId("pptx-slide-label-0")).toHaveTextContent("第 1 张 / 共 2 张");
    expect(screen.getByTestId("pptx-slide-label-1")).toHaveTextContent("第 2 张 / 共 2 张");
  });

  it("应该_当读取尚未完成时_显示加载中", async () => {
    readMock.mockReturnValue(new Promise(() => {}));
    render(<PptxViewer path="/w/deck.pptx" reloadKey={1} />);
    expect(await screen.findByTestId("preview-loading")).toHaveTextContent("正在加载");
  });

  it("应该_当字节已读到但仍在解析时_显示加载中", async () => {
    parseMock.mockReturnValue(new Promise(() => {}));
    render(<PptxViewer path="/w/deck.pptx" reloadKey={1} />);
    await waitFor(() => expect(parseMock).toHaveBeenCalled());
    expect(screen.getByTestId("preview-loading")).toHaveTextContent("正在加载");
  });

  it("应该_当文字含_script_标签时_按文本显示且不生成_script_元素", async () => {
    await renderReady();
    const slide = screen.getByTestId("pptx-slide-0");
    expect(slide).toHaveTextContent("<script>alert(1)</script>");
    expect(slide.querySelector("script")).toBeNull();
    expect(screen.getByTestId("pptx-viewer").querySelector("script")).toBeNull();
  });

  it("应该_当文字有粗体与颜色时_体现在内联样式", async () => {
    await renderReady();
    const run = screen.getByText("加粗红字");
    // 样式可能落在 run 本身或其最近的带样式祖先上
    const styled = run.closest<HTMLElement>("[style*='font-weight']") ?? run;
    expect(styled.style.fontWeight).toMatch(/bold|700/);
    expect(run.closest<HTMLElement>("[style*='color']")!.style.color).toMatch(/#00ff00|rgb\(0,\s*255,\s*0\)/i);
  });

  it("应该_当形状有填充色时_形状元素带该背景色", async () => {
    await renderReady();
    const slide = screen.getByTestId("pptx-slide-0");
    const filled = Array.from(slide.querySelectorAll<HTMLElement>("*")).find((el) =>
      /#ff0000|rgb\(255,\s*0,\s*0\)/i.test(el.style.backgroundColor),
    );
    expect(filled).toBeDefined();
  });

  it("应该_当文本框垂直居中且有内边距时_体现在形状样式", async () => {
    await renderReady();
    const shape = screen.getByText("加粗红字").closest("[data-shape]") as HTMLElement;
    expect(shape.style.justifyContent).toBe("center");
    expect(shape.style.padding).toBe("4.8px 9.6px");
  });

  it("应该_当点击预览区后_可以获得焦点以便键盘翻页", async () => {
    await renderReady();
    expect(screen.getByTestId("pptx-viewer")).toHaveAttribute("tabindex", "-1");
  });

  it("应该_当有图片元素时_渲染_img_并使用创建的_Blob_URL", async () => {
    await renderReady();
    expect(createUrl).toHaveBeenCalledTimes(1);
    const blob = createUrl.mock.calls[0][0] as { type: string };
    expect(blob.type).toBe("image/png");
    const img = screen.getByTestId("pptx-slide-0").querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe("blob:fake-1");
  });

  it("应该_当卸载时_回收所有创建的_Blob_URL", async () => {
    const r = await renderReady();
    expect(revokeUrl).not.toHaveBeenCalled();
    r.unmount();
    expect(revokeUrl).toHaveBeenCalledWith("blob:fake-1");
  });

  it("应该_当幻灯片有背景色时_体现在幻灯片样式", async () => {
    await renderReady();
    const bg0 = screen.getByTestId("pptx-slide-0").style.backgroundColor;
    expect(bg0).toMatch(/#112233|rgb\(17,\s*34,\s*51\)/i);
    expect(screen.getByTestId("pptx-slide-1").style.backgroundColor).toMatch(/#fff(fff)?|rgb\(255,\s*255,\s*255\)|white/i);
  });

  it("应该_当解析失败时_显示无法解析提示与默认应用按钮", async () => {
    parseMock.mockRejectedValue(new Error("bad zip"));
    render(<PptxViewer path="/w/bad.pptx" reloadKey={1} />);
    const box = await screen.findByTestId("preview-error");
    expect(box).toHaveTextContent("无法解析此文件，它可能已损坏或格式不符");
    expect(screen.getByTestId("preview-open-default")).toBeInTheDocument();
  });

  it("应该_当文件超过上限时_显示超限提示且不解析", async () => {
    readMock.mockRejectedValue(
      JSON.stringify({
        code: "fs.fileTooLarge",
        params: { size: String(21 * 1024 * 1024), max: String(20 * 1024 * 1024) },
        message: "文件过大",
      }),
    );
    render(<PptxViewer path="/w/big.pptx" reloadKey={1} />);
    const box = await screen.findByTestId("preview-too-large");
    expect(box).toHaveTextContent("21.0 MB");
    expect(box).toHaveTextContent("20.0 MB");
    expect(parseMock).not.toHaveBeenCalled();
  });

  it("应该_当_reloadKey_变化时_重新读取并解析", async () => {
    const r = await renderReady();
    r.rerender(<PptxViewer path="/w/deck.pptx" reloadKey={2} />);
    await waitFor(() => expect(readMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(parseMock).toHaveBeenCalledTimes(2));
  });
});
