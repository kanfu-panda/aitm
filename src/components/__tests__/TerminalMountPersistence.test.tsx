/* =============================================================================
 * CentralMainArea 终端子树跨"文件预览开关"保活单测（v1.3.0 P10）
 * -----------------------------------------------------------------------------
 * 背景（P10 真机悬案，维护者原话）：
 *   "主屏同时打开终端和文件预览，正在终端里工作的 Claude Code，当关闭文件预览时，
 *    终端屏幕不能上滚太多；完整退出 Claude Code 再进来后，屏幕又可以滚动了。"
 *
 * 根因：`CentralMainArea` 对 `fileEditorActive` 用**两套结构完全不同的 JSX 分支**
 * （true → PanelGroup/Panel 包裹；false → 裸 div 包裹）。React 在这个位置看到
 * 元素类型变了，会把**整棵终端子树 unmount 重建** ——
 * `TerminalView` 的 cleanup 调 `term.dispose()`，remount 时 `new Terminal()`。
 * 后果不只是丢 scrollback，更要命的是**终端模式全部复位**：
 *   - `ESC[?1049h`（进备用屏）、鼠标追踪、DECCKM 都是**旧实例**消费掉的，
 *     PTY 不会重发；Claude Code 这类全屏 TUI 只在 SIGWINCH 时重绘内容。
 *   - 新 xterm 自认为在普通屏 → `altScroll.shouldAltScroll` 判 false → 滚轮不再
 *     转方向键交给 CC，只能滚新实例那点空 scrollback = "上滚不了太多"。
 *   - 完整退出 CC 再进来，新实例这次真收到了 `ESC[?1049h` → 又能滚了。
 *
 * 因此本测试锁住的不变量是：**开关文件预览不得重建终端子树**。
 *
 * 这里**故意用真实的 react-resizable-panels**（不 mock）：修法依赖"条件渲染
 * Panel 时库按稳定 id/order 复用"这一真实行为，mock 掉就测不到了；顺带断言
 * 单 Panel 布局不会打 "Invalid layout total size" 警告。
 *
 * 说明：真实 xterm.js + PTY + TUI 的行为无法在 jsdom 里单测，这里只能锁住
 * React 层"不重建"这一必要条件；备用屏模式是否真的保住需真机验证。
 * ========================================================================== */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { useEffect } from "react";

vi.mock("../FilePreviewWorkspace", () => ({
  __esModule: true,
  default: () => <div data-testid="mock-file-preview-workspace" />,
}));

// 用 mount 计数器替身代表"终端子树"（真实链路 LayoutNodeRenderer →
// TerminalPaneGroup → TerminalView → new Terminal()）。计数 > 1 即等价于
// 真机上的 xterm 实例被销毁重建。
const mountCounter = { mounts: 0, unmounts: 0 };
vi.mock("../panes/LayoutNodeRenderer", () => ({
  __esModule: true,
  LayoutNodeRenderer: () => {
    useEffect(() => {
      mountCounter.mounts += 1;
      return () => {
        mountCounter.unmounts += 1;
      };
    }, []);
    return <div data-testid="mock-layout-renderer" />;
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import { CentralMainArea } from "../../App";
import { useFileEditorStore } from "../../stores/file-editor";

/** react-resizable-panels 的 autoSave 走 localStorage；逐用例清掉避免串味。
 *  jsdom 环境下 localStorage 不一定挂在 globalThis 上，取 window 并容错。 */
function clearPanelStorage(): void {
  try {
    globalThis.window?.localStorage?.clear();
  } catch {
    /* 无 storage 环境（库自己也会降级成 noop storage），忽略 */
  }
}

/** 断言用：收集 react-resizable-panels 的布局非法警告。 */
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mountCounter.mounts = 0;
  mountCounter.unmounts = 0;
  clearPanelStorage();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  useFileEditorStore.setState({
    openFiles: [],
    activeId: null,
    maximized: false,
  });
});

afterEach(() => {
  cleanup();
  warnSpy.mockRestore();
  clearPanelStorage();
  useFileEditorStore.setState({
    openFiles: [],
    activeId: null,
    maximized: false,
  });
});

describe("P10：文件预览开关不得重建终端子树", () => {
  it("打开文件预览（false→true）不 unmount 终端子树", () => {
    const { rerender } = render(<CentralMainArea fileEditorActive={false} />);
    expect(mountCounter.mounts).toBe(1);

    rerender(<CentralMainArea fileEditorActive={true} />);

    expect(mountCounter.unmounts).toBe(0);
    expect(mountCounter.mounts).toBe(1);
  });

  it("关闭文件预览（true→false）不 unmount 终端子树（P10 主复现路径）", () => {
    const { rerender } = render(<CentralMainArea fileEditorActive={true} />);
    expect(mountCounter.mounts).toBe(1);

    rerender(<CentralMainArea fileEditorActive={false} />);

    expect(mountCounter.unmounts).toBe(0);
    expect(mountCounter.mounts).toBe(1);
  });

  it("反复开关文件预览，终端子树始终只 mount 一次、DOM 节点也不换", () => {
    const { getByTestId, rerender } = render(
      <CentralMainArea fileEditorActive={false} />,
    );
    const firstNode = getByTestId("mock-layout-renderer");

    for (let i = 0; i < 5; i++) {
      rerender(<CentralMainArea fileEditorActive={true} />);
      rerender(<CentralMainArea fileEditorActive={false} />);
    }

    expect(mountCounter.mounts).toBe(1);
    expect(mountCounter.unmounts).toBe(0);
    // DOM 节点同一实例 —— 真机上等价于 xterm 挂载的那个 container 没被换掉
    expect(getByTestId("mock-layout-renderer")).toBe(firstNode);
  });

  it("预览收起时只卸掉分割条 + 编辑器面板，终端面板原地保活", () => {
    const { container, queryByTestId, rerender } = render(
      <CentralMainArea fileEditorActive={true} />,
    );
    expect(queryByTestId("mock-file-preview-workspace")).not.toBeNull();
    expect(
      container.querySelector("[data-panel-resize-handle-id]"),
    ).not.toBeNull();
    expect(container.querySelectorAll("[data-panel]").length).toBe(2);

    rerender(<CentralMainArea fileEditorActive={false} />);

    expect(queryByTestId("mock-file-preview-workspace")).toBeNull();
    expect(container.querySelector("[data-panel-resize-handle-id]")).toBeNull();
    expect(container.querySelectorAll("[data-panel]").length).toBe(1);
    // PanelGroup 本身常驻
    expect(container.querySelector("[data-panel-group]")).not.toBeNull();
    expect(queryByTestId("mock-layout-renderer")).not.toBeNull();
  });

  it("单 Panel 布局（预览收起）不触发库的 Invalid layout total size 警告", () => {
    const { rerender } = render(<CentralMainArea fileEditorActive={true} />);
    rerender(<CentralMainArea fileEditorActive={false} />);
    rerender(<CentralMainArea fileEditorActive={true} />);

    const invalid = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes("Invalid layout total size"),
    );
    expect(invalid).toEqual([]);
  });
});
