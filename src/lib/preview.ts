/** 预览类型判定：按扩展名决定文件以哪种只读查看器打开。 */

/** 二进制预览类型；文本类文件（含 csv / tsv）不属于这里，走编辑器。 */
export type PreviewKind = "pdf" | "image" | "sheet" | "docx" | "pptx" | "unsupported";

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
};

/** 取文件名部分的小写扩展名；没有扩展名返回空串（兼容 / 与 \\ 分隔符）。 */
function extOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** 扩展名 → 预览类型；文本类返回 null。 */
export function previewKindOf(path: string): PreviewKind | null {
  const ext = extOf(path);
  if (ext === "pdf") return "pdf";
  if (ext in IMAGE_MIME) return "image";
  if (ext === "xlsx" || ext === "xls") return "sheet";
  if (ext === "docx") return "docx";
  if (ext === "pptx") return "pptx";
  // 老格式 Word：浏览器端无法解析，只给提示
  if (ext === "doc") return "unsupported";
  return null;
}

/** csv / tsv：按文本打开，默认以表格显示。 */
export function isTablePath(path: string): boolean {
  const ext = extOf(path);
  return ext === "csv" || ext === "tsv";
}

/** 图片扩展名 → MIME；非图片返回通用二进制类型。 */
export function imageMimeOf(path: string): string {
  return IMAGE_MIME[extOf(path)] ?? "application/octet-stream";
}
