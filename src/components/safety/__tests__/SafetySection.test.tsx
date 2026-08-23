import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SafetySection from "../SafetySection";
import { useSettingsStore } from "../../../stores/settings";

// mock 后端 IPC（vitest 风格参考 ConfirmDialog.test）
vi.mock("../../../lib/tauri", async (orig) => {
  const real = await orig<typeof import("../../../lib/tauri")>();
  return {
    ...real,
    safetyValidatePattern: vi.fn().mockResolvedValue(undefined),
    safetyTestMatch: vi.fn().mockResolvedValue(null),
  };
});

import { safetyTestMatch, safetyValidatePattern } from "../../../lib/tauri";

const mockValidate = safetyValidatePattern as unknown as ReturnType<
  typeof vi.fn
>;
const mockTestMatch = safetyTestMatch as unknown as ReturnType<typeof vi.fn>;

/** 把 zustand store 重置到测试需要的状态。 */
function resetStore(whitelist: string[] = [], showLow = false) {
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
      safety: { whitelist, show_low_auto_approved: showLow },
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

describe("SafetySection", () => {
  beforeEach(() => {
    mockValidate.mockReset();
    mockValidate.mockResolvedValue(undefined);
    mockTestMatch.mockReset();
    mockTestMatch.mockResolvedValue(null);
    resetStore();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("空白名单：显示空提示 + 添加按钮", () => {
    render(<SafetySection />);
    expect(screen.getByText(/暂无条目/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "+ 添加模式" }),
    ).toBeInTheDocument();
  });

  it("已有条目：渲染 list + 删除按钮", () => {
    resetStore(["git status *", "ls *"]);
    render(<SafetySection />);

    expect(screen.getByText("git status *")).toBeInTheDocument();
    expect(screen.getByText("ls *")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "删除模式 git status *" }),
    ).toBeInTheDocument();
  });

  it("添加合法 pattern：调 validate → 写入 store", async () => {
    mockValidate.mockResolvedValueOnce(undefined);
    render(<SafetySection />);

    fireEvent.click(screen.getByRole("button", { name: "+ 添加模式" }));
    const input = await screen.findByLabelText("新白名单模式");
    fireEvent.change(input, { target: { value: "pnpm test *" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(mockValidate).toHaveBeenCalledWith("pnpm test *"));
    await waitFor(() =>
      expect(useSettingsStore.getState().settings.safety.whitelist).toEqual([
        "pnpm test *",
      ]),
    );
  });

  it("添加非法 pattern：显示红色错误 + 不入列表", async () => {
    mockValidate.mockRejectedValueOnce("中括号未闭合");
    render(<SafetySection />);

    fireEvent.click(screen.getByRole("button", { name: "+ 添加模式" }));
    const input = await screen.findByLabelText("新白名单模式");
    fireEvent.change(input, { target: { value: "ls [" } });
    fireEvent.keyDown(input, { key: "Enter" });

    const err = await screen.findByLabelText("模式语法错误");
    expect(err).toHaveTextContent("中括号未闭合");
    // 仍未入 store
    expect(useSettingsStore.getState().settings.safety.whitelist).toEqual([]);
  });

  it("删除 pattern：从 store 移除", () => {
    resetStore(["git status *", "ls *"]);
    render(<SafetySection />);

    fireEvent.click(
      screen.getByRole("button", { name: "删除模式 git status *" }),
    );
    expect(useSettingsStore.getState().settings.safety.whitelist).toEqual([
      "ls *",
    ]);
  });

  it("show_low_auto_approved 切换：写入 store", () => {
    render(<SafetySection />);
    const cb = screen.getByLabelText("自动批准时在工具气泡上显示徽章");
    fireEvent.click(cb);

    expect(
      useSettingsStore.getState().settings.safety.show_low_auto_approved,
    ).toBe(true);
  });

  it("PatternTester 命中：显示 ✓ 命中文字", async () => {
    resetStore(["git status *"]);
    mockTestMatch.mockResolvedValueOnce("git status *");
    render(<SafetySection />);

    const tester = screen.getByLabelText("命中测试输入");
    fireEvent.change(tester, { target: { value: "git status -sb" } });

    const result = await screen.findByLabelText("命中测试结果");
    expect(result).toHaveTextContent("✓ 命中：git status *");
    expect(result.className).toContain("text-[var(--c-success-fg)]");
  });

  it("PatternTester 不命中：显示 ✗ 文字", async () => {
    resetStore(["git status *"]);
    mockTestMatch.mockResolvedValueOnce(null);
    render(<SafetySection />);

    const tester = screen.getByLabelText("命中测试输入");
    fireEvent.change(tester, { target: { value: "rm -rf /" } });

    const result = await screen.findByLabelText("命中测试结果");
    expect(result).toHaveTextContent("不命中");
  });

  it("PatternTester 空输入：不显示结果", () => {
    render(<SafetySection />);
    expect(screen.queryByLabelText("命中测试结果")).toBeNull();
  });
});
