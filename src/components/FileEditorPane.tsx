/* =============================================================================
 * FileEditorPane.tsx —— v0.9.0 T5b 单文件编辑器容器 + T5c Cmd+S 保存 + T5e md 预览
 * -----------------------------------------------------------------------------
 * 渲染单个 OpenFile，挂 CodeMirrorViewer + 接 onChange / onCursorChange 写回 store。
 *
 * T5e 改造：
 *   - md / markdown / mdx 文件多渲染一条工具栏（"预览" / "原文" 两按钮）
 *   - mdMode === "preview"（默认）→ ReactMarkdown 渲染 + `.prose-md` 样式（跟
 *     FilePreviewDialog 内的 MarkdownView 保持视觉一致）
 *   - mdMode === "raw" → 走 CodeMirrorViewer + md 语言扩展，可编辑
 *   - 切换不丢 content：file.content 是 source of truth，preview / raw 只换
 *     view，dirty 状态 / 光标位置全部保留在 store
 *
 * T5c：Cmd+S / Ctrl+S 全局 keydown 监听 → 调 store.saveFile。
 *   - 只在焦点落在本 pane 内时才响应（paneRef.current.contains(activeElement)）
 *   - 失败 console.error 透传，不弹 modal（避免和 CloseFileConfirmDialog 路径打架）
 *
 * 注意：CodeMirrorViewer mount 时按 key={path} 重建（而非 useEffect 内 reconfigure），
 * 切 tab 时 React 自动 unmount 旧 view + mount 新 view，避免跨文件 state 混。
 * ========================================================================== */

import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import CodeMirrorViewer from "./CodeMirrorViewer";
import { useFileEditorStore, type OpenFile } from "../stores/file-editor";

interface Props {
  file: OpenFile;
}

export default function FileEditorPane({ file }: Props) {
  const { t } = useTranslation();
  const updateContent = useFileEditorStore((s) => s.updateContent);
  const setCursor = useFileEditorStore((s) => s.setCursor);
  const setMdMode = useFileEditorStore((s) => s.setMdMode);
  const paneRef = useRef<HTMLDivElement | null>(null);

  const onChange = useCallback(
    (content: string) => {
      updateContent(file.id, content);
    },
    [file.id, updateContent],
  );

  const onCursorChange = useCallback(
    (line: number, col: number) => {
      setCursor(file.id, line, col);
    },
    [file.id, setCursor],
  );

  // T5c：Cmd+S（macOS）/ Ctrl+S（Win/Linux）保存当前文件。
  // 焦点必须落在本 pane 内才响应，否则会抢全局快捷键，跨 pane 误触。
  //
  // H1 hotfix（v0.9.0 真机回归）：早期实现把 listener 挂在 window 上，
  // 在 WKWebView 上会扰动 xterm.js issue #5374 workaround 的事件时序
  // （详见 FilePreviewWorkspace.tsx 同段注释 + xtermTextarea.ts）。
  // 改挂在 pane 元素上：终端 keydown 根本不会传到这里，xterm 路径零污染。
  useEffect(() => {
    const root = paneRef.current;
    if (!root) return;
    const handler = (e: KeyboardEvent) => {
      const isMacCombo = e.metaKey && !e.ctrlKey;
      const isWinCombo = e.ctrlKey && !e.metaKey;
      if (!(isMacCombo || isWinCombo)) return;
      if (e.key !== "s" && e.key !== "S") return;

      const active = document.activeElement;
      // 焦点不在本 pane 内 → 不处理（让其他 pane 或浏览器原生行为接管）
      if (!active || !root.contains(active)) return;

      e.preventDefault();
      e.stopPropagation();
      void useFileEditorStore
        .getState()
        .saveFile(file.id)
        .catch((err: unknown) => {
          // 保存失败 → console.error；read-only / 权限受限场景的降级提示由后续
          // toast 系统接入；当前 v0.9.0 没全局 toast 组件，先 log 避开误导。
          console.error("[FileEditorPane] 保存失败：", err);
        });
    };
    root.addEventListener("keydown", handler);
    return () => root.removeEventListener("keydown", handler);
  }, [file.id]);

  const isMd =
    file.language === "md" ||
    file.language === "markdown" ||
    file.language === "mdx";
  const showPreview = isMd && file.mdMode === "preview";

  return (
    <div
      ref={paneRef}
      className="flex h-full w-full min-h-0 min-w-0 flex-col"
      data-testid={`file-editor-pane-${file.id}`}
    >
      {isMd && (
        <div
          className="flex items-center gap-1 px-2 py-1 border-b border-[var(--c-border)] bg-[var(--c-bg-elev-1)]"
          data-testid={`md-mode-toolbar-${file.id}`}
        >
          <button
            type="button"
            className={
              file.mdMode === "preview"
                ? "px-2 py-0.5 text-xs rounded bg-[var(--c-bg-elev-2)] text-[var(--c-text-base)]"
                : "px-2 py-0.5 text-xs rounded text-[var(--c-text-muted)] hover:bg-[var(--c-bg-elev-2)]"
            }
            onClick={() => setMdMode(file.id, "preview")}
            data-testid={`md-mode-preview-${file.id}`}
            aria-pressed={file.mdMode === "preview"}
          >
            {t("fileEditor.mdPreview")}
          </button>
          <button
            type="button"
            className={
              file.mdMode === "raw"
                ? "px-2 py-0.5 text-xs rounded bg-[var(--c-bg-elev-2)] text-[var(--c-text-base)]"
                : "px-2 py-0.5 text-xs rounded text-[var(--c-text-muted)] hover:bg-[var(--c-bg-elev-2)]"
            }
            onClick={() => setMdMode(file.id, "raw")}
            data-testid={`md-mode-raw-${file.id}`}
            aria-pressed={file.mdMode === "raw"}
          >
            {t("fileEditor.mdRaw")}
          </button>
        </div>
      )}
      <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
        {showPreview ? (
          <article
            className="prose-md h-full overflow-auto px-6 py-4"
            data-testid={`md-preview-${file.id}`}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {file.content}
            </ReactMarkdown>
          </article>
        ) : (
          <CodeMirrorViewer
            // key=path：切 tab 时强制重建 EditorView，避免跨文件 state 复用
            key={file.path}
            path={file.path}
            content={file.content}
            language={file.language}
            onChange={onChange}
            onCursorChange={onCursorChange}
          />
        )}
      </div>
    </div>
  );
}
