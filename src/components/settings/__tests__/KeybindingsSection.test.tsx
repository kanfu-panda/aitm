import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import KeybindingsSection from "../KeybindingsSection";
import { useSettingsStore } from "../../../stores/settings";
import { DEFAULT_KEYBINDINGS } from "../../../lib/shortcuts";

/**
 * v0.10.0 HR7-7：设置面板"快捷键"tab 单测。
 *
 * 覆盖：
 * - 表格渲染 10 个 action（与 DEFAULT_KEYBINDINGS 数量一致）
 * - 默认 binding 显示 + "恢复默认"按钮 disabled
 * - "修改"→ 弹 capture dialog → 按下键 → 确认 → 写 store
 * - 冲突检测：两个 action 同 binding → 行级红框 + 警告文案
 * - "恢复默认"→ 删覆盖项
 * - "全部恢复默认"→ 清空 overrides
 */

// mock IPC（避免 settingsUpdate fetch；与 SafetySection 测试一致）
vi.mock("../../../lib/tauri", async (orig) => {
  const real = await orig<typeof import("../../../lib/tauri")>();
  return {
    ...real,
    settingsUpdate: vi.fn().mockResolvedValue(undefined),
    settingsGet: vi.fn(),
  };
});

function resetStore(keybindings: Record<string, string> = {}) {
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
    restore_session: true,
        pane_layout: null,
        keybindings,
        language: "en",
      },
      notifications: { sound: true },
      privacy: { analytics_opt_in: true },
      editor: { open_files: [], active_file: null, font_size: 13 },
    },
    loaded: true,
  });
}

describe("KeybindingsSection", () => {
  beforeEach(() => {
    resetStore();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("渲染 12 个 action 行（与 DEFAULT_KEYBINDINGS 数量一致）", () => {
    render(<KeybindingsSection />);
    const expectedCount = Object.keys(DEFAULT_KEYBINDINGS).length;
    expect(expectedCount).toBe(12);
    for (const action of Object.keys(DEFAULT_KEYBINDINGS)) {
      expect(screen.getByTestId(`keybinding-row-${action}`)).toBeInTheDocument();
    }
  });

  it("默认状态下 恢复默认 按钮被禁用", () => {
    render(<KeybindingsSection />);
    const resetBtn = screen.getByTestId("keybinding-reset-newTab") as HTMLButtonElement;
    expect(resetBtn.disabled).toBe(true);
  });

  it("用户已覆盖的 action 行显示 (改) 标签 + 启用恢复按钮", () => {
    resetStore({ newTab: "Cmd+Shift+T" });
    render(<KeybindingsSection />);
    const row = screen.getByTestId("keybinding-row-newTab");
    expect(row.textContent).toContain("(改)");
    const resetBtn = screen.getByTestId("keybinding-reset-newTab") as HTMLButtonElement;
    expect(resetBtn.disabled).toBe(false);
  });

  it("点 修改 弹 capture dialog → 按 Cmd+Shift+N → 确认 → 写 store", async () => {
    render(<KeybindingsSection />);
    fireEvent.click(screen.getByTestId("keybinding-edit-newTab"));

    await waitFor(() => {
      expect(screen.getByTestId("keybinding-capture-dialog")).toBeInTheDocument();
    });

    // 模拟按下 Cmd+Shift+N
    act(() => {
      const ev = new KeyboardEvent("keydown", {
        key: "n",
        metaKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(ev);
    });

    // 预览字符串应该是 Cmd+Shift+N
    await waitFor(() => {
      expect(screen.getByTestId("keybinding-capture-preview").textContent).toBe(
        "Cmd+Shift+N",
      );
    });

    // 点"确认"
    fireEvent.click(screen.getByTestId("keybinding-capture-confirm"));

    await waitFor(() => {
      expect(
        useSettingsStore.getState().settings.ui.keybindings.newTab,
      ).toBe("Cmd+Shift+N");
    });
  });

  it("capture dialog Esc → 关闭不写 store", async () => {
    render(<KeybindingsSection />);
    fireEvent.click(screen.getByTestId("keybinding-edit-newTab"));

    await waitFor(() => {
      expect(screen.getByTestId("keybinding-capture-dialog")).toBeInTheDocument();
    });

    act(() => {
      const ev = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(ev);
    });

    await waitFor(() => {
      expect(screen.queryByTestId("keybinding-capture-dialog")).not.toBeInTheDocument();
    });
    expect(useSettingsStore.getState().settings.ui.keybindings.newTab).toBeUndefined();
  });

  it("两个 action 同 binding → 行级 conflict 标记 + 警告文案", () => {
    // 让 closeTab 也绑 Cmd+T（与 newTab 默认冲突）
    resetStore({ closeTab: "Cmd+T" });
    render(<KeybindingsSection />);

    expect(
      screen.getByTestId("keybindings-conflict-warning"),
    ).toBeInTheDocument();

    const newTabRow = screen.getByTestId("keybinding-row-newTab");
    const closeTabRow = screen.getByTestId("keybinding-row-closeTab");
    expect(newTabRow.getAttribute("data-conflict")).toBe("true");
    expect(closeTabRow.getAttribute("data-conflict")).toBe("true");
  });

  it("无冲突时不显示警告文案", () => {
    render(<KeybindingsSection />);
    expect(
      screen.queryByTestId("keybindings-conflict-warning"),
    ).not.toBeInTheDocument();
  });

  it("点 恢复默认 删除单个覆盖项", () => {
    resetStore({ newTab: "Cmd+Shift+T" });
    render(<KeybindingsSection />);

    expect(useSettingsStore.getState().settings.ui.keybindings.newTab).toBe(
      "Cmd+Shift+T",
    );

    fireEvent.click(screen.getByTestId("keybinding-reset-newTab"));

    expect(
      useSettingsStore.getState().settings.ui.keybindings.newTab,
    ).toBeUndefined();
  });

  it("点 全部恢复默认 清空所有覆盖项", () => {
    resetStore({ newTab: "Cmd+Shift+T", closeTab: "Cmd+Shift+X" });
    render(<KeybindingsSection />);

    expect(
      Object.keys(useSettingsStore.getState().settings.ui.keybindings).length,
    ).toBe(2);

    fireEvent.click(screen.getByTestId("keybindings-reset-all"));

    expect(
      useSettingsStore.getState().settings.ui.keybindings,
    ).toEqual({});
  });

  it("capture dialog 仅 modifier 键按下不更新预览（要求至少一个非修饰键）", async () => {
    render(<KeybindingsSection />);
    fireEvent.click(screen.getByTestId("keybinding-edit-newTab"));

    await waitFor(() => {
      expect(screen.getByTestId("keybinding-capture-dialog")).toBeInTheDocument();
    });

    act(() => {
      // 单独按 Meta（Cmd）
      const ev = new KeyboardEvent("keydown", {
        key: "Meta",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(ev);
    });

    // 预览应保持初始状态（"按下按键..."）
    expect(screen.getByTestId("keybinding-capture-preview").textContent).toBe(
      "按下按键...",
    );

    // 确认按钮禁用
    const confirmBtn = screen.getByTestId(
      "keybinding-capture-confirm",
    ) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
  });
});
