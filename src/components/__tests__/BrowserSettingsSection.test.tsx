import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock IPC：BrowserSettingsSection 改值会调 settingsUpdate（debounced 300ms）
vi.mock("../../lib/tauri", async (orig) => {
  const real = await orig<typeof import("../../lib/tauri")>();
  return {
    ...real,
    settingsUpdate: vi.fn().mockResolvedValue(undefined),
  };
});

import BrowserSettingsSection from "../browser/BrowserSettingsSection";
import { useSettingsStore } from "../../stores/settings";

/** 重置 store 到给定的 browser 配置（其他字段用默认值）。 */
function resetStore(maxActive = 3, suspendMin = 5) {
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
      browser: {
        max_active_tabs: maxActive,
        suspend_timer_minutes: suspendMin,
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
}

describe("BrowserSettingsSection", () => {
  beforeEach(() => {
    resetStore();
  });

  it("渲染：两个 number input + 资源预算文案", () => {
    render(<BrowserSettingsSection />);

    expect(screen.getByLabelText("同时 active 上限")).toBeInTheDocument();
    expect(
      screen.getByLabelText("失焦自动 suspend 时间（分钟）"),
    ).toBeInTheDocument();
    // 内存预算估算：3 * 150 = 450
    expect(screen.getByText(/\+450\s*MB/)).toBeInTheDocument();
  });

  it("默认值显示 3 / 5", () => {
    render(<BrowserSettingsSection />);
    const maxInput = screen.getByLabelText("同时 active 上限") as HTMLInputElement;
    const timerInput = screen.getByLabelText(
      "失焦自动 suspend 时间（分钟）",
    ) as HTMLInputElement;
    expect(maxInput.value).toBe("3");
    expect(timerInput.value).toBe("5");
  });

  it("改 max_active_tabs：写入 store + 内存预算更新", () => {
    render(<BrowserSettingsSection />);
    const maxInput = screen.getByLabelText("同时 active 上限");

    fireEvent.change(maxInput, { target: { value: "5" } });

    expect(
      useSettingsStore.getState().settings.browser.max_active_tabs,
    ).toBe(5);
    // 5 * 150 = 750
    expect(screen.getByText(/\+750\s*MB/)).toBeInTheDocument();
  });

  it("改 suspend_timer_minutes：写入 store", () => {
    render(<BrowserSettingsSection />);
    const timerInput = screen.getByLabelText(
      "失焦自动 suspend 时间（分钟）",
    );

    fireEvent.change(timerInput, { target: { value: "10" } });

    expect(
      useSettingsStore.getState().settings.browser.suspend_timer_minutes,
    ).toBe(10);
  });

  it("max_active_tabs 输入超上限（>10）：夹紧到 10", () => {
    render(<BrowserSettingsSection />);
    const maxInput = screen.getByLabelText("同时 active 上限");

    fireEvent.change(maxInput, { target: { value: "99" } });

    expect(
      useSettingsStore.getState().settings.browser.max_active_tabs,
    ).toBe(10);
  });

  it("max_active_tabs 输入低于下限（<1）：夹紧到 1", () => {
    render(<BrowserSettingsSection />);
    const maxInput = screen.getByLabelText("同时 active 上限");

    fireEvent.change(maxInput, { target: { value: "0" } });

    expect(
      useSettingsStore.getState().settings.browser.max_active_tabs,
    ).toBe(1);
  });

  it("suspend_timer_minutes 输入超上限（>60）：夹紧到 60", () => {
    render(<BrowserSettingsSection />);
    const timerInput = screen.getByLabelText(
      "失焦自动 suspend 时间（分钟）",
    );

    fireEvent.change(timerInput, { target: { value: "120" } });

    expect(
      useSettingsStore.getState().settings.browser.suspend_timer_minutes,
    ).toBe(60);
  });

  it("展示提示文案：建议 3-5 / 范围 1-10 / 范围 1-60", () => {
    render(<BrowserSettingsSection />);
    expect(screen.getByText(/建议保持 3-5/)).toBeInTheDocument();
    expect(screen.getByText(/范围 1-10/)).toBeInTheDocument();
    expect(screen.getByText(/范围 1-60/)).toBeInTheDocument();
  });

  it("已有非默认配置（5 / 10）：input 显示存量值", () => {
    resetStore(5, 10);
    render(<BrowserSettingsSection />);
    const maxInput = screen.getByLabelText("同时 active 上限") as HTMLInputElement;
    const timerInput = screen.getByLabelText(
      "失焦自动 suspend 时间（分钟）",
    ) as HTMLInputElement;
    expect(maxInput.value).toBe("5");
    expect(timerInput.value).toBe("10");
    // 5 * 150 = 750
    expect(screen.getByText(/\+750\s*MB/)).toBeInTheDocument();
  });
});
