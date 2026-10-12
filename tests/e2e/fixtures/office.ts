/* E2E 用的 Office / 图片测试文件：现场生成，返回 base64 交给 mock 的 fs_read_binary。 */
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { buildPptx, para, run, sp } from "../../../src/lib/__tests__/fixtures/pptx";

const b64 = (buf: ArrayBuffer | Uint8Array) => Buffer.from(buf as ArrayBuffer).toString("base64");

/** 2 × 1 像素的 PNG（左红右蓝）。 */
export const PNG_2X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8AAQv8BD/kD/YURmXYAAAAASUVORK5CYII=";

/** 两个工作表的 xlsx：每个 sheet 的单元格文字可区分。 */
export function makeXlsxBase64(): string {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["名称", "数量"], ["苹果", 3]]), "Q1");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["名称", "数量"], ["香蕉", 7]]), "Q2");
  return b64(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}

/** 只有一段正文的最小 docx。 */
export async function makeDocxBase64(text: string): Promise<string> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.file(
    "word/document.xml",
    '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
  );
  return b64(await zip.generateAsync({ type: "uint8array" }));
}

/** 两张幻灯片的 pptx，每张一个文字框。 */
export async function makePptxBase64(texts: string[]): Promise<string> {
  const box = { x: 60, y: 60, w: 600, h: 120 };
  const buf = await buildPptx({
    slides: texts.map((t) => ({ shapes: [sp({ box, paras: [para(run(t, { sz: 3200 }))] })] })),
  });
  return b64(buf);
}
