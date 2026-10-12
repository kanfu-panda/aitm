/* =============================================================================
 * pdfjs.ts —— pdf.js 适配层
 * -----------------------------------------------------------------------------
 * 把 pdf.js 的文档加载与自带的 PDFViewer（连续滚动、懒渲染、文字层、查找高亮）
 * 包成一个小控制器，PdfViewer 组件只和这里的接口打交道，单测时整个模块可替换。
 *
 * - 用 legacy 构建：自带对较旧 WebView 的兼容处理（最低支持 macOS 12）
 * - CMap / 标准字体 / 图像解码器由 vite.config.ts 的插件以同源静态资源提供（/pdfjs/）
 * - 每次加载都传字节副本：pdf.js 会把缓冲区转移给 worker，转移后原缓冲区即失效，
 *   而加密 PDF 输错密码后需要用同一份字节重试
 * - 关闭注释层：PDF 里的外链在应用 WebView 内被点开会把整个界面导航走
 * ========================================================================== */

import {
  AnnotationMode,
  GlobalWorkerOptions,
  getDocument,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  EventBus,
  FindState,
  PDFFindController,
  PDFLinkService,
  PDFViewer,
} from "pdfjs-dist/legacy/web/pdf_viewer.mjs";
import "pdfjs-dist/legacy/web/pdf_viewer.css";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

const ASSET_BASE = `${import.meta.env.BASE_URL}pdfjs/`;

export interface PdfFindResult {
  /** 当前高亮的是第几个结果（1 起）；无结果为 0。 */
  current: number;
  total: number;
  notFound: boolean;
}

export interface PdfEvents {
  onPageChange: (page: number) => void;
  onScaleChange: (scale: number) => void;
  onFindResult: (r: PdfFindResult) => void;
}

export interface PdfController {
  pageCount: number;
  setPage: (page: number) => void;
  setScale: (scale: number) => void;
  fitWidth: () => void;
  find: (query: string, previous: boolean) => void;
  closeFind: () => void;
  destroy: () => void;
}

/**
 * 在 `container`（须为 `position:absolute; overflow:auto`，内含一个 `.pdfViewer` 子元素）
 * 里打开 PDF。解析失败时抛出 pdf.js 的异常（`PasswordException` / `InvalidPDFException` 等）。
 */
export async function openPdfViewer(
  container: HTMLDivElement,
  data: ArrayBuffer,
  events: PdfEvents,
  password?: string,
): Promise<PdfController> {
  const loadingTask = getDocument({
    data: new Uint8Array(data.slice(0)),
    ...(password === undefined ? {} : { password }),
    cMapUrl: `${ASSET_BASE}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${ASSET_BASE}standard_fonts/`,
    wasmUrl: `${ASSET_BASE}wasm/`,
    enableXfa: false,
  });
  let doc;
  try {
    doc = await loadingTask.promise;
  } catch (e) {
    void loadingTask.destroy();
    throw e;
  }

  const eventBus = new EventBus();
  const linkService = new PDFLinkService({ eventBus });
  const findController = new PDFFindController({ eventBus, linkService });
  const viewer = new PDFViewer({
    container,
    eventBus,
    linkService,
    findController,
    annotationMode: AnnotationMode.DISABLE,
    enableAutoLinking: false,
  });
  linkService.setViewer(viewer);

  // 适应宽度模式下，容器宽度变化（拖动分隔条、改窗口大小）时重新按宽度缩放
  let fitMode = true;
  const resizeObserver =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
          if (fitMode && viewer.pagesCount > 0) viewer.currentScaleValue = "page-width";
        });
  resizeObserver?.observe(container);

  eventBus.on("pagesinit", () => {
    viewer.currentScaleValue = "page-width";
  });
  eventBus.on("pagechanging", (e: { pageNumber: number }) => {
    events.onPageChange(e.pageNumber);
  });
  eventBus.on("scalechanging", (e: { scale: number }) => {
    events.onScaleChange(e.scale);
  });
  eventBus.on(
    "updatefindmatchescount",
    (e: { matchesCount: { current: number; total: number } }) => {
      const { current, total } = e.matchesCount;
      events.onFindResult({ current, total, notFound: total === 0 });
    },
  );
  eventBus.on(
    "updatefindcontrolstate",
    (e: { state: number; matchesCount: { current: number; total: number } }) => {
      if (e.state === FindState.NOT_FOUND) {
        events.onFindResult({ current: 0, total: 0, notFound: true });
      } else if (e.state !== FindState.PENDING && e.matchesCount) {
        const { current, total } = e.matchesCount;
        events.onFindResult({ current, total, notFound: total === 0 });
      }
    },
  );

  viewer.setDocument(doc);
  linkService.setDocument(doc, null);

  let lastQuery = "";
  return {
    pageCount: doc.numPages,
    setPage: (page) => {
      linkService.page = page;
    },
    setScale: (scale) => {
      fitMode = false;
      viewer.currentScale = scale;
    },
    fitWidth: () => {
      fitMode = true;
      viewer.currentScaleValue = "page-width";
    },
    find: (query, previous) => {
      eventBus.dispatch("find", {
        source: null,
        type: query === lastQuery ? "again" : "",
        query,
        caseSensitive: false,
        entireWord: false,
        highlightAll: true,
        findPrevious: previous,
        matchDiacritics: false,
      });
      lastQuery = query;
    },
    closeFind: () => {
      lastQuery = "";
      eventBus.dispatch("findbarclose", { source: null });
    },
    destroy: () => {
      resizeObserver?.disconnect();
      viewer.setDocument(null as never);
      linkService.setDocument(null, null);
      void loadingTask.destroy();
    },
  };
}
