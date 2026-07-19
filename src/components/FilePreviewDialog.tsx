import {
  isValidElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { remarkStripComments } from "../lib/remark-strip-comments";
import { MarkdownLink } from "./MarkdownLink";

import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import xml from "highlight.js/lib/languages/xml"; // html
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import lua from "highlight.js/lib/languages/lua";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import toml from "highlight.js/lib/languages/ini"; // ini 适合 toml
import yaml from "highlight.js/lib/languages/yaml";
// v1.1.0 F7 hljs 主题跟随修复：不再静态导入 highlight.js/styles/github-dark.css
// （硬编码深底，light 模式刺眼且不跟随）。改用 src/index.css 里 token 化的
// .hljs-* class 映射（--c-syntax-* 走 data-theme 自动切换），dark/light 都对，
// 且跟 rehype-highlight（下方 MarkdownView）共用同一套样式，无需维护两份。

import {
  fsReadPreview,
  shellOpen,
  type DialogRect,
  type PreviewResult,
} from "../lib/tauri";
import { useBrowserModalGuard } from "../lib/useBrowserModalGuard";
import { usePreviewStore } from "../stores/preview";
import { useSettingsStore } from "../stores/settings";

// 一次性注册所有支持的语言（hljs 用 alias 解析）
const REGISTERED = new Set<string>();
function registerLanguages() {
  if (REGISTERED.size > 0) return;
  hljs.registerLanguage("bash", bash);
  hljs.registerLanguage("c", c);
  hljs.registerLanguage("cpp", cpp);
  hljs.registerLanguage("css", css);
  hljs.registerLanguage("dockerfile", dockerfile);
  hljs.registerLanguage("go", go);
  hljs.registerLanguage("html", xml);
  hljs.registerLanguage("java", java);
  hljs.registerLanguage("javascript", javascript);
  hljs.registerLanguage("json", json);
  hljs.registerLanguage("kotlin", kotlin);
  hljs.registerLanguage("lua", lua);
  hljs.registerLanguage("python", python);
  hljs.registerLanguage("ruby", ruby);
  hljs.registerLanguage("rust", rust);
  hljs.registerLanguage("sql", sql);
  hljs.registerLanguage("swift", swift);
  hljs.registerLanguage("toml", toml);
  hljs.registerLanguage("typescript", typescript);
  hljs.registerLanguage("yaml", yaml);
  ["bash", "rust", "typescript"].forEach((l) => REGISTERED.add(l));
}

// ===== v0.6.0-A T4：浮动可拖可缩放 FilePreviewDialog =====
//
// 设计要点（参 plan §2.5 + §4）：
// - 不再用 Radix Dialog 居中；用 React Portal + position:fixed 自管 rect。
// - 8 个 resize handle（4 边 + 4 角），最小 400×300、最大屏幕 90%。
// - 标题栏拖动（mousedown）+ 双击 toggle maximize（max 占屏 90% 居中）。
// - rect 持久化到 settings.ui.file_preview_dialog（mouseup 时 commit）。
// - 首次打开 / off-screen detect → 居中默认 800×600。
// - rAF 节流拖动 / resize 期间的 rect 计算，避免每帧 zustand 写。
// - maximize 状态不持久化（仅当前会话内 toggle）。

/** 浮动窗口的最小尺寸（plan §1 #6）。 */
const MIN_W = 400;
const MIN_H = 300;
/** 浮动窗口的最大相对比例（屏幕 90%）。 */
const MAX_RATIO = 0.9;
/** 首次打开的默认尺寸。 */
const DEFAULT_W = 800;
const DEFAULT_H = 600;
/** 标题栏高度（plan §2.5）。 */
const TITLE_BAR_H = 32;

/** 8 方向 resize handle 标识。 */
type ResizeDir = "t" | "b" | "l" | "r" | "tl" | "tr" | "bl" | "br";

/** 计算居中默认 rect（基于 window viewport，按默认 800×600，受 90% 上限约束）。 */
function centerDefaultRect(): DialogRect {
  const maxW = window.innerWidth * MAX_RATIO;
  const maxH = window.innerHeight * MAX_RATIO;
  const w = Math.min(DEFAULT_W, maxW);
  const h = Math.min(DEFAULT_H, maxH);
  const x = Math.max(0, (window.innerWidth - w) / 2);
  const y = Math.max(0, (window.innerHeight - h) / 2);
  return { x, y, w, h };
}

/** 判定持久化 rect 是否还在当前 viewport 内（多 monitor 拔显示器场景） */
function isRectOnScreen(r: DialogRect): boolean {
  return (
    r.x >= 0 &&
    r.y >= 0 &&
    r.x + r.w <= window.innerWidth &&
    r.y + r.h <= window.innerHeight &&
    r.w >= MIN_W &&
    r.h >= MIN_H
  );
}

/** 算 maximize 占屏 90% 的 rect（居中）。 */
function maximizedRect(): DialogRect {
  const w = window.innerWidth * MAX_RATIO;
  const h = window.innerHeight * MAX_RATIO;
  const x = (window.innerWidth - w) / 2;
  const y = (window.innerHeight - h) / 2;
  return { x, y, w, h };
}

/**
 * v0.5.0-C T2：通用文件预览 Dialog（替换 v0.3.0 MarkdownPreviewDialog）。
 * v0.6.0-A T4：改造为浮动可拖可缩放窗口。
 *
 * 按后端 fs_read_preview 返的 kind 分流渲染：
 * - markdown → react-markdown + remark-gfm
 * - code → highlight.js + GitHub Dark
 * - text → 纯 `<pre>`
 * - image → `<img src="data:...">`
 * - binary / too_large → UnsupportedFallback 显示"用默认应用打开"按钮
 *
 * 行为：
 * - 首次打开 → 居中 800×600；之后 mouseup 后持久化 rect 到 settings TOML。
 * - 标题栏拖动 + 4 边 4 角 resize；双击标题栏 toggle maximize（不持久化 max 状态）。
 * - off-screen detect → 重置居中（拔显示器场景）。
 */
export default function FilePreviewDialog() {
  const previewPath = usePreviewStore((s) => s.previewPath);
  const setPreviewPath = usePreviewStore((s) => s.setPreviewPath);
  const persistedRect = useSettingsStore(
    (s) => s.settings.ui.file_preview_dialog,
  );
  const updateSettings = useSettingsStore((s) => s.update);

  const [result, setResult] = useState<PreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const open = !!previewPath;

  useBrowserModalGuard(open);

  // 加载预览内容
  useEffect(() => {
    if (!previewPath) {
      setResult(null);
      setError(null);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    setResult(null);
    fsReadPreview(previewPath)
      .then((r) => {
        if (alive) {
          setResult(r);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (alive) {
          setError(String(e));
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [previewPath]);

  if (!open) return null;
  return (
    <FloatingPreview
      previewPath={previewPath ?? ""}
      persistedRect={persistedRect}
      onCommitRect={(rect) =>
        updateSettings({ ui: { file_preview_dialog: rect } })
      }
      onClose={() => setPreviewPath(null)}
      result={result}
      error={error}
      loading={loading}
    />
  );
}

interface FloatingPreviewProps {
  previewPath: string;
  persistedRect: DialogRect | null;
  onCommitRect: (rect: DialogRect) => void;
  onClose: () => void;
  result: PreviewResult | null;
  error: string | null;
  loading: boolean;
}

function FloatingPreview({
  previewPath,
  persistedRect,
  onCommitRect,
  onClose,
  result,
  error,
  loading,
}: FloatingPreviewProps) {
  const { t } = useTranslation();
  const basename = useMemo(
    () => previewPath.split("/").pop() ?? "",
    [previewPath],
  );

  // 初始 rect：persisted 有效则用 persisted；否则 / off-screen → 居中默认
  const initialRect = useMemo<DialogRect>(() => {
    if (persistedRect && isRectOnScreen(persistedRect)) {
      return persistedRect;
    }
    return centerDefaultRect();
    // 仅在 mount 时计算一次；后续 rect 由 local state 管。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [rect, setRect] = useState<DialogRect>(initialRect);
  const [isMaximized, setIsMaximized] = useState(false);
  const [maxRect, setMaxRect] = useState<DialogRect>(() => maximizedRect());

  // maximize 前的 normal rect（用于还原）；不持久化到 settings
  const preMaximizeRectRef = useRef<DialogRect>(initialRect);
  // 拖动/resize 期间最新 rect（rAF 节流时 ref 直接更新；commit 时拿最终值）
  const latestRectRef = useRef<DialogRect>(initialRect);
  // 当前操作类型（drag / resize+方向 / null）
  const opRef = useRef<{ kind: "drag" } | { kind: "resize"; dir: ResizeDir } | null>(
    null,
  );
  // 操作起点：鼠标坐标 + 起始 rect
  const startRef = useRef<{ x: number; y: number; rect: DialogRect }>({
    x: 0,
    y: 0,
    rect: initialRect,
  });
  // rAF 节流
  const rafScheduledRef = useRef(false);
  const pendingEventRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  // window resize 时同步 maximize rect（max 状态跟随屏幕尺寸）
  useEffect(() => {
    const handler = () => {
      setMaxRect(maximizedRect());
    };
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);

  // v0.6.0：dialog 容器 ref，用于外点关闭检测 + ESC 关闭
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handleDocMouseDown = (e: globalThis.MouseEvent) => {
      // dialog 内部 mousedown 不关闭
      const t = e.target as globalThis.Node | null;
      if (!t || !dialogRef.current) return;
      if (dialogRef.current.contains(t)) return;
      // 正在拖动/resize → 不关闭（mousemove 跑出 dialog 边界也算"内部操作"）
      if (opRef.current) return;
      onClose();
    };
    const handleKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handleDocMouseDown);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleDocMouseDown);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  // 实际渲染用的 rect：maximize 时取 maxRect，否则 local rect
  const renderRect = isMaximized ? maxRect : rect;

  /** 把 raw rect clamp 到 [min, max-90%-viewport] 范围。 */
  const clampRect = useCallback((r: DialogRect): DialogRect => {
    const maxW = Math.max(MIN_W, window.innerWidth * MAX_RATIO);
    const maxH = Math.max(MIN_H, window.innerHeight * MAX_RATIO);
    const w = Math.min(maxW, Math.max(MIN_W, r.w));
    const h = Math.min(maxH, Math.max(MIN_H, r.h));
    const maxX = Math.max(0, window.innerWidth - w);
    const maxY = Math.max(0, window.innerHeight - h);
    const x = Math.min(maxX, Math.max(0, r.x));
    const y = Math.min(maxY, Math.max(0, r.y));
    return { x, y, w, h };
  }, []);

  /** 根据起点 + 当前鼠标位置 + 操作类型计算新 rect。 */
  const computeNextRect = useCallback(
    (clientX: number, clientY: number): DialogRect => {
      const op = opRef.current;
      if (!op) return latestRectRef.current;
      const dx = clientX - startRef.current.x;
      const dy = clientY - startRef.current.y;
      const s = startRef.current.rect;
      if (op.kind === "drag") {
        return clampRect({ x: s.x + dx, y: s.y + dy, w: s.w, h: s.h });
      }
      // resize：每个方向影响的维度不同
      let nx = s.x;
      let ny = s.y;
      let nw = s.w;
      let nh = s.h;
      const dir = op.dir;
      if (dir === "l" || dir === "tl" || dir === "bl") {
        nx = s.x + dx;
        nw = s.w - dx;
      }
      if (dir === "r" || dir === "tr" || dir === "br") {
        nw = s.w + dx;
      }
      if (dir === "t" || dir === "tl" || dir === "tr") {
        ny = s.y + dy;
        nh = s.h - dy;
      }
      if (dir === "b" || dir === "bl" || dir === "br") {
        nh = s.h + dy;
      }
      // 防止 left/top 边在 hit min 后继续吃进 x/y：先 clamp 尺寸
      const maxW = Math.max(MIN_W, window.innerWidth * MAX_RATIO);
      const maxH = Math.max(MIN_H, window.innerHeight * MAX_RATIO);
      const clampedW = Math.min(maxW, Math.max(MIN_W, nw));
      const clampedH = Math.min(maxH, Math.max(MIN_H, nh));
      if (dir === "l" || dir === "tl" || dir === "bl") {
        // left 边拖动时 x 跟随宽度变化；保持右边界（s.x + s.w）不变
        nx = s.x + s.w - clampedW;
      }
      if (dir === "t" || dir === "tl" || dir === "tr") {
        ny = s.y + s.h - clampedH;
      }
      return clampRect({ x: nx, y: ny, w: clampedW, h: clampedH });
    },
    [clampRect],
  );

  // mouse 事件挂在 document（拖动 / resize 跟随全屏）
  useEffect(() => {
    if (!opRef.current && !rafScheduledRef.current) {
      // 没在操作 → 不挂监听
    }
    const flush = () => {
      rafScheduledRef.current = false;
      const next = computeNextRect(
        pendingEventRef.current.x,
        pendingEventRef.current.y,
      );
      latestRectRef.current = next;
      // v0.6.0：max 状态下 drag 改 maxRect（保持 size 跟随鼠标移动）；
      // 非 max 状态改 rect。维护者 真机：max 拖标题栏退 max 反直觉，应该保持 max
      if (isMaximized) {
        setMaxRect(next);
      } else {
        setRect(next);
      }
    };
    const handleMove = (e: MouseEvent) => {
      if (!opRef.current) return;
      pendingEventRef.current = { x: e.clientX, y: e.clientY };
      if (rafScheduledRef.current) return;
      rafScheduledRef.current = true;
      requestAnimationFrame(flush);
    };
    const handleUp = () => {
      if (!opRef.current) return;
      // flush 最后一帧
      if (rafScheduledRef.current) {
        rafScheduledRef.current = false;
        const next = computeNextRect(
          pendingEventRef.current.x,
          pendingEventRef.current.y,
        );
        latestRectRef.current = next;
        if (isMaximized) {
          setMaxRect(next);
        } else {
          setRect(next);
        }
      }
      opRef.current = null;
      // 只在非 maximize 状态 commit（maximize 状态的 rect 不入持久化）
      if (!isMaximized) {
        onCommitRect(latestRectRef.current);
      }
    };
    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
    return () => {
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
    };
  }, [computeNextRect, isMaximized, onCommitRect]);

  /** 标题栏 mousedown → 进入 dragging（除非点击的是关闭按钮）。
   *  v0.6.0：max 状态下也允许 drag —— 保持 max size 仅改位置（维护者 真机反馈
   *  "max 拖标题栏退回原状了反直觉，max 状态也要能拖"）。*/
  const handleTitleMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      // 关闭按钮 / 标题栏内交互元素不触发拖动
      const target = e.target as HTMLElement;
      if (target.closest("[data-no-drag]")) return;
      e.preventDefault();
      const startRect = isMaximized ? maxRect : rect;
      opRef.current = { kind: "drag" };
      startRef.current = {
        x: e.clientX,
        y: e.clientY,
        rect: startRect,
      };
      latestRectRef.current = startRect;
    },
    [rect, isMaximized, maxRect],
  );

  /** 双击标题栏 → toggle maximize。 */
  const handleTitleDoubleClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      // 关闭按钮上的双击不触发 maximize
      const target = e.target as HTMLElement;
      if (target.closest("[data-no-drag]")) return;
      if (!isMaximized) {
        preMaximizeRectRef.current = rect;
        setIsMaximized(true);
      } else {
        setIsMaximized(false);
        setRect(preMaximizeRectRef.current);
        latestRectRef.current = preMaximizeRectRef.current;
      }
    },
    [rect, isMaximized],
  );

  /** resize handle mousedown → 进入对应方向 resize。 */
  const handleResizeMouseDown = useCallback(
    (dir: ResizeDir, e: ReactMouseEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      if (isMaximized) return; // max 状态下不允许 resize
      e.preventDefault();
      e.stopPropagation();
      opRef.current = { kind: "resize", dir };
      startRef.current = {
        x: e.clientX,
        y: e.clientY,
        rect: rect,
      };
      latestRectRef.current = rect;
    },
    [rect, isMaximized],
  );

  const dialogStyle: CSSProperties = {
    position: "fixed",
    left: `${renderRect.x}px`,
    top: `${renderRect.y}px`,
    width: `${renderRect.w}px`,
    height: `${renderRect.h}px`,
    zIndex: 50,
  };

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="false"
      aria-label={t("filePreviewDialog.dialogAria", { name: basename })}
      data-testid="file-preview-dialog"
      style={dialogStyle}
      className="flex flex-col rounded-lg border border-[var(--c-border-strong)] bg-[var(--c-bg-elev-1)] text-[var(--c-text-base)] shadow-2xl"
    >
      {/* 标题栏（32px 高） */}
      <div
        data-testid="file-preview-title-bar"
        onMouseDown={handleTitleMouseDown}
        onDoubleClick={handleTitleDoubleClick}
        style={{ height: `${TITLE_BAR_H}px`, cursor: "move" }}
        className="flex items-center justify-between border-b border-[var(--c-border)] px-3 select-none"
      >
        <span className="truncate text-sm font-mono text-[var(--c-text-muted)]">
          {basename}
        </span>
        <button
          type="button"
          data-no-drag
          data-testid="file-preview-close"
          onClick={onClose}
          aria-label={t("filePreviewDialog.closeAria")}
          className="rounded p-1 leading-none text-[var(--c-text-dim)] hover:bg-[var(--c-bg-elev-2)] hover:text-[var(--c-text-base)]"
        >
          ×
        </button>
      </div>

      {/* 内容区 */}
      <div className="sr-only" id="file-preview-desc">
        {t("filePreviewDialog.descLabel", { name: basename })}
      </div>
      <main className="flex-1 overflow-auto">
        {loading && (
          <div className="py-12 text-center text-sm text-[var(--c-text-dim)]">
            {t("filePreviewDialog.loading")}
          </div>
        )}
        {error && (
          <div
            role="alert"
            className="m-4 rounded border border-[var(--c-error)] bg-[var(--c-bg-elev-2)] px-3 py-2 text-sm text-[var(--c-error)]"
          >
            {t("filePreviewDialog.readError", { error })}
          </div>
        )}
        {!loading && !error && result && (
          <PreviewBody result={result} path={previewPath} />
        )}
      </main>

      {/* 8 个 resize handle（maximize 状态下隐藏） */}
      {!isMaximized && (
        <>
          {/* 4 边 */}
          <ResizeHandle dir="t" onMouseDown={handleResizeMouseDown} />
          <ResizeHandle dir="b" onMouseDown={handleResizeMouseDown} />
          <ResizeHandle dir="l" onMouseDown={handleResizeMouseDown} />
          <ResizeHandle dir="r" onMouseDown={handleResizeMouseDown} />
          {/* 4 角 */}
          <ResizeHandle dir="tl" onMouseDown={handleResizeMouseDown} />
          <ResizeHandle dir="tr" onMouseDown={handleResizeMouseDown} />
          <ResizeHandle dir="bl" onMouseDown={handleResizeMouseDown} />
          <ResizeHandle dir="br" onMouseDown={handleResizeMouseDown} />
        </>
      )}
    </div>,
    document.body,
  );
}

interface ResizeHandleProps {
  dir: ResizeDir;
  onMouseDown: (dir: ResizeDir, e: ReactMouseEvent<HTMLDivElement>) => void;
}

/** 单个 resize handle；按 dir 决定位置 + cursor。 */
function ResizeHandle({ dir, onMouseDown }: ResizeHandleProps) {
  // 各方向位置 + cursor + 尺寸（4 边全长 4px；4 角 8×8）
  const cursorMap: Record<ResizeDir, string> = {
    t: "n-resize",
    b: "s-resize",
    l: "w-resize",
    r: "e-resize",
    tl: "nw-resize",
    tr: "ne-resize",
    bl: "sw-resize",
    br: "se-resize",
  };
  const styleMap: Record<ResizeDir, CSSProperties> = {
    t: { top: -2, left: 0, right: 0, height: 4 },
    b: { bottom: -2, left: 0, right: 0, height: 4 },
    l: { left: -2, top: 0, bottom: 0, width: 4 },
    r: { right: -2, top: 0, bottom: 0, width: 4 },
    tl: { top: -2, left: -2, width: 8, height: 8 },
    tr: { top: -2, right: -2, width: 8, height: 8 },
    bl: { bottom: -2, left: -2, width: 8, height: 8 },
    br: { bottom: -2, right: -2, width: 8, height: 8 },
  };

  return (
    <div
      data-testid={`file-preview-resize-${dir}`}
      role="presentation"
      onMouseDown={(e) => onMouseDown(dir, e)}
      style={{
        position: "absolute",
        cursor: cursorMap[dir],
        ...styleMap[dir],
        zIndex: 1,
      }}
      className="hover:bg-[var(--c-bg-elev-3)]/30"
    />
  );
}

interface BodyProps {
  result: PreviewResult;
  path: string;
}

function PreviewBody({ result, path }: BodyProps) {
  const { t } = useTranslation();
  switch (result.kind) {
    case "markdown":
      return <MarkdownView content={result.content} truncated={result.truncated} />;
    case "code":
      return (
        <CodeView
          content={result.content}
          language={result.language}
          truncated={result.truncated}
        />
      );
    case "text":
      return <TextView content={result.content} truncated={result.truncated} />;
    case "image":
      return <ImageView mime={result.mime} base64={result.base64} />;
    case "binary":
      return <UnsupportedFallback path={path} reason={result.reason} />;
    case "too_large":
      return (
        <UnsupportedFallback
          path={path}
          reason={t("filePreviewDialog.tooLargeReason", {
            size: (result.size / 1024 / 1024).toFixed(1),
            max: (result.max_size / 1024 / 1024).toFixed(0),
          })}
        />
      );
  }
}

/** 递归从 react-markdown/rehype 渲染出的 children 节点树里提取纯文本。
 * rehype-highlight 把高亮 token 包成嵌套 <span>，不能直接 String(children)。
 * （与 FileEditorPane.tsx 的同名 helper 逻辑一致，各文件独立一份避免跨文件耦合。） */
function getNodeText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(getNodeText).join("");
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode };
    return getNodeText(props.children);
  }
  return "";
}

