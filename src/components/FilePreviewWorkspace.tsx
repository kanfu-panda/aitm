/* =============================================================================
 * FilePreviewWorkspace.tsx —— v0.9.0 T5b 文件预览 tab 容器顶层
 * -----------------------------------------------------------------------------
 * 多 tab 文件编辑器主容器（替代旧 FilePreviewDialog 浮动单文件模式）：
 *   - 顶部 FileTabBar
 *   - 底部 FileEditorPane（当前 active tab）
 *
 * 由 App.tsx 嵌入终端区上方的 PanelGroup 垂直分割（方案 A，参 plan §3 T5b）。
 * `openFiles.length === 0` 时不渲染（容器自动收回）。
 *
 * Cmd+W / Ctrl+W 关 active tab；dirty 状态触发 CloseFileConfirmDialog 三选项：
 *   - 保存并关闭 → store.saveFile（T5c 实现）→ 成功调 closeFile
 *     T5b 阶段 saveFile 占位 throw → catch 后降级走"丢弃"路径
 *   - 丢弃改动 → 直接 closeFile
 *   - 取消 → 保持 tab 开着
 *
 * 注意 Cmd+W 在 v0.4 已被 useShortcuts.closeTab 占用（关终端 tab），
 * 这里通过 capture phase + stopImmediatePropagation 抢先：
 *   - 焦点在编辑器容器（hover 或 focus）→ 关编辑器 tab
 *   - 焦点在终端 → 让 useShortcuts.closeTab 关终端 tab
 * 用 hasFocus pattern（document.activeElement contained in editor）判断。
 *
 * v1.1.0 F3（编辑器侧聚焦，US-3）：activeId 变化时（切 tab / 激活）调
 * FileEditorPane.focus() —— 跟终端侧 TerminalView 的 isActive→term.focus()
 * 对称，消除"切完还得再点一下才能输入"的手感断裂。
 * ========================================================================== */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useFileEditorStore } from "../stores/file-editor";
import { useFocusSurfaceStore } from "../stores/focus-surface";
import { fsReadText, fsStat } from "../lib/tauri";
import FileTabBar from "./FileTabBar";
import FileEditorPane, { type FileEditorPaneHandle } from "./FileEditorPane";
import CloseFileConfirmDialog from "./CloseFileConfirmDialog";

/** v0.10.3 #10：外部改动轮询间隔（ms）。3s 平衡及时性 + IPC 频率。 */
const EXTERNAL_CHANGE_POLL_MS = 3_000;
/** 跟 file-editor store openFile 的 max_bytes 保持一致。 */
const MAX_READ_BYTES = 1024 * 1024;

