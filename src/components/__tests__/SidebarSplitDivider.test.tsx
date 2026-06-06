import { fireEvent, render, screen } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * v0.6.0-A T3 SplitDivider 集成测试：覆盖 plan §2.4 §4。
 *
 * 1) 拖 FileTree↔主区 → store 的 file_tree_width 更新（onChange 直接调
 *    updateFileTreeWidthLocal 同步 store）。
 * 2) mouseup → settingsUpdate IPC 被 mock 调用一次（参数含当前完整 settings，
 *    其中 ui.file_tree_width 已是拖动后的值）。
 * 3) 同 1/2 但针对 ai_sidebar_width（commitSidebarSettings 复用同一 IPC）。
 * 4) file_tree_position=right 时 SplitDivider direction=left（公式反转：
 *    鼠标右移 → 宽度减小），且 wrapper border-l 而非 border-r。
 * 5) SplitDivider 渲染的 aria-valuenow 反映 store 当前的 file_tree_width。
 *
 * Mock：
 * - lib/tauri.settingsUpdate 替成 vi.fn().mockResolvedValue(undefined)，
 *   断言"mouseup 时被调用一次"。
 * - requestAnimationFrame 同步执行（cb 立刻跑），让 onChange 在 mousemove
 *   后立即生效。
 */

// 必须在 import lib/sidebarResize 之前 mock lib/tauri，避免实际去 invoke
const settingsUpdateMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../../lib/tauri", async (orig) => {
  const real = await orig<typeof import("../../lib/tauri")>();
  return {
    ...real,
    settingsUpdate: (...args: Parameters<typeof real.settingsUpdate>) =>
      settingsUpdateMock(...args),
  };
});

import SplitDivider from "../SplitDivider";
import SidebarWrapper from "../SidebarWrapper";
import {
  commitSidebarSettings,
  updateAiSidebarWidthLocal,
  updateFileTreeWidthLocal,
} from "../../lib/sidebarResize";
import { useSettingsStore } from "../../stores/settings";

