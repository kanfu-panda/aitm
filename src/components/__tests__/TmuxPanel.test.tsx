import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TmuxSession } from "../../lib/tauri";

/**
 * TmuxPanel 单测。
 *
 * 覆盖：列表渲染、已连接标记、两种空状态、点击接入、右键菜单三个动作、刷新。
 * lib/tauri 整模块 mock。结束会话的确认走应用内对话框：WKWebView 不实现
 * `window.confirm`（直接返回 false、不弹窗），所以测试里把它钉成 false 来模拟 macOS 上的实际行为。
 */

const tmuxAvailableMock = vi.fn();
const tmuxListSessionsMock = vi.fn();
const tmuxAttachCommandMock = vi.fn();
const tmuxInterruptSessionMock = vi.fn();
const tmuxKillSessionMock = vi.fn();
const tmuxNewSessionMock = vi.fn();
const tmuxRenameSessionMock = vi.fn();
const tmuxCapturePaneMock = vi.fn();
const sessionCurrentCwdMock = vi.fn();

vi.mock("../../lib/tauri", async (orig) => {
  const real = await orig<typeof import("../../lib/tauri")>();
  return {
    ...real,
    tmuxAvailable: () => tmuxAvailableMock(),
    tmuxListSessions: () => tmuxListSessionsMock(),
    tmuxAttachCommand: (id: string, takeover: boolean) =>
      tmuxAttachCommandMock(id, takeover),
    tmuxInterruptSession: (id: string) => tmuxInterruptSessionMock(id),
    tmuxKillSession: (id: string) => tmuxKillSessionMock(id),
    tmuxNewSession: (name: string, cwd: string | null) =>
      tmuxNewSessionMock(name, cwd),
    tmuxRenameSession: (id: string, name: string) =>
      tmuxRenameSessionMock(id, name),
    tmuxCapturePane: (id: string) => tmuxCapturePaneMock(id),
    sessionCurrentCwd: (id: string) => sessionCurrentCwdMock(id),
  };
});

import TmuxPanel from "../tmux/TmuxPanel";
import { hasNewOutput, useTmuxStore } from "../../stores/tmux";
import { useTabsStore } from "../../stores/tabs";
import {
  INITIAL_GROUP_ID,
  usePaneLayoutStore,
  type LayoutNode,
} from "../../stores/pane-layout";

function session(
  name: string,
  attached = 0,
  activity = 100,
): TmuxSession {
  return {
    id: `$${name}`,
    activity,
    name,
    windows: 2,
    attached,
    created: 1_700_000_000,
    current_path: "/home/dev/demo",
    current_command: "zsh",
    title: `${name} 的任务`,
  };
}

/** 等面板打开时那次自动 refresh 落定。 */
async function renderPanel() {
  const view = render(<TmuxPanel />);
  await waitFor(() => expect(tmuxAvailableMock).toHaveBeenCalled());
  return view;
}

