import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PrivacySection from "../PrivacySection";
import { useSettingsStore } from "../../../stores/settings";

// mock 后端 IPC（参考 SafetySection.test.tsx 写法）
vi.mock("../../../lib/tauri", async (orig) => {
  const real = await orig<typeof import("../../../lib/tauri")>();
  return {
    ...real,
    settingsUpdate: vi.fn().mockResolvedValue(undefined),
  };
});

/** 把 zustand store 重置到测试需要的状态。 */
function resetStore(optIn: boolean) {
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
      privacy: { analytics_opt_in: optIn },
      editor: { open_files: [], active_file: null, font_size: 13 },
    },
    loaded: true,
  });
}

describe("PrivacySection", () => {
  beforeEach(() => {
    resetStore(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("默认 opt-in=true：toggle 渲染为 checked", () => {
    render(<PrivacySection />);
    const cb = screen.getByLabelText("参与匿名使用统计") as HTMLInputElement;
    expect(cb.checked).toBe(true);
  });

  it("opt-in=false：toggle 渲染为 unchecked", () => {
    resetStore(false);
    render(<PrivacySection />);
    const cb = screen.getByLabelText("参与匿名使用统计") as HTMLInputElement;
    expect(cb.checked).toBe(false);
  });

  it("点击 toggle：store.privacy.analytics_opt_in 翻转", () => {
    render(<PrivacySection />);
    const cb = screen.getByLabelText("参与匿名使用统计");

    fireEvent.click(cb);
    expect(
      useSettingsStore.getState().settings.privacy.analytics_opt_in,
    ).toBe(false);

    fireEvent.click(cb);
    expect(
      useSettingsStore.getState().settings.privacy.analytics_opt_in,
    ).toBe(true);
  });

  it("渲染隐私说明：包含 Aptabase 关键词 + 链接", () => {
    render(<PrivacySection />);
    // 说明文字包含 Aptabase
    expect(screen.getByText(/Aptabase/)).toBeInTheDocument();
    // 链接 href 指向 aptabase.com
    const link = screen.getByRole("link", { name: /aptabase\.com/i });
    expect(link).toHaveAttribute("href", "https://aptabase.com");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("渲染'不会收集'文案 + 推荐标记", () => {
    render(<PrivacySection />);
    expect(screen.getByText(/参与匿名使用统计（推荐）/)).toBeInTheDocument();
    // "不会" 强调标签
    expect(screen.getByText("不会")).toBeInTheDocument();
  });
});
