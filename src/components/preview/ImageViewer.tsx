/* =============================================================================
 * ImageViewer.tsx —— 文件工作区里的只读图片标签页
 * -----------------------------------------------------------------------------
 * 按字节读取图片（fs_read_binary）→ Blob URL → <img>。本组件只管：
 *   - 工具栏：原始尺寸、缩放档位、适应窗口、实际大小
 *   - 缩放：默认适应窗口（小图不放大）；固定倍率按原始宽度换算，容器可滚动
 *   - 提示态：加载中、超过大小上限、读取失败、图片无法解码
 * `reloadKey` 变化（文件在磁盘上被替换）时整份重新加载，缩放回到适应窗口。
 * ========================================================================== */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { imageMimeOf } from "../../lib/preview";
import { nextZoom } from "../../lib/zoom";
import BinaryStatus from "./BinaryStatus";
import PreviewFallback from "./PreviewFallback";
import { useBinaryFile } from "./useBinaryFile";

interface Props {
  path: string;
  /** 变化即重新加载（传文件的 mtime）。 */
  reloadKey: number | undefined;
}

const BTN =
  "rounded px-1.5 py-0.5 text-xs text-[var(--c-text-muted)] hover:bg-[var(--c-bg-elev-2)] hover:text-[var(--c-text-base)] disabled:opacity-40 disabled:hover:bg-transparent";

// 棋盘格底纹：标示图片的透明区域
const CHECKER_STYLE = {
  backgroundColor: "#ffffff",
  backgroundImage:
    "linear-gradient(45deg, #d4d4d8 25%, transparent 25%, transparent 75%, #d4d4d8 75%), linear-gradient(45deg, #d4d4d8 25%, transparent 25%, transparent 75%, #d4d4d8 75%)",
  backgroundSize: "16px 16px",
  backgroundPosition: "0 0, 8px 8px",
} as const;

export default function ImageViewer({ path, reloadKey }: Props) {
  const { t } = useTranslation();
  const state = useBinaryFile(path, reloadKey);
  const data = state.status === "ready" ? state.data : null;

  const [url, setUrl] = useState<string | null>(null);
  const [zoom, setZoom] = useState<number | null>(null); // null = 适应窗口
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [broken, setBroken] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    setZoom(null);
    setSize(null);
    setBroken(false);
    if (!data) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(new window.Blob([data], { type: imageMimeOf(path) }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [data, path]);

  // 适应窗口态以当前实际显示比例为起点；取不到尺寸（如 jsdom）时按 1 计
  const currentZoom = (): number => {
    if (zoom !== null) return zoom;
    const shown = imgRef.current?.clientWidth ?? 0;
    return size && size.w > 0 && shown > 0 ? shown / size.w : 1;
  };

  const step = (dir: "in" | "out") => {
    const next = nextZoom(currentZoom(), dir);
    if (next !== null) setZoom(next);
  };

  const fileName = path.split(/[\\/]/).pop() ?? path;

  let body;
  if (state.status !== "ready") {
    body = <BinaryStatus state={state} path={path} />;
  } else if (broken) {
    body = <PreviewFallback testId="preview-error" message={t("preview.invalid")} path={path} />;
  } else {
    body = (
      <div className="absolute inset-0 overflow-auto">
        {/* 适应窗口时容器必须有确定高度，图片的 max-height: 100% 才生效；固定倍率时容器随图片撑开以便滚动 */}
        <div
          className={`flex items-center justify-center p-4 ${zoom === null ? "h-full w-full" : "min-h-full min-w-full"}`}
          data-testid="image-stage"
        >
          {url && (
            <img
              ref={imgRef}
              src={url}
              alt={fileName}
              draggable={false}
              style={{
                ...CHECKER_STYLE,
                ...(zoom === null
                  ? { maxWidth: "100%", maxHeight: "100%" }
                  : { width: size ? size.w * zoom : undefined, maxWidth: "none" }),
              }}
              onLoad={(e) => {
                const el = e.currentTarget;
                setSize({ w: el.naturalWidth, h: el.naturalHeight });
              }}
              onError={() => setBroken(true)}
              data-testid="image-content"
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-[var(--c-bg-base)] outline-none"
      data-testid="image-viewer"
    >
      {state.status === "ready" && !broken && (
        <div className="flex shrink-0 items-center gap-3 border-b border-[var(--c-border)] px-3 py-1 text-xs text-[var(--c-text-muted)]">
          <span className="tabular-nums" data-testid="image-size">
            {size ? `${size.w} × ${size.h}` : ""}
          </span>
          <div className="mx-auto flex items-center gap-1">
            <button
              className={BTN}
              onClick={() => step("out")}
              disabled={nextZoom(currentZoom(), "out") === null}
              aria-label={t("preview.zoomOut")}
              title={t("preview.zoomOut")}
              data-testid="image-zoom-out"
            >
              −
            </button>
            <span className="w-12 text-center tabular-nums" data-testid="image-zoom-level">
              {zoom === null ? "" : `${Math.round(zoom * 100)}%`}
            </span>
            <button
              className={BTN}
              onClick={() => step("in")}
              disabled={nextZoom(currentZoom(), "in") === null}
              aria-label={t("preview.zoomIn")}
              title={t("preview.zoomIn")}
              data-testid="image-zoom-in"
            >
              +
            </button>
            <button className={BTN} onClick={() => setZoom(null)} data-testid="image-fit">
              {t("preview.fitWindow")}
            </button>
            <button className={BTN} onClick={() => setZoom(1)} data-testid="image-actual">
              {t("preview.actualSize")}
            </button>
          </div>
        </div>
      )}
      <div className="relative min-h-0 flex-1 bg-[var(--c-bg-elev-1)]">{body}</div>
    </div>
  );
}