function langFromClassName(cls?: string): string | undefined {
  return /language-(\S+)/.exec(cls ?? "")?.[1];
}

/** md 代码块容器：语言标签（CSS ::before 读 data-lang）+ 复制按钮。
 * 高亮本身由 rehype-highlight 注入的 hljs-* class 渲染（见 index.css）。 */
function MdPre({ children, className, ...rest }: ComponentProps<"pre">) {
  const { t } = useTranslation();
  const codeClassName = isValidElement(children)
    ? (children.props as { className?: string }).className
    : undefined;
  const lang = langFromClassName(codeClassName);
  const raw = getNodeText(children);
  return (
    <pre {...rest} className={`group ${className ?? ""}`} data-lang={lang}>
      <button
        type="button"
        onClick={() => {
          navigator.clipboard.writeText(raw).catch(() => {});
        }}
        className="absolute right-2 top-1.5 rounded bg-[var(--c-bg-elev-3)] px-1.5 py-0.5 text-[10px] text-[var(--c-text-muted)] opacity-0 hover:text-[var(--c-text-base)] group-hover:opacity-100"
        aria-label={t("messageBubble.copyCodeAria")}
      >
        {t("messageBubble.copyCode")}
      </button>
      {children}
    </pre>
  );
}

function MarkdownView({ content, truncated }: { content: string; truncated: boolean }) {
  // v0.6.0：去掉 max-w-[800px] 让内容跟随 dialog 宽度撑满。维护者 真机：max
  // 状态 dialog ~1800px 但内容仍卡在 800px 居中显得空旷，max 失去意义
  return (
    <article className="prose-md px-6 py-4">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkStripComments]}
        rehypePlugins={[rehypeHighlight]}
        components={{ pre: MdPre, a: MarkdownLink }}
      >
        {content}
      </ReactMarkdown>
      {truncated && <TruncatedNotice />}
    </article>
  );
}

