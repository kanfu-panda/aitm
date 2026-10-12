/* pdf.js 适配层单测：pdf.js 本身用假实现代替，只验证接线是否正确。 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  type Handler = (e: unknown) => void;
  const state = {
    handlers: new Map<string, Handler>(),
    dispatched: [] as Array<{ name: string; data: unknown }>,
    viewer: null as null | Record<string, unknown>,
    linkService: null as null | Record<string, unknown>,
    loadingTask: null as null | { promise: Promise<unknown>; destroy: ReturnType<typeof vi.fn> },
    getDocumentArgs: null as unknown,
    viewerOptions: null as unknown,
  };
  return { state };
});

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  AnnotationMode: { DISABLE: 0 },
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: (args: unknown) => {
    h.state.getDocumentArgs = args;
    return h.state.loadingTask;
  },
}));
vi.mock("pdfjs-dist/legacy/web/pdf_viewer.mjs", () => ({
  FindState: { FOUND: 0, NOT_FOUND: 1, WRAPPED: 2, PENDING: 3 },
  EventBus: class {
    on(name: string, fn: (e: unknown) => void) {
      h.state.handlers.set(name, fn);
    }
    dispatch(name: string, data: unknown) {
      h.state.dispatched.push({ name, data });
    }
  },
  PDFLinkService: class {
    page = 1;
    setViewer = vi.fn();
    setDocument = vi.fn();
    constructor() {
      h.state.linkService = this as unknown as Record<string, unknown>;
    }
  },
  PDFFindController: class {},
  PDFViewer: class {
    pagesCount = 3;
    currentScale = 1;
    currentScaleValue = "auto";
    setDocument = vi.fn();
    constructor(opts: unknown) {
      h.state.viewerOptions = opts;
      h.state.viewer = this as unknown as Record<string, unknown>;
    }
  },
}));
vi.mock("pdfjs-dist/legacy/web/pdf_viewer.css", () => ({}));
vi.mock("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url", () => ({ default: "/worker.mjs" }));

import { openPdfViewer, type PdfEvents } from "../pdfjs";

function events() {
  return {
    onPageChange: vi.fn<PdfEvents["onPageChange"]>(),
    onScaleChange: vi.fn<PdfEvents["onScaleChange"]>(),
    onFindResult: vi.fn<PdfEvents["onFindResult"]>(),
  };
}

const fire = (name: string, e: unknown) => h.state.handlers.get(name)?.(e);

beforeEach(() => {
  h.state.handlers.clear();
  h.state.dispatched.length = 0;
  h.state.loadingTask = {
    promise: Promise.resolve({ numPages: 3 }),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
});

describe("openPdfViewer", () => {
  it("应该_用同源资源路径加载文档_关闭注释层与自动链接_返回页数", async () => {
    const ctl = await openPdfViewer(document.createElement("div"), new ArrayBuffer(4), events());
    const args = h.state.getDocumentArgs as Record<string, unknown>;
    expect(args.data).toBeInstanceOf(Uint8Array);
    expect(args.cMapUrl).toMatch(/pdfjs\/cmaps\/$/);
    expect(args.standardFontDataUrl).toMatch(/pdfjs\/standard_fonts\/$/);
    expect(args.wasmUrl).toMatch(/pdfjs\/wasm\/$/);
    const opts = h.state.viewerOptions as Record<string, unknown>;
    expect(opts.annotationMode).toBe(0);
    expect(opts.enableAutoLinking).toBe(false);
    expect(ctl.pageCount).toBe(3);
  });

  it("应该_当传入密码时_getDocument_参数带上该密码", async () => {
    await openPdfViewer(document.createElement("div"), new ArrayBuffer(4), events(), "s3cret");
    const args = h.state.getDocumentArgs as Record<string, unknown>;
    expect(args.password).toBe("s3cret");
  });

  it("应该_当不传密码时_getDocument_参数不带密码", async () => {
    await openPdfViewer(document.createElement("div"), new ArrayBuffer(4), events());
    const args = h.state.getDocumentArgs as Record<string, unknown>;
    expect(args.password).toBeUndefined();
  });

  it("应该_每次加载都传字节副本_不让原缓冲区被转移", async () => {
    const original = new ArrayBuffer(4);
    new Uint8Array(original).set([1, 2, 3, 4]);
    await openPdfViewer(document.createElement("div"), original, events());
    const args = h.state.getDocumentArgs as { data: Uint8Array };
    expect(args.data.buffer).not.toBe(original);
    expect(Array.from(args.data)).toEqual([1, 2, 3, 4]);
    // 模拟 pdf.js 转移副本缓冲区后，原缓冲区仍可再次使用
    expect(original.byteLength).toBe(4);
    await openPdfViewer(document.createElement("div"), original, events(), "pw");
    const args2 = h.state.getDocumentArgs as { data: Uint8Array };
    expect(args2.data.buffer).not.toBe(original);
    expect(args2.data.buffer).not.toBe(args.data.buffer);
  });

  it("应该_当需要密码或密码错误时_原样抛出_PasswordException_并保持_code", async () => {
    for (const code of [1, 2]) {
      const err = Object.assign(new Error("pw"), { name: "PasswordException", code });
      h.state.loadingTask = { promise: Promise.reject(err), destroy: vi.fn() };
      const p = openPdfViewer(document.createElement("div"), new ArrayBuffer(4), events());
      await expect(p).rejects.toBe(err);
      await expect(p).rejects.toMatchObject({ name: "PasswordException", code });
      expect(h.state.loadingTask.destroy).toHaveBeenCalled();
    }
  });

  it("应该_当文档解析失败时_销毁加载任务并抛出原错误", async () => {
    const err = Object.assign(new Error("bad"), { name: "InvalidPDFException" });
    h.state.loadingTask = { promise: Promise.reject(err), destroy: vi.fn() };
    await expect(
      openPdfViewer(document.createElement("div"), new ArrayBuffer(4), events()),
    ).rejects.toBe(err);
    expect(h.state.loadingTask.destroy).toHaveBeenCalled();
  });

  it("应该_把翻页_缩放_查找事件转成回调", async () => {
    const ev = events();
    await openPdfViewer(document.createElement("div"), new ArrayBuffer(4), ev);

    fire("pagesinit", {});
    expect(h.state.viewer!.currentScaleValue).toBe("page-width");
    fire("pagechanging", { pageNumber: 2 });
    expect(ev.onPageChange).toHaveBeenCalledWith(2);
    fire("scalechanging", { scale: 1.5 });
    expect(ev.onScaleChange).toHaveBeenCalledWith(1.5);

    fire("updatefindmatchescount", { matchesCount: { current: 1, total: 4 } });
    expect(ev.onFindResult).toHaveBeenLastCalledWith({ current: 1, total: 4, notFound: false });
    fire("updatefindcontrolstate", { state: 1, matchesCount: { current: 0, total: 0 } });
    expect(ev.onFindResult).toHaveBeenLastCalledWith({ current: 0, total: 0, notFound: true });
    fire("updatefindcontrolstate", { state: 0, matchesCount: { current: 2, total: 4 } });
    expect(ev.onFindResult).toHaveBeenLastCalledWith({ current: 2, total: 4, notFound: false });
    const calls = ev.onFindResult.mock.calls.length;
    fire("updatefindcontrolstate", { state: 3, matchesCount: { current: 0, total: 0 } });
    expect(ev.onFindResult.mock.calls.length).toBe(calls);
  });

  it("应该_跳页_缩放_适应宽度作用到查看器", async () => {
    const ctl = await openPdfViewer(document.createElement("div"), new ArrayBuffer(4), events());
    ctl.setPage(3);
    expect(h.state.linkService!.page).toBe(3);
    ctl.setScale(2);
    expect(h.state.viewer!.currentScale).toBe(2);
    ctl.fitWidth();
    expect(h.state.viewer!.currentScaleValue).toBe("page-width");
  });

  it("应该_同一关键词再次查找时用_again_换词或关闭后重新开始", async () => {
    const ctl = await openPdfViewer(document.createElement("div"), new ArrayBuffer(4), events());
    ctl.find("foo", false);
    ctl.find("foo", true);
    ctl.find("bar", false);
    ctl.closeFind();
    ctl.find("bar", false);
    const finds = h.state.dispatched.filter((d) => d.name === "find").map((d) => d.data as Record<string, unknown>);
    expect(finds.map((f) => f.type)).toEqual(["", "again", "", ""]);
    expect(finds[1].findPrevious).toBe(true);
    expect(finds[0].highlightAll).toBe(true);
    expect(h.state.dispatched.some((d) => d.name === "findbarclose")).toBe(true);
  });

  it("应该_销毁时释放查看器_链接服务与加载任务", async () => {
    const ctl = await openPdfViewer(document.createElement("div"), new ArrayBuffer(4), events());
    ctl.destroy();
    expect(h.state.viewer!.setDocument).toHaveBeenLastCalledWith(null);
    expect(h.state.linkService!.setDocument).toHaveBeenLastCalledWith(null, null);
    expect(h.state.loadingTask!.destroy).toHaveBeenCalled();
  });
});
