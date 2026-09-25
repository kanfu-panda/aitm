import { describe, expect, it, vi } from "vitest";

import { openSessionWithOutput } from "../openSessionWithOutput";

type Listener = (sessionId: string, bytes: Uint8Array) => void;

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe("openSessionWithOutput（先订阅再开 PTY，首屏输出不丢）", () => {
  it("应该_当_PTY_在打开返回前就输出时_这部分输出也交给终端且顺序不乱", async () => {
    let listener: Listener | null = null;
    const listenAll = vi.fn(async (cb: Listener) => {
      listener = cb;
      return () => {};
    });
    // 模拟后端：PTY 一建好就发输出，早于 session_open 的返回值到达前端
    const open = vi.fn(async () => {
      listener?.("s1", bytes("prompt% "));
      listener?.("s2", bytes("别的会话"));
      return "s1";
    });
    const received: string[] = [];

    const { id } = await openSessionWithOutput(open, (b) =>
      received.push(text(b)),
      listenAll,
    );
    listener!("s1", bytes("ls\r\n"));
    listener!("s2", bytes("还是别的会话"));

    expect(id).toBe("s1");
    expect(received).toEqual(["prompt% ", "ls\r\n"]);
  });

  it("应该_在打开_PTY_之前就完成订阅", async () => {
    const order: string[] = [];
    const listenAll = vi.fn(async () => {
      order.push("listen");
      return () => {};
    });
    const open = vi.fn(async () => {
      order.push("open");
      return "s1";
    });

    await openSessionWithOutput(open, () => {}, listenAll);

    expect(order).toEqual(["listen", "open"]);
  });

  it("应该_当打开失败时_撤销订阅并把错误抛给调用方", async () => {
    const unlisten = vi.fn();
    const listenAll = vi.fn(async () => unlisten);
    const open = vi.fn(async () => {
      throw new Error("PTY 资源耗尽");
    });

    await expect(
      openSessionWithOutput(open, () => {}, listenAll),
    ).rejects.toThrow("PTY 资源耗尽");
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("应该_把撤销订阅的函数交给调用方", async () => {
    const unlisten = vi.fn();
    const result = await openSessionWithOutput(
      async () => "s1",
      () => {},
      vi.fn(async () => unlisten),
    );
    result.unlisten();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
