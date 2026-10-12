/* useBinaryFile 单测：按路径读取二进制文件的状态机，含超限、错误与过期结果丢弃。 */
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/tauri", () => ({
  fsReadBinary: vi.fn(),
}));

import { fsReadBinary } from "../../../lib/tauri";
import { useBinaryFile } from "../useBinaryFile";

const readMock = fsReadBinary as unknown as ReturnType<typeof vi.fn>;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  readMock.mockReset().mockResolvedValue(new ArrayBuffer(8));
});

describe("useBinaryFile", () => {
  it("应该_当读取成功时_先为_loading_再返回_ready_与字节", async () => {
    const buf = new ArrayBuffer(16);
    readMock.mockResolvedValue(buf);
    const { result } = renderHook(() => useBinaryFile("/w/a.png", 1));
    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current).toEqual({ status: "ready", data: buf });
    expect(readMock).toHaveBeenCalledWith("/w/a.png");
  });

  it("应该_当后端返回_fs.fileTooLarge_时_得到_tooLarge_且大小为数字", async () => {
    readMock.mockRejectedValue(
      JSON.stringify({
        code: "fs.fileTooLarge",
        params: { size: String(51 * 1024 * 1024), max: String(50 * 1024 * 1024) },
        message: "文件过大",
      }),
    );
    const { result } = renderHook(() => useBinaryFile("/w/big.png", 1));
    await waitFor(() => expect(result.current.status).toBe("tooLarge"));
    expect(result.current).toEqual({
      status: "tooLarge",
      size: 51 * 1024 * 1024,
      max: 50 * 1024 * 1024,
    });
  });

  it("应该_当读取抛出其它错误时_得到_error_并保留原错误", async () => {
    readMock.mockRejectedValue("磁盘出错");
    const { result } = renderHook(() => useBinaryFile("/w/x.png", 1));
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current).toEqual({ status: "error", error: "磁盘出错" });
  });

  it("应该_当错误码不是_fs.fileTooLarge_时_归为_error", async () => {
    const raw = JSON.stringify({ code: "fs.other", params: {}, message: "别的错误" });
    readMock.mockRejectedValue(raw);
    const { result } = renderHook(() => useBinaryFile("/w/x.png", 1));
    await waitFor(() => expect(result.current.status).toBe("error"));
  });

  it("应该_当_path_变化时_回到_loading_并重新读取", async () => {
    const second = deferred<ArrayBuffer>();
    readMock.mockResolvedValueOnce(new ArrayBuffer(1)).mockReturnValueOnce(second.promise);
    const { result, rerender } = renderHook(({ p }) => useBinaryFile(p, 1), {
      initialProps: { p: "/w/a.png" },
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    rerender({ p: "/w/b.png" });
    expect(result.current.status).toBe("loading");
    expect(readMock).toHaveBeenLastCalledWith("/w/b.png");
    const buf = new ArrayBuffer(2);
    second.resolve(buf);
    await waitFor(() => expect(result.current).toEqual({ status: "ready", data: buf }));
  });

  it("应该_当_reloadKey_变化时_重新读取", async () => {
    const { result, rerender } = renderHook(({ k }) => useBinaryFile("/w/a.png", k), {
      initialProps: { k: 1 as number | undefined },
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    rerender({ k: 2 });
    await waitFor(() => expect(readMock).toHaveBeenCalledTimes(2));
  });

  it("应该_当换了路径后旧请求才返回时_丢弃旧结果", async () => {
    const first = deferred<ArrayBuffer>();
    const second = deferred<ArrayBuffer>();
    readMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result, rerender } = renderHook(({ p }) => useBinaryFile(p, 1), {
      initialProps: { p: "/w/a.png" },
    });
    rerender({ p: "/w/b.png" });
    const newBuf = new ArrayBuffer(4);
    second.resolve(newBuf);
    await waitFor(() => expect(result.current).toEqual({ status: "ready", data: newBuf }));
    first.resolve(new ArrayBuffer(99));
    await Promise.resolve();
    await Promise.resolve();
    expect(result.current).toEqual({ status: "ready", data: newBuf });
  });

  it("应该_当换了路径后旧请求才失败时_丢弃旧错误", async () => {
    const first = deferred<ArrayBuffer>();
    readMock.mockReturnValueOnce(first.promise).mockResolvedValueOnce(new ArrayBuffer(3));
    const { result, rerender } = renderHook(({ p }) => useBinaryFile(p, 1), {
      initialProps: { p: "/w/a.png" },
    });
    rerender({ p: "/w/b.png" });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    first.reject("旧错误");
    await Promise.resolve();
    await Promise.resolve();
    expect(result.current.status).toBe("ready");
  });

  it("应该_当卸载后请求才返回时_不抛错也不更新状态", async () => {
    const d = deferred<ArrayBuffer>();
    readMock.mockReturnValueOnce(d.promise);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result, unmount } = renderHook(() => useBinaryFile("/w/a.png", 1));
    unmount();
    d.resolve(new ArrayBuffer(1));
    await Promise.resolve();
    await Promise.resolve();
    expect(result.current.status).toBe("loading");
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
