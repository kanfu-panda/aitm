import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TmuxSession } from "../lib/tauri";

/**
 * tmux store 单测。
 *
 * store 只做三件事：探测可用性、拉列表、干预后自动刷新。这里把 lib/tauri
 * 整模块 mock 掉，断言的是状态流转而不是 IPC 本身。
 */

const tmuxAvailableMock = vi.fn();
const tmuxListSessionsMock = vi.fn();
const tmuxKillSessionMock = vi.fn();
const tmuxInterruptSessionMock = vi.fn();

vi.mock("../lib/tauri", async (orig) => {
  const real = await orig<typeof import("../lib/tauri")>();
  return {
    ...real,
    tmuxAvailable: () => tmuxAvailableMock(),
    tmuxListSessions: () => tmuxListSessionsMock(),
    tmuxKillSession: (name: string) => tmuxKillSessionMock(name),
    tmuxInterruptSession: (name: string) => tmuxInterruptSessionMock(name),
  };
});

import { useTmuxStore } from "./tmux";

function session(name: string, attached = 0): TmuxSession {
  return {
    name,
    windows: 1,
    attached,
    created: 1_700_000_000,
    current_path: "/tmp",
    current_command: "zsh",
    title: `${name} 任务`,
  };
}

describe("tmux store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTmuxStore.setState({
      sessions: [],
      loading: false,
      error: null,
      available: true,
    });
  });

  it("UT-S01 刷新成功时填充列表、清空错误并复位 loading", async () => {
    tmuxAvailableMock.mockResolvedValue(true);
    tmuxListSessionsMock.mockResolvedValue([session("alpha"), session("beta")]);

    await useTmuxStore.getState().refresh();

    const s = useTmuxStore.getState();
    expect(s.sessions.map((x) => x.name)).toEqual(["alpha", "beta"]);
    expect(s.error).toBeNull();
    expect(s.loading).toBe(false);
    expect(s.available).toBe(true);
  });

  it("UT-S02 tmux 不可用时标记 available=false 且不再拉列表", async () => {
    tmuxAvailableMock.mockResolvedValue(false);

    await useTmuxStore.getState().refresh();

    expect(useTmuxStore.getState().available).toBe(false);
    expect(useTmuxStore.getState().sessions).toEqual([]);
    expect(tmuxListSessionsMock).not.toHaveBeenCalled();
  });

  it("UT-S03 列表接口抛错时记录错误并保留上一次列表", async () => {
    useTmuxStore.setState({ sessions: [session("old")] });
    tmuxAvailableMock.mockResolvedValue(true);
    tmuxListSessionsMock.mockRejectedValue(new Error("tmux 炸了"));

    await useTmuxStore.getState().refresh();

    const s = useTmuxStore.getState();
    expect(s.error).toContain("tmux 炸了");
    expect(s.sessions.map((x) => x.name)).toEqual(["old"]);
    expect(s.loading).toBe(false);
  });

  it("UT-S04 结束会话成功后自动刷新列表", async () => {
    tmuxAvailableMock.mockResolvedValue(true);
    tmuxListSessionsMock.mockResolvedValue([session("survivor")]);
    tmuxKillSessionMock.mockResolvedValue(undefined);

    await useTmuxStore.getState().killSession("doomed");

    expect(tmuxKillSessionMock).toHaveBeenCalledWith("doomed");
    expect(tmuxListSessionsMock).toHaveBeenCalled();
    expect(useTmuxStore.getState().sessions.map((x) => x.name)).toEqual([
      "survivor",
    ]);
  });

  it("UT-S05 结束会话失败时记录错误但仍然刷新", async () => {
    tmuxAvailableMock.mockResolvedValue(true);
    tmuxListSessionsMock.mockResolvedValue([]);
    tmuxKillSessionMock.mockRejectedValue(new Error("会话不存在"));

    await useTmuxStore.getState().killSession("ghost");

    expect(useTmuxStore.getState().error).toContain("会话不存在");
    expect(tmuxListSessionsMock).toHaveBeenCalled();
  });

  it("中断会话失败时同样记录错误", async () => {
    tmuxAvailableMock.mockResolvedValue(true);
    tmuxListSessionsMock.mockResolvedValue([]);
    tmuxInterruptSessionMock.mockRejectedValue(new Error("发送失败"));

    await useTmuxStore.getState().interruptSession("alpha");

    expect(tmuxInterruptSessionMock).toHaveBeenCalledWith("alpha");
    expect(useTmuxStore.getState().error).toContain("发送失败");
  });
});
