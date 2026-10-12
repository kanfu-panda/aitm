/* 表格解析适配层单测：用真实 SheetJS 现场生成工作簿，验证 loadWorkbook / colName / truncateRows。 */
import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import {
  colName,
  loadWorkbook,
  SHEET_MAX_COLS,
  SHEET_MAX_ROWS,
  truncateRows,
} from "../sheet";

function toBuffer(wb: XLSX.WorkBook, bookType: XLSX.BookType = "xlsx"): ArrayBuffer {
  const out = XLSX.write(wb, { type: "array", bookType }) as ArrayBuffer | Uint8Array;
  if (out instanceof ArrayBuffer) return out;
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

function singleSheet(ws: XLSX.WorkSheet, name = "Sheet1", bookType: XLSX.BookType = "xlsx") {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, name);
  return toBuffer(wb, bookType);
}

describe("colName", () => {
  it("应该_当序号为边界值时_返回对应的列字母", () => {
    expect(colName(0)).toBe("A");
    expect(colName(25)).toBe("Z");
    expect(colName(26)).toBe("AA");
    expect(colName(701)).toBe("ZZ");
    expect(colName(702)).toBe("AAA");
  });
});

describe("truncateRows", () => {
  it("应该_当规模未超限时_原样返回并给出原始行列数", () => {
    const rows = [["a", "b"], ["c"]];
    const r = truncateRows(rows);
    expect(r.rows).toEqual(rows);
    expect(r.totalRows).toBe(2);
    expect(r.totalCols).toBe(2);
  });

  it("应该_当行列超限时_截断到上限且总数为原始规模", () => {
    const rows = Array.from({ length: SHEET_MAX_ROWS + 5 }, () =>
      Array.from({ length: SHEET_MAX_COLS + 7 }, () => "x"),
    );
    const r = truncateRows(rows);
    expect(r.rows).toHaveLength(SHEET_MAX_ROWS);
    expect(r.rows[0]).toHaveLength(SHEET_MAX_COLS);
    expect(r.totalRows).toBe(SHEET_MAX_ROWS + 5);
    expect(r.totalCols).toBe(SHEET_MAX_COLS + 7);
  });

  it("应该_当输入为空时_总数为_0", () => {
    expect(truncateRows([])).toEqual({ rows: [], totalRows: 0, totalCols: 0 });
  });
});

