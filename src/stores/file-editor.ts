/* =============================================================================
 * file-editor store —— v0.9.0 T5b 文件预览 tab 容器化
 * -----------------------------------------------------------------------------
 * 多文件 tab 状态（替代 v0.6.0 浮动 FilePreviewDialog 单文件模式）。
 *
 * 核心数据：
 *   - openFiles：当前打开的 tab 列表（顺序 = UI tab 顺序）
 *   - activeId：当前激活 tab id（= path）
 *
 * 行为：
 *   - openFile(path)：在 list 里 → 切到该 tab；不在 → IPC fs_read_text 读盘
 *     新建 + active 到新 tab
 *   - closeFile(id)：仅从 store 移除（dirty 弹确认由调用方负责，store 不弹）
 *   - setActive(id)：切 active；持久化 active_file
 *   - updateContent(id, content)：由 CodeMirror onChange 调；标 dirty
 *   - setCursor(id, line, col)：StatusBar 行列号（T5d 读这两字段）
 *   - saveFile(id) / setMdMode(id, mode)：T5c / T5e 占位，本 task 不实现
 *
 * 持久化策略：
 *   - openFiles / activeId 变化 → 写 settings.editor.{open_files, active_file}
 *   - 不存 dirty buffer（编辑器关闭即弃）；T5c 保存逻辑独立
 *   - debounce 100ms 合并连续变化（短时间多次 setActive / open 不轰炸后端）
 *
 * 不在 T5b 范围（占位 / 留口子给后续 task）：
 *   - saveFile：T5c 实现（throw 占位让 dirty 关 tab 走"丢弃"分支或编译期发现误用）
 *   - setMdMode：T5e 实现
 *   - dirty 关 tab 弹保存确认：T5b 提供 CloseFileConfirmDialog 组件，但实际
 *     "保存并关闭"按钮调 saveFile → 在 T5c 实现前会 throw → 调用方需 catch
 *     降级到"丢弃改动"（CloseFileConfirmDialog 的 onConfirm/onDiscard 已分流）
 * ========================================================================== */

import { create } from "zustand";
import { fileWrite, fsReadText, fsStat, settingsUpdate } from "../lib/tauri";
import { useSettingsStore } from "./settings";
import { extFromPath } from "../lib/cm-lang";

/** 单个打开文件的状态。 */
export interface OpenFile {
  /** tab id；用 path 当 id 唯一（同一文件不重复打开）。 */
  id: string;
  /** 文件绝对路径。 */
  path: string;
  /** 当前 buffer（含 dirty 修改）；CodeMirror 的 source of truth。 */
  content: string;
  /** 磁盘上的版本（最近一次 read / save 的内容）；用于判 dirty + 弃改动。 */
  original: string;
  /** 内容跟 original 不一致 = dirty；UI 显示圆点 / 标题末星号。 */
  dirty: boolean;
  /** 推断的语言标签（小写扩展名，如 "ts" / "rs" / "md"）；空串 = 纯文本。 */
  language?: string;
  /** 光标当前行（1-based）。StatusBar T5d 读。 */
  cursorLine: number;
  /** 光标当前列（1-based）。StatusBar T5d 读。 */
  cursorCol: number;
  /** T5e：md 文件的展示模式（preview / raw）；非 md 为 undefined。 */
  mdMode?: "preview" | "raw";
  /** v0.10.3 #10：上次 read/save 时磁盘的 mtime（ms）；用于外部改动检测对比 */
  lastMtimeMs?: number;
  /** v0.10.3 #10：磁盘上文件被外部修改了但本地 buffer dirty 没办法静默 reload，
   *  UI 显示 banner 让用户选 reload / 保留我的；非 dirty 时静默 reload 不置 stale。 */
  stale?: boolean;
}

