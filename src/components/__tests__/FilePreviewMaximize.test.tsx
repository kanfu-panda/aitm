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
  it("fileEditorActive=false → 不渲染 PanelGroup，只渲染纯终端容器", () => {
    const { queryByTestId } = render(
      <CentralMainArea fileEditorActive={false} />,
    );
    expect(queryByTestId("mock-panel-group")).toBeNull();
    // 纯终端分支仍有 LayoutNodeRendererRoot
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

  it("fileEditorActive false→true 切换不调 setLayout（effect 在 false 早退）", () => {
    const { rerender } = render(
      <CentralMainArea fileEditorActive={false} />,
    );
    expect(setLayoutSpy).not.toHaveBeenCalled();
    rerender(<CentralMainArea fileEditorActive={true} />);
    // mount 时 maximized=false 且无 preMax → effect 走 else 分支 setLayout([55, 45])
    expect(setLayoutSpy).toHaveBeenLastCalledWith([55, 45]);
  });
});