describe("TmuxPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTmuxStore.setState({
      sessions: [],
      loading: false,
      error: null,
      available: true,
      seen: {},
    });
    useTabsStore.setState({ tabs: [], activeId: null, unreadByTab: {} });
    usePaneLayoutStore.setState({
      root: {
        kind: "leaf",
        group: {
          id: INITIAL_GROUP_ID,
          type: "terminal",
          tab_ids: [],
          active_tab_id: null,
        },
      },
      active_group_id: INITIAL_GROUP_ID,
    });
    tmuxAvailableMock.mockResolvedValue(true);
    tmuxListSessionsMock.mockResolvedValue([]);
    tmuxAttachCommandMock.mockResolvedValue("tmux attach-session -t 'alpha'");
  });

  it("UT-P01 有会话时渲染等量列表项并显示名称与任务标签", async () => {
    tmuxListSessionsMock.mockResolvedValue([session("alpha"), session("beta")]);
    await renderPanel();

    await waitFor(() =>
      expect(screen.getAllByTestId(/^tmux-session-item-/)).toHaveLength(2),
    );
    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(screen.getByText("alpha 的任务")).toBeInTheDocument();
  });

  it("UT-P02 attached > 0 时显示已连接标记", async () => {
    tmuxListSessionsMock.mockResolvedValue([
      session("busy", 2),
      session("idle", 0),
    ]);
    await renderPanel();

    await waitFor(() =>
      expect(screen.getByTestId("tmux-attached-badge-busy")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("tmux-attached-badge-idle")).toBeNull();
  });

  it("UT-P03 tmux 不可用时显示未检测到 tmux 的空状态", async () => {
    tmuxAvailableMock.mockResolvedValue(false);
    await renderPanel();

    await waitFor(() =>
      expect(screen.getByTestId("tmux-empty-unavailable")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("tmux-empty-no-sessions")).toBeNull();
  });

  it("UT-P04 可用但零会话时显示没有会话的空状态", async () => {
    await renderPanel();

    await waitFor(() =>
      expect(screen.getByTestId("tmux-empty-no-sessions")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("tmux-empty-unavailable")).toBeNull();
  });

  it("UT-P05 点击列表项新建标签页并带上 attach 初始输入", async () => {
    tmuxListSessionsMock.mockResolvedValue([session("alpha")]);
    await renderPanel();
    await waitFor(() =>
      expect(screen.getByTestId("tmux-session-item-alpha")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("tmux-session-item-alpha"));

    await waitFor(() => expect(useTabsStore.getState().tabs).toHaveLength(1));
    const tab = useTabsStore.getState().tabs[0];
    expect(tab.title).toContain("alpha");
    expect(tab.initialInput).toBe("tmux attach-session -t 'alpha'\n");
    // 记下接的是哪个会话：重启恢复时靠它接回去
    expect(tab.tmuxSessionId).toBe("$alpha");
    // 默认是共享接入，不踢人
    expect(tmuxAttachCommandMock).toHaveBeenCalledWith("$alpha", false);
  });

  it("应该_当处于分屏时点击会话_新标签进入当前焦点分屏组并成为其活动标签", async () => {
    const root: LayoutNode = {
      kind: "split",
      direction: "horizontal",
      ratio: 0.5,
      left: {
        kind: "leaf",
        group: {
          id: "g-left",
          type: "terminal",
          tab_ids: ["t-left"],
          active_tab_id: "t-left",
        },
      },
      right: {
        kind: "leaf",
        group: {
          id: "g-right",
          type: "terminal",
          tab_ids: ["t-right"],
          active_tab_id: "t-right",
        },
      },
    };
    usePaneLayoutStore.setState({ root, active_group_id: "g-right" });
    useTabsStore.setState({
      tabs: [
        { id: "t-left", title: "l", sessionId: null, auto_title: true },
        { id: "t-right", title: "r", sessionId: null, auto_title: true },
      ],
      activeId: "t-right",
      unreadByTab: {},
    });
    tmuxListSessionsMock.mockResolvedValue([session("alpha")]);
    await renderPanel();
    await waitFor(() =>
      expect(screen.getByTestId("tmux-session-item-alpha")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("tmux-session-item-alpha"));

    await waitFor(() => expect(useTabsStore.getState().tabs).toHaveLength(3));
    const newTab = useTabsStore.getState().tabs[2];
    expect(newTab.initialInput).toBe("tmux attach-session -t 'alpha'\n");
    const after = usePaneLayoutStore.getState().root;
    if (after.kind !== "split" || after.right.kind !== "leaf") {
      throw new Error("分屏结构不应被改变");
    }
    expect(after.right.group.tab_ids).toContain(newTab.id);
    expect(after.right.group.active_tab_id).toBe(newTab.id);
  });

  it("应该_当接入失败时_不清除该会话的新输出标记", async () => {
    // 先让 alpha 带着"新输出"：基线 100，之后活动时间变成 200
    tmuxListSessionsMock.mockResolvedValue([session("alpha", 0, 200)]);
    useTmuxStore.setState({ seen: { $alpha: 100 } });
    // 没有可放新标签的分屏（与标签数已满同一条返回 null 的路径）
    usePaneLayoutStore.setState({ active_group_id: null });
    await renderPanel();
    await waitFor(() =>
      expect(screen.getByTestId("tmux-new-output-alpha")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("tmux-session-item-alpha"));

    await waitFor(() =>
      expect(screen.getByTestId("tmux-error")).toBeInTheDocument(),
    );
    const st = useTmuxStore.getState();
    expect(hasNewOutput(st.sessions[0], st.seen)).toBe(true);
    expect(screen.getByTestId("tmux-new-output-alpha")).toBeInTheDocument();
  });

  it("应该_当取接入命令失败时_不清除该会话的新输出标记", async () => {
    tmuxListSessionsMock.mockResolvedValue([session("alpha", 0, 200)]);
    useTmuxStore.setState({ seen: { $alpha: 100 } });
    tmuxAttachCommandMock.mockRejectedValue(new Error("tmux 出错"));
    await renderPanel();
    await waitFor(() =>
      expect(screen.getByTestId("tmux-new-output-alpha")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("tmux-session-item-alpha"));

    await waitFor(() =>
      expect(screen.getByTestId("tmux-error")).toBeInTheDocument(),
    );
    const st = useTmuxStore.getState();
    expect(hasNewOutput(st.sessions[0], st.seen)).toBe(true);
  });

  it("UT-P06 右键弹出菜单，含接管 / 中断 / 结束三项", async () => {
    tmuxListSessionsMock.mockResolvedValue([session("alpha")]);
    await renderPanel();
    await waitFor(() =>
      expect(screen.getByTestId("tmux-session-item-alpha")).toBeInTheDocument(),
    );

    fireEvent.contextMenu(screen.getByTestId("tmux-session-item-alpha"));

    expect(screen.getByTestId("tmux-menu-takeover")).toBeInTheDocument();
    expect(screen.getByTestId("tmux-menu-interrupt")).toBeInTheDocument();
    expect(screen.getByTestId("tmux-menu-kill")).toBeInTheDocument();
  });

  it("UT-P07 点接管时以 takeover=true 取命令", async () => {
    tmuxListSessionsMock.mockResolvedValue([session("alpha")]);
    tmuxAttachCommandMock.mockResolvedValue(
      "tmux attach-session -d -t 'alpha'",
    );
    await renderPanel();
    await waitFor(() =>
      expect(screen.getByTestId("tmux-session-item-alpha")).toBeInTheDocument(),
    );

    fireEvent.contextMenu(screen.getByTestId("tmux-session-item-alpha"));
    fireEvent.click(screen.getByTestId("tmux-menu-takeover"));

    await waitFor(() =>
      expect(tmuxAttachCommandMock).toHaveBeenCalledWith("$alpha", true),
    );
    await waitFor(() => expect(useTabsStore.getState().tabs).toHaveLength(1));
    expect(useTabsStore.getState().tabs[0].initialInput).toBe(
      "tmux attach-session -d -t 'alpha'\n",
    );
  });

  it("UT-P08 点中断时调中断接口并带上会话名", async () => {
    tmuxListSessionsMock.mockResolvedValue([session("alpha")]);
    tmuxInterruptSessionMock.mockResolvedValue(undefined);
    await renderPanel();
    await waitFor(() =>
      expect(screen.getByTestId("tmux-session-item-alpha")).toBeInTheDocument(),
    );

    fireEvent.contextMenu(screen.getByTestId("tmux-session-item-alpha"));
    fireEvent.click(screen.getByTestId("tmux-menu-interrupt"));

    await waitFor(() =>
      expect(tmuxInterruptSessionMock).toHaveBeenCalledWith("$alpha"),
    );
  });

  it("UT-P09 结束会话：弹应用内确认框，确认后以 id 调 kill 接口", async () => {
    tmuxListSessionsMock.mockResolvedValue([session("alpha")]);
    tmuxKillSessionMock.mockResolvedValue(undefined);
    await renderPanel();
    await waitFor(() =>
      expect(screen.getByTestId("tmux-session-item-alpha")).toBeInTheDocument(),
    );

    fireEvent.contextMenu(screen.getByTestId("tmux-session-item-alpha"));
    fireEvent.click(screen.getByTestId("tmux-menu-kill"));
    fireEvent.click(await screen.findByTestId("confirm-action-ok"));

    await waitFor(() =>
      expect(tmuxKillSessionMock).toHaveBeenCalledWith("$alpha"),
    );
  });

  it("UT-P10 结束会话但在确认框点取消时不调 kill 接口", async () => {
    tmuxListSessionsMock.mockResolvedValue([session("alpha")]);
    await renderPanel();
    await waitFor(() =>
      expect(screen.getByTestId("tmux-session-item-alpha")).toBeInTheDocument(),
    );

    fireEvent.contextMenu(screen.getByTestId("tmux-session-item-alpha"));
    fireEvent.click(screen.getByTestId("tmux-menu-kill"));
    fireEvent.click(await screen.findByTestId("confirm-action-cancel"));

    await waitFor(() =>
      expect(screen.queryByTestId("confirm-action-ok")).toBeNull(),
    );
    expect(tmuxKillSessionMock).not.toHaveBeenCalled();
  });

  it("应该_当运行环境不支持_window_confirm_时_结束会话仍能确认并执行", async () => {
    // macOS 上 WKWebView 的行为：不弹窗，直接返回 false
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    tmuxListSessionsMock.mockResolvedValue([session("alpha")]);
    tmuxKillSessionMock.mockResolvedValue(undefined);
    await renderPanel();
    await waitFor(() =>
      expect(screen.getByTestId("tmux-session-item-alpha")).toBeInTheDocument(),
    );

    fireEvent.contextMenu(screen.getByTestId("tmux-session-item-alpha"));
    fireEvent.click(screen.getByTestId("tmux-menu-kill"));
    fireEvent.click(await screen.findByTestId("confirm-action-ok"));

    await waitFor(() =>
      expect(tmuxKillSessionMock).toHaveBeenCalledWith("$alpha"),
    );
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("UT-P11 点刷新按钮再次拉取列表", async () => {
    await renderPanel();
    const callsBefore = tmuxListSessionsMock.mock.calls.length;

    fireEvent.click(screen.getByTestId("tmux-refresh"));

    await waitFor(() =>
      expect(tmuxListSessionsMock.mock.calls.length).toBeGreaterThan(
        callsBefore,
      ),
    );
  });
});

describe("TmuxPanel 增强：定时刷新、新建、改名、预览、新输出", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTmuxStore.setState({
      sessions: [],
      loading: false,
      error: null,
      available: true,
      seen: {},
    });
    useTabsStore.setState({ tabs: [], activeId: null, unreadByTab: {} });
    tmuxAvailableMock.mockResolvedValue(true);
    tmuxListSessionsMock.mockResolvedValue([]);
    tmuxAttachCommandMock.mockResolvedValue("tmux attach-session -t '$new'");
  });

  it("UT-P12 挂载期间每 3 秒刷新一次，卸载后不再刷新", async () => {
    vi.useFakeTimers();
    try {
      const view = render(<TmuxPanel />);
      await act(async () => {
        await Promise.resolve();
      });
      const afterMount = tmuxListSessionsMock.mock.calls.length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(tmuxListSessionsMock.mock.calls.length).toBe(afterMount + 1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(tmuxListSessionsMock.mock.calls.length).toBe(afterMount + 2);

      view.unmount();
      const afterUnmount = tmuxListSessionsMock.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(tmuxListSessionsMock.mock.calls.length).toBe(afterUnmount);
    } finally {
      vi.useRealTimers();
    }
  });

  it("UT-P13 新建：预填当前标签页目录名，确认后建会话并打开接入标签页", async () => {
    useTabsStore.setState({
      tabs: [
        {
          id: "t1",
          title: "x",
          sessionId: "sid-1",
          auto_title: true,
          cwd: "/home/dev/my.proj",
        },
      ],
      activeId: "t1",
      unreadByTab: {},
    });
    sessionCurrentCwdMock.mockResolvedValue("/home/dev/my.proj");
    tmuxNewSessionMock.mockResolvedValue("$new");
    await renderPanel();

    fireEvent.click(screen.getByTestId("tmux-new"));
    const input = (await screen.findByTestId(
      "input-dialog-input",
    )) as HTMLInputElement;
    // 目录名里的 . 替换成 _
    await waitFor(() => expect(input.value).toBe("my_proj"));

    fireEvent.click(screen.getByTestId("input-dialog-ok"));

    await waitFor(() =>
      expect(tmuxNewSessionMock).toHaveBeenCalledWith(
        "my_proj",
        "/home/dev/my.proj",
      ),
    );
    await waitFor(() =>
      expect(useTabsStore.getState().tabs.length).toBe(2),
    );
    expect(tmuxAttachCommandMock).toHaveBeenCalledWith("$new", false);
  });

  it("UT-P14 新建时重名或含冒号：显示错误且不调接口", async () => {
    tmuxListSessionsMock.mockResolvedValue([session("taken")]);
    await renderPanel();
    await screen.findByTestId("tmux-session-item-taken");

    fireEvent.click(screen.getByTestId("tmux-new"));
    const input = await screen.findByTestId("input-dialog-input");

    fireEvent.change(input, { target: { value: "taken" } });
    expect(await screen.findByTestId("input-dialog-error")).toBeInTheDocument();
    expect(screen.getByTestId("input-dialog-ok")).toBeDisabled();

    fireEvent.change(input, { target: { value: "a:b" } });
    expect(await screen.findByTestId("input-dialog-error")).toBeInTheDocument();
    expect(screen.getByTestId("input-dialog-ok")).toBeDisabled();

    expect(tmuxNewSessionMock).not.toHaveBeenCalled();
  });

  it("UT-P15 右键重命名：预填当前名，确认后以 id 调改名接口", async () => {
    tmuxListSessionsMock.mockResolvedValue([session("alpha")]);
    tmuxRenameSessionMock.mockResolvedValue(undefined);
    await renderPanel();
    await screen.findByTestId("tmux-session-item-alpha");

    fireEvent.contextMenu(screen.getByTestId("tmux-session-item-alpha"));
    fireEvent.click(screen.getByTestId("tmux-menu-rename"));

    const input = (await screen.findByTestId(
      "input-dialog-input",
    )) as HTMLInputElement;
    expect(input.value).toBe("alpha");
    fireEvent.change(input, { target: { value: "alpha-2" } });
    fireEvent.click(screen.getByTestId("input-dialog-ok"));

    await waitFor(() =>
      expect(tmuxRenameSessionMock).toHaveBeenCalledWith("$alpha", "alpha-2"),
    );
  });

  it("UT-P16 展开：调预览接口并显示文本，同时消除新输出标记", async () => {
    tmuxListSessionsMock.mockResolvedValueOnce([session("alpha", 0, 100)]);
    tmuxListSessionsMock.mockResolvedValue([session("alpha", 0, 900)]);
    tmuxCapturePaneMock.mockResolvedValue("step 1\nstep 2 done");
    await renderPanel();
    await screen.findByTestId("tmux-session-item-alpha");
    // 第二次刷新拿到更大的 activity → 出现新输出标记
    fireEvent.click(screen.getByTestId("tmux-refresh"));
    await screen.findByTestId("tmux-new-output-alpha");

    fireEvent.click(screen.getByTestId("tmux-expand-alpha"));

    await waitFor(() =>
      expect(tmuxCapturePaneMock).toHaveBeenCalledWith("$alpha"),
    );
    const preview = await screen.findByTestId("tmux-preview-alpha");
    expect(preview.textContent).toContain("step 2 done");
    expect(screen.queryByTestId("tmux-new-output-alpha")).toBeNull();
  });

  it("UT-P17 首次加载不显示新输出标记", async () => {
    tmuxListSessionsMock.mockResolvedValue([session("alpha", 0, 900)]);
    await renderPanel();
    await screen.findByTestId("tmux-session-item-alpha");
    expect(screen.queryByTestId("tmux-new-output-alpha")).toBeNull();
  });

  it("UT-P18 预览失败时在预览区显示错误，不影响列表", async () => {
    tmuxListSessionsMock.mockResolvedValue([session("alpha")]);
    tmuxCapturePaneMock.mockRejectedValue(new Error("can't find session"));
    await renderPanel();
    await screen.findByTestId("tmux-session-item-alpha");

    fireEvent.click(screen.getByTestId("tmux-expand-alpha"));

    const preview = await screen.findByTestId("tmux-preview-alpha");
    await waitFor(() =>
      expect(preview.textContent).toContain("can't find session"),
    );
    expect(screen.getByTestId("tmux-session-item-alpha")).toBeInTheDocument();
  });
});
