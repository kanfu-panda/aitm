/* =============================================================================
 * PdfViewer.tsx —— 文件工作区里的只读 PDF 标签页
 * -----------------------------------------------------------------------------
 * 按字节读取 PDF（fs_read_pdf）→ 交给 lib/pdfjs 的控制器渲染。本组件只管：
 *   - 工具栏：页码 / 跳页、缩放档位与适应宽度
 *   - 搜索框：焦点在预览内时 ⌘F / Ctrl+F 打开，回车 / ⇧回车查找，Esc 关闭
 *   - 提示态：加载中、超过大小上限、打开失败（都可用默认应用打开）
 * `reloadKey` 变化（文件在磁盘上被替换）时整份重新加载。
 * ========================================================================== */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { fsReadPdf, shellOpen } from "../../lib/tauri";
import { openPdfViewer, type PdfController, type PdfFindResult } from "../../lib/pdfjs";
import { nextZoom } from "../../lib/pdf";
import { backendErrorCode, formatBackendError } from "../../lib/backendError";

interface Props {
  path: string;
  /** 变化即重新加载（传文件的 mtime）。 */
  reloadKey: number | undefined;
}

type ViewState =
  | { status: "loading" }
  | { status: "ready" }
  | { status: "tooLarge"; size: number; max: number }
  // encrypted / invalid 在渲染时翻译（切换界面语言后跟着变）；read 为后端错误原文
  | { status: "error"; kind: "encrypted" | "invalid" }
  | { status: "error"; kind: "read"; error: unknown };

const MB = 1024 * 1024;
const formatMb = (bytes: number) => `${(bytes / MB).toFixed(1)} MB`;

// 搜索框 / 页码框：关掉 macOS WebView 的自动更正与首字母大写（否则 "aitm" 会被改成 "Aitm"）
const PLAIN_INPUT = {
  autoComplete: "off",
  autoCorrect: "off",
  autoCapitalize: "off",
  spellCheck: false,
} as const;

const BTN =
  "rounded px-1.5 py-0.5 text-xs text-[var(--c-text-muted)] hover:bg-[var(--c-bg-elev-2)] hover:text-[var(--c-text-base)] disabled:opacity-40 disabled:hover:bg-transparent";

