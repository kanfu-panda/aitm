import { beforeEach, describe, expect, it, vi } from "vitest";

// v0.7.0-A：mock analytics 验证 settings_changed 事件
vi.mock("../lib/analytics", () => ({
  trackEvent: vi.fn(),
}));

// mock IPC settings_update 防止 debounced timer 真调后端
vi.mock("../lib/tauri", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/tauri")>("../lib/tauri");
  return {
    ...actual,
    settingsGet: vi.fn().mockResolvedValue({}),
    settingsUpdate: vi.fn().mockResolvedValue(undefined),
  };
});

import { trackEvent } from "../lib/analytics";
import { useSettingsStore } from "./settings";

const trackEventMock = trackEvent as unknown as ReturnType<typeof vi.fn>;

describe("useSettingsStore", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      settings: {
        terminal: {
          font_family: "Menlo, monospace",
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
      editor: { open_files: [], active_file: null, font_size: 13 },
      },
      loaded: true,
    });
    vi.clearAllMocks();
  });

  it("初始 settings 为默认值", () => {
    const { settings } = useSettingsStore.getState();
    expect(settings.terminal.font_size).toBe(13);
    expect(settings.terminal.cursor_style).toBe("block");
  });

  it("update 部分字段保留其他字段", () => {
    const { update } = useSettingsStore.getState();
    update({ terminal: { font_size: 16 } });
    const s = useSettingsStore.getState().settings;
    expect(s.terminal.font_size).toBe(16);
    expect(s.terminal.font_family).toBe("Menlo, monospace"); // 保留
    expect(s.terminal.line_height).toBe(1.2); // 保留
  });

  it("update 嵌套字段（cursor_style）", () => {
    const { update } = useSettingsStore.getState();
    update({ terminal: { cursor_style: "bar" } });
    expect(useSettingsStore.getState().settings.terminal.cursor_style).toBe("bar");
  });

  it("statusBarEnabled 默认 true", () => {
    expect(useSettingsStore.getState().statusBarEnabled).toBe(true);
  });

  it("toggleStatusBar 切换显隐", () => {
    const { toggleStatusBar } = useSettingsStore.getState();
    toggleStatusBar();
    expect(useSettingsStore.getState().statusBarEnabled).toBe(false);
    toggleStatusBar();
    expect(useSettingsStore.getState().statusBarEnabled).toBe(true);
  });

  // === v0.4.1 T2：ui.activity_bar_position ===

  it("初始 ui.activity_bar_position 默认 'right'", () => {
    expect(
      useSettingsStore.getState().settings.ui.activity_bar_position,
    ).toBe("right");
  });

  it("update ui.activity_bar_position 切换 4 向", () => {
    const { update } = useSettingsStore.getState();
    update({ ui: { activity_bar_position: "bottom" } });
    expect(
      useSettingsStore.getState().settings.ui.activity_bar_position,
    ).toBe("bottom");
    update({ ui: { activity_bar_position: "left" } });
    expect(
      useSettingsStore.getState().settings.ui.activity_bar_position,
    ).toBe("left");
  });

  it("update 其它段不影响 ui.activity_bar_position", () => {
    const { update } = useSettingsStore.getState();
    update({ ui: { activity_bar_position: "top" } });
    update({ terminal: { font_size: 18 } });
    const s = useSettingsStore.getState().settings;
    expect(s.terminal.font_size).toBe(18);
    expect(s.ui.activity_bar_position).toBe("top");
  });

  // === v0.4.1 T5：ui.theme_mode ===

  it("初始 ui.theme_mode 默认 'dark'", () => {
    expect(useSettingsStore.getState().settings.ui.theme_mode).toBe("dark");
  });

  it("update ui.theme_mode 切换 3 态", () => {
    const { update } = useSettingsStore.getState();
    update({ ui: { theme_mode: "light" } });
    expect(useSettingsStore.getState().settings.ui.theme_mode).toBe("light");
    update({ ui: { theme_mode: "auto" } });
    expect(useSettingsStore.getState().settings.ui.theme_mode).toBe("auto");
    update({ ui: { theme_mode: "dark" } });
    expect(useSettingsStore.getState().settings.ui.theme_mode).toBe("dark");
  });

  it("update theme_mode 不影响 activity_bar_position", () => {
    const { update } = useSettingsStore.getState();
    update({ ui: { activity_bar_position: "left" } });
    update({ ui: { theme_mode: "light" } });
    const s = useSettingsStore.getState().settings;
    expect(s.ui.activity_bar_position).toBe("left");
    expect(s.ui.theme_mode).toBe("light");
  });

  it("update activity_bar_position 不影响 theme_mode", () => {
    const { update } = useSettingsStore.getState();
    update({ ui: { theme_mode: "auto" } });
    update({ ui: { activity_bar_position: "bottom" } });
    const s = useSettingsStore.getState().settings;
    expect(s.ui.theme_mode).toBe("auto");
    expect(s.ui.activity_bar_position).toBe("bottom");
  });

  // === v0.6.0-A T1：ui.{file_tree_width, ai_sidebar_width, file_preview_dialog} ===

  it("初始 ui.file_tree_width 默认 240", () => {
    expect(useSettingsStore.getState().settings.ui.file_tree_width).toBe(240);
  });

  it("初始 ui.ai_sidebar_width 默认 360", () => {
    expect(useSettingsStore.getState().settings.ui.ai_sidebar_width).toBe(360);
  });

  it("初始 ui.file_preview_dialog 默认 null", () => {
    expect(
      useSettingsStore.getState().settings.ui.file_preview_dialog,
    ).toBeNull();
  });

  it("update ui.file_tree_width 持有新值", () => {
    const { update } = useSettingsStore.getState();
    update({ ui: { file_tree_width: 320 } });
    expect(useSettingsStore.getState().settings.ui.file_tree_width).toBe(320);
  });

  it("update ui.ai_sidebar_width 持有新值", () => {
    const { update } = useSettingsStore.getState();
    update({ ui: { ai_sidebar_width: 420 } });
    expect(useSettingsStore.getState().settings.ui.ai_sidebar_width).toBe(420);
  });

  it("update ui.file_preview_dialog 持有 rect", () => {
    const { update } = useSettingsStore.getState();
    update({
      ui: { file_preview_dialog: { x: 100, y: 80, w: 900, h: 640 } },
    });
    const rect = useSettingsStore.getState().settings.ui.file_preview_dialog;
    expect(rect).not.toBeNull();
    expect(rect).toEqual({ x: 100, y: 80, w: 900, h: 640 });
  });

  it("update file_tree_width 不影响其他 ui 字段", () => {
    const { update } = useSettingsStore.getState();
    update({ ui: { file_tree_width: 280 } });
    const s = useSettingsStore.getState().settings;
    expect(s.ui.file_tree_width).toBe(280);
    expect(s.ui.activity_bar_position).toBe("right");
    expect(s.ui.theme_mode).toBe("dark");
    expect(s.ui.ai_sidebar_width).toBe(360);
  });

  // === v0.7.0-A：匿名统计 settings_changed ===

  describe("匿名统计 (v0.7.0-A)", () => {
    it("update ui 段触发 settings_changed{section:'ui'}", () => {
      useSettingsStore.getState().update({ ui: { theme_mode: "light" } });
      expect(trackEventMock).toHaveBeenCalledWith("settings_changed", {
        section: "ui",
      });
    });

    it("update terminal 段触发 settings_changed{section:'terminal'}", () => {
      useSettingsStore.getState().update({ terminal: { font_size: 14 } });
      expect(trackEventMock).toHaveBeenCalledWith("settings_changed", {
        section: "terminal",
      });
    });

    it("update privacy 段触发 settings_changed{section:'privacy'}", () => {
      useSettingsStore
        .getState()
        .update({ privacy: { analytics_opt_in: false } });
      expect(trackEventMock).toHaveBeenCalledWith("settings_changed", {
        section: "privacy",
      });
    });

    it("update browser 段触发 settings_changed{section:'browser'}", () => {
      useSettingsStore
        .getState()
        .update({ browser: { max_active_tabs: 5 } });
      expect(trackEventMock).toHaveBeenCalledWith("settings_changed", {
        section: "browser",
      });
    });

    it("update notifications 段触发 settings_changed{section:'notifications'}", () => {
      useSettingsStore
        .getState()
        .update({ notifications: { sound: false } });
      expect(trackEventMock).toHaveBeenCalledWith("settings_changed", {
        section: "notifications",
      });
    });

    it("一次 patch 同时含多个 section → 每段各发一次", () => {
      useSettingsStore.getState().update({
        ui: { theme_mode: "light" },
        terminal: { font_size: 14 },
      });
      const sections = trackEventMock.mock.calls
        .filter((c) => c[0] === "settings_changed")
        .map((c) => (c[1] as { section: string }).section);
      expect(sections).toContain("ui");
      expect(sections).toContain("terminal");
    });

    it("空 patch 不发事件", () => {
      useSettingsStore.getState().update({});
      const settingsChangedCalls = trackEventMock.mock.calls.filter(
        (c) => c[0] === "settings_changed",
      );
      expect(settingsChangedCalls).toHaveLength(0);
    });

    it("trackEvent 不传具体值（只传 section 名）", () => {
      useSettingsStore
        .getState()
        .update({ terminal: { font_size: 22, cursor_style: "bar" } });
      const call = trackEventMock.mock.calls.find(
        (c) => c[0] === "settings_changed",
      );
      expect(call).toBeDefined();
      const props = call![1] as Record<string, unknown>;
      // 仅含 section key；不含 font_size / cursor_style 等具体值
      expect(Object.keys(props)).toEqual(["section"]);
      expect(props.section).toBe("terminal");
    });
  });
});
