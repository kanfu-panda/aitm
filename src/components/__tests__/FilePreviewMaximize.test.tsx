/* =============================================================================
 * CentralMainArea 文件预览双击 maximize regression 单测（v0.10.6 T3）
 * -----------------------------------------------------------------------------
 * 背景：v0.10.0 HR9-1 重构连带删除了 App.tsx 对 useFileEditorStore.maximized
 * 的消费点 —— store action + UI handler 都在，但 PanelGroup 没读 maximized
 * → 双击 active tab 调 toggleMaximized 改 store，比例纹丝不动。
 *
 * 本测试验证 T3 imperativePanelApi 修复：
 *   - fileEditorActive=true → render PanelGroup
 *   - toggleMaximized true → 调 setLayout([0, 100])
 *   - toggleMaximized 回 false → 调 setLayout(preMaxLayout)（首次没 preMax 用 55/45）
 *   - fileEditorActive=false → 不 render PanelGroup（切到纯终端分支）
 *
 * 实现策略：mock react-resizable-panels，PanelGroup 用 forwardRef 暴露
 *   { setLayout: spy, getLayout: () => [55, 45] }，Panel/PanelResizeHandle stub。
 *   不依赖真实库 DOM 测量逻辑。
 * ========================================================================== */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { forwardRef, useImperativeHandle, type ReactNode } from "react";
import type {
  ImperativePanelGroupHandle,
  PanelGroupProps,
  PanelProps,
} from "react-resizable-panels";

// ---- mock react-resizable-panels ----
//
// 暴露一个共享的 setLayout spy + 可控的 getLayout 返回值，让 test 直接读 / 改。
const setLayoutSpy = vi.fn<(layout: number[]) => void>();
let nextGetLayoutValue: number[] = [55, 45];
/** mock PanelGroup 收到的 onLayout（测试用它模拟库的布局变化回调）。 */
let lastOnLayout: ((layout: number[]) => void) | null = null;

function setNextGetLayout(v: number[]) {
  nextGetLayoutValue = v;
}

vi.mock("react-resizable-panels", () => {
  const PanelGroup = forwardRef<
    ImperativePanelGroupHandle,
    PanelGroupProps & { children?: ReactNode }
  >(function PanelGroupMock(props, ref) {
    useImperativeHandle(
      ref,
      (): ImperativePanelGroupHandle => ({
        // 真库的 getId 返回 string；这里 stub 用 autoSaveId 或固定值
        getId: () => props.autoSaveId ?? "mock-pg",
        getLayout: () => nextGetLayoutValue,
        setLayout: setLayoutSpy,
      }),
      [props.autoSaveId],
    );
    // 把 onLayout 暴露出来：真库在 autoSave 恢复 / 用户拖动后都会调它，
    // 测试要靠它模拟"effect 跑完之后布局才被恢复成 [0,100]"这个真实时序。
    lastOnLayout = props.onLayout ?? null;
    return <div data-testid="mock-panel-group">{props.children}</div>;
  });
  const Panel = (props: PanelProps & { children?: ReactNode }) => (
    <div data-testid={`mock-panel-${props.id ?? "noid"}`}>{props.children}</div>
  );
  const PanelResizeHandle = () => <div data-testid="mock-panel-handle" />;
  return {
    __esModule: true,
    PanelGroup,
    Panel,
    PanelResizeHandle,
  };
});

// ---- mock 重型子组件 ----
//
// FilePreviewWorkspace / LayoutNodeRendererRoot 不是本测试关心的内容，
// stub 掉避免拖入 CodeMirror / xterm / Tauri IPC 之类的副作用。

vi.mock("../FilePreviewWorkspace", () => ({
  __esModule: true,
  default: () => <div data-testid="mock-file-preview-workspace" />,
}));

