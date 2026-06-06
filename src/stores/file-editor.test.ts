/* =============================================================================
 * file-editor store 单测（v0.9.0 T5b）
 * -----------------------------------------------------------------------------
 * 覆盖：
 *   - 初始 state 空
 *   - openFile 新文件 → push + active；调 IPC fs_read_text
 *   - openFile 已有文件 → 切 active，不再 IPC
 *   - closeFile 切到右侧；无右侧切左侧；全关到 null
 *   - setActive 直接切
 *   - updateContent 标 dirty；同 original 时 dirty=false
 *   - setCursor 写 line/col
 *   - saveFile 占位 throw（T5c 留口子）
 *   - setMdMode 切 preview/raw 字段
 *   - restoreFromSettings 顺序 reopen + 单文件失败不阻塞
 *   - 持久化 hook 收到 paths / active 变化（debounce 100ms）
 * ========================================================================== */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// settings store 内部会调 settings_update IPC；测试用 noop mock 隔离。
vi.mock("../lib/tauri", () => ({
  fsReadText: vi.fn(),
  fileWrite: vi.fn().mockResolvedValue(undefined),
  // v0.10.3 #10：openFile / saveFile 现在也调 fsStat 拿 mtime 作为外部改动基线
  fsStat: vi
    .fn()
    .mockResolvedValue({ exists: true, mtime_ms: 1, size: 0, is_dir: false }),
  settingsUpdate: vi.fn().mockResolvedValue(undefined),
  settingsGet: vi.fn().mockResolvedValue({}),
  settingsReset: vi.fn().mockResolvedValue({}),
}));

// analytics trackEvent 静默
vi.mock("../lib/analytics", () => ({
  trackEvent: vi.fn(),
}));

import { fileWrite, fsReadText } from "../lib/tauri";
import {
  __cancelPendingPersistForTest,
  __setPersistFnForTest,
  useFileEditorStore,
} from "./file-editor";

const fsReadTextMock = fsReadText as unknown as ReturnType<typeof vi.fn>;
const fileWriteMock = fileWrite as unknown as ReturnType<typeof vi.fn>;

/** persistFn 调用记录。 */
const persistCalls: Array<{ paths: string[]; active: string | null }> = [];

function resetStore() {
  useFileEditorStore.setState({ openFiles: [], activeId: null });
  __cancelPendingPersistForTest();
  persistCalls.length = 0;
  __setPersistFnForTest((paths, active) => {
    persistCalls.push({ paths: [...paths], active });
  });
}