function CodeView({
  content,
  language,
  truncated,
}: {
  content: string;
  language: string;
  truncated: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    registerLanguages();
    if (ref.current) {
      // hljs.highlightElement 会在已 highlight 元素上跑会 warn，每次清掉 attribute
      ref.current.removeAttribute("data-highlighted");
      hljs.highlightElement(ref.current);
    }
  }, [content, language]);

  return (
    <div className="px-4 py-4">
      <pre className="overflow-auto rounded bg-[var(--c-bg-base)] p-4 text-xs leading-relaxed">
        <code ref={ref} className={`language-${language}`}>
          {content}
        </code>
      </pre>
      {truncated && <TruncatedNotice />}
    </div>
  );
}

function TextView({ content, truncated }: { content: string; truncated: boolean }) {
  return (
    <div className="px-4 py-4">
      <pre className="overflow-auto rounded bg-[var(--c-bg-base)] p-4 text-xs leading-relaxed text-[var(--c-text-base)] whitespace-pre-wrap break-words">
        {content}
      </pre>
      {truncated && <TruncatedNotice />}
    </div>
  );
}

function ImageView({ mime, base64 }: { mime: string; base64: string }) {
  return (
    <div className="flex h-full items-center justify-center p-4">
      <img
        src={`data:${mime};base64,${base64}`}
        alt=""
        className="max-h-full max-w-full object-contain"
        data-testid="preview-image"
      />
    </div>
  );
}