// LayoutNodeRendererRoot 不是导出 component，是 App.tsx 内部 function；
// 它依赖 usePaneLayoutStore + LayoutNodeRenderer + 一堆下游组件。
// 测试只关心 CentralMainArea 的 PanelGroup 行为，不关心终端内容渲染——
// 用 i18n / store mock 让它能 mount 但不真渲染终端就行。
//
// 实际上 CentralMainArea 内部直接 import 了 LayoutNodeRendererRoot
// （定义在 App.tsx 同文件内），不能单独 mock。改为 mock 它的依赖：
// useTranslation 已经能用 react-i18next test setup；
// pane-layout store 用 setState 灌一个 minimal root 即可——但 LayoutNodeRenderer
// 真渲染终端会调 invoke。所以最稳的方式是 mock LayoutNodeRenderer 模块：
vi.mock("../panes/LayoutNodeRenderer", () => ({
  __esModule: true,
  LayoutNodeRenderer: () => <div data-testid="mock-layout-renderer" />,
}));

// i18n：返回 key 即可，本测试不断言文案
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

// ---- import 待测组件 + store ----
import { CentralMainArea } from "../../App";
import { useFileEditorStore } from "../../stores/file-editor";

afterEach(() => {
  cleanup();
  setLayoutSpy.mockClear();
  setNextGetLayout([55, 45]);
  // 重置 file-editor store
  useFileEditorStore.setState({
    openFiles: [],
    activeId: null,
    maximized: false,
  });
});

beforeEach(() => {
  setLayoutSpy.mockClear();
  useFileEditorStore.setState({
    openFiles: [],
    activeId: null,
    maximized: false,
  });
});

describe("CentralMainArea v0.10.6 T3 maximize regression", () => {
  // v1.3.0 P10 起 PanelGroup 常驻（条件 unmount 会重建 xterm 实例 →
  // 备用屏状态丢失 → 关掉预览后终端滚不动，见 TerminalMountPersistence.test.tsx）。
  // 预览收起时只卸掉「分割条 + 编辑器 Panel」，终端 Panel 原地保活。
  it("fileEditorActive=false → PanelGroup 仍在，只剩终端 Panel", () => {
    const { queryByTestId } = render(
      <CentralMainArea fileEditorActive={false} />,
    );
    expect(queryByTestId("mock-panel-group")).not.toBeNull();
    expect(queryByTestId("mock-panel-terminal")).not.toBeNull();
    expect(queryByTestId("mock-panel-editor")).toBeNull();
    expect(queryByTestId("mock-panel-handle")).toBeNull();
    expect(queryByTestId("mock-layout-renderer")).not.toBeNull();
  });

  it("fileEditorActive=true → 渲染 PanelGroup + terminal panel + editor panel", () => {
    const { getByTestId } = render(<CentralMainArea fileEditorActive={true} />);
    expect(getByTestId("mock-panel-group")).toBeTruthy();
    expect(getByTestId("mock-panel-terminal")).toBeTruthy();
    expect(getByTestId("mock-panel-editor")).toBeTruthy();
    expect(getByTestId("mock-panel-handle")).toBeTruthy();
  });

  it("toggleMaximized → true：调 setLayout([0, 100])", () => {
    render(<CentralMainArea fileEditorActive={true} />);
    // 初次 mount 时 maximized=false 且没有 preMax，会触发 setLayout([55, 45])
    // —— 这是 effect 的初次同步，先 clear 再断言 toggle 行为
    setLayoutSpy.mockClear();
    // 模拟当前 layout 是 60/40（用户拖过）
    setNextGetLayout([60, 40]);
    act(() => {
      useFileEditorStore.getState().toggleMaximized();
    });
    expect(setLayoutSpy).toHaveBeenCalledTimes(1);
    expect(setLayoutSpy).toHaveBeenCalledWith([0, 100]);
  });

  it("toggleMaximized 两次 → 第二次恢复到 maximize 前的比例", () => {
    render(<CentralMainArea fileEditorActive={true} />);
    setLayoutSpy.mockClear();

    // 当前比例 70/30（用户拖过）
    setNextGetLayout([70, 30]);
    act(() => {
      useFileEditorStore.getState().toggleMaximized();
    });
    expect(setLayoutSpy).toHaveBeenLastCalledWith([0, 100]);

    // 再次 toggle 退出 max → 应回到 [70, 30]
    act(() => {
      useFileEditorStore.getState().toggleMaximized();
    });
    expect(setLayoutSpy).toHaveBeenLastCalledWith([70, 30]);
  });

  it("初次 mount 后直接退出 max（没 preMax 记录）→ setLayout([55, 45])", () => {
    // 模拟 store 已经处于 maximized=true 状态（边界场景）
    useFileEditorStore.setState({ maximized: true });
    render(<CentralMainArea fileEditorActive={true} />);
    // 初次 effect：maximized=true + 没 preMax → 走 maximized 分支 setLayout([0,100])
    expect(setLayoutSpy).toHaveBeenLastCalledWith([0, 100]);
    setLayoutSpy.mockClear();
    // toggle 退出
    act(() => {
      useFileEditorStore.getState().toggleMaximized();
    });
    // preMax 是 mount 时调 getLayout 拿的 [55, 45]（默认 mock 返回值）
    expect(setLayoutSpy).toHaveBeenLastCalledWith([55, 45]);
  });

  it("fileEditorActive false→true 且比例正常时不动布局（保留用户拖过的比例）", () => {
    // v1.3.0 真机回归修复：原来这里无条件 setLayout([55, 45])，会把用户拖过的比例
    // 冲掉。现在只在检测到"异常塌陷"时才纠正，正常比例一律保留。
    nextGetLayoutValue = [70, 30]; // 用户自己拖成 70/30
    const { rerender } = render(<CentralMainArea fileEditorActive={false} />);
    expect(setLayoutSpy).not.toHaveBeenCalled();
    rerender(<CentralMainArea fileEditorActive={true} />);
    expect(setLayoutSpy).not.toHaveBeenCalled();
  });

  it("fileEditorActive false→true 时自愈 autoSave 残留的 maximize 布局", () => {
    // 🔴 真机回归：P10 让 PanelGroup 常驻后，autoSaveId 把 maximize 时的 [0, 100]
    // 持久化下来，下次打开预览就"一进来占满全屏"，双击 maximize 反而掰回分屏。
    // 非 maximize 态下终端被压到近 0 只可能是残留，必须自愈回默认分屏。
    nextGetLayoutValue = [0, 100];
    const { rerender } = render(<CentralMainArea fileEditorActive={false} />);
    rerender(<CentralMainArea fileEditorActive={true} />);
    expect(setLayoutSpy).toHaveBeenLastCalledWith([55, 45]);
  });
});

