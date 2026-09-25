/* =============================================================================
 * file-editor store —— 默认持久化函数单测
 * -----------------------------------------------------------------------------
 * 故意独立于 file-editor.test.ts：那边所有用例的 beforeEach 都会调
 * __setPersistFnForTest 注入测试 hook，把真实 persistFn（走 settings store /
 * IPC 兜底）整个换掉，测不到默认实现本身。
 *
 * Vitest 默认按测试文件隔离模块（各文件独立 module registry），本文件从不
 * 调 __setPersistFnForTest，store 走的就是源码里的默认 persistFn，专测：
 *   - 正常路径：debounce 后调 useSettingsStore.getState().update()
 *   - 兜底路径：settings store 抛错 → 直调 settings_update IPC
 * ========================================================================== */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/tauri", () => ({
  fsReadText: vi.fn().mockResolvedValue("body"),
  fileWrite: vi.fn().mockResolvedValue(undefined),
  fsStat: vi
    .fn()
    .mockResolvedValue({ exists: true, mtime_ms: 1, size: 0, is_dir: false }),
  settingsUpdate: vi.fn().mockResolvedValue(undefined),
  settingsGet: vi.fn().mockResolvedValue({}),
  settingsReset: vi.fn().mockResolvedValue({}),
}));
vi.mock("../lib/analytics", () => ({
  trackEvent: vi.fn(),
}));

import { fsReadText, settingsUpdate } from "../lib/tauri";
import { __cancelPendingPersistForTest, useFileEditorStore } from "./file-editor";
import { useSettingsStore } from "./settings";

const fsReadTextMock = fsReadText as unknown as ReturnType<typeof vi.fn>;
const settingsUpdateMock = settingsUpdate as unknown as ReturnType<
  typeof vi.fn
>;

beforeEach(() => {
  useFileEditorStore.setState({ openFiles: [], activeId: null });
  __cancelPendingPersistForTest();
  fsReadTextMock.mockReset();
  fsReadTextMock.mockResolvedValue("body");
  settingsUpdateMock.mockClear();
});

afterEach(() => {
  __cancelPendingPersistForTest();
  vi.useRealTimers();
});

describe("useFileEditorStore 默认持久化（未注入 __setPersistFnForTest）", () => {
  it("debounce 触发后走真实 settings store 的 update()", async () => {
    const updateSpy = vi.fn();
    useSettingsStore.setState({ update: updateSpy });

    vi.useFakeTimers();
    const p = useFileEditorStore.getState().openFile("/default-persist.ts");
    await vi.advanceTimersByTimeAsync(0);
    await p;
    await vi.advanceTimersByTimeAsync(150);

    expect(updateSpy).toHaveBeenCalledWith({
      editor: {
        open_files: ["/default-persist.ts"],
        active_file: "/default-persist.ts",
      },
    });
  });

  it("settings store 的 update() 抛错 → 兜底直调 settings_update IPC", async () => {
    useSettingsStore.setState({
      update: () => {
        throw new Error("settings store 未 init");
      },
    });

    vi.useFakeTimers();
    const p = useFileEditorStore.getState().openFile("/fallback.ts");
    await vi.advanceTimersByTimeAsync(0);
    await p;
    await vi.advanceTimersByTimeAsync(150);
    // persistFn 内部 catch 分支里 void settingsUpdate(...).catch(...) 是
    // fire-and-forget，给它一个额外的微任务 tick 落地。
    await vi.advanceTimersByTimeAsync(0);

    expect(settingsUpdateMock).toHaveBeenCalledTimes(1);
    const [payload] = settingsUpdateMock.mock.calls[0];
    expect(payload.editor.open_files).toEqual(["/fallback.ts"]);
    expect(payload.editor.active_file).toBe("/fallback.ts");
  });
});
