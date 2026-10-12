/* =============================================================================
 * csv.ts —— CSV / TSV 解析
 * -----------------------------------------------------------------------------
 * 自写、无依赖，遵循 RFC 4180：双引号字段可含分隔符与换行，"" 表示一个双引号；
 * \r\n 与 \n 都认；末尾换行不产生空行；各行列数按原样保留。
 * ========================================================================== */

export function parseDelimited(text: string, delimiter: "," | "\t"): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  // 当前行是否已有内容（区分"空行"与"文本结束"）
  let touched = false;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
    touched = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === "") {
      inQuotes = true;
      touched = true;
    } else if (ch === delimiter) {
      endField();
      touched = true;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRow();
    } else {
      field += ch;
      touched = true;
    }
  }
  // 末尾没有换行的最后一行
  if (touched || field !== "") endRow();
  return rows;
}
