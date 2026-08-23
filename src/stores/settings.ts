import { create } from "zustand";
import { trackEvent } from "../lib/analytics";
import {
  type AppSettings,
  settingsGet,
  settingsUpdate,
} from "../lib/tauri";

const DEFAULT_SETTINGS: AppSettings = {
  terminal: {
    font_family: "Menlo, Monaco, 'JetBrains Mono', monospace",
    font_size: 13,
    line_height: 1.2,
    cursor_style: "block",
    theme: "default",
  },
  shell: { default_shell: "" },
  safety: { whitelist: [], show_low_auto_approved: false },
  browser: { max_active_tabs: 3, suspend_timer_minutes: 5 },
  ui: {
    activity_bar_position: "right",
    theme_mode: "dark",
    ai_sidebar_position: "right",
    file_tree_position: "left",
    // v0.6.0-A：sidebar 默认宽度（与后端 UiSettings::default() 同步）
    file_tree_width: 240,
    ai_sidebar_width: 360,
    // null = 首次打开，FilePreviewDialog 自己居中 + 800×600 默认尺寸
    file_preview_dialog: null,
    // v0.9.0 T4：默认开启关闭二次确认（与后端 UiSettings::default() 同步）
    confirm_quit: true,
    // 默认静默恢复上次会话（与后端 UiSettings::default() 同步）
    restore_session: true,
    // v0.10.0 HR6-3e：null = 首次启动，前端用 makeDefaultRoot 单 leaf 兜底
    pane_layout: null,
    // v0.10.0 HR7-7：用户自定义快捷键覆盖；默认空，行为等同走 DEFAULT_KEYBINDINGS
    keybindings: {},
    // v0.10.4 i18n：默认英文（en / zh-CN / ja 三种）
    language: "en",
  },
  notifications: { sound: true },
  privacy: { analytics_opt_in: true },
  // v0.9.0 T5b：文件编辑器 tab 状态（与后端 EditorSettings::default() 同步）
  // v0.10.6 T4：editor.font_size 默认 13（与后端 default_editor_font_size 同步）
  editor: { open_files: [], active_file: null, font_size: 13 },
};

interface SettingsState {
  settings: AppSettings;
  loaded: boolean;
  /** Phase 2A T5：底部 status bar 显隐开关（默认开）。
   *  v0.2.0 极简：只在内存（zustand）维护，不持久化到 settings.toml；
   *  toggle UI 入口留 v0.2.x patch（要加后端 AppSettings 字段同步太重）。
   *  用户想关：dev console 调 `useSettingsStore.getState().toggleStatusBar()`。 */
  statusBarEnabled: boolean;
  /** 启动时拉一次后端的，把 store 同步好 */
  init: () => Promise<void>;
  /** 部分更新（深合并 terminal / shell 字段），debounced 写后端 */
  update: (patch: PartialSettings) => void;
  /** 切换底部 status bar 显隐（v0.2.0 不持久化）。 */
  toggleStatusBar: () => void;
}

interface PartialSettings {
  terminal?: Partial<AppSettings["terminal"]>;
  shell?: Partial<AppSettings["shell"]>;
  safety?: Partial<AppSettings["safety"]>;
  browser?: Partial<AppSettings["browser"]>;
  ui?: Partial<AppSettings["ui"]>;
  notifications?: Partial<AppSettings["notifications"]>;
  privacy?: Partial<AppSettings["privacy"]>;
  /** v0.9.0 T5b：文件编辑器 tab 状态（open_files / active_file）持久化。 */
  editor?: Partial<AppSettings["editor"]>;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  statusBarEnabled: true,
  toggleStatusBar: () =>
    set((s) => ({ statusBarEnabled: !s.statusBarEnabled })),

  init: async () => {
    try {
      const s = await settingsGet();
      set({ settings: s, loaded: true });
    } catch (e) {
      console.warn("settings_get 失败，用默认值", e);
      set({ loaded: true });
    }
  },

  update: (patch) => {
    set((s) => ({
      settings: {
        terminal: { ...s.settings.terminal, ...(patch.terminal ?? {}) },
        shell: { ...s.settings.shell, ...(patch.shell ?? {}) },
        safety: { ...s.settings.safety, ...(patch.safety ?? {}) },
        browser: { ...s.settings.browser, ...(patch.browser ?? {}) },
        ui: { ...s.settings.ui, ...(patch.ui ?? {}) },
        notifications: {
          ...s.settings.notifications,
          ...(patch.notifications ?? {}),
        },
        privacy: { ...s.settings.privacy, ...(patch.privacy ?? {}) },
        editor: { ...s.settings.editor, ...(patch.editor ?? {}) },
      },
    }));

    // v0.7.0-A：匿名统计——只传 section 名（"ui"/"terminal"/...），**不**传具体值
    // 一个 patch 可能同时更新多个 section，每个 section 各发一次。
    // 注：providers 走独立 IPC（不经此 store），由 SettingsModal 段单独插桩。
    const trackableSections = [
      "ui",
      "terminal",
      "browser",
      "notifications",
      "privacy",
    ] as const;
    for (const section of trackableSections) {
      if (patch[section] !== undefined) {
        trackEvent("settings_changed", { section });
      }
    }

    // debounced 写后端（300ms 抖动窗口）
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const current = get().settings;
      settingsUpdate(current).catch((e) => console.error("settings_update 失败", e));
    }, 300);
  },
}));