function UnsupportedFallback({ path, reason }: { path: string; reason: string }) {
  const { t } = useTranslation();
  const basename = path.split("/").pop() ?? "";
  const setPreviewPath = usePreviewStore((s) => s.setPreviewPath);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  const handleOpen = async () => {
    setOpening(true);
    setOpenError(null);
    try {
      await shellOpen(path);
      // 打开成功 → 关 Dialog（用户已切到外部 app）
      setPreviewPath(null);
    } catch (e) {
      setOpenError(String(e));
    } finally {
      setOpening(false);
    }
  };

  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-4 px-6 py-12 text-center"
      data-testid="preview-unsupported"
    >
      <p className="text-sm text-[var(--c-text-muted)]">
        <span className="font-mono text-[var(--c-text-base)]">{basename}</span>{" "}
        {t("filePreviewDialog.unsupportedPrefix")}
      </p>
      <p className="text-xs text-[var(--c-text-dim)]">
        {t("filePreviewDialog.reasonLabel", { reason })}
      </p>
      <button
        onClick={handleOpen}
        disabled={opening}
        className="rounded border border-[var(--c-success)] bg-[var(--c-success-bg)] px-4 py-1.5 text-sm text-[var(--c-success-fg)] hover:opacity-90 disabled:opacity-50"
        data-testid="preview-open-default-app"
      >
        {opening
          ? t("filePreviewDialog.opening")
          : t("filePreviewDialog.openWithDefault")}
      </button>
      {openError && (
        <p role="alert" className="text-xs text-[var(--c-error)]">
          {t("filePreviewDialog.openFailed", { error: openError })}
        </p>
      )}
    </div>
  );
}

function TruncatedNotice() {
  const { t } = useTranslation();
  return (
    <p className="mt-4 text-center text-[10px] text-[var(--c-warn)]" role="status">
      {t("filePreviewDialog.truncated")}
    </p>
  );
}
