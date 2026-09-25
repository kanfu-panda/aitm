import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
 * 2026-09-24 补充：Radix Tabs.Trigger 靠 `onMouseDown`（不是 `onClick`）判断
 * `event.button === 0 && event.ctrlKey === false` 来切 tab；jsdom 原生支持
 * MouseEvent 的 button 字段，所以 `fireEvent.mouseDown(trigger, {button:0})`
 * 在这台环境实测完全可靠（`fireEvent.click` 才是那个不生效的）。下面新增的
 * "外观 tab" / "语言 tab" 用例都走这条路径真实切换；旧注释说的"jsdom 不可靠"
 * 只针对 click，不影响这里保留的浅渲染测。
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

describe("SettingsModal — initialTab", () => {
  it("带 initialTab='appearance' 打开时直接落在外观 tab（不用手动切）", () => {
    render(
      <SettingsModal
        open={true}
        onOpenChange={() => {}}
        initialTab="appearance"
      />,
    );
    expect(screen.getByTestId("settings-tab-appearance")).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});

describe("SettingsModal — 外观 tab", () => {
  // 每个用例都重置 ui.* 到出厂默认，避免用例之间互相污染（同一 zustand
  // store 是模块级单例，跨用例共享）。
  beforeEach(() => {
    useSettingsStore.setState((s) => ({
      settings: {
        ...s.settings,
        ui: {
          ...s.settings.ui,
          activity_bar_position: "right",
          theme_mode: "dark",
          ai_sidebar_position: "right",
          file_tree_position: "left",
          confirm_quit: true,
          restore_session: true,
        },
        notifications: { sound: true },
      },
    }));
  });

  function openAppearance() {
    render(<SettingsModal open={true} onOpenChange={() => {}} />);
    fireEvent.mouseDown(screen.getByTestId("settings-tab-appearance"), {
      button: 0,
    });
  }

  it("切到外观 tab 后渲染各 section", () => {
    openAppearance();
    expect(screen.getByText("布局")).toBeInTheDocument();
    expect(screen.getByText("主题模式")).toBeInTheDocument();
    expect(screen.getByText("侧栏布局")).toBeInTheDocument();
    expect(screen.getByText("通用")).toBeInTheDocument();
    expect(screen.getByText("通知")).toBeInTheDocument();
  });

  it("点击 ActivityBar 位置 '左侧' → store 更新", () => {
    openAppearance();
    fireEvent.click(screen.getByRole("radio", { name: "ActivityBar 左侧" }));
    expect(
      useSettingsStore.getState().settings.ui.activity_bar_position,
    ).toBe("left");
  });

  it("点击主题模式 '跟随系统' → store 更新", () => {
    openAppearance();
    fireEvent.click(
      screen.getByRole("radio", { name: "主题模式 跟随系统" }),
    );
    expect(useSettingsStore.getState().settings.ui.theme_mode).toBe("auto");
  });

  it("点击 AI 侧栏位置 '左侧' → store 更新", () => {
    openAppearance();
    fireEvent.click(screen.getByTestId("ai-sidebar-pos-left"));
    expect(
      useSettingsStore.getState().settings.ui.ai_sidebar_position,
    ).toBe("left");
  });

  it("点击文件树位置 '右侧' → store 更新", () => {
    openAppearance();
    fireEvent.click(screen.getByTestId("file-tree-pos-right"));
    expect(useSettingsStore.getState().settings.ui.file_tree_position).toBe(
      "right",
    );
  });

  it("切换'退出时确认' checkbox → store 取反", () => {
    openAppearance();
    const box = screen.getByTestId("confirm-quit-toggle") as HTMLInputElement;
    const before = box.checked;
    fireEvent.click(box);
    expect(useSettingsStore.getState().settings.ui.confirm_quit).toBe(
      !before,
    );
  });

  it("切换'启动时恢复上次会话' checkbox → store 取反", () => {
    openAppearance();
    const box = screen.getByTestId(
      "restore-session-toggle",
    ) as HTMLInputElement;
    const before = box.checked;
    fireEvent.click(box);
    expect(useSettingsStore.getState().settings.ui.restore_session).toBe(
      !before,
    );
  });

  it("切换'系统通知声音' checkbox → store 取反", () => {
    openAppearance();
    const box = screen.getByLabelText("系统通知声音") as HTMLInputElement;
    const before = box.checked;
    fireEvent.click(box);
    expect(useSettingsStore.getState().settings.notifications.sound).toBe(
      !before,
    );
  });
});

describe("SettingsModal — 语言 tab", () => {
  beforeEach(() => {
    useSettingsStore.setState((s) => ({
      settings: { ...s.settings, ui: { ...s.settings.ui, language: "en" } },
    }));
  });

  function openLanguage() {
    render(<SettingsModal open={true} onOpenChange={() => {}} />);
    fireEvent.mouseDown(screen.getByTestId("settings-tab-language"), {
      button: 0,
    });
  }

  it("切到语言 tab，渲染 3 个语言选项，当前语言被勾选", () => {
    openLanguage();
    expect(screen.getByTestId("language-radio-en")).toBeChecked();
    expect(screen.getByTestId("language-radio-zh-CN")).not.toBeChecked();
    expect(screen.getByTestId("language-radio-ja")).not.toBeChecked();
  });

  it("点击 简体中文 → store 更新 language='zh-CN'", () => {
    openLanguage();
    fireEvent.click(screen.getByTestId("language-radio-zh-CN"));
    expect(useSettingsStore.getState().settings.ui.language).toBe("zh-CN");
  });
});

describe("SettingsModal — 终端 tab 补充交互", () => {
  it("字体族下拉选另一预设 → store 更新 font_family", () => {
    render(<SettingsModal open={true} onOpenChange={() => {}} />);
    const selects = screen.getAllByRole("combobox");
    fireEvent.change(selects[0], {
      target: { value: "'JetBrains Mono', Menlo, monospace" },
    });
    expect(useSettingsStore.getState().settings.terminal.font_family).toBe(
      "'JetBrains Mono', Menlo, monospace",
    );
  });

  it("字体族手输文本框 → store 更新 font_family", () => {
    render(<SettingsModal open={true} onOpenChange={() => {}} />);
    const input = screen.getByPlaceholderText(
      "CSS 字体栈，如 'Fira Code', monospace",
    );
    fireEvent.change(input, { target: { value: "'Custom Font', monospace" } });
    expect(useSettingsStore.getState().settings.terminal.font_family).toBe(
      "'Custom Font', monospace",
    );
  });

  it("拖字号滑杆 → store 更新 font_size", () => {
    render(<SettingsModal open={true} onOpenChange={() => {}} />);
    const sliders = screen.getAllByRole("slider");
    fireEvent.change(sliders[0], { target: { value: "18" } });
    expect(useSettingsStore.getState().settings.terminal.font_size).toBe(18);
  });

  it("拖行高滑杆 → store 更新 line_height", () => {
    render(<SettingsModal open={true} onOpenChange={() => {}} />);
    const sliders = screen.getAllByRole("slider");
    fireEvent.change(sliders[1], { target: { value: "1.5" } });
    expect(useSettingsStore.getState().settings.terminal.line_height).toBe(
      1.5,
    );
  });

  it("点击光标样式按钮 → store 更新 cursor_style", () => {
    render(<SettingsModal open={true} onOpenChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "_ 下划线" }));
    expect(useSettingsStore.getState().settings.terminal.cursor_style).toBe(
      "underline",
    );
  });

  it("Shell 路径输入 → store 更新 default_shell", () => {
    render(<SettingsModal open={true} onOpenChange={() => {}} />);
    const input = screen.getByPlaceholderText(
      "例如：/bin/zsh、/opt/homebrew/bin/fish",
    );
    fireEvent.change(input, { target: { value: "/bin/zsh" } });
    expect(useSettingsStore.getState().settings.shell.default_shell).toBe(
      "/bin/zsh",
    );
  });

  it("编辑器字号下拉 → store 更新 editor.font_size", () => {
    render(<SettingsModal open={true} onOpenChange={() => {}} />);
    const selects = screen.getAllByRole("combobox");
    fireEvent.change(selects[1], { target: { value: "18" } });
    expect(useSettingsStore.getState().settings.editor.font_size).toBe(18);
  });
});
