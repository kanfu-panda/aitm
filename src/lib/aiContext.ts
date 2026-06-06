/* =============================================================================
 * aiContext —— v0.9.2 HR5-1：前端运行时 active 状态收集
 * -----------------------------------------------------------------------------
 * 每次 aiChatSend 发请求前调 `collectRuntimeContext()`，把"用户当前 active 的
 * 终端 tab / 浏览器 tab / 编辑器文件"打包传给后端。后端用它 append 到 system
 * prompt 末尾（HR5-2），让 AI 知道用户此刻在哪 / 看啥 / 编辑啥。
 *
 * 设计要点：
 * - 各 store 自身的 active 概念已经明确（tabs.activeId / browser.activeKey /
 *   file-editor.activeId），本模块只是抽取归一化成 IPC 协议字段
 * - 缺失字段一律 undefined（serde Option）；后端 render 时全 None 直接 skip
 *   整个 block，不污染 system prompt
 * - 不主动发 IPC 取数据（保持 send 路径快）；后端有现成实时 cwd 查询，本层不重复
 * - OS 检测用 navigator.userAgent，跟 [`lib/xtermTextarea.ts`] 已有模式对齐
 * ========================================================================== */

import { useBrowserStore } from "../stores/browser";
import { useFileEditorStore } from "../stores/file-editor";
import { useSettingsStore } from "../stores/settings";
import { useTabsStore } from "../stores/tabs";

/** active 终端 tab 的快照（运行时 IPC 协议层）。 */
export interface ActiveTerminalContext {
  /** 后端 session UUID（tab 关联的 PTY）。 */
  session_id: string;
  /** OSC 7 / cd 跟踪的最新 cwd 绝对路径；首条 OSC 7 之前为 undefined。 */
  cwd?: string;
  /** 设置面板配置的 default_shell（兜底；实际 shell 可能不同但够用）。 */
  shell?: string;
}

/** active 浏览器 tab 的快照。 */
export interface ActiveBrowserContext {
  /** 后端 webview label（suspended → undefined，整 active_browser 也不会上报）。 */
  tab_id: string;
  url: string;
  title?: string;
}

/** active 编辑器 tab 的快照。 */
export interface ActiveEditorContext {
  path: string;
  /** 推断的语言标签（小写扩展名 ts / rs / md 等）；空 / 纯文本 → undefined。 */
  language?: string;
  /** 当前 buffer 与磁盘版本是否不一致（编辑器有未保存改动）。 */
  dirty: boolean;
}

/** 运行时上下文 IPC payload（与后端 `ipc::ai::RuntimeContext` 一一对应）。
 *  全字段都 optional（serde Option / serde default）—— 后端 render 时全 None
 *  会跳过整个 runtime block，不污染 system prompt。 */
export interface RuntimeContext {
  active_terminal?: ActiveTerminalContext;
  active_browser?: ActiveBrowserContext;
  active_editor?: ActiveEditorContext;
  /** 操作系统三态；后端拿去 system prompt 里讲"用户在 X 系统"。 */
  os: "macos" | "windows" | "linux";
}

/** 检测当前 OS。webview userAgent 在三家都能区分。
 *  不区分 macOS / iOS（aitm 桌面 only）：含 "Mac" 即视为 macos。 */
export function detectOs(ua: string = navigator.userAgent): "macos" | "windows" | "linux" {
  if (/Mac/i.test(ua)) return "macos";
  if (/Win/i.test(ua)) return "windows";
  return "linux";
}

/** 收集当前 active runtime context 给 aiChatSend 用。
 *
 * 实现路径：
 * - tabs store → 找 activeId 对应 tab 的 sessionId / cwd
 * - browser store → 仅当 panelOpen + activeKey 对应 tab 状态为 active
 *   且后端有 webview tab_id（id != null）时上报
 * - file-editor store → activeId 对应 OpenFile 的 path / language / dirty
 * - settings store → shell.default_shell 给 terminal.shell 兜底
 *
 * 各 store 都没 active 时返回 `{ os }`，后端 render 跳过整个 block。 */
export function collectRuntimeContext(): RuntimeContext {
  const ctx: RuntimeContext = { os: detectOs() };

  // --- active terminal ---
  const tabsState = useTabsStore.getState();
  const activeTab = tabsState.tabs.find((t) => t.id === tabsState.activeId);
  if (activeTab?.sessionId) {
    const shell = useSettingsStore.getState().settings.shell.default_shell;
    const term: ActiveTerminalContext = {
      session_id: activeTab.sessionId,
    };
    if (activeTab.cwd) term.cwd = activeTab.cwd;
    if (shell && shell.trim().length > 0) term.shell = shell;
    ctx.active_terminal = term;
  }

  // --- active browser tab ---
  const browserState = useBrowserStore.getState();
  if (browserState.panelOpen && browserState.activeKey) {
    const activeBwTab = browserState.tabs.find(
      (t) => t.key === browserState.activeKey,
    );
    // 只在 active 状态 + 有后端 tab_id 时上报（suspended / loading 不算 active）
    if (activeBwTab?.state === "active" && activeBwTab.id) {
      const bw: ActiveBrowserContext = {
        tab_id: activeBwTab.id,
        url: activeBwTab.url,
      };
      // title 等于 url 时不重复传（webview 还没拿到真 title 时 title=url）
      if (activeBwTab.title && activeBwTab.title !== activeBwTab.url) {
        bw.title = activeBwTab.title;
      }
      ctx.active_browser = bw;
    }
  }

  // --- active editor file ---
  const editorState = useFileEditorStore.getState();
  if (editorState.activeId) {
    const activeFile = editorState.openFiles.find(
      (f) => f.id === editorState.activeId,
    );
    if (activeFile) {
      const ed: ActiveEditorContext = {
        path: activeFile.path,
        dirty: activeFile.dirty,
      };
      if (activeFile.language) ed.language = activeFile.language;
      ctx.active_editor = ed;
    }
  }

  return ctx;
}
