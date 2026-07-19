import type { AppSettings } from "../../../src/lib/tauri";

/**
 * v0.7.1-A：e2e 默认 settings fixture。
 *
 * 跟 src/lib/tauri.ts::AppSettings interface 完整对齐。每次 AppSettings 新增字段，
 * 都必须在这里补默认值；否则 store init 解析失败 / 部分组件不渲染，e2e selector
 * 会 timeout（很难直接定位到 mock 缺字段是根因）。
 *
 * 历史踩坑：
 * - v0.4.1 加 `ui.activity_bar_position` + `ui.theme_mode` 后早期 mock 漏写
 *   → ActivityBar 渲染错位 → 多个 spec 找不到按钮
 * - v0.6.0-A 加 `ui.file_tree_width` / `ui.ai_sidebar_width` /
 *   `ui.file_preview_dialog` 三字段
 * - v0.7.0-A 加 `privacy.analytics_opt_in`
 *
 * 数值与后端 `crate::settings` Default 实现一致：
 * - file_tree_width 240 / ai_sidebar_width 360（[180, 600] clamp 范围内）
 * - file_preview_dialog null（首次打开走前端默认居中）
 * - analytics_opt_in true（默认开启遥测）
 */
export const DEFAULT_E2E_SETTINGS: AppSettings = {
  terminal: {
    font_family: "Menlo, monospace",
    font_size: 13,
    line_height: 1.2,
    cursor_style: "block",
    theme: "default",
  },
  shell: { default_shell: "" },
  safety: {
    whitelist: [],
    show_low_auto_approved: false,
  },
  browser: {
    max_active_tabs: 3,
    suspend_timer_minutes: 5,
  },
  ui: {
    activity_bar_position: "right",
    theme_mode: "dark",
    ai_sidebar_position: "right",
    file_tree_position: "left",
    file_tree_width: 240,
    ai_sidebar_width: 360,
    file_preview_dialog: null,
    confirm_quit: true,
    // v0.10.0 HR6-3e：分屏 layout 持久化（首次启动 null）
    pane_layout: null,
    // v0.10.0 HR7-7：快捷键自定义覆盖（默认空 → 走 DEFAULT_KEYBINDINGS）
    keybindings: {},
    // E2E 钉死中文 locale：spec 的 getByLabel / getByRole 断言用中文文案
    // （"AI 助手" / "AI 提供商" / "安全" 等）。生产默认仍是英文
    // （i18n.ts lng="en" + stores/settings.ts），此处只固定测试 locale 让
    // 标签断言稳定。v0.10.4 默认改英文后此 fixture 漏改，曾导致全套 spec 失配。
    language: "zh-CN",
  },
  notifications: {
    sound: true,
  },
  privacy: {
    analytics_opt_in: true,
  },
  // v0.9.0 T5b：文件编辑器 tab 状态（默认空，与后端 EditorSettings::default() 同步）
  editor: {
    open_files: [],
    active_file: null,
  },
};
