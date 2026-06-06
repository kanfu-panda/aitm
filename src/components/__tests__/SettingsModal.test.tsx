import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "../../stores/settings";

// mock providersGetConfig 避免 fetch；其余 IPC 方法保持 real
vi.mock("../../lib/tauri", async (orig) => {
  const real = await orig<typeof import("../../lib/tauri")>();
  return {
    ...real,
    providersGetConfig: vi.fn().mockResolvedValue([]),
    safetyValidatePattern: vi.fn().mockResolvedValue(undefined),
    safetyTestMatch: vi.fn().mockResolvedValue(null),
  };
});

import SettingsModal from "../SettingsModal";

/**
 * SettingsModal Tab 布局浅渲染测。
 *
 * Radix Tabs 的 click 切换逻辑用 pointer events，在 jsdom 里 fireEvent.click
 * 不可靠 — 完整切换交互放 Playwright E2E（settings-tabs.spec.ts）。
 * 这里只测：渲染 / 默认 active / a11y / 关闭态。
 */
describe("SettingsModal — Tab 布局", () => {
  it("渲染所有 tab trigger（v0.10.4：用 testid 断言不依赖 i18n 文案）", () => {
    render(<SettingsModal open={true} onOpenChange={() => {}} />);

    expect(screen.getByTestId("settings-tab-terminal")).toBeInTheDocument();
    expect(screen.getByTestId("settings-tab-providers")).toBeInTheDocument();
    expect(screen.getByTestId("settings-tab-safety")).toBeInTheDocument();
    expect(screen.getByTestId("settings-tab-privacy")).toBeInTheDocument();
    expect(screen.getByTestId("settings-tab-browser")).toBeInTheDocument();
  });

  it("默认 active 是终端 tab，字体族可见", () => {
    render(<SettingsModal open={true} onOpenChange={() => {}} />);

    const terminalTrigger = screen.getByTestId("settings-tab-terminal");
    expect(terminalTrigger).toHaveAttribute("aria-selected", "true");

    // 终端 tab 内容（字体 / 光标 / Shell）的标识元素
    expect(screen.getByText("字体族")).toBeInTheDocument();
  });

  it("Tabs 是 vertical 方向（左侧 list）", () => {
    render(<SettingsModal open={true} onOpenChange={() => {}} />);

    const tablist = screen.getByRole("tablist", { name: "设置分类" });
    expect(tablist).toHaveAttribute("aria-orientation", "vertical");
  });

  it("modal 关闭时不渲染内容", () => {
    render(<SettingsModal open={false} onOpenChange={() => {}} />);
    // Dialog.Portal 关闭时 children 不挂载
    expect(screen.queryByTestId("settings-tab-terminal")).toBeNull();
  });

  // ===== 1G + v0.4.1 T5 主题色卡 =====

  it("终端 tab 渲染 13 个主题色卡（默认 + 12 套预设；T5 加 5 套）", () => {
    render(<SettingsModal open={true} onOpenChange={() => {}} />);

    const radioGroup = screen.getByRole("radiogroup", { name: "终端主题" });
    expect(radioGroup).toBeInTheDocument();

    const swatches = screen.getAllByRole("radio");
    expect(swatches).toHaveLength(13);
    expect(screen.getByRole("radio", { name: "主题 默认" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "主题 Dracula" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "主题 Solarized Dark" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "主题 Solarized Light" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "主题 One Dark" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "主题 One Light" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "主题 Homebrew" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "主题 Warp" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "主题 Catppuccin Mocha" })).toBeInTheDocument();
    // v0.4.1 T5 新增
    expect(screen.getByRole("radio", { name: "主题 GitHub Dark" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "主题 GitHub Light" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "主题 Monokai" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "主题 Monokai Light" })).toBeInTheDocument();
  });

  it("默认 active 是 default 主题（aria-checked=true）", () => {
    render(<SettingsModal open={true} onOpenChange={() => {}} />);
    const def = screen.getByRole("radio", { name: "主题 默认" });
    expect(def).toHaveAttribute("aria-checked", "true");
  });

  it("点击 Dracula 色卡 → store 更新 theme = 'dracula'", () => {
    render(<SettingsModal open={true} onOpenChange={() => {}} />);

    fireEvent.click(screen.getByRole("radio", { name: "主题 Dracula" }));

    expect(
      useSettingsStore.getState().settings.terminal.theme,
    ).toBe("dracula");
  });

  // ===== v0.9.0 T4：关闭应用二次确认 toggle =====
  // 注意：Radix Tabs 切换需要 pointer events，jsdom 不可靠（见文件顶部注释）；
  // toggle 的实际交互验证放在 Playwright E2E（quit-confirm.spec.ts）。
  // 这里只验"外观"tab 的 trigger 存在 + 渲染 / 默认状态。
  it("外观 tab trigger 存在（GeneralSection 渲染入口）", () => {
    render(<SettingsModal open={true} onOpenChange={() => {}} />);
    expect(screen.getByRole("tab", { name: "外观" })).toBeInTheDocument();
  });
});
