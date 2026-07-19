/* =============================================================================
 * CodeMirrorViewer.tsx —— v0.9.0 T5a 基础 viewer 组件
 * -----------------------------------------------------------------------------
 * 单文件 CodeMirror 6 容器。负责：
 *   - mount 时按 path / language 推断语言扩展（lazy import）
 *   - 创建 EditorView，挂在传入的 ref 容器
 *   - props 变更时通过 dispatch transaction 增量更新（不重建 view）
 *   - unmount 时调 view.destroy() 防内存泄漏
 *   - 触发 onChange / onCursorChange 回调（父层 zustand store 维护 dirty）
 *
 * 不在本 task 范围（留给 T5b/T5c/T5d）：
 *   - 文件树点击 → openFile（T5b file-editor store）
 *   - Cmd+S 保存 IPC（T5c）
 *   - 行号显示到 StatusBar（T5d）
 *
 * CodeMirror 6 协议层踩坑（plan §6.2）：
 *   1. 不传 basicSetup 啥都没（无行号、无快捷键、无高亮）
 *   2. updateListener 内 onChange 不要触发 setState 循环；父层 zustand 异步
 *      更新本组件 content prop，由 effect 比对 doc 后才 dispatch，无循环
 *   3. 更新内容用 dispatch transaction（changes），不要重建 EditorState
 *   4. lang-* import 必须 await（dynamic import 返回 promise）
 *   5. view.destroy() 是 sync，可以直接在 effect cleanup 调
 *
 * v1.1.0 F3（编辑器侧聚焦）：forwardRef 暴露 `focus()`，供
 * FilePreviewWorkspace 在 activeId 切换 / tab 激活时调用 `view.focus()`，
 * 跟终端侧的自动聚焦对称（详见 TerminalView.tsx 的 isActive effect）。
 * ========================================================================== */

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { EditorState, Compartment } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { basicSetup } from "codemirror";

import { customTheme, vscodeSyntaxHighlighting } from "../lib/cm-theme";
import { extFromPath, inferLanguageExtension } from "../lib/cm-lang";

export interface CodeMirrorViewerProps {
  /** 文件路径；用于扩展名推断语言 + key 比对 */
  path: string;
  /** 初始内容；父层 store 是唯一 source of truth，本组件不内部维护 */
  content: string;
  /** 显式指定语言（覆盖 path 推断），如 "ts" / "markdown" */
  language?: string;
  /** 只读模式 */
  readOnly?: boolean;
  /** 内容变更回调（debounce 由父层处理） */
  onChange?: (content: string) => void;
  /** 光标 / 选区变更回调，line/col 从 1 开始 */
  onCursorChange?: (line: number, col: number) => void;
  /** className 透传给容器 div */
  className?: string;
}

/** v1.1.0 F3：通过 ref 暴露给父层的聚焦能力。 */
export interface CodeMirrorViewerHandle {
  /** 把键盘焦点交给内部 EditorView（对应 xterm 侧的 term.focus()）。 */
  focus: () => void;
}

/**
 * CodeMirror 6 viewer / editor 组件。
 *
 * Compartment 用于"可重配置"的扩展槽位：
 *   - languageCompartment：path 变时换语言 extension
 *   - readOnlyCompartment：readOnly prop 变时切换
 * 不用 Compartment 就只能重建整个 EditorState，会丢光标位置 / 滚动。
 */
export const CodeMirrorViewer = forwardRef<
  CodeMirrorViewerHandle,
  CodeMirrorViewerProps
>(function CodeMirrorViewer(
  { path, content, language, readOnly, onChange, onCursorChange, className },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langCompartmentRef = useRef<Compartment>(new Compartment());
  const readOnlyCompartmentRef = useRef<Compartment>(new Compartment());

  /** onChange / onCursorChange 用 ref 持，避免 effect 重建 */
  const onChangeRef = useRef(onChange);
  const onCursorChangeRef = useRef(onCursorChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  useEffect(() => {
    onCursorChangeRef.current = onCursorChange;
  }, [onCursorChange]);

  // v1.1.0 F3：把内部 EditorView 的 focus() 暴露给父层（FilePreviewWorkspace）。
  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        viewRef.current?.focus();
      },
    }),
    [],
  );

  // ---------- mount / unmount：只跑一次 ----------
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const langCompartment = langCompartmentRef.current;
    const readOnlyCompartment = readOnlyCompartmentRef.current;

    const updateListener = EditorView.updateListener.of((u) => {
      if (u.docChanged) {
        onChangeRef.current?.(u.state.doc.toString());
      }
      if (u.selectionSet || u.docChanged) {
        const head = u.state.selection.main.head;
        const line = u.state.doc.lineAt(head);
        const col = head - line.from + 1;
        onCursorChangeRef.current?.(line.number, col);
      }
    });

    const state = EditorState.create({
      doc: content,
      extensions: [
        basicSetup,
        langCompartment.of([]), // 语言 extension 异步装载后 reconfigure
        readOnlyCompartment.of(EditorState.readOnly.of(readOnly ?? false)),
        customTheme,
        // HR3-2：放在 customTheme 之后，syntax 颜色优先级高于内置 fallback
        vscodeSyntaxHighlighting,
        updateListener,
      ],
    });

    const view = new EditorView({ state, parent: host });
    viewRef.current = view;

    // 异步装载语言 extension（不阻塞 mount）
    const extKey = language ?? extFromPath(path);
    let cancelled = false;
    void inferLanguageExtension(extKey).then((ext: Extension) => {
      if (cancelled || !viewRef.current) return;
      viewRef.current.dispatch({
        effects: langCompartment.reconfigure(ext),
      });
    });

    return () => {
      cancelled = true;
      view.destroy();
      viewRef.current = null;
    };
    // mount 只跑一次；后续 prop 变更走下面的 effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- content prop 变 → 同步 doc ----------
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === content) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
    });
  }, [content]);

  // ---------- readOnly prop 变 → reconfigure ----------
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readOnlyCompartmentRef.current.reconfigure(
        EditorState.readOnly.of(readOnly ?? false),
      ),
    });
  }, [readOnly]);

  // ---------- path / language 变 → 异步换语言 extension ----------
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const extKey = language ?? extFromPath(path);
    let cancelled = false;
    void inferLanguageExtension(extKey).then((ext: Extension) => {
      if (cancelled || !viewRef.current) return;
      viewRef.current.dispatch({
        effects: langCompartmentRef.current.reconfigure(ext),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [path, language]);

  return (
    <div
      ref={hostRef}
      data-testid="cm-viewer"
      data-path={path}
      className={className ?? "h-full w-full overflow-hidden"}
    />
  );
});

export default CodeMirrorViewer;
