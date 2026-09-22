import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TmuxSession } from "../../lib/tauri";

/**
 * TmuxPanel 单测。
 *
 * 覆盖：列表渲染、已连接标记、两种空状态、点击接入、右键菜单三个动作、刷新。
 * lib/tauri 整模块 mock；确认框用 window.confirm 的 spy。
 */

const tmuxAvailableMock = vi.fn();
const tmuxListSessionsMock = vi.fn();
const tmuxAttachCommandMock = vi.fn();
const tmuxInterruptSessionMock = vi.fn();
const tmuxKillSessionMock = vi.fn();

vi.mock("../../lib/tauri", async (orig) => {
  const real = await orig<typeof import("../../lib/tauri")>();
  return {
    ...real,
    tmuxAvailable: () => tmuxAvailableMock(),
    tmuxListSessions: () => tmuxListSessionsMock(),
    tmuxAttachCommand: (name: string, takeover: boolean) =>
      tmuxAttachCommandMock(name, takeover),
    tmuxInterruptSession: (name: string) => tmuxInterruptSessionMock(name),
    tmuxKillSession: (name: string) => tmuxKillSessionMock(name),
  };
});

import TmuxPanel from "../tmux/TmuxPanel";
import { useTmuxStore } from "../../stores/tmux";
import { useTabsStore } from "../../stores/tabs";

function session(name: string, attached = 0): TmuxSession {
  return {
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
    });
    useTabsStore.setState({ tabs: [], activeId: null, unreadByTab: {} });
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
    // 默认是共享接入，不踢人
    expect(tmuxAttachCommandMock).toHaveBeenCalledWith("alpha", false);
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
      expect(tmuxAttachCommandMock).toHaveBeenCalledWith("alpha", true),
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
      expect(tmuxInterruptSessionMock).toHaveBeenCalledWith("alpha"),
    );
  });

  it("UT-P09 结束会话并确认时调 kill 接口", async () => {
    tmuxListSessionsMock.mockResolvedValue([session("alpha")]);
    tmuxKillSessionMock.mockResolvedValue(undefined);
    const confirmSpy = vi
      .spyOn(window, "confirm")
      .mockImplementation(() => true);
    await renderPanel();
    await waitFor(() =>
      expect(screen.getByTestId("tmux-session-item-alpha")).toBeInTheDocument(),
    );

    fireEvent.contextMenu(screen.getByTestId("tmux-session-item-alpha"));
    fireEvent.click(screen.getByTestId("tmux-menu-kill"));

    await waitFor(() =>
      expect(tmuxKillSessionMock).toHaveBeenCalledWith("alpha"),
    );
    expect(confirmSpy).toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("UT-P10 结束会话但取消确认时不调 kill 接口", async () => {
    tmuxListSessionsMock.mockResolvedValue([session("alpha")]);
    const confirmSpy = vi
      .spyOn(window, "confirm")
      .mockImplementation(() => false);
    await renderPanel();
    await waitFor(() =>
      expect(screen.getByTestId("tmux-session-item-alpha")).toBeInTheDocument(),
    );

    fireEvent.contextMenu(screen.getByTestId("tmux-session-item-alpha"));
    fireEvent.click(screen.getByTestId("tmux-menu-kill"));

    expect(tmuxKillSessionMock).not.toHaveBeenCalled();
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
