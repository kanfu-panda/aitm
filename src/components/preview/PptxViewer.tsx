/* =============================================================================
 * PptxViewer.tsx —— 文件工作区里的只读 PowerPoint 预览
 * -----------------------------------------------------------------------------
 * useBinaryFile 读字节 → lib/pptx 解析成简化模型 → 每张幻灯片按原尺寸（pt→px）绝对定位绘制，
 * 外层按容器宽度整体 scale。文字一律作为文本节点插入（不走 innerHTML）；
 * 图片用 Blob URL，换数据 / 卸载时回收。
 * ========================================================================== */

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { parsePptx, type PptxElement, type PptxParagraph, type Presentation } from "../../lib/pptx";
import BinaryStatus from "./BinaryStatus";
import PreviewFallback, { PreviewLoading } from "./PreviewFallback";
import { useBinaryFile } from "./useBinaryFile";

interface Props {
  path: string;
  /** 变化即重新加载（传文件的 mtime）。 */
  reloadKey: number | undefined;
}

type Model = { pres: Presentation; urls: Map<PptxElement, string> };

const PX = 96 / 72; // pt → px
const px = (pt: number) => pt * PX;
const PAD = 32; // 画布左右留白（px）
const JUSTIFY = { top: "flex-start", middle: "center", bottom: "flex-end" } as const;

function Paragraph({ p }: { p: PptxParagraph }) {
  return (
    <div style={{ textAlign: p.align, minHeight: "1em" }}>
      {p.runs.map((r, i) => {
        const style: CSSProperties = { fontSize: px(r.sizePt) };
        if (r.bold) style.fontWeight = "bold";
        if (r.italic) style.fontStyle = "italic";
        if (r.underline) style.textDecoration = "underline";
        if (r.color) style.color = r.color;
        return (
          <span key={i} style={style}>
            {r.text}
          </span>
        );
      })}
    </div>
  );
}

function Element({ el, url }: { el: PptxElement; url: string | undefined }) {
  const box: CSSProperties = { position: "absolute", left: px(el.x), top: px(el.y), width: px(el.w), height: px(el.h) };
  if (el.type === "picture") {
    return <img src={url} alt="" style={{ ...box, objectFit: "fill" }} draggable={false} />;
  }
  return (
    <div
      data-shape=""
      style={{
        ...box,
        backgroundColor: el.fill ?? undefined,
        overflow: "hidden",
        whiteSpace: "pre-wrap",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        justifyContent: JUSTIFY[el.anchor],
        padding: `${px(el.inset.t)}px ${px(el.inset.r)}px ${px(el.inset.b)}px ${px(el.inset.l)}px`,
      }}
    >
      {el.paragraphs.map((p, i) => (
        <Paragraph key={i} p={p} />
      ))}
    </div>
  );
}

export default function PptxViewer({ path, reloadKey }: Props) {
  const { t } = useTranslation();
  const state = useBinaryFile(path, reloadKey);
  const [model, setModel] = useState<Model | null>(null);
  const [failed, setFailed] = useState(false);
  const [width, setWidth] = useState(0);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // 就绪后解析；换数据 / 卸载时回收 Blob URL
  const data = state.status === "ready" ? state.data : null;
  useEffect(() => {
    setModel(null);
    setFailed(false);
    if (!data) return;
    let cancelled = false;
    const created: string[] = [];
    parsePptx(data).then(
      (pres) => {
        if (cancelled) return;
        const urls = new Map<PptxElement, string>();
        for (const s of pres.slides) {
          for (const el of s.elements) {
            if (el.type !== "picture") continue;
            const url = URL.createObjectURL(new window.Blob([el.data], { type: el.mime }));
            created.push(url);
            urls.set(el, url);
          }
        }
        setModel({ pres, urls });
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
      created.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [data]);

  // 跟随容器宽度缩放
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [model]);

  if (state.status !== "ready") return <BinaryStatus state={state} path={path} />;
  if (failed) return <PreviewFallback testId="preview-error" message={t("preview.invalid")} path={path} />;
  if (!model) return <PreviewLoading />;

  const { pres, urls } = model;
  const wPx = px(pres.width);
  const hPx = px(pres.height);
  const k = width > 0 && wPx > 0 ? Math.max(0.1, (width - PAD) / wPx) : 1;

  return (
    <div ref={boxRef} tabIndex={-1} className="absolute inset-0 overflow-auto outline-none" data-testid="pptx-viewer">
      <div className="flex flex-col items-center gap-4 p-4">
        {pres.slides.map((slide, i) => (
          <div key={i}>
            <div className="mb-1 text-xs text-[var(--c-text-dim)]" data-testid={`pptx-slide-label-${i}`}>
              {t("preview.slideLabel", { index: i + 1, total: pres.slides.length })}
            </div>
            <div style={{ width: wPx * k, height: hPx * k }} className="shadow-md">
              <div
                data-testid={`pptx-slide-${i}`}
                style={{
                  position: "relative",
                  width: wPx,
                  height: hPx,
                  overflow: "hidden",
                  color: "#000000",
                  backgroundColor: slide.background,
                  transform: `scale(${k})`,
                  transformOrigin: "top left",
                }}
              >
                {slide.elements.map((el, j) => (
                  <Element key={j} el={el} url={urls.get(el)} />
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