describe("loadWorkbook", () => {
  it("应该_当工作簿含多个_sheet_时_按原顺序返回名称与内容", async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["a", "b"], [1, 2]]), "第一页");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["x"]]), "Second");
    const sheets = await loadWorkbook(toBuffer(wb));
    expect(sheets.map((s) => s.name)).toEqual(["第一页", "Second"]);
    expect(sheets[0].rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(sheets[1].rows).toEqual([["x"]]);
    expect(sheets[0].totalRows).toBe(2);
    expect(sheets[0].totalCols).toBe(2);
  });

  it("应该_当单元格设了百分比格式时_返回格式化后的显示值", async () => {
    const ws = XLSX.utils.aoa_to_sheet([[0.125]]);
    ws["A1"].z = "0.00%";
    const sheets = await loadWorkbook(singleSheet(ws));
    expect(sheets[0].rows[0][0]).toBe("12.50%");
  });

  it("应该_当单元格是日期格式时_返回按格式显示的日期文本", async () => {
    const ws = XLSX.utils.aoa_to_sheet([[new Date(Date.UTC(2024, 0, 15))]], { cellDates: true });
    ws["A1"].z = "yyyy-mm-dd";
    const sheets = await loadWorkbook(singleSheet(ws));
    expect(sheets[0].rows[0][0]).toBe("2024-01-15");
  });

  it("应该_当单元格是公式时_显示缓存值而不是公式文本", async () => {
    const ws: XLSX.WorkSheet = {
      A1: { t: "n", v: 3, f: "1+2" },
      "!ref": "A1",
    };
    const sheets = await loadWorkbook(singleSheet(ws));
    expect(sheets[0].rows[0][0]).toBe("3");
  });

  it("应该_当存在合并单元格时_原样带出合并范围", async () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ["a", "", "b"],
      ["", "", "c"],
    ]);
    ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 1, c: 1 } }];
    const sheets = await loadWorkbook(singleSheet(ws));
    expect(sheets[0].merges).toEqual([{ s: { r: 0, c: 0 }, e: { r: 1, c: 1 } }]);
  });

  it("应该_当行列超过上限时_截断显示区且总数为原始规模并丢弃截断区外的合并块", async () => {
    const totalRows = SHEET_MAX_ROWS + 20;
    const totalCols = SHEET_MAX_COLS + 10;
    const aoa = Array.from({ length: totalRows }, (_, r) =>
      Array.from({ length: totalCols }, (_, c) => `${r}-${c}`),
    );
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!merges"] = [
      { s: { r: 0, c: 0 }, e: { r: 1, c: 1 } }, // 区内，保留
      { s: { r: SHEET_MAX_ROWS + 2, c: 0 }, e: { r: SHEET_MAX_ROWS + 3, c: 1 } }, // 行越界，丢弃
      { s: { r: 0, c: SHEET_MAX_COLS + 2 }, e: { r: 0, c: SHEET_MAX_COLS + 3 } }, // 列越界，丢弃
    ];
    const sheets = await loadWorkbook(singleSheet(ws));
    const s = sheets[0];
    expect(s.rows).toHaveLength(SHEET_MAX_ROWS);
    expect(s.rows[0]).toHaveLength(SHEET_MAX_COLS);
    expect(s.totalRows).toBe(totalRows);
    expect(s.totalCols).toBe(totalCols);
    expect(s.merges).toEqual([{ s: { r: 0, c: 0 }, e: { r: 1, c: 1 } }]);
  });

  it("应该_当_sheet_为空时_rows_为空数组", async () => {
    const sheets = await loadWorkbook(singleSheet(XLSX.utils.aoa_to_sheet([]), "空"));
    expect(sheets[0].name).toBe("空");
    expect(sheets[0].rows).toEqual([]);
    expect(sheets[0].merges).toEqual([]);
  });

  it("应该_当文件是旧版_xls_格式时_同样能读出内容", async () => {
    const ws = XLSX.utils.aoa_to_sheet([["名称", "数量"], ["苹果", 3]]);
    const sheets = await loadWorkbook(singleSheet(ws, "旧表", "biff8"));
    expect(sheets[0].name).toBe("旧表");
    expect(sheets[0].rows).toEqual([
      ["名称", "数量"],
      ["苹果", "3"],
    ]);
  });

  it("应该_当字节不是表格文件时_抛出错误", async () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + 11) % 256;
    await expect(loadWorkbook(bytes.buffer)).rejects.toBeDefined();
  });

  it("应该_当字节是纯文本时_同样抛出错误而不是当作表格解析", async () => {
    const bytes = new TextEncoder().encode("hello world, this is not a workbook");
    await expect(loadWorkbook(bytes.buffer as ArrayBuffer)).rejects.toBeDefined();
  });

  it("应该_当工作表声明了_A1_范围但没有任何内容时_按空表处理", async () => {
    const XLSX = await import("xlsx");
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([]);
    ws["!ref"] = "A1";
    XLSX.utils.book_append_sheet(wb, ws, "空");
    const data = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    const [sheet] = await loadWorkbook(data);
    expect(sheet).toEqual({ name: "空", rows: [], merges: [], totalRows: 0, totalCols: 0 });
  });

  it("应该_当数据不从_A1_开始时_仍从_A1_起排列_行列号与_Excel_对齐", async () => {
    const XLSX = await import("xlsx");
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.sheet_add_aoa(XLSX.utils.aoa_to_sheet([]), [["标题"], ["值"]], { origin: "B3" });
    XLSX.utils.book_append_sheet(wb, ws, "S");
    const data = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    const [sheet] = await loadWorkbook(data);
    expect(sheet.rows[2][1]).toBe("标题");
    expect(sheet.rows[3][1]).toBe("值");
    expect(sheet.rows[0]).toEqual(["", ""]);
    expect([sheet.totalRows, sheet.totalCols]).toEqual([4, 2]);
  });
});