export default function PdfViewer({ path, reloadKey }: Props) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const ctlRef = useRef<PdfController | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const [view, setView] = useState<ViewState>({ status: "loading" });
  const [pageCount, setPageCount] = useState(0);
  const [page, setPage] = useState(1);
  const [pageText, setPageText] = useState("1");
  const [scale, setScale] = useState<number | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [findResult, setFindResult] = useState<PdfFindResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    setView({ status: "loading" });
    setSearchOpen(false);
    setFindResult(null);
    setScale(null);

    void (async () => {
      let data: ArrayBuffer;
      try {
        data = await fsReadPdf(path);
      } catch (e) {
        if (cancelled) return;
        const coded = backendErrorCode(e);
        if (coded?.code === "fs.pdfTooLarge") {
          setView({
            status: "tooLarge",
            size: Number(coded.params.size),
            max: Number(coded.params.max),
          });
        } else {
          setView({ status: "error", kind: "read", error: e });
        }
        return;
      }
      if (cancelled || !containerRef.current) return;

      let ctl: PdfController;
      try {
        ctl = await openPdfViewer(containerRef.current, data, {
          onPageChange: (n) => {
            setPage(n);
            setPageText(String(n));
          },
          onScaleChange: setScale,
          onFindResult: setFindResult,
        });
      } catch (e) {
        if (cancelled) return;
        const name = (e as { name?: string }).name;
        setView({ status: "error", kind: name === "PasswordException" ? "encrypted" : "invalid" });
        return;
      }
      if (cancelled) {
        ctl.destroy();
        return;
      }
      ctlRef.current = ctl;
      setPageCount(ctl.pageCount);
      setPage(1);
      setPageText("1");
      setView({ status: "ready" });
    })();

    return () => {
      cancelled = true;
      ctlRef.current?.destroy();
      ctlRef.current = null;
    };
  }, [path, reloadKey]);

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  const commitPage = () => {
    const n = Number(pageText);
    if (Number.isInteger(n) && n >= 1 && n <= pageCount) {
      ctlRef.current?.setPage(n);
    } else {
      setPageText(String(page));
    }
  };

  const zoom = (dir: "in" | "out") => {
    const next = nextZoom(scale ?? 1, dir);
    if (next !== null) ctlRef.current?.setScale(next);
  };

  const closeSearch = useCallback(() => {
    ctlRef.current?.closeFind();
    setSearchOpen(false);
    setFindResult(null);
  }, []);

  const onRootKeyDown = (e: KeyboardEvent) => {
    const combo = (e.metaKey && !e.ctrlKey) || (e.ctrlKey && !e.metaKey);
    if (combo && (e.key === "f" || e.key === "F") && view.status === "ready") {
      e.preventDefault();
      e.stopPropagation();
      setSearchOpen(true);
      searchRef.current?.focus();
    }
  };

  const onSearchKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (query) ctlRef.current?.find(query, e.shiftKey);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeSearch();
    }
  };

  const openDefault = async () => {
    try {
      await shellOpen(path);
    } catch (e) {
      setView({ status: "error", kind: "read", error: e });
    }
  };

  const fallback = (testId: string, message: string) => (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center"
      data-testid={testId}
    >
      <p className="text-sm text-[var(--c-text-muted)]">{message}</p>
      <button
        onClick={() => void openDefault()}
        className="rounded border border-[var(--c-success)] bg-[var(--c-success-bg)] px-4 py-1.5 text-sm text-[var(--c-success-fg)] hover:opacity-90"
        data-testid="pdf-open-default"
      >
        {t("pdfViewer.openWithDefault")}
      </button>
    </div>
  );

  const countText = findResult
    ? findResult.notFound
      ? t("pdfViewer.noMatch")
      : t("pdfViewer.matchCount", { current: findResult.current, total: findResult.total })
    : "";

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-[var(--c-bg-base)] outline-none"
      tabIndex={-1}
      onKeyDown={onRootKeyDown}
      data-testid="pdf-viewer"
    >
      {view.status === "ready" && (
        <div
          className="flex shrink-0 items-center gap-3 border-b border-[var(--c-border)] px-3 py-1 text-xs text-[var(--c-text-muted)]"
          data-testid="pdf-toolbar"
        >
          <div className="flex items-center gap-1">
            <input
              value={pageText}
              onChange={(e) => setPageText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitPage();
              }}
              onBlur={() => setPageText(String(page))}
              aria-label={t("pdfViewer.pageInput")}
              {...PLAIN_INPUT}
              className="w-10 rounded border border-[var(--c-border)] bg-transparent px-1 text-center text-[var(--c-text-base)]"
              data-testid="pdf-page-input"
            />
            <span data-testid="pdf-page-count">{t("pdfViewer.pageOf", { count: pageCount })}</span>
          </div>
          <div className="mx-auto flex items-center gap-1">
            <button
              className={BTN}
              onClick={() => zoom("out")}
              disabled={nextZoom(scale ?? 1, "out") === null}
              aria-label={t("pdfViewer.zoomOut")}
              title={t("pdfViewer.zoomOut")}
              data-testid="pdf-zoom-out"
            >
              −
            </button>
            <span className="w-12 text-center tabular-nums" data-testid="pdf-zoom-level">
              {scale === null ? "" : `${Math.round(scale * 100)}%`}
            </span>
            <button
              className={BTN}
              onClick={() => zoom("in")}
              disabled={nextZoom(scale ?? 1, "in") === null}
              aria-label={t("pdfViewer.zoomIn")}
              title={t("pdfViewer.zoomIn")}
              data-testid="pdf-zoom-in"
            >
              +
            </button>
            <button
              className={BTN}
              onClick={() => ctlRef.current?.fitWidth()}
              data-testid="pdf-fit-width"
            >
              {t("pdfViewer.fitWidth")}
            </button>
          </div>
          <button
            className={BTN}
            onClick={() => setSearchOpen(true)}
            aria-label={t("pdfViewer.search")}
            title={t("pdfViewer.search")}
            data-testid="pdf-search-button"
          >
            {t("pdfViewer.search")}
          </button>
        </div>
      )}

      <div className="relative min-h-0 flex-1 bg-[var(--c-bg-elev-1)]">
        {searchOpen && (
          <div className="absolute right-4 top-2 z-10 flex items-center gap-1 rounded border border-[var(--c-border)] bg-[var(--c-bg-base)] px-2 py-1 text-xs shadow">
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKeyDown}
              placeholder={t("pdfViewer.searchPlaceholder")}
              aria-label={t("pdfViewer.search")}
              {...PLAIN_INPUT}
              className="w-40 bg-transparent text-[var(--c-text-base)] outline-none"
              data-testid="pdf-search-input"
            />
            <span
              className="min-w-14 text-center text-[var(--c-text-dim)]"
              aria-live="polite"
              data-testid="pdf-search-count"
            >
              {countText}
            </span>
            <button
              className={BTN}
              onClick={() => query && ctlRef.current?.find(query, true)}
              aria-label={t("pdfViewer.prevMatch")}
              title={t("pdfViewer.prevMatch")}
            >
              ↑
            </button>
            <button
              className={BTN}
              onClick={() => query && ctlRef.current?.find(query, false)}
              aria-label={t("pdfViewer.nextMatch")}
              title={t("pdfViewer.nextMatch")}
            >
              ↓
            </button>
            <button
              className={BTN}
              onClick={closeSearch}
              aria-label={t("pdfViewer.closeSearch")}
              title={t("pdfViewer.closeSearch")}
            >
              ×
            </button>
          </div>
        )}

        {/* PDFViewer 要求容器绝对定位且可滚动，内含 .pdfViewer 子元素 */}
        <div
          ref={containerRef}
          className="absolute inset-0 overflow-auto"
          style={{ visibility: view.status === "ready" ? "visible" : "hidden" }}
        >
          <div className="pdfViewer" />
        </div>

        {view.status === "loading" && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-[var(--c-text-dim)]">
            {t("pdfViewer.loading")}
          </div>
        )}
        {view.status === "tooLarge" &&
          fallback(
            "pdf-too-large",
            t("pdfViewer.tooLarge", { size: formatMb(view.size), max: formatMb(view.max) }),
          )}
        {view.status === "error" &&
          fallback(
            "pdf-error",
            view.kind === "read" ? formatBackendError(view.error) : t(`pdfViewer.${view.kind}`),
          )}
      </div>
    </div>
  );
}
