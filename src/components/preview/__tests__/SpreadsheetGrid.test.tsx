/* SpreadsheetGrid 单测：表头、合并块、截断提示、空表与文本转义。 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import SpreadsheetGrid from "../SpreadsheetGrid";

afterEach(cleanup);

const rows3 = [
  ["a1", "b1", "c1"],
  ["a2", "b2", "c2"],
  ["a3", "b3", "c3"],
];

describe("SpreadsheetGrid", () => {
  it("应该_当渲染普通表格时_显示列号表头_A_B_C_与行号_1_2_3", () => {
    render(<SpreadsheetGrid rows={rows3} totalRows={3} totalCols={3} />);
    const grid = screen.getByTestId("sheet-grid");
    const headers = within(grid)
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(headers).toEqual(expect.arrayContaining(["A", "B", "C"]));
    const rowHeaders = within(grid)
      .getAllByRole("rowheader")
      .map((h) => h.textContent);
    expect(rowHeaders).toEqual(["1", "2", "3"]);
  });

  it("应该_当渲染单元格时_data_cell_按列字母加行号定位且文本正确", () => {
    const { container } = render(<SpreadsheetGrid rows={rows3} totalRows={3} totalCols={3} />);
    expect(container.querySelector('td[data-cell="B2"]')?.textContent).toBe("b2");
    expect(container.querySelector('td[data-cell="C3"]')?.textContent).toBe("c3");
    expect(container.querySelector('td[data-cell="A1"]')?.textContent).toBe("a1");
  });

  it("应该_当存在合并块时_左上角带_rowSpan_colSpan_且被覆盖的格子不渲染", () => {
    const { container } = render(
      <SpreadsheetGrid
        rows={rows3}
        merges={[{ s: { r: 0, c: 0 }, e: { r: 1, c: 1 } }]}
        totalRows={3}
        totalCols={3}
      />,
    );
    const tl = container.querySelector('td[data-cell="A1"]') as unknown as { rowSpan: number; colSpan: number };
    expect(tl.rowSpan).toBe(2);
    expect(tl.colSpan).toBe(2);
    expect(container.querySelector('td[data-cell="B1"]')).toBeNull();
    expect(container.querySelector('td[data-cell="A2"]')).toBeNull();
    expect(container.querySelector('td[data-cell="B2"]')).toBeNull();
    expect(container.querySelector('td[data-cell="C1"]')).not.toBeNull();
    expect(container.querySelector('td[data-cell="A3"]')).not.toBeNull();
  });

  it("应该_当总行数大于已有行数时_显示截断提示", () => {
    render(<SpreadsheetGrid rows={rows3} totalRows={5000} totalCols={3} />);
    expect(screen.getByTestId("sheet-truncated")).toHaveTextContent(
      "仅显示前 3 行、3 列（共 5000 行、3 列）",
    );
  });

  it("应该_当总列数大于已有列数时_也显示截断提示", () => {
    render(<SpreadsheetGrid rows={rows3} totalRows={3} totalCols={300} />);
    expect(screen.getByTestId("sheet-truncated")).toHaveTextContent(
      "仅显示前 3 行、3 列（共 3 行、300 列）",
    );
  });

  it("应该_当未超限时_不显示截断提示", () => {
    render(<SpreadsheetGrid rows={rows3} totalRows={3} totalCols={3} />);
    expect(screen.queryByTestId("sheet-truncated")).toBeNull();
  });

  it("应该_当_rows_为空时_显示空工作表提示而不是表格", () => {
    render(<SpreadsheetGrid rows={[]} totalRows={0} totalCols={0} />);
    expect(screen.getByTestId("sheet-empty")).toHaveTextContent("空工作表");
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("应该_当单元格内容含_HTML_时_按纯文本显示且不生成元素", () => {
    const { container } = render(
      <SpreadsheetGrid rows={[["<b>x</b>"]]} totalRows={1} totalCols={1} />,
    );
    const cell = container.querySelector('td[data-cell="A1"]') as HTMLElement;
    expect(cell.textContent).toBe("<b>x</b>");
    expect(cell.querySelector("b")).toBeNull();
  });
});
