/* 预览类型判定单测。 */
import { describe, expect, it } from "vitest";
import { imageMimeOf, isTablePath, previewKindOf } from "../preview";

describe("previewKindOf", () => {
  it("应该_按扩展名识别各预览类型_不区分大小写", () => {
    expect(previewKindOf("/a/b.pdf")).toBe("pdf");
    expect(previewKindOf("/a/B.PDF")).toBe("pdf");
    for (const ext of ["png", "jpg", "JPEG", "gif", "webp", "svg", "bmp", "ico"]) {
      expect(previewKindOf(`/a/x.${ext}`)).toBe("image");
    }
    expect(previewKindOf("/a/x.xlsx")).toBe("sheet");
    expect(previewKindOf("/a/x.XLS")).toBe("sheet");
    expect(previewKindOf("/a/x.docx")).toBe("docx");
    expect(previewKindOf("/a/x.pptx")).toBe("pptx");
    expect(previewKindOf("/a/x.doc")).toBe("unsupported");
  });

  it("应该_当是文本类或无扩展名时_返回_null", () => {
    for (const p of ["/a/x.ts", "/a/x.csv", "/a/x.tsv", "/a/x.md", "/a/Makefile", "/a/x.pdf.txt", "/a/pdf"]) {
      expect(previewKindOf(p)).toBeNull();
    }
  });

  it("应该_只看文件名部分的扩展名", () => {
    expect(previewKindOf("/a.png/readme")).toBeNull();
    expect(previewKindOf("C:\\dir\\pic.PNG")).toBe("image");
  });
});

describe("isTablePath", () => {
  it("应该_识别_csv_与_tsv", () => {
    expect(isTablePath("/a/x.csv")).toBe(true);
    expect(isTablePath("/a/x.TSV")).toBe(true);
    expect(isTablePath("/a/x.xlsx")).toBe(false);
    expect(isTablePath("/a/x.txt")).toBe(false);
  });
});

describe("imageMimeOf", () => {
  it("应该_给出各图片扩展名的_MIME", () => {
    expect(imageMimeOf("/a/x.png")).toBe("image/png");
    expect(imageMimeOf("/a/x.jpg")).toBe("image/jpeg");
    expect(imageMimeOf("/a/x.JPEG")).toBe("image/jpeg");
    expect(imageMimeOf("/a/x.gif")).toBe("image/gif");
    expect(imageMimeOf("/a/x.webp")).toBe("image/webp");
    expect(imageMimeOf("/a/x.svg")).toBe("image/svg+xml");
    expect(imageMimeOf("/a/x.bmp")).toBe("image/bmp");
    expect(imageMimeOf("/a/x.ico")).toBe("image/x-icon");
  });

  it("应该_当不是图片时_返回通用二进制类型", () => {
    expect(imageMimeOf("/a/x.docx")).toBe("application/octet-stream");
  });
});