/** 重置 settings store 到默认值（其他字段保留默认）。 */
function resetSettings(opts?: {
  fileTreeWidth?: number;
  aiSidebarWidth?: number;
  fileTreePosition?: "left" | "right";
  aiSidebarPosition?: "left" | "right";
}) {
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
        ai_sidebar_position: opts?.aiSidebarPosition ?? "right",
        file_tree_position: opts?.fileTreePosition ?? "left",
        file_tree_width: opts?.fileTreeWidth ?? 240,
        ai_sidebar_width: opts?.aiSidebarWidth ?? 360,
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

/**
 * 测试用最小 layout 片段（mirror App.tsx FileTree-on-left 的 wrapper + divider）。
 * direction="right" 对应"caller 在左、鼠标右移让 value 增大"。
 */
function FileTreeLeftLayout() {
  const width = useSettingsStore((s) => s.settings.ui.file_tree_width);
  return (
    <SidebarWrapper
      width={width}
      borderSide="right"
      data-testid="file-tree-wrapper"
    >
      <div data-testid="file-tree-stub">tree</div>
      <SplitDivider
        value={width}
        defaultValue={240}
        direction="right"
        min={180}
        max={600}
        ariaLabel="调整文件树宽度"
        className="-right-0.5"
        onChange={(next) => updateFileTreeWidthLocal(next)}
        onCommit={() => commitSidebarSettings()}
      />
    </SidebarWrapper>
  );
}

function AiSidebarRightLayout() {
  const width = useSettingsStore((s) => s.settings.ui.ai_sidebar_width);
  return (
    <SidebarWrapper
      width={width}
      borderSide="left"
      data-testid="ai-sidebar-wrapper"
    >
      <div data-testid="ai-sidebar-stub">ai</div>
      <SplitDivider
        value={width}
        defaultValue={360}
        direction="left"
        min={180}
        max={600}
        ariaLabel="调整 AI 侧栏宽度"
        className="-left-0.5"
        onChange={(next) => updateAiSidebarWidthLocal(next)}
        onCommit={() => commitSidebarSettings()}
      />
    </SidebarWrapper>
  );
}

function FileTreeRightLayout() {
  const width = useSettingsStore((s) => s.settings.ui.file_tree_width);
  return (
    <SidebarWrapper
      width={width}
      borderSide="left"
      data-testid="file-tree-wrapper"
    >
      <div data-testid="file-tree-stub">tree</div>
      <SplitDivider
        value={width}
        defaultValue={240}
        direction="left"
        min={180}
        max={600}
        ariaLabel="调整文件树宽度"
        className="-left-0.5"
        onChange={(next) => updateFileTreeWidthLocal(next)}
        onCommit={() => commitSidebarSettings()}
      />
    </SidebarWrapper>
  );
}

describe("SidebarSplitDivider 集成（v0.6.0-A T3）", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rafSpy: any;

  beforeEach(() => {
    settingsUpdateMock.mockClear();
    resetSettings();
    rafSpy = vi
      .spyOn(globalThis, "requestAnimationFrame")
      .mockImplementation(((cb: (t: number) => void) => {
        cb(0);
        return 0;
      }) as typeof requestAnimationFrame);
  });

  afterEach(() => {
    rafSpy?.mockRestore();
  });

  it("FileTree 在左：拖 50px 右移 → store.file_tree_width 同步 240→290", () => {
    render(<FileTreeLeftLayout />);
    const sep = screen.getByRole("separator", { name: "调整文件树宽度" });

    fireEvent.mouseDown(sep, { clientX: 500, button: 0 });
    fireEvent.mouseMove(document, { clientX: 550 });

    expect(
      useSettingsStore.getState().settings.ui.file_tree_width,
    ).toBe(290);
    // mouseup 之前不应触发 IPC
    expect(settingsUpdateMock).not.toHaveBeenCalled();

    fireEvent.mouseUp(document);
  });

  it("FileTree 在左：mouseup 调 settingsUpdate 一次，参数含拖动后的 file_tree_width", () => {
    render(<FileTreeLeftLayout />);
    const sep = screen.getByRole("separator", { name: "调整文件树宽度" });

    fireEvent.mouseDown(sep, { clientX: 100, button: 0 });
    fireEvent.mouseMove(document, { clientX: 200 });
    fireEvent.mouseUp(document);

    expect(settingsUpdateMock).toHaveBeenCalledTimes(1);
    const args = settingsUpdateMock.mock.calls[0][0];
    expect(args.ui.file_tree_width).toBe(340); // 240 + 100
  });

  it("AiSidebar 在右：拖 80px 左移 → store.ai_sidebar_width 同步 360→440", () => {
    render(<AiSidebarRightLayout />);
    const sep = screen.getByRole("separator", { name: "调整 AI 侧栏宽度" });

    // direction=left：鼠标左移（delta<0）→ value 增加
    fireEvent.mouseDown(sep, { clientX: 500, button: 0 });
    fireEvent.mouseMove(document, { clientX: 420 });

    expect(
      useSettingsStore.getState().settings.ui.ai_sidebar_width,
    ).toBe(440);

    fireEvent.mouseUp(document);
    expect(settingsUpdateMock).toHaveBeenCalledTimes(1);
    expect(
      settingsUpdateMock.mock.calls[0][0].ui.ai_sidebar_width,
    ).toBe(440);
  });

  it("FileTree 在右：direction=left + wrapper border-l；鼠标右移 → file_tree_width 减小", () => {
    resetSettings({ fileTreePosition: "right", fileTreeWidth: 300 });
    render(<FileTreeRightLayout />);

    const wrapper = screen.getByTestId("file-tree-wrapper");
    // border-l 通过 className 字符串断言（避免依赖 computed style）
    expect(wrapper.className).toMatch(/\bborder-l\b/);
    expect(wrapper.className).not.toMatch(/\bborder-r\b/);

    const sep = screen.getByRole("separator", { name: "调整文件树宽度" });
    fireEvent.mouseDown(sep, { clientX: 100, button: 0 });
    fireEvent.mouseMove(document, { clientX: 160 });

    // 鼠标右移 60px + direction=left → 300 - 60 = 240
    expect(
      useSettingsStore.getState().settings.ui.file_tree_width,
    ).toBe(240);

    fireEvent.mouseUp(document);
  });

  it("SplitDivider 的 aria-valuenow 反映 store 当前的 file_tree_width", () => {
    resetSettings({ fileTreeWidth: 400 });
    render(<FileTreeLeftLayout />);

    const sep = screen.getByRole("separator", { name: "调整文件树宽度" });
    expect(sep.getAttribute("aria-valuenow")).toBe("400");
    expect(sep.getAttribute("aria-valuemin")).toBe("180");
    expect(sep.getAttribute("aria-valuemax")).toBe("600");
  });

  it("FileTree 在左：wrapper border-r + inline style width 跟随 store", () => {
    resetSettings({ fileTreeWidth: 280 });
    render(<FileTreeLeftLayout />);

    const wrapper = screen.getByTestId("file-tree-wrapper");
    expect(wrapper.className).toMatch(/\bborder-r\b/);
    expect(wrapper.style.width).toBe("280px");
  });

  it("双击 SplitDivider 重置默认宽度 → 调 settingsUpdate 一次", () => {
    resetSettings({ fileTreeWidth: 500 });
    render(<FileTreeLeftLayout />);

    const sep = screen.getByRole("separator", { name: "调整文件树宽度" });
    fireEvent.doubleClick(sep);

    expect(
      useSettingsStore.getState().settings.ui.file_tree_width,
    ).toBe(240);
    expect(settingsUpdateMock).toHaveBeenCalledTimes(1);
    expect(
      settingsUpdateMock.mock.calls[0][0].ui.file_tree_width,
    ).toBe(240);
  });
});