describe("CentralMainArea v1.3.0 布局守卫（autoSave 恢复晚于 effect）", () => {
  it("autoSave 在 effect 之后把布局恢复成 [0,100] → onLayout 守卫纠正回 55/45", () => {
    // 🔴 这正是真机回归两次都没修好的时序：
    // effect 里 getLayout() 读到的还是正常值（55/45），检查通过什么也不做；
    // 之后库才从 localStorage 把上次 maximize 存的 [0,100] 恢复上去 →
    // 用户看到"一打开预览终端就没了"。onLayout 是唯一能兜住这一刻的钩子。
    render(<CentralMainArea fileEditorActive={true} />);
    setLayoutSpy.mockClear();

    act(() => {
      lastOnLayout?.([0, 100]); // 模拟 autoSave 恢复
    });
    expect(setLayoutSpy).toHaveBeenCalledWith([55, 45]);
  });

  it("maximize 态下 onLayout([0,100]) 不纠正（那是用户要的全屏）", () => {
    useFileEditorStore.setState({ maximized: true });
    render(<CentralMainArea fileEditorActive={true} />);
    setLayoutSpy.mockClear();

    act(() => {
      lastOnLayout?.([0, 100]);
    });
    expect(setLayoutSpy).not.toHaveBeenCalled();
  });

  it("正常比例的 onLayout 不触发纠正（不干扰用户拖动）", () => {
    render(<CentralMainArea fileEditorActive={true} />);
    setLayoutSpy.mockClear();

    act(() => {
      lastOnLayout?.([70, 30]);
    });
    expect(setLayoutSpy).not.toHaveBeenCalled();
  });

  it("预览未打开时不纠正（只剩终端 Panel，布局本就是 [100]）", () => {
    render(<CentralMainArea fileEditorActive={false} />);
    setLayoutSpy.mockClear();

    act(() => {
      lastOnLayout?.([0, 100]);
    });
    expect(setLayoutSpy).not.toHaveBeenCalled();
  });
});