beforeEach(() => {
  resetStore();
  fsReadTextMock.mockReset();
  fileWriteMock.mockReset();
  fileWriteMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useFileEditorStore", () => {
  it("初始 openFiles 空 / activeId 为 null", () => {
    const s = useFileEditorStore.getState();
    expect(s.openFiles).toEqual([]);
    expect(s.activeId).toBeNull();
  });

  describe("openFile", () => {
    it("打开新文件 → IPC fs_read_text + push tab + active", async () => {
      fsReadTextMock.mockResolvedValueOnce("hello\nworld");
      await useFileEditorStore.getState().openFile("/proj/a.ts");
      const s = useFileEditorStore.getState();
      expect(fsReadTextMock).toHaveBeenCalledWith("/proj/a.ts", 1024 * 1024);
      expect(s.openFiles).toHaveLength(1);
      expect(s.openFiles[0].path).toBe("/proj/a.ts");
      expect(s.openFiles[0].content).toBe("hello\nworld");
      expect(s.openFiles[0].original).toBe("hello\nworld");
      expect(s.openFiles[0].dirty).toBe(false);
      expect(s.openFiles[0].language).toBe("ts");
      expect(s.openFiles[0].cursorLine).toBe(1);
      expect(s.openFiles[0].cursorCol).toBe(1);
      expect(s.activeId).toBe("/proj/a.ts");
    });

    it("打开 md 文件 → mdMode 默认 preview（T5e 接入位）", async () => {
      fsReadTextMock.mockResolvedValueOnce("# hi");
      await useFileEditorStore.getState().openFile("/proj/README.md");
      const s = useFileEditorStore.getState();
      expect(s.openFiles[0].mdMode).toBe("preview");
    });

    it("打开非 md 文件 → mdMode undefined", async () => {
      fsReadTextMock.mockResolvedValueOnce("code");
      await useFileEditorStore.getState().openFile("/proj/a.ts");
      const s = useFileEditorStore.getState();
      expect(s.openFiles[0].mdMode).toBeUndefined();
    });

    it("打开已在列表的文件 → 切 active，不重复 IPC", async () => {
      fsReadTextMock.mockResolvedValueOnce("a-content");
      fsReadTextMock.mockResolvedValueOnce("b-content");
      await useFileEditorStore.getState().openFile("/proj/a.ts");
      await useFileEditorStore.getState().openFile("/proj/b.ts");
      // 现 active 是 b；再打开 a 应切回 a，不调第 3 次 fsReadText
      fsReadTextMock.mockClear();
      await useFileEditorStore.getState().openFile("/proj/a.ts");
      expect(fsReadTextMock).not.toHaveBeenCalled();
      const s = useFileEditorStore.getState();
      expect(s.openFiles).toHaveLength(2);
      expect(s.activeId).toBe("/proj/a.ts");
    });

    it("IPC 失败 → throw 透传（调用方决定降级）", async () => {
      fsReadTextMock.mockRejectedValueOnce(new Error("read fail"));
      await expect(
        useFileEditorStore.getState().openFile("/no/such.ts"),
      ).rejects.toThrow("read fail");
    });
  });

  describe("closeFile", () => {
    it("关 active → 切到右侧", async () => {
      fsReadTextMock.mockResolvedValueOnce("a").mockResolvedValueOnce("b").mockResolvedValueOnce("c");
      await useFileEditorStore.getState().openFile("/a.ts");
      await useFileEditorStore.getState().openFile("/b.ts");
      await useFileEditorStore.getState().openFile("/c.ts");
      // 切 active 到 b
      useFileEditorStore.getState().setActive("/b.ts");
      await useFileEditorStore.getState().closeFile("/b.ts");
      const s = useFileEditorStore.getState();
      expect(s.openFiles.map((f) => f.id)).toEqual(["/a.ts", "/c.ts"]);
      // 关 b → 索引 1 → 右侧是原 idx=2(c)，过滤后还是 idx=1=c
      expect(s.activeId).toBe("/c.ts");
    });

    it("关最后一个 tab → activeId 切到左侧", async () => {
      fsReadTextMock.mockResolvedValueOnce("a").mockResolvedValueOnce("b");
      await useFileEditorStore.getState().openFile("/a.ts");
      await useFileEditorStore.getState().openFile("/b.ts");
      // active 是 b（最后开），关 b → 切到 a
      await useFileEditorStore.getState().closeFile("/b.ts");
      expect(useFileEditorStore.getState().activeId).toBe("/a.ts");
    });

    it("关所有 tab → activeId 为 null", async () => {
      fsReadTextMock.mockResolvedValueOnce("a");
      await useFileEditorStore.getState().openFile("/a.ts");
      await useFileEditorStore.getState().closeFile("/a.ts");
      const s = useFileEditorStore.getState();
      expect(s.openFiles).toEqual([]);
      expect(s.activeId).toBeNull();
    });

    it("关非 active tab → activeId 不变", async () => {
      fsReadTextMock.mockResolvedValueOnce("a").mockResolvedValueOnce("b");
      await useFileEditorStore.getState().openFile("/a.ts");
      await useFileEditorStore.getState().openFile("/b.ts"); // active = b
      await useFileEditorStore.getState().closeFile("/a.ts");
      expect(useFileEditorStore.getState().activeId).toBe("/b.ts");
    });

    it("关不存在的 id → noop", async () => {
      fsReadTextMock.mockResolvedValueOnce("a");
      await useFileEditorStore.getState().openFile("/a.ts");
      await useFileEditorStore.getState().closeFile("/nope.ts");
      expect(useFileEditorStore.getState().openFiles).toHaveLength(1);
    });
  });

  describe("setActive", () => {
    it("切到已存在的 tab", async () => {
      fsReadTextMock.mockResolvedValueOnce("a").mockResolvedValueOnce("b");
      await useFileEditorStore.getState().openFile("/a.ts");
      await useFileEditorStore.getState().openFile("/b.ts");
      useFileEditorStore.getState().setActive("/a.ts");
      expect(useFileEditorStore.getState().activeId).toBe("/a.ts");
    });
  });

  describe("updateContent / dirty 标记", () => {
    it("内容变 → dirty=true", async () => {
      fsReadTextMock.mockResolvedValueOnce("v1");
      await useFileEditorStore.getState().openFile("/a.ts");
      useFileEditorStore.getState().updateContent("/a.ts", "v1-edited");
      const f = useFileEditorStore.getState().openFiles[0];
      expect(f.dirty).toBe(true);
      expect(f.content).toBe("v1-edited");
      expect(f.original).toBe("v1");
    });

    it("改回 original → dirty=false", async () => {
      fsReadTextMock.mockResolvedValueOnce("v1");
      await useFileEditorStore.getState().openFile("/a.ts");
      useFileEditorStore.getState().updateContent("/a.ts", "edited");
      expect(useFileEditorStore.getState().openFiles[0].dirty).toBe(true);
      useFileEditorStore.getState().updateContent("/a.ts", "v1");
      expect(useFileEditorStore.getState().openFiles[0].dirty).toBe(false);
    });

    it("updateContent 不存在的 id → noop", async () => {
      fsReadTextMock.mockResolvedValueOnce("v1");
      await useFileEditorStore.getState().openFile("/a.ts");
      useFileEditorStore.getState().updateContent("/nope", "x");
      expect(useFileEditorStore.getState().openFiles[0].content).toBe("v1");
    });
  });

  describe("setCursor", () => {
    it("写 line/col", async () => {
      fsReadTextMock.mockResolvedValueOnce("abc");
      await useFileEditorStore.getState().openFile("/a.ts");
      useFileEditorStore.getState().setCursor("/a.ts", 12, 34);
      const f = useFileEditorStore.getState().openFiles[0];
      expect(f.cursorLine).toBe(12);
      expect(f.cursorCol).toBe(34);
    });
  });

  describe("saveFile（T5c）", () => {
    it("调 file_write IPC 用当前 path / content", async () => {
      fsReadTextMock.mockResolvedValueOnce("v1");
      await useFileEditorStore.getState().openFile("/proj/a.ts");
      useFileEditorStore.getState().updateContent("/proj/a.ts", "v1-edited");
      await useFileEditorStore.getState().saveFile("/proj/a.ts");
      expect(fileWriteMock).toHaveBeenCalledTimes(1);
      expect(fileWriteMock).toHaveBeenCalledWith("/proj/a.ts", "v1-edited");
    });

    it("成功后 dirty=false / original 同步到落盘内容", async () => {
      fsReadTextMock.mockResolvedValueOnce("v1");
      await useFileEditorStore.getState().openFile("/proj/a.ts");
      useFileEditorStore.getState().updateContent("/proj/a.ts", "v1-edited");
      expect(useFileEditorStore.getState().openFiles[0].dirty).toBe(true);
      await useFileEditorStore.getState().saveFile("/proj/a.ts");
      const f = useFileEditorStore.getState().openFiles[0];
      expect(f.dirty).toBe(false);
      expect(f.original).toBe("v1-edited");
      expect(f.content).toBe("v1-edited");
    });

    it("内容跟 original 一致时保存也能跑（写空操作 / 无 dirty 也保存）", async () => {
      fsReadTextMock.mockResolvedValueOnce("v1");
      await useFileEditorStore.getState().openFile("/proj/a.ts");
      await useFileEditorStore.getState().saveFile("/proj/a.ts");
      expect(fileWriteMock).toHaveBeenCalledWith("/proj/a.ts", "v1");
      expect(useFileEditorStore.getState().openFiles[0].dirty).toBe(false);
    });

    it("file_write 失败 → throw Error 透传，不改 store state", async () => {
      fsReadTextMock.mockResolvedValueOnce("v1");
      await useFileEditorStore.getState().openFile("/proj/a.ts");
      useFileEditorStore.getState().updateContent("/proj/a.ts", "v1-edited");
      fileWriteMock.mockRejectedValueOnce("禁止写入系统目录");
      await expect(
        useFileEditorStore.getState().saveFile("/proj/a.ts"),
      ).rejects.toThrow(/禁止写入系统目录/);
      // 保存失败 → dirty 仍 true，original 不变
      const f = useFileEditorStore.getState().openFiles[0];
      expect(f.dirty).toBe(true);
      expect(f.original).toBe("v1");
    });

    it("保存中 content 又被改 → 保存后仍 dirty=true（追新）", async () => {
      fsReadTextMock.mockResolvedValueOnce("v1");
      await useFileEditorStore.getState().openFile("/proj/a.ts");
      useFileEditorStore.getState().updateContent("/proj/a.ts", "v2");
      // 让 fileWrite hang 一下，让我们能在它返回前再改 content
      let resolveWrite: (() => void) | null = null;
      fileWriteMock.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveWrite = resolve;
          }),
      );
      const savePromise = useFileEditorStore.getState().saveFile("/proj/a.ts");
      // 在 write resolve 之前再编辑
      useFileEditorStore.getState().updateContent("/proj/a.ts", "v3");
      resolveWrite!();
      await savePromise;
      const f = useFileEditorStore.getState().openFiles[0];
      expect(f.original).toBe("v2"); // original 是落盘那次的快照
      expect(f.content).toBe("v3");
      expect(f.dirty).toBe(true); // content !== original → 仍 dirty
    });

    it("saveFile 不存在的 id → 静默返", async () => {
      await useFileEditorStore.getState().saveFile("/nope");
      expect(fileWriteMock).not.toHaveBeenCalled();
    });

    it("saveFile 不触发 persistFn（dirty buffer / original 不持久化）", async () => {
      vi.useFakeTimers();
      try {
        fsReadTextMock.mockResolvedValueOnce("v1");
        const p = useFileEditorStore.getState().openFile("/a.ts");
        await vi.advanceTimersByTimeAsync(0);
        await p;
        await vi.advanceTimersByTimeAsync(150);
        persistCalls.length = 0;

        useFileEditorStore.getState().updateContent("/a.ts", "edited");
        await useFileEditorStore.getState().saveFile("/a.ts");
        await vi.advanceTimersByTimeAsync(300);
        expect(persistCalls.length).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("setMdMode（T5e 占位字段）", () => {
    it("切 preview/raw 写到 mdMode", async () => {
      fsReadTextMock.mockResolvedValueOnce("# hi");
      await useFileEditorStore.getState().openFile("/x.md");
      expect(useFileEditorStore.getState().openFiles[0].mdMode).toBe("preview");
      useFileEditorStore.getState().setMdMode("/x.md", "raw");
      expect(useFileEditorStore.getState().openFiles[0].mdMode).toBe("raw");
      useFileEditorStore.getState().setMdMode("/x.md", "preview");
      expect(useFileEditorStore.getState().openFiles[0].mdMode).toBe("preview");
    });
  });

  describe("restoreFromSettings", () => {
    it("顺序 reopen 多个文件 + 恢复 active", async () => {
      fsReadTextMock.mockImplementation(async (path: string) => `body-${path}`);
      await useFileEditorStore
        .getState()
        .restoreFromSettings(["/a.ts", "/b.ts", "/c.ts"], "/b.ts");
      const s = useFileEditorStore.getState();
      expect(s.openFiles.map((f) => f.path)).toEqual([
        "/a.ts",
        "/b.ts",
        "/c.ts",
      ]);
      expect(s.activeId).toBe("/b.ts");
    });

    it("单文件 read 失败 → 静默跳过其余仍恢复", async () => {
      fsReadTextMock.mockImplementation(async (path: string) => {
        if (path === "/bad.ts") throw new Error("missing");
        return `body-${path}`;
      });
      await useFileEditorStore
        .getState()
        .restoreFromSettings(["/a.ts", "/bad.ts", "/c.ts"], "/c.ts");
      const s = useFileEditorStore.getState();
      expect(s.openFiles.map((f) => f.path)).toEqual(["/a.ts", "/c.ts"]);
      expect(s.activeId).toBe("/c.ts");
    });

    it("activeFile 不在 open_files 时 → 不强切（保持 openFile 默认行为）", async () => {
      fsReadTextMock.mockImplementation(async () => "x");
      await useFileEditorStore
        .getState()
        .restoreFromSettings(["/a.ts"], "/not-open.ts");
      // /a.ts open 后 active = /a.ts；/not-open.ts 不在 list 不强切
      expect(useFileEditorStore.getState().activeId).toBe("/a.ts");
    });
  });

  describe("持久化（debounced persistFn）", () => {
    it("openFile / closeFile / setActive 触发 persistFn", async () => {
      vi.useFakeTimers();
      try {
        fsReadTextMock.mockResolvedValueOnce("x").mockResolvedValueOnce("y");
        // open a
        const p1 = useFileEditorStore.getState().openFile("/a.ts");
        await vi.advanceTimersByTimeAsync(0);
        await p1;
        await vi.advanceTimersByTimeAsync(150);
        // 应至少有一次 persist 调用
        expect(persistCalls.length).toBeGreaterThanOrEqual(1);
        const last1 = persistCalls[persistCalls.length - 1];
        expect(last1.paths).toEqual(["/a.ts"]);
        expect(last1.active).toBe("/a.ts");

        // open b
        const p2 = useFileEditorStore.getState().openFile("/b.ts");
        await vi.advanceTimersByTimeAsync(0);
        await p2;
        await vi.advanceTimersByTimeAsync(150);
        const last2 = persistCalls[persistCalls.length - 1];
        expect(last2.paths).toEqual(["/a.ts", "/b.ts"]);
        expect(last2.active).toBe("/b.ts");

        // close b
        await useFileEditorStore.getState().closeFile("/b.ts");
        await vi.advanceTimersByTimeAsync(150);
        const last3 = persistCalls[persistCalls.length - 1];
        expect(last3.paths).toEqual(["/a.ts"]);
        expect(last3.active).toBe("/a.ts");
      } finally {
        vi.useRealTimers();
      }
    });

    it("连续操作 100ms 内 debounce 合并", async () => {
      vi.useFakeTimers();
      try {
        fsReadTextMock.mockResolvedValueOnce("a").mockResolvedValueOnce("b");
        // 连续两次 open 在 debounce 窗口内
        const p1 = useFileEditorStore.getState().openFile("/a.ts");
        await vi.advanceTimersByTimeAsync(0);
        await p1;
        const p2 = useFileEditorStore.getState().openFile("/b.ts");
        await vi.advanceTimersByTimeAsync(0);
        await p2;
        // 这时还没到 100ms 触发
        expect(persistCalls.length).toBe(0);
        await vi.advanceTimersByTimeAsync(150);
        // debounce 后只有一次 persist，且是最终 state
        expect(persistCalls.length).toBe(1);
        expect(persistCalls[0].paths).toEqual(["/a.ts", "/b.ts"]);
        expect(persistCalls[0].active).toBe("/b.ts");
      } finally {
        vi.useRealTimers();
      }
    });

    it("updateContent / setCursor 不触发 persist（dirty buffer + 光标都不持久化）", async () => {
      vi.useFakeTimers();
      try {
        fsReadTextMock.mockResolvedValueOnce("x");
        const p = useFileEditorStore.getState().openFile("/a.ts");
        await vi.advanceTimersByTimeAsync(0);
        await p;
        await vi.advanceTimersByTimeAsync(150);
        persistCalls.length = 0;

        useFileEditorStore.getState().updateContent("/a.ts", "x-edited");
        useFileEditorStore.getState().setCursor("/a.ts", 5, 10);
        await vi.advanceTimersByTimeAsync(300);
        expect(persistCalls.length).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
