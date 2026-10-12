/* =============================================================================
 * sheet.ts —— 表格文件解析适配层
 * -----------------------------------------------------------------------------
 * xlsx / xls 经 SheetJS 解析成"显示值"二维数组 + 合并块。SheetJS 体积大，只在
 * loadWorkbook 内 await import("xlsx") 按需加载，本文件顶层不静态引入，
 * 所以 truncateRows / colName 可被 CSV 预览安全复用。
 * ========================================================================== */

export interface Merge {
  s: { r: number; c: number };
  e: { r: number; c: number };
}
export interface SheetData {
  name: string;
  rows: string[][];
  merges: Merge[];
  totalRows: number;
  totalCols: number;
}

export const SHEET_MAX_ROWS = 1000;
export const SHEET_MAX_COLS = 100;

/** 列序号（0 起）→ 列字母：0 → A，25 → Z，26 → AA。 */
export function colName(index: number): string {
  let n = index;
  let s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/** 截到前 SHEET_MAX_ROWS 行 × SHEET_MAX_COLS 列，同时给出原始规模。 */
export function truncateRows(rows: string[][]): {
  rows: string[][];
  totalRows: number;
  totalCols: number;
} {
  const totalCols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const cut = rows.slice(0, SHEET_MAX_ROWS).map((r) => r.slice(0, SHEET_MAX_COLS));
  return { rows: cut, totalRows: rows.length, totalCols };
}

/** 文件头魔数：zip（xlsx）或 CFB（xls）。SheetJS 会把任意字节当文本表格读，必须先挡掉。 */
function isWorkbookBytes(data: ArrayBuffer): boolean {
  const b = new Uint8Array(data, 0, Math.min(8, data.byteLength));
  const zip = [0x50, 0x4b, 0x03, 0x04];
  const cfb = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  return zip.every((v, i) => b[i] === v) || cfb.every((v, i) => b[i] === v);
}

export async function loadWorkbook(data: ArrayBuffer): Promise<SheetData[]> {
  if (!isWorkbookBytes(data)) throw new Error("not a workbook");
  const XLSX = await import("xlsx");
  const wb = XLSX.read(data, { type: "array", cellDates: true });
  return wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    if (!ws || !ws["!ref"]) {
      return { name, rows: [], merges: [], totalRows: 0, totalCols: 0 };
    }
    // 一律从 A1 起取：数据不从 A1 开始（如表格从 B2 起）时，行号列字母仍与 Excel 对齐
    const used = XLSX.utils.decode_range(ws["!ref"]);
    const totalRows = used.e.r + 1;
    const totalCols = used.e.c + 1;
    const rowLimit = Math.min(totalRows, SHEET_MAX_ROWS);
    const colLimit = Math.min(totalCols, SHEET_MAX_COLS);
    const range = { s: { r: 0, c: 0 }, e: { r: rowLimit - 1, c: colLimit - 1 } };
    const rows = (
      XLSX.utils.sheet_to_json(ws, {
        header: 1,
        raw: false,
        defval: "",
        blankrows: true,
        range,
      }) as unknown[][]
    ).map((r) => r.map((v) => String(v ?? "")));
    const merges: Merge[] = (ws["!merges"] ?? [])
      .map((m) => ({ s: { r: m.s.r, c: m.s.c }, e: { r: m.e.r, c: m.e.c } }))
      .filter((m) => m.e.r < rowLimit && m.e.c < colLimit);
    // 有的生成工具给空表也写上 A1 范围：没有任何内容就按空表处理
    if (merges.length === 0 && rows.every((r) => r.every((v) => v === ""))) {
      return { name, rows: [], merges: [], totalRows: 0, totalCols: 0 };
    }
    return { name, rows, merges, totalRows, totalCols };
  });
}
