/* SpreadsheetViewer 单测：mock 解析适配层与 IPC，验证 sheet 标签、切换、失败与超限。 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/tauri", () => ({
  fsReadBinary: vi.fn(),
  shellOpen: vi.fn(),
}));
vi.mock("../../../lib/sheet", async (orig) => {
  const real = await orig<typeof import("../../../lib/sheet")>();
  return { ...real, loadWorkbook: vi.fn() };
});

import { fsReadBinary, shellOpen } from "../../../lib/tauri";
import { loadWorkbook, type SheetData } from "../../../lib/sheet";
import SpreadsheetViewer from "../SpreadsheetViewer";

const readMock = fsReadBinary as unknown as ReturnType<typeof vi.fn>;
const openMock = shellOpen as unknown as ReturnType<typeof vi.fn>;
const loadMock = loadWorkbook as unknown as ReturnType<typeof vi.fn>;

function sheet(name: string, rows: string[][]): SheetData {
  return {
    name,
    rows,
    merges: [],
    totalRows: rows.length,
    totalCols: Math.max(0, ...rows.map((r) => r.length)),
  };
}

const twoSheets = [
  sheet("预算", [["项目", "金额"], ["差旅", "100"]]),
  sheet("Summary", [["total", "100"]]),
];

beforeEach(() => {
  readMock.mockReset().mockResolvedValue(new ArrayBuffer(8));
  openMock.mockReset().mockResolvedValue(undefined);
  loadMock.mockReset().mockResolvedValue(twoSheets);
});

afterEach(cleanup);

describe("SpreadsheetViewer", () => {
  it("应该_当加载完成时_按路径读取字节并显示第一个_sheet_的内容", async () => {
    const { container } = render(<SpreadsheetViewer path="/w/a.xlsx" reloadKey={1} />);
    await screen.findByTestId("sheet-viewer");
    await waitFor(() =>
      expect(container.querySelector('td[data-cell="B2"]')?.textContent).toBe("100"),
    );
    expect(readMock).toHaveBeenCalledWith("/w/a.xlsx");
    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(container.querySelector('td[data-cell="A2"]')?.textContent).toBe("差旅");
  });

  it("应该_当有多个_sheet_时_底部标签显示名称且仅当前项_aria_selected", async () => {
    render(<SpreadsheetViewer path="/w/a.xlsx" reloadKey={1} />);
    const tab0 = await screen.findByTestId("sheet-tab-0");
    const tab1 = screen.getByTestId("sheet-tab-1");
    expect(tab0).toHaveTextContent("预算");
    expect(tab1).toHaveTextContent("Summary");
    expect(tab0).toHaveAttribute("aria-selected", "true");
    expect(tab1).toHaveAttribute("aria-selected", "false");
  });

  it("应该_当点击另一个标签时_切换显示对应_sheet_的内容", async () => {
    const { container } = render(<SpreadsheetViewer path="/w/a.xlsx" reloadKey={1} />);
    fireEvent.click(await screen.findByTestId("sheet-tab-1"));
    await waitFor(() =>
      expect(container.querySelector('td[data-cell="A1"]')?.textContent).toBe("total"),
    );
    expect(container.querySelector('td[data-cell="A2"]')).toBeNull();
    expect(screen.getByTestId("sheet-tab-1")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("sheet-tab-0")).toHaveAttribute("aria-selected", "false");
  });

  it("应该_当解析失败时_显示无法解析提示和默认应用打开按钮", async () => {
    loadMock.mockRejectedValue(new Error("bad zip"));
    render(<SpreadsheetViewer path="/w/bad.xlsx" reloadKey={1} />);
    const err = await screen.findByTestId("preview-error");
    expect(err).toHaveTextContent("无法解析此文件，它可能已损坏或格式不符");
    fireEvent.click(screen.getByTestId("preview-open-default"));
    expect(openMock).toHaveBeenCalledWith("/w/bad.xlsx");
  });

  it("应该_当文件超过大小上限时_显示文件过大提示且不调用解析", async () => {
    readMock.mockRejectedValue(
      new Error(
        JSON.stringify({
          code: "fs.fileTooLarge",
          params: { size: String(80 * 1048576), max: String(50 * 1048576) },
          message: "文件过大",
        }),
      ),
    );
    render(<SpreadsheetViewer path="/w/big.xlsx" reloadKey={1} />);
    const el = await screen.findByTestId("preview-too-large");
    expect(el).toHaveTextContent("80.0 MB");
    expect(el).toHaveTextContent("50.0 MB");
    expect(loadMock).not.toHaveBeenCalled();
  });

  it("应该_当读取文件的其它错误发生时_显示_preview_error", async () => {
    readMock.mockRejectedValue(new Error("磁盘错误"));
    render(<SpreadsheetViewer path="/w/a.xlsx" reloadKey={1} />);
    expect(await screen.findByTestId("preview-error")).toHaveTextContent("磁盘错误");
  });

  it("应该_当_reloadKey_变化时_重新读取并解析", async () => {
    const { rerender } = render(<SpreadsheetViewer path="/w/a.xlsx" reloadKey={1} />);
    await screen.findByTestId("sheet-tab-0");
    expect(readMock).toHaveBeenCalledTimes(1);
    loadMock.mockResolvedValue([sheet("新表", [["new"]])]);
    rerender(<SpreadsheetViewer path="/w/a.xlsx" reloadKey={2} />);
    await waitFor(() => expect(screen.getByTestId("sheet-tab-0")).toHaveTextContent("新表"));
    expect(readMock).toHaveBeenCalledTimes(2);
    expect(loadMock).toHaveBeenCalledTimes(2);
  });
});