export interface FileEditorState {
  openFiles: OpenFile[];
  activeId: string | null;
  /**
   * v0.9.0 HR2-9：编辑器最大化模式。
   * true → App.tsx 的 PanelGroup 让编辑器占满终端区，终端面板隐藏。
   * 触发：FileTabBar 上双击 tab 标题。再次双击恢复 false。
   * 不持久化（仅会话内态，重启回默认 split）。
   */
  maximized: boolean;
  /** v0.9.0 HR2-9：toggle 最大化。 */
  toggleMaximized: () => void;
  /**
   * 打开文件 tab；
   * - 已在列表里 → 切 active
   * - 不在列表 → IPC 读盘 + push + active 到新 tab
   *
   * 读盘失败（路径不存在 / 二进制）抛出，调用方决定 UI 反馈
   * （目前 FileTree 双击进来已经预先 fs_read_preview 过，纯文件 read 失败少见）。
   */
  openFile: (path: string) => Promise<void>;
  /** 关 tab。仅从 store 移除；dirty 检查由调用方做（CloseFileConfirmDialog）。 */
  closeFile: (id: string) => Promise<void>;
  /** 切 active tab。 */
  setActive: (id: string) => void;
  /** 由 CodeMirror onChange 调；标 dirty。 */
  updateContent: (id: string, content: string) => void;
  /** 由 CodeMirror onCursorChange 调；StatusBar T5d 读。 */
  setCursor: (id: string, line: number, col: number) => void;
  /**
   * 保存到磁盘（v0.9.0 T5c）。
   *
   * 走 `file_write` IPC：path 必须绝对、不能落在系统黑名单。
   * 成功后把 `original` 设成当前 content + `dirty=false`。
   * 失败（权限 / 黑名单 / 父目录不存在等）throw Error 透传；
   * 调用方（FileEditorPane Cmd+S handler / CloseFileConfirmDialog "保存并关闭"）
   * 负责 catch + 给用户提示（toast / 降级到丢弃改动）。
   */
  saveFile: (id: string) => Promise<void>;
  /** T5e：切 md 展示模式。当前实现：仅写 store 字段（UI 渲染 T5e 接入）。 */
  setMdMode: (id: string, mode: "preview" | "raw") => void;
  /**
   * 启动时按 settings.editor 恢复 tabs；
   * 失败的单个文件静默跳过（不阻塞其他 tab 恢复）。
   */
  restoreFromSettings: (
    openPaths: string[],
    activeFile: string | null,
  ) => Promise<void>;
  /**
   * v0.10.3 #10：把外部修改的内容 reload 回 buffer。
   * 调用方判过 stale + 用户接受 reload 后才调；本 action 清 stale + 重置 dirty。
   */
  reloadFromDisk: (id: string, content: string, mtimeMs: number) => void;
  /**
   * v0.10.3 #10：标记 file 为 stale（外部修改了但本地 dirty 不能静默 reload）。
   * Workspace 显 banner 让用户选保留 / reload。
   */
  markStale: (id: string, mtimeMs: number) => void;
  /**
   * v0.10.3 #10：清 stale 标记（用户选了"保留我的"忽略外部改动，
   * 同时更新 lastMtimeMs 让下次比对从新基线开始）。
   */
  dismissStale: (id: string, mtimeMs: number) => void;
}

/** 持久化 debounce 窗口（ms）；连续 open / close / setActive 合并写一次。 */
const PERSIST_DEBOUNCE_MS = 100;
/** fs_read_text 单文件 max_bytes 上限：1 MB（跟 fs_read_preview 文本上限一致）。 */
const MAX_READ_BYTES = 1024 * 1024;

let persistTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * v0.10.0 HR9-10：同 path 并发 openFile 去重锁。
 *
 * StrictMode dev 双 mount 时 effect 跑两次，restoreFromSettings 各调一次
 * `openFile(path)`：`get().openFiles.find` 都看到 store 空（第一次的
 * `fsReadText` 还在飞），两个 effect 都 `set([...openFiles, file])` →
 * 同一 path 出现 2 个 tab。
 *
 * 加 inflight set 拦同 path 第二次进入；release 在最后 set/return 之后。
 * 该 set 只在 store 实例化期间存在，不持久化、不跨进程。
 */
const inflightOpen = new Set<string>();
/** 单元测试 hook：替换持久化目标（默认调 settings store + IPC）。 */
let persistFn: (paths: string[], active: string | null) => void = (
  paths,
  active,
) => {
  // 通过 settings store 走 IPC（共享 settings store 的 300ms debounced settings_update）。
  // 同时 fallback 直接调 settings_update 兜底（防 settings store 未 init）。
  try {
    useSettingsStore.getState().update({
      editor: { open_files: paths, active_file: active },
    });
  } catch (e) {
    const cur = useSettingsStore.getState().settings;
    void settingsUpdate({
      ...cur,
      editor: { ...cur.editor, open_files: paths, active_file: active },
    }).catch(() => {});
    void e;
  }
};

