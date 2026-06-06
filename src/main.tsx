import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// v0.4.1: 字体本地嵌入（Tauri 离线 app 不能依赖 Google Fonts CDN）
// IBM Plex Sans → UI 文字；JetBrains Mono → 终端 / 代码块
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";

import "./index.css";
// v0.10.4 i18n：在 App 加载前 init i18next（资源 import 时已 register）；
// 实际语言由 App.tsx settings init 后调 i18n.changeLanguage(settings.ui.language)。
import "./lib/i18n";
import App from "./App";
import { applyTheme, watchSystemTheme } from "./lib/theme";
import { applyEditorFontSize } from "./lib/font-size";
import { MotionRoot } from "./lib/motion";
import { useSettingsStore } from "./stores/settings";
import {
  setMarkUnreadHook,
  setSystemNotificationHook,
} from "./stores/notifications";
import { useTabsStore } from "./stores/tabs";
import {
  ensureNotificationPermission,
  sendSystemNotification,
} from "./lib/systemNotification";

// v0.4.1 T5：启动应用初始主题。
//
// 流程（不阻塞首屏）：
//
// 1. **同步**先读 zustand store 的初始 theme_mode（store 的 DEFAULT_SETTINGS
//    是 'dark'，避免首屏白闪一帧）→ 调 applyTheme 写 <html data-theme>
// 2. **同步**注册 watchSystemTheme：mode='auto' 时系统主题切换自动跟切
// 3. **同步**注册 store subscription：用户在 SettingsModal 改 theme_mode → applyTheme
// 4. **异步**（settings init Promise 触发后）后端 settings 拉回，store 用真值
//    覆盖 → subscription 自动重 applyTheme
//
// applyTheme 内部 SSR-safe（matchMedia 只在 mode='auto' 时调）；createRoot
// 之前先 applyTheme 让 <html data-theme> 已就位，避免 React 首次 render 时
// CSS 变量还是默认。
const initialMode = useSettingsStore.getState().settings.ui.theme_mode;
applyTheme(initialMode);

watchSystemTheme(() => useSettingsStore.getState().settings.ui.theme_mode);

useSettingsStore.subscribe((state, prev) => {
  const next = state.settings.ui.theme_mode;
  if (prev.settings.ui.theme_mode !== next) {
    applyTheme(next);
  }
});

// v0.10.6 T4：CodeMirror 字号——启动时 apply 初始值（让 --cm-font-size 在
// 首次 EditorView 创建前已就位），settings.editor.font_size 变化时同步写 var。
// 终端字号通过 TerminalView 自己的 settings.terminal.font_size subscription 接管。
applyEditorFontSize(useSettingsStore.getState().settings.editor.font_size);
useSettingsStore.subscribe((state, prev) => {
  const next = state.settings.editor.font_size;
  if (prev.settings.editor.font_size !== next) {
    applyEditorFontSize(next);
  }
});

// v0.10.4 i18n：settings store 变化时同步 i18next 当前语言。
// 启动序列：DEFAULT_SETTINGS.language=en → i18n init lng=en → settings init
// 拉真值 → 若用户存的是别的语言 subscribe 触发 i18n.changeLanguage。
// 同样 SettingsModal 语言切换写 store.update({ ui:{ language }}) 自动触发。
//
// v0.10.6 T1：同 subscription 内 fire-and-forget invoke menu_rebuild，让
// macOS NSMenu 跟着切（非 macOS 平台后端 IPC silently no-op）。invoke 失败
// 不阻塞前端 i18n 切换（用 console.warn 记录即可，菜单文案不致命）。
import("./lib/i18n").then(({ default: i18n, isSupportedLanguage }) => {
  const syncLanguage = (code: string): void => {
    if (!isSupportedLanguage(code)) return;
    if (i18n.language !== code) void i18n.changeLanguage(code);
    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("menu_rebuild", { lang: code }))
      .catch((err) => {
        // 浏览器环境 / IPC 缺席（vitest jsdom）时 import 或 invoke 会抛；
        // 菜单不可用不影响主流程，记录即可。
        console.warn("[i18n] menu_rebuild failed:", err);
      });
  };
  syncLanguage(useSettingsStore.getState().settings.ui.language);
  useSettingsStore.subscribe((state, prev) => {
    const next = state.settings.ui.language;
    if (prev.settings.ui.language !== next) syncLanguage(next);
  });
});

// v0.5.0-A：把 systemNotification 注入 notifications store（避免 store 直接依赖
// Tauri plugin 让 jsdom 单测能 mock）；启动时申请系统通知权限（一次性，不打扰）
setSystemNotificationHook((event) => {
  void sendSystemNotification(event);
});
// v0.10.5：注入 markUnread hook 让 notifications.emitNotification 时
// 同时 +1 tab unread badge（替代之前 TerminalView 任何 PTY 输出 +1 的噪音逻辑）
setMarkUnreadHook((tabId) => {
  useTabsStore.getState().markUnread(tabId);
});
void ensureNotificationPermission();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MotionRoot>
      <App />
    </MotionRoot>
  </StrictMode>,
);
