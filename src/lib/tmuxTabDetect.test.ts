import { beforeEach, describe, expect, it, vi } from "vitest";

const tmuxSessionOfTabMock = vi.fn();
vi.mock("./tauri", async (orig) => {
  const real = await orig<typeof import("./tauri")>();
  return {
    ...real,
    tmuxSessionOfTab: (id: string) => tmuxSessionOfTabMock(id),
  };
});

import { detectHandTypedTmux } from "./tmuxTabDetect";
import { useTabsStore } from "../stores/tabs";

/**
 * 识别手敲 `tmux attach` / `tmux new` 的标签。
 * 只查还没记下会话、且 PTY 已起来的标签；查询失败按"没接"处理。
 */
describe("detectHandTypedTmux", () => {
  beforeEach(() => {
    tmuxSessionOfTabMock.mockReset();
    useTabsStore.setState({
      tabs: [
        { id: "a", title: "~", sessionId: "s-a", auto_title: true },
        {
          id: "b",
          title: "old",
          sessionId: "s-b",
          auto_title: false,
          tmuxSessionId: "$1",
        },
        { id: "c", title: "新标签", sessionId: null, auto_title: true },
        { id: "d", title: "~", sessionId: "s-d", auto_title: true },
        { id: "e", title: "~", sessionId: "s-e", auto_title: true },
      ],
      activeId: "a",
    });
  });

  it("应该_当标签里手敲了_tmux_attach_时_记下会话并显示会话名", async () => {
    tmuxSessionOfTabMock.mockImplementation(async (sid: string) => {
      if (sid === "s-a") return { id: "$9", name: "farm" };
      if (sid === "s-e") throw new Error("tmux 出错");
      return null;
    });

    await detectHandTypedTmux();

    const byId = (id: string) =>
      useTabsStore.getState().tabs.find((t) => t.id === id)!;
    expect(byId("a").tmuxSessionId).toBe("$9");
    expect(byId("a").title).toBe("farm");
    expect(byId("d").tmuxSessionId).toBeUndefined();
    expect(byId("e").tmuxSessionId).toBeUndefined();
    // 已记下会话的、PTY 还没起来的不查
    const asked = tmuxSessionOfTabMock.mock.calls.map((c) => c[0]).sort();
    expect(asked).toEqual(["s-a", "s-d", "s-e"]);
  });

  it("应该_当没有待查标签时_不发任何查询", async () => {
    useTabsStore.setState({ tabs: [], activeId: null });
    await detectHandTypedTmux();
    expect(tmuxSessionOfTabMock).not.toHaveBeenCalled();
  });
});
