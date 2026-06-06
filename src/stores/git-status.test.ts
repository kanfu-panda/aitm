import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GitFileStatus } from "../lib/tauri";

vi.mock("../lib/tauri", () => ({
  gitStatus: vi.fn(),
}));

import { gitStatus as gitStatusMock } from "../lib/tauri";
import {
  dirHasDirty,
  getFileStatus,
  gitStatusFileClass,
  useGitStatusStore,
} from "./git-status";

const mock = gitStatusMock as unknown as ReturnType<typeof vi.fn>;

describe("useGitStatusStore", () => {
  beforeEach(() => {
    mock.mockReset();
    useGitStatusStore.setState({ byPath: {} });
  });

  describe("setEntries 全量替换", () => {
    it("把数组转 byPath 映射", () => {
      useGitStatusStore.getState().setEntries([
        { path: "/repo/a.ts", status: "modified" },
        { path: "/repo/b.ts", status: "untracked" },
      ]);
      const m = useGitStatusStore.getState().byPath;
      expect(m["/repo/a.ts"]).toBe("modified");
      expect(m["/repo/b.ts"]).toBe("untracked");
    });

    it("二次 setEntries 覆盖前一次（不合并）", () => {
      const { setEntries } = useGitStatusStore.getState();
      setEntries([{ path: "/x", status: "modified" }]);
      setEntries([{ path: "/y", status: "added" }]);
      const m = useGitStatusStore.getState().byPath;
      expect(m["/x"]).toBeUndefined();
      expect(m["/y"]).toBe("added");
    });

    it("空数组 → byPath 清空", () => {
      const { setEntries } = useGitStatusStore.getState();
      setEntries([{ path: "/x", status: "modified" }]);
      setEntries([]);
      expect(useGitStatusStore.getState().byPath).toEqual({});
    });
  });

  describe("clear", () => {
    it("byPath 整体置空", () => {
      useGitStatusStore.getState().setEntries([
        { path: "/x", status: "modified" },
      ]);
      useGitStatusStore.getState().clear();
      expect(useGitStatusStore.getState().byPath).toEqual({});
    });
  });

  describe("refresh", () => {
    it("cwd=null → clear 不调 IPC", async () => {
      useGitStatusStore.getState().setEntries([
        { path: "/x", status: "modified" },
      ]);
      await useGitStatusStore.getState().refresh(null);
      expect(mock).not.toHaveBeenCalled();
      expect(useGitStatusStore.getState().byPath).toEqual({});
    });

    it("调 git_status IPC + setEntries 结果", async () => {
      const entries: GitFileStatus[] = [
        { path: "/repo/a.ts", status: "modified" },
        { path: "/repo/c.ts", status: "deleted" },
      ];
      mock.mockResolvedValueOnce(entries);
      await useGitStatusStore.getState().refresh("/repo");
      expect(mock).toHaveBeenCalledWith("/repo");
      const m = useGitStatusStore.getState().byPath;
      expect(m["/repo/a.ts"]).toBe("modified");
      expect(m["/repo/c.ts"]).toBe("deleted");
    });

    it("IPC 失败 → 静默 clear 不抛", async () => {
      useGitStatusStore.getState().setEntries([
        { path: "/x", status: "modified" },
      ]);
      mock.mockRejectedValueOnce(new Error("boom"));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await expect(
        useGitStatusStore.getState().refresh("/repo"),
      ).resolves.toBeUndefined();
      expect(useGitStatusStore.getState().byPath).toEqual({});
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
  });
});

describe("gitStatusFileClass", () => {
  // HR4-8：3 个 (modified / added / renamed) 加 font-semibold 提高对比度
  // —— file-icon 扩展名色（.env.example 本身 amber）跟 git modified 色撞车，
  // 加粗才能视觉区分
  it.each([
    ["modified", "text-amber-400 font-semibold"],
    ["added", "text-emerald-400 font-semibold"],
    ["deleted", "text-rose-400 line-through"],
    ["untracked", "text-emerald-500 italic"],
    ["renamed", "text-sky-400 font-semibold"],
    ["conflict", "text-orange-500 font-bold"],
  ] as const)("%s → %s", (status, cls) => {
    expect(gitStatusFileClass(status)).toBe(cls);
  });

  it("undefined → null（不染色）", () => {
    expect(gitStatusFileClass(undefined)).toBeNull();
  });
});

describe("dirHasDirty", () => {
  const map = {
    "/repo/src/a.ts": "modified",
    "/repo/docs/readme.md": "untracked",
  } as const;

  it("dir 下有脏文件 → true", () => {
    expect(dirHasDirty("/repo/src", map)).toBe(true);
    expect(dirHasDirty("/repo/docs", map)).toBe(true);
  });

  it("dir 下无脏文件 → false", () => {
    expect(dirHasDirty("/repo/tests", map)).toBe(false);
  });

  it("空 map → false", () => {
    expect(dirHasDirty("/repo/src", {})).toBe(false);
  });

  it("不误判前缀子串（/foo 不命中 /foobar/x）", () => {
    const m = { "/repo/foobar/x.ts": "modified" } as const;
    expect(dirHasDirty("/repo/foo", m)).toBe(false);
    expect(dirHasDirty("/repo/foobar", m)).toBe(true);
  });

  it("dirPath 末尾带 / 也能匹配", () => {
    expect(dirHasDirty("/repo/src/", map)).toBe(true);
  });

  it("HR4-7：byPath 中 key 末尾混入 / 也能 prefix 命中", () => {
    // 防御性 case：万一某个上游给的 key 多了尾 slash，normalize 后仍能匹配
    const m = { "/repo/src/a.ts/": "modified" } as const;
    expect(dirHasDirty("/repo/src", m)).toBe(true);
  });

  it("HR4-7：dirPath 含双斜杠也能匹配", () => {
    const m = { "/repo/src/a.ts": "modified" } as const;
    expect(dirHasDirty("/repo//src", m)).toBe(true);
  });
});

describe("getFileStatus（HR4-7 容错查询）", () => {
  it("精确等值命中（fast path）", () => {
    const m = { "/repo/a.ts": "modified" } as const;
    expect(getFileStatus("/repo/a.ts", m)).toBe("modified");
  });

  it("未命中 → undefined", () => {
    const m = { "/repo/a.ts": "modified" } as const;
    expect(getFileStatus("/repo/b.ts", m)).toBeUndefined();
  });

  it("byPath key 末尾带 / 也能命中（normalize 兜底）", () => {
    const m = { "/repo/a.ts/": "modified" } as const;
    expect(getFileStatus("/repo/a.ts", m)).toBe("modified");
  });

  it("查询路径末尾带 / 也能命中", () => {
    const m = { "/repo/a.ts": "modified" } as const;
    expect(getFileStatus("/repo/a.ts/", m)).toBe("modified");
  });

  it("查询路径含双斜杠也能命中", () => {
    const m = { "/repo/sub/a.ts": "modified" } as const;
    expect(getFileStatus("/repo//sub/a.ts", m)).toBe("modified");
  });

  it("反斜杠 → 正斜杠 normalize（Windows 兼容兜底）", () => {
    const m = { "/repo/sub/a.ts": "modified" } as const;
    expect(getFileStatus("\\repo\\sub\\a.ts", m)).toBe("modified");
  });

  it("空 byPath → undefined", () => {
    expect(getFileStatus("/repo/a.ts", {})).toBeUndefined();
  });

  it("大小写不同 → 不命中（git 大小写敏感）", () => {
    // 不做大小写归一化，避免误合并不同文件
    const m = { "/repo/A.ts": "modified" } as const;
    expect(getFileStatus("/repo/a.ts", m)).toBeUndefined();
  });
});
