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
const tmuxNewSessionMock = vi.fn();
const tmuxRenameSessionMock = vi.fn();

vi.mock("../lib/tauri", async (orig) => {
  const real = await orig<typeof import("../lib/tauri")>();
  return {
    ...real,
    tmuxAvailable: () => tmuxAvailableMock(),
    tmuxListSessions: () => tmuxListSessionsMock(),
    tmuxKillSession: (name: string) => tmuxKillSessionMock(name),
    tmuxInterruptSession: (id: string) => tmuxInterruptSessionMock(id),
    tmuxNewSession: (name: string, cwd: string | null) =>
      tmuxNewSessionMock(name, cwd),
    tmuxRenameSession: (id: string, name: string) =>
      tmuxRenameSessionMock(id, name),
  };
});

import { hasNewOutput, useTmuxStore } from "./tmux";

function session(
  name: string,
  attached = 0,
  activity = 100,
  id = `$${name}`,
): TmuxSession {
  return {
    id,
    activity,
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
      seen: {},
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

describe("tmux store：新输出提示、新建、改名", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTmuxStore.setState({
      sessions: [],
      loading: false,
      error: null,
      available: true,
      seen: {},
    });
    tmuxAvailableMock.mockResolvedValue(true);
  });

  it("UT-S06 首次加载时不把任何会话算作有新输出（以当次为基线）", async () => {
    tmuxListSessionsMock.mockResolvedValue([session("a", 0, 500)]);
    await useTmuxStore.getState().refresh();
    const s = useTmuxStore.getState();
    expect(hasNewOutput(s.sessions[0], s.seen)).toBe(false);
  });

  it("UT-S07 之后 activity 变大 → 标记为有新输出", async () => {
    tmuxListSessionsMock.mockResolvedValue([session("a", 0, 500)]);
    await useTmuxStore.getState().refresh();
    tmuxListSessionsMock.mockResolvedValue([session("a", 0, 900)]);
    await useTmuxStore.getState().refresh();
    const s = useTmuxStore.getState();
    expect(hasNewOutput(s.sessions[0], s.seen)).toBe(true);
  });

  it("UT-S08 markSeen 之后标记消失", async () => {
    tmuxListSessionsMock.mockResolvedValue([session("a", 0, 500)]);
    await useTmuxStore.getState().refresh();
    tmuxListSessionsMock.mockResolvedValue([session("a", 0, 900)]);
    await useTmuxStore.getState().refresh();
    useTmuxStore.getState().markSeen("$a");
    const s = useTmuxStore.getState();
    expect(hasNewOutput(s.sessions[0], s.seen)).toBe(false);
  });

  it("UT-S09 改名后 id 不变，已查看记录保留", async () => {
    tmuxListSessionsMock.mockResolvedValue([session("old", 0, 500, "$7")]);
    await useTmuxStore.getState().refresh();
    tmuxRenameSessionMock.mockResolvedValue(undefined);
    tmuxListSessionsMock.mockResolvedValue([session("new", 0, 500, "$7")]);
    await useTmuxStore.getState().renameSession("$7", "new");

    expect(tmuxRenameSessionMock).toHaveBeenCalledWith("$7", "new");
    const s = useTmuxStore.getState();
    expect(s.sessions[0].name).toBe("new");
    expect(s.seen["$7"]).toBe(500);
    expect(hasNewOutput(s.sessions[0], s.seen)).toBe(false);
  });

  it("UT-S10 newSession 调接口、刷新列表并返回新 id", async () => {
    tmuxNewSessionMock.mockResolvedValue("$42");
    tmuxListSessionsMock.mockResolvedValue([session("proj", 0, 100, "$42")]);

    const id = await useTmuxStore.getState().newSession("proj", "/tmp");

    expect(id).toBe("$42");
    expect(tmuxNewSessionMock).toHaveBeenCalledWith("proj", "/tmp");
    expect(useTmuxStore.getState().sessions.map((x) => x.id)).toEqual(["$42"]);
  });

  it("newSession 失败时抛出错误，交给调用方的输入框显示", async () => {
    tmuxNewSessionMock.mockRejectedValue(new Error("duplicate session: proj"));
    await expect(
      useTmuxStore.getState().newSession("proj", null),
    ).rejects.toThrow("duplicate session");
  });
});

describe("tmux store：高频自动刷新", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTmuxStore.setState({
      sessions: [],
      loading: false,
      error: null,
      available: true,
      seen: {},
    });
    tmuxAvailableMock.mockResolvedValue(true);
  });

  it("UT-S11 静默刷新不切换 loading（否则刷新按钮会每 3 秒闪一下）", async () => {
    const states: boolean[] = [];
    const unsub = useTmuxStore.subscribe((st) => states.push(st.loading));
    tmuxListSessionsMock.mockResolvedValue([session("a")]);

    await useTmuxStore.getState().refresh({ silent: true });

    unsub();
    expect(states).not.toContain(true);
    expect(useTmuxStore.getState().sessions).toHaveLength(1);
  });

  it("UT-S12 上一次刷新还没返回时，再次调用直接跳过", async () => {
    let release!: (v: TmuxSession[]) => void;
    tmuxListSessionsMock.mockReturnValue(
      new Promise<TmuxSession[]>((r) => {
        release = r;
      }),
    );

    const first = useTmuxStore.getState().refresh({ silent: true });
    await useTmuxStore.getState().refresh({ silent: true });
    await useTmuxStore.getState().refresh({ silent: true });
    release([session("a")]);
    await first;

    expect(tmuxListSessionsMock).toHaveBeenCalledTimes(1);
  });

  it("UT-S13 非静默刷新遇到在途刷新时不丢弃，等它结束后再拉一次", async () => {
    let release!: (v: TmuxSession[]) => void;
    tmuxListSessionsMock.mockReturnValueOnce(
      new Promise<TmuxSession[]>((r) => {
        release = r;
      }),
    );
    tmuxListSessionsMock.mockResolvedValue([session("fresh")]);

    const bg = useTmuxStore.getState().refresh({ silent: true });
    // 比如用户刚结束了一个会话——这次刷新必须拿到最新列表，不能被跳过
    const explicit = useTmuxStore.getState().refresh();
    release([session("stale")]);
    await bg;
    await explicit;

    expect(tmuxListSessionsMock).toHaveBeenCalledTimes(2);
    expect(useTmuxStore.getState().sessions.map((x) => x.name)).toEqual([
      "fresh",
    ]);
  });
});