export default function FilePreviewWorkspace() {
  const { t } = useTranslation();
  const openFiles = useFileEditorStore((s) => s.openFiles);
  const activeId = useFileEditorStore((s) => s.activeId);
  const setActive = useFileEditorStore((s) => s.setActive);
  const closeFile = useFileEditorStore((s) => s.closeFile);
  const saveFile = useFileEditorStore((s) => s.saveFile);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const editorPaneRef = useRef<FileEditorPaneHandle | null>(null);

  /** dirty 关 tab 时弹窗确认的 pending path；null = 无 pending。 */
  const [pendingClose, setPendingClose] = useState<string | null>(null);

  const activeFile = openFiles.find((f) => f.id === activeId) ?? null;

  // v1.1.0 F3：切 tab / 激活 tab 后聚焦当前 FileEditorPane（终端侧对称实现见
  // TerminalView.tsx 的 isActive effect）。rAF 等一帧：activeId 变化常伴随
  // CodeMirrorViewer 因 key={file.path} 变化而重新 mount，需等新 view ready。
  useEffect(() => {
    if (!activeId) return;
    const raf = requestAnimationFrame(() => {
      editorPaneRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [activeId]);

  /** 关 tab：dirty → 弹弹窗；non-dirty → 直接 close。 */
  const requestClose = (id: string) => {
    const f = openFiles.find((x) => x.id === id);
    if (!f) return;
    if (f.dirty) {
      setPendingClose(id);
    } else {
      void closeFile(id);
      // v0.10.0 HR9-10：关 tab 后 close button unmount，焦点会 fall back 到 body
      // → 下次 Cmd+W 的 `document.activeElement.closest('[data-testid="file-
      //   preview-workspace"]')` 返回 null → 走终端路径 → 维护者 反馈"再 cmd+w 无响应"。
      // 修：focus root 容器（tabIndex=-1）让后续 Cmd+W 仍判定为 editor 焦点。
      // requestAnimationFrame 等 React 提交 DOM 后再 focus，避免被即将 unmount 的元素吃掉。
      requestAnimationFrame(() => {
        rootRef.current?.focus();
      });
    }
  };

  /**
   * v0.9.1 HR4-6 右键菜单：批量关闭辅助函数。
   *
   * 逐个走 requestClose（dirty 会逐个弹 CloseFileConfirmDialog；
   * 简化方案：不引"一次性全选保存/丢弃/取消"对话框降低风险）。
   * 注意：requestClose 是同步的（仅 setState 或 void closeFile），
   * 因此可在循环里直接调；store 自己处理批量 setState 合并。
   */
  const closeOthers = (id: string) => {
    const ids = openFiles.filter((f) => f.id !== id).map((f) => f.id);
    for (const x of ids) requestClose(x);
  };
  const closeRight = (id: string) => {
    const idx = openFiles.findIndex((f) => f.id === id);
    if (idx < 0) return;
    const ids = openFiles.slice(idx + 1).map((f) => f.id);
    for (const x of ids) requestClose(x);
  };
  const closeAll = () => {
    const ids = openFiles.map((f) => f.id);
    for (const x of ids) requestClose(x);
  };

  // Cmd+W / Ctrl+W：焦点在编辑器内时关编辑器 tab；
  // 终端焦点时由 useShortcuts.closeTab 关终端 tab。
  //
  // H1 hotfix（v0.9.0 真机回归）：早期实现把这个 listener 挂在
  // window + capture phase，本意是抢在 useShortcuts.closeTab 之前；
  // 但 capture-phase window listener 会让 WKWebView 的 keydown 派发路径
  // **绕一圈**先到 window，破坏 xterm.js issue #5374 workaround 依赖的
  // "Safari 上 onData 先于 customKeyEvent 触发" 时序——结果 Shift+ 标点
  // 时 customKeyEvent 反而早于 onData 拿到事件，`lastOnDataTime` 还是
  // 上一次的旧值，差值 > 50ms 误判为"被吞"，主动 sessionWrite 兜底 → 字符双发。
  //
  // 修法：listener 挂在自身 root 元素上（pane scoped），不污染全局 keydown
  // 路径。终端 / 浏览器面板等其他区域的 keydown 根本不会传到这个 listener，
  // 也就不会改变 xterm helper textarea 的事件时序。
  // 同时 Cmd+W 抢先 useShortcuts 的 window listener 仍然成立：DOM 事件
  // 先到 element listener，stopPropagation 阻止冒泡到 window。
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if (e.key.toLowerCase() !== "w") return;
      // 必须焦点确实在 root 内（点 tab close 按钮时焦点已在 root 内自然成立）。
      const active = document.activeElement;
      if (!active || !root.contains(active)) return;
      const id = useFileEditorStore.getState().activeId;
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      requestClose(id);
    };
    root.addEventListener("keydown", handler);
    return () => root.removeEventListener("keydown", handler);
    // requestClose 用 store getState 取，依赖故意空
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // v0.9.0 H6：App.useShortcuts.closeTab 通过 dispatchEvent 通知 workspace
  // 关 active 编辑器 tab（焦点不在 workspace 内时走这条路径）。
  // 之前真机：编辑文件后焦点离开 workspace 再按 Cmd+W → 走 useShortcuts 关
  // 终端 tab，关到最后一个就触发 Tauri close-window → T4 弹"确认退出"。
  useEffect(() => {
    const onRequest = () => {
      const id = useFileEditorStore.getState().activeId;
      if (id) requestClose(id);
    };
    window.addEventListener("aitm:request-close-editor-tab", onRequest);
    return () =>
      window.removeEventListener("aitm:request-close-editor-tab", onRequest);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // v0.10.3 #10：仅 poll active file 外部 mtime 变化，避免 N 文件 N IPC。
  //   mtime 一致 → noop
  //   mtime 变 + buffer dirty → markStale，banner 让用户选
  //   mtime 变 + 非 dirty → 静默 fsReadText → reloadFromDisk
  // poll 间隔 3s；切到 tab 时立即查一次（不用等 3s）。
  const activePath = activeFile?.path ?? null;
  const activeBaseline = activeFile?.lastMtimeMs ?? null;
  const activeDirty = activeFile?.dirty ?? false;
  useEffect(() => {
    if (!activePath || activeBaseline == null) return;
    let cancelled = false;
    const check = async () => {
      const meta = await fsStat(activePath).catch(() => null);
      if (cancelled || !meta || !meta.exists) return;
      if (meta.mtime_ms === activeBaseline) return;
      // 外部改动了
      const store = useFileEditorStore.getState();
      const fresh = store.openFiles.find((f) => f.path === activePath);
      if (!fresh) return; // tab 已关
      if (fresh.dirty) {
        store.markStale(fresh.id, meta.mtime_ms);
      } else {
        const content = await fsReadText(activePath, MAX_READ_BYTES).catch(
          () => null,
        );
        if (cancelled || content === null) return;
        store.reloadFromDisk(fresh.id, content, meta.mtime_ms);
      }
    };
    void check();
    const id = setInterval(() => void check(), EXTERNAL_CHANGE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [activePath, activeBaseline, activeDirty]);

  if (openFiles.length === 0) return null;

  const onSaveAndClose = async () => {
    if (!pendingClose) return;
    const id = pendingClose;
    try {
      await saveFile(id);
      await closeFile(id);
    } catch (_e) {
      // T5b 阶段 saveFile throw 占位 → 降级走"丢弃"路径，避免 dialog 卡住；
      // T5c 实现 saveFile 后正常路径生效。
      void _e;
      await closeFile(id);
    }
    setPendingClose(null);
  };

  const onDiscard = async () => {
    if (!pendingClose) return;
    await closeFile(pendingClose);
    setPendingClose(null);
  };

  const onCancel = () => {
    setPendingClose(null);
  };

  return (
    <div
      ref={rootRef}
      className="flex h-full w-full min-h-0 min-w-0 flex-col bg-[var(--c-bg-base)] text-[var(--c-text-base)]"
      data-testid="file-preview-workspace"
      // 让容器可拿键盘焦点，便于 Cmd+W focus 判定（点 tab 切换时浏览器会 focus 容器）
      tabIndex={-1}
      // v0.10.0 HR9-11：mousedown 时记 lastSurface=editor，给 Cmd+W 路由用
      onMouseDownCapture={() =>
        useFocusSurfaceStore.getState().setSurface("editor")
      }
    >
      <FileTabBar
        files={openFiles}
        activeId={activeId}
        onActivate={setActive}
        onCloseRequested={requestClose}
        onToggleMaximized={() => useFileEditorStore.getState().toggleMaximized()}
        onCloseOthers={closeOthers}
        onCloseRight={closeRight}
        onCloseAll={closeAll}
      />
      {/* v0.10.3 #10：外部改动 banner —— buffer dirty 时不静默 reload，
       *  让用户选保留我的（dismissStale）或丢改动重 load。 */}
      {activeFile?.stale && (
        <div
          data-testid="file-stale-banner"
          role="alert"
          className="flex items-center gap-3 border-b border-[var(--c-warning)] bg-[var(--c-warning)]/15 px-3 py-1.5 text-xs"
        >
          <span className="flex-1 text-[var(--c-text-base)]">
            {t("fileStaleBanner.message")}
          </span>
          <button
            type="button"
            data-testid="file-stale-reload"
            onClick={async () => {
              const meta = await fsStat(activeFile.path).catch(() => null);
              const content = await fsReadText(
                activeFile.path,
                MAX_READ_BYTES,
              ).catch(() => null);
              if (meta?.exists && content !== null) {
                useFileEditorStore
                  .getState()
                  .reloadFromDisk(activeFile.id, content, meta.mtime_ms);
              }
            }}
            className="rounded bg-[var(--c-warning)] px-2 py-1 text-[10px] font-medium text-[var(--c-bg-base)] hover:opacity-90"
          >
            {t("fileStaleBanner.reload")}
          </button>
          <button
            type="button"
            data-testid="file-stale-keep"
            onClick={async () => {
              const meta = await fsStat(activeFile.path).catch(() => null);
              useFileEditorStore
                .getState()
                .dismissStale(
                  activeFile.id,
                  meta?.exists ? meta.mtime_ms : (activeFile.lastMtimeMs ?? 0),
                );
            }}
            className="rounded border border-[var(--c-border-strong)] bg-[var(--c-bg-elev-2)] px-2 py-1 text-[10px] text-[var(--c-text-base)] hover:bg-[var(--c-bg-elev-3)]"
          >
            {t("fileStaleBanner.keepMine")}
          </button>
        </div>
      )}
      <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
        {activeFile && <FileEditorPane ref={editorPaneRef} file={activeFile} />}
      </div>
      <CloseFileConfirmDialog
        pendingPath={pendingClose}
        onSaveAndClose={onSaveAndClose}
        onDiscard={onDiscard}
        onCancel={onCancel}
      />
    </div>
  );
}