/** 测试用：注入自定义持久化函数。 */
export function __setPersistFnForTest(
  fn: (paths: string[], active: string | null) => void,
): void {
  persistFn = fn;
}

/** 取消未触发的持久化（测试 teardown 用，避免跨 case 干扰）。 */
export function __cancelPendingPersistForTest(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
}

function schedulePersist(paths: string[], active: string | null): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistFn(paths, active);
  }, PERSIST_DEBOUNCE_MS);
}

function inferMdMode(path: string): "preview" | "raw" | undefined {
  const ext = extFromPath(path);
  if (ext === "md" || ext === "markdown" || ext === "mdx") {
    return "preview"; // T5e：md 默认 preview，工具栏一键切 raw
  }
  return undefined;
}

export const useFileEditorStore = create<FileEditorState>((set, get) => ({
  openFiles: [],
  activeId: null,
  maximized: false,

  toggleMaximized: () => set((s) => ({ maximized: !s.maximized })),

  openFile: async (path) => {
    const existing = get().openFiles.find((f) => f.id === path);
    if (existing) {
      // 已开 → 切 active
      set({ activeId: path });
      schedulePersist(
        get().openFiles.map((f) => f.path),
        path,
      );
      return;
    }
    // v0.10.0 HR9-10：同 path 并发去重 —— StrictMode 双 mount 时
    // restoreFromSettings 两路同时 await fsReadText，会都 push 一个 file。
    if (inflightOpen.has(path)) {
      // 同 path 已经在读盘中，第二次 caller 等同 "已开"语义：切 active 并退出。
      set({ activeId: path });
      return;
    }
    inflightOpen.add(path);
    try {
      // 读盘 + 同时拿 mtime（v0.10.3 #10 外部改动检测基线）
      const content = await fsReadText(path, MAX_READ_BYTES);
      const meta = await fsStat(path).catch(() => null);
      // 二次校验：await 期间可能 race winner 已经 push 了同 path 的 file。
      if (get().openFiles.find((f) => f.id === path)) {
        set({ activeId: path });
        return;
      }
      const file: OpenFile = {
        id: path,
        path,
        content,
        original: content,
        dirty: false,
        language: extFromPath(path) || undefined,
        cursorLine: 1,
        cursorCol: 1,
        mdMode: inferMdMode(path),
        lastMtimeMs: meta?.exists ? meta.mtime_ms : undefined,
      };
      set((s) => ({
        openFiles: [...s.openFiles, file],
        activeId: path,
      }));
      schedulePersist(
        get().openFiles.map((f) => f.path),
        path,
      );
    } finally {
      inflightOpen.delete(path);
    }
  },

  closeFile: async (id) => {
    const state = get();
    const idx = state.openFiles.findIndex((f) => f.id === id);
    if (idx < 0) return;
    const remaining = state.openFiles.filter((f) => f.id !== id);
    let newActive: string | null = state.activeId;
    if (state.activeId === id) {
      // 切到右侧；右侧没有就切到左侧；都没有 → null（容器收回）
      newActive =
        remaining[idx]?.id ?? remaining[idx - 1]?.id ?? null;
    }
    // HR2-9：关到最后一个 tab → 自动退出最大化（panel collapse 会随 fileEditorActive=false unmount）
    set({
      openFiles: remaining,
      activeId: newActive,
      maximized: remaining.length === 0 ? false : get().maximized,
    });
    schedulePersist(
      remaining.map((f) => f.path),
      newActive,
    );
  },

  setActive: (id) => {
    set({ activeId: id });
    schedulePersist(
      get().openFiles.map((f) => f.path),
      id,
    );
  },

  updateContent: (id, content) => {
    set((s) => ({
      openFiles: s.openFiles.map((f) =>
        f.id === id
          ? { ...f, content, dirty: content !== f.original }
          : f,
      ),
    }));
    // updateContent 不触发持久化（path 列表 / active 没变；dirty buffer 不持久化）
  },

  setCursor: (id, line, col) => {
    set((s) => ({
      openFiles: s.openFiles.map((f) =>
        f.id === id ? { ...f, cursorLine: line, cursorCol: col } : f,
      ),
    }));
    // 光标不持久化
  },

  saveFile: async (id) => {
    const target = get().openFiles.find((f) => f.id === id);
    if (!target) {
      // 找不到 tab 静默返；调用方一般是已经知道 id 的（Cmd+S 拿当前 active）。
      return;
    }
    // 抓个快照避免 race（保存中用户继续打字时，落盘的内容是当时按 Cmd+S 那刻的
    // 内容，但 dirty 标记应反映"保存后 original 同步到这次落盘内容"）。
    const snapshot = target.content;
    try {
      await fileWrite(target.path, snapshot);
    } catch (e) {
      // 包装成 Error 抛给调用方（FileEditorPane keydown / CloseFileConfirmDialog）。
      throw new Error(typeof e === "string" ? e : String(e));
    }
    // v0.10.3 #10：save 后重新 stat 拿新 mtime，作为外部改动检测的新基线
    const meta = await fsStat(target.path).catch(() => null);
    set((s) => ({
      openFiles: s.openFiles.map((f) =>
        f.id === id
          ? {
              ...f,
              original: snapshot,
              // 保存期间用户可能继续编辑 → 若 content 已经又变了，仍是 dirty
              dirty: f.content !== snapshot,
              // 自己 save 之后 mtime 必然变了；更新基线避免下一次 poll 误判为外部改
              lastMtimeMs: meta?.exists ? meta.mtime_ms : f.lastMtimeMs,
              // 自己 save 不算 stale
              stale: false,
            }
          : f,
      ),
    }));
    // 保存不触发 persistFn（openFiles / activeId 列表没变；dirty 不持久化）。
  },

  setMdMode: (id, mode) => {
    set((s) => ({
      openFiles: s.openFiles.map((f) =>
        f.id === id ? { ...f, mdMode: mode } : f,
      ),
    }));
    // 模式不持久化（重启用 inferMdMode 重置回 preview）；
    // T5e 真接入后看是否要按文件路径记忆。
  },

  restoreFromSettings: async (openPaths, activeFile) => {
    // 顺序 openFile；失败静默跳过（文件被删 / 权限丢 / 二进制都不该阻塞其他 tab）。
    for (const p of openPaths) {
      try {
        await get().openFile(p);
      } catch (_e) {
        void _e;
        // 跳过；恢复阶段不弹错误（用户体验：上次开过的文件没了就当没开过）。
      }
    }
    // 恢复 active：openFile 内部把每个 path 都置 active，最后一个 open 的会赢；
    // 显式纠正回 activeFile（在 list 内 → 切；不在 → 保持最后一个 open 的）。
    if (activeFile) {
      const exists = get().openFiles.some((f) => f.id === activeFile);
      if (exists) {
        set({ activeId: activeFile });
      }
    }
  },

  // v0.10.3 #10：外部改动 reload 路径（用户选 reload 或非 dirty 静默走这条）
  reloadFromDisk: (id, content, mtimeMs) =>
    set((s) => ({
      openFiles: s.openFiles.map((f) =>
        f.id === id
          ? {
              ...f,
              content,
              original: content,
              dirty: false,
              lastMtimeMs: mtimeMs,
              stale: false,
            }
          : f,
      ),
    })),

  // v0.10.3 #10：标 stale（dirty buffer + 外部改了）让 banner 显示
  markStale: (id, mtimeMs) =>
    set((s) => ({
      openFiles: s.openFiles.map((f) =>
        f.id === id
          ? {
              ...f,
              stale: true,
              // 不更新 lastMtimeMs：让下一次 poll 还能识别到外部 mtime > basemtime
              // 直到用户 dismiss 或 reload。
              lastMtimeMs: mtimeMs,
            }
          : f,
      ),
    })),

  // v0.10.3 #10：用户点 banner 上的"保留我的"，清 stale 不动 content
  // lastMtimeMs 更到当前磁盘值，避免下次 poll 又触发
  dismissStale: (id, mtimeMs) =>
    set((s) => ({
      openFiles: s.openFiles.map((f) =>
        f.id === id ? { ...f, stale: false, lastMtimeMs: mtimeMs } : f,
      ),
    })),
}));
