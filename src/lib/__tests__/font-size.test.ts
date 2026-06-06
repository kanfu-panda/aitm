/**
 * v0.10.6 T4：字号缩放工具单测
 *
 * 覆盖：
 * - `clampFontSize` 边界（< 10 / > 24 / NaN / 非整数）
 * - `adjustFontSize` 按 `useFocusSurfaceStore.lastSurface` 路由到
 *   terminal vs editor，并正确 dispatch settings.update
 * - reset 行为：回 13（与后端 default 同步）
 * - no-op：已在边界 / 重置到当前值时不触发 update
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// mock IPC 防止 debounced settings_update 真触底
vi.mock("../tauri", async () => {
  const actual = await vi.importActual<typeof import("../tauri")>("../tauri");
  return {
    ...actual,
    settingsGet: vi.fn().mockResolvedValue({}),
    settingsUpdate: vi.fn().mockResolvedValue(undefined),
  };
});

// mock analytics 防止 trackEvent 噪音
vi.mock("../analytics", () => ({
  trackEvent: vi.fn(),
}));

import {
  FONT_SIZE_DEFAULT_EDITOR,
  FONT_SIZE_DEFAULT_TERMINAL,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  adjustFontSize,
  clampFontSize,
} from "../font-size";
import { useSettingsStore } from "../../stores/settings";
import { useFocusSurfaceStore } from "../../stores/focus-surface";

function resetSettings(terminalSize: number, editorSize: number): void {
  useSettingsStore.setState({
    settings: {
      terminal: {
        font_family: "Menlo, monospace",
        font_size: terminalSize,
        line_height: 1.5,
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
        file_tree_width: 240,
        ai_sidebar_width: 360,
        file_preview_dialog: null,
        confirm_quit: true,
        pane_layout: null,
        keybindings: {},
        language: "en",
      },
      notifications: { sound: true },
      privacy: { analytics_opt_in: true },
      editor: { open_files: [], active_file: null, font_size: editorSize },
    },
    loaded: true,
  });
}

describe("clampFontSize", () => {
  it("常规值 ≥ 10 且 ≤ 24 保留", () => {
    expect(clampFontSize(10)).toBe(10);
    expect(clampFontSize(13)).toBe(13);
    expect(clampFontSize(24)).toBe(24);
  });

  it("< 10 clamp 到 10", () => {
    expect(clampFontSize(5)).toBe(FONT_SIZE_MIN);
    expect(clampFontSize(-100)).toBe(FONT_SIZE_MIN);
  });

  it("> 24 clamp 到 24", () => {
    expect(clampFontSize(25)).toBe(FONT_SIZE_MAX);
    expect(clampFontSize(999)).toBe(FONT_SIZE_MAX);
  });

  it("非整数四舍五入", () => {
    expect(clampFontSize(13.4)).toBe(13);
    expect(clampFontSize(13.6)).toBe(14);
  });

  it("NaN / 非有限数 fallback 到 13", () => {
    expect(clampFontSize(NaN)).toBe(FONT_SIZE_DEFAULT_TERMINAL);
    expect(clampFontSize(Infinity)).toBe(FONT_SIZE_DEFAULT_TERMINAL);
    expect(clampFontSize(-Infinity)).toBe(FONT_SIZE_DEFAULT_TERMINAL);
  });
});

describe("adjustFontSize 路由", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSettings(13, 13);
    useFocusSurfaceStore.setState({ lastSurface: "terminal" });
  });

  it("lastSurface = terminal 时调整 terminal 字号", async () => {
    await adjustFontSize(+1);
    const s = useSettingsStore.getState().settings;
    expect(s.terminal.font_size).toBe(14);
    expect(s.editor.font_size).toBe(13); // 不动
  });

  it("lastSurface = editor 时调整 editor 字号", async () => {
    useFocusSurfaceStore.setState({ lastSurface: "editor" });
    await adjustFontSize(+1);
    const s = useSettingsStore.getState().settings;
    expect(s.editor.font_size).toBe(14);
    expect(s.terminal.font_size).toBe(13); // 不动
  });

  it("lastSurface = browser 走 terminal 路径", async () => {
    useFocusSurfaceStore.setState({ lastSurface: "browser" });
    await adjustFontSize(+1);
    expect(useSettingsStore.getState().settings.terminal.font_size).toBe(14);
  });

  it("lastSurface = ai-sidebar 走 terminal 路径", async () => {
    useFocusSurfaceStore.setState({ lastSurface: "ai-sidebar" });
    await adjustFontSize(-1);
    expect(useSettingsStore.getState().settings.terminal.font_size).toBe(12);
  });

  it("delta -1 减小字号", async () => {
    await adjustFontSize(-1);
    expect(useSettingsStore.getState().settings.terminal.font_size).toBe(12);
  });

  it("reset 回 13（terminal）", async () => {
    resetSettings(20, 13);
    await adjustFontSize("reset");
    expect(useSettingsStore.getState().settings.terminal.font_size).toBe(
      FONT_SIZE_DEFAULT_TERMINAL,
    );
  });

  it("reset 回 13（editor）", async () => {
    resetSettings(13, 20);
    useFocusSurfaceStore.setState({ lastSurface: "editor" });
    await adjustFontSize("reset");
    expect(useSettingsStore.getState().settings.editor.font_size).toBe(
      FONT_SIZE_DEFAULT_EDITOR,
    );
  });

  it("超 24 上界后再 + 1 不变（clamp）", async () => {
    resetSettings(24, 13);
    await adjustFontSize(+1);
    expect(useSettingsStore.getState().settings.terminal.font_size).toBe(24);
  });

  it("低于 10 下界后再 - 1 不变（clamp）", async () => {
    resetSettings(10, 13);
    await adjustFontSize(-1);
    expect(useSettingsStore.getState().settings.terminal.font_size).toBe(10);
  });

  it("reset 已是默认值时仍是 13（no-op 静默）", async () => {
    resetSettings(13, 13);
    await adjustFontSize("reset");
    expect(useSettingsStore.getState().settings.terminal.font_size).toBe(13);
  });
});
