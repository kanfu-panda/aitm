/* =============================================================================
 * FilePreviewWorkspace 单测（v0.9.0 T5b）
 * -----------------------------------------------------------------------------
 * 覆盖：
 *   - 无 open file → 不渲染
 *   - 有 open file → 渲染 + 含 file-tab-bar
 *   - 切 tab：onActivate → store.setActive
 *   - 关 non-dirty tab → 不弹 dialog 直接 close
 *   - 关 dirty tab → 弹 CloseFileConfirmDialog
 *   - dialog "丢弃改动" → closeFile + dialog 关
 *   - dialog "取消" → tab 仍在
 *   - dialog "保存并关闭"（T5b saveFile throw）→ 降级走 closeFile（仍关 tab）
 *   - Cmd+W 在编辑器焦点时关 active tab
 * ========================================================================== */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

// mock CodeMirrorViewer 避免在 jsdom 起重；只渲染 stub。
// v1.1.0 F3：真实组件已是 forwardRef（暴露 focus()），stub 也 forwardRef 包一层，
// 并把 focus() 转发到 stub 自身 DOM 节点的 .focus()——这样可以用
// document.activeElement 真实断言"切 tab 后编辑器侧确实拿到焦点"（US-3），
// 而不是仅仅 mock 掉整条链路。
vi.mock("../CodeMirrorViewer", async () => {
  const React = await import("react");
  const Stub = React.forwardRef<{ focus: () => void }, { path: string }>(
    function CodeMirrorViewerStub({ path }, ref) {
      const elRef = React.useRef<HTMLDivElement>(null);
      React.useImperativeHandle(
        ref,
        () => ({
          focus: () => elRef.current?.focus(),
        }),
        [],
      );
      return (
        <div ref={elRef} tabIndex={-1} data-testid={`cm-stub-${path}`}>
          {path}
        </div>
      );
    },
  );
  return { __esModule: true, default: Stub };
});

// tauri 层 partial mock：保留 browserHideAllActive 等 useBrowserModalGuard 依赖；
// 只覆盖本测试关心的 fsReadText / fsStat / fileWrite / settings 路径，避免误把
// dialog modal-guard 打断。
// fsStat 默认给个固定 mtime，配合 pushFiles 的 lastMtimeMs 断言"外部改动轮询"逻辑；
// fileWrite 默认成功，saveFile 走真实 store 实现（实测也是真调 file_write IPC）。
vi.mock("../../lib/tauri", async (orig) => {
  const real = await orig<typeof import("../../lib/tauri")>();
  return {
    ...real,
    fsReadText: vi.fn(),
    fsStat: vi
      .fn()
      .mockResolvedValue({ exists: true, mtime_ms: 1, size: 0, is_dir: false }),
    fileWrite: vi.fn().mockResolvedValue(undefined),
    settingsUpdate: vi.fn().mockResolvedValue(undefined),
    settingsGet: vi.fn().mockResolvedValue({}),
    settingsReset: vi.fn().mockResolvedValue({}),
    browserHideAllActive: vi.fn().mockResolvedValue(undefined),
    browserShowAllActive: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock("../../lib/analytics", () => ({
  trackEvent: vi.fn(),
}));

import {
  __cancelPendingPersistForTest,
  __setPersistFnForTest,
  useFileEditorStore,
} from "../../stores/file-editor";
import { fileWrite, fsReadText, fsStat } from "../../lib/tauri";
import { useFocusSurfaceStore } from "../../stores/focus-surface";
import FilePreviewWorkspace from "../FilePreviewWorkspace";

const fsReadTextMock = fsReadText as unknown as ReturnType<typeof vi.fn>;
const fsStatMock = fsStat as unknown as ReturnType<typeof vi.fn>;
const fileWriteMock = fileWrite as unknown as ReturnType<typeof vi.fn>;

function resetStore() {
  useFileEditorStore.setState({ openFiles: [], activeId: null });
  __cancelPendingPersistForTest();
  __setPersistFnForTest(() => {});
  fsReadTextMock.mockReset();
  fsStatMock.mockReset();
  fsStatMock.mockResolvedValue({
    exists: true,
    mtime_ms: 1,
    size: 0,
    is_dir: false,
  });
  fileWriteMock.mockReset();
  fileWriteMock.mockResolvedValue(undefined);
  useFocusSurfaceStore.setState({ lastSurface: "terminal" });
}

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  resetStore();
});

function pushFiles(
  files: Array<Partial<import("../../stores/file-editor").OpenFile>>,
  activeId: string | null,
) {
  const made = files.map((f) => ({
    id: (f.id ?? f.path ?? "") as string,
    path: (f.path ?? f.id ?? "") as string,
    content: f.content ?? "",
    original: f.original ?? f.content ?? "",
    dirty: f.dirty ?? false,
    language: f.language,
    cursorLine: f.cursorLine ?? 1,
    cursorCol: f.cursorCol ?? 1,
    mdMode: f.mdMode,
    lastMtimeMs: f.lastMtimeMs,
    stale: f.stale ?? false,
  }));
  useFileEditorStore.setState({ openFiles: made, activeId });
}

describe("FilePreviewWorkspace", () => {
  it("无 open file → 不渲染", () => {
    render(<FilePreviewWorkspace />);
    expect(
      screen.queryByTestId("file-preview-workspace"),
    ).toBeNull();
  });

  it("有 open file → 渲染 + 含 tabbar + 当前 pane", () => {
    pushFiles(
      [
        { path: "/x/a.ts", content: "AAA" },
        { path: "/y/b.rs", content: "BBB" },
      ],
      "/x/a.ts",
    );
    render(<FilePreviewWorkspace />);
    expect(screen.getByTestId("file-preview-workspace")).toBeTruthy();
    expect(screen.getByTestId("file-tab-bar")).toBeTruthy();
    expect(screen.getByTestId("cm-stub-/x/a.ts")).toBeTruthy();
  });

  it("点 tab → store.setActive 切 active", () => {
    pushFiles(
      [
        { path: "/x/a.ts" },
        { path: "/y/b.rs" },
      ],
      "/x/a.ts",
    );
    render(<FilePreviewWorkspace />);
    fireEvent.click(screen.getByTestId("file-tab-/y/b.rs"));
    expect(useFileEditorStore.getState().activeId).toBe("/y/b.rs");
  });

  it("关 non-dirty tab → 不弹 dialog 直接 closeFile", async () => {
    pushFiles(
      [
        { path: "/x/a.ts" },
        { path: "/y/b.rs" },
      ],
      "/x/a.ts",
    );
    render(<FilePreviewWorkspace />);
    fireEvent.click(screen.getByTestId("file-tab-close-/x/a.ts"));
    await waitFor(() => {
      expect(useFileEditorStore.getState().openFiles).toHaveLength(1);
    });
    expect(
      screen.queryByTestId("close-file-confirm-dialog"),
    ).toBeNull();
  });

  it("关 dirty tab → 弹 CloseFileConfirmDialog", async () => {
    pushFiles(
      [{ path: "/x/a.ts", content: "edited", original: "orig", dirty: true }],
      "/x/a.ts",
    );
    render(<FilePreviewWorkspace />);
    fireEvent.click(screen.getByTestId("file-tab-close-/x/a.ts"));
    expect(
      await screen.findByTestId("close-file-confirm-dialog"),
    ).toBeTruthy();
    // tab 仍在
    expect(useFileEditorStore.getState().openFiles).toHaveLength(1);
  });

  it("dialog '丢弃改动' → closeFile + dialog 关", async () => {
    pushFiles(
      [{ path: "/x/a.ts", dirty: true }],
      "/x/a.ts",
    );
    render(<FilePreviewWorkspace />);
    fireEvent.click(screen.getByTestId("file-tab-close-/x/a.ts"));
    await screen.findByTestId("close-file-confirm-dialog");
    fireEvent.click(screen.getByTestId("close-file-btn-discard"));
    await waitFor(() => {
      expect(useFileEditorStore.getState().openFiles).toHaveLength(0);
    });
  });

  it("dialog '取消' → tab 仍在 + dialog 关", async () => {
    pushFiles(
      [{ path: "/x/a.ts", dirty: true }],
      "/x/a.ts",
    );
    render(<FilePreviewWorkspace />);
    fireEvent.click(screen.getByTestId("file-tab-close-/x/a.ts"));
    await screen.findByTestId("close-file-confirm-dialog");
    fireEvent.click(screen.getByTestId("close-file-btn-cancel"));
    await waitFor(() => {
      expect(
        screen.queryByTestId("close-file-confirm-dialog"),
      ).toBeNull();
    });
    expect(useFileEditorStore.getState().openFiles).toHaveLength(1);
  });

  it("dialog '保存并关闭' saveFile 失败（如禁止写入）→ 降级走 closeFile 仍关 tab", async () => {
    fileWriteMock.mockRejectedValueOnce(new Error("禁止写入系统目录"));
    pushFiles(
      [{ path: "/x/a.ts", dirty: true }],
      "/x/a.ts",
    );
    render(<FilePreviewWorkspace />);
    fireEvent.click(screen.getByTestId("file-tab-close-/x/a.ts"));
    await screen.findByTestId("close-file-confirm-dialog");
    fireEvent.click(screen.getByTestId("close-file-btn-save"));
    // saveFile 失败；FilePreviewWorkspace 内部 catch 后走 closeFile 降级
    await waitFor(() => {
      expect(useFileEditorStore.getState().openFiles).toHaveLength(0);
    });
  });

  it("dialog '保存并关闭' saveFile 成功 → 落盘后关 tab", async () => {
    pushFiles(
      [{ path: "/x/a.ts", content: "edited", original: "orig", dirty: true }],
      "/x/a.ts",
    );
    render(<FilePreviewWorkspace />);
    fireEvent.click(screen.getByTestId("file-tab-close-/x/a.ts"));
    await screen.findByTestId("close-file-confirm-dialog");
    fireEvent.click(screen.getByTestId("close-file-btn-save"));
    await waitFor(() => {
      expect(useFileEditorStore.getState().openFiles).toHaveLength(0);
    });
    expect(fileWriteMock).toHaveBeenCalledWith("/x/a.ts", "edited");
  });

  it("Cmd+W 焦点在编辑器 → 关 active tab", async () => {
    pushFiles(
      [
        { path: "/x/a.ts" },
        { path: "/y/b.rs" },
      ],
      "/y/b.rs",
    );
    render(<FilePreviewWorkspace />);
    // 把焦点放在 workspace 内
    const workspace = screen.getByTestId("file-preview-workspace");
    workspace.focus();
    act(() => {
      fireEvent.keyDown(workspace, { key: "w", metaKey: true });
    });
    await waitFor(() => {
      const ids = useFileEditorStore.getState().openFiles.map((f) => f.id);
      expect(ids).toEqual(["/x/a.ts"]);
    });
  });

  it("Cmd+W 焦点不在编辑器 → 不关 tab（让 useShortcuts 接终端 close）", async () => {
    pushFiles(
      [{ path: "/x/a.ts" }],
      "/x/a.ts",
    );
    render(<FilePreviewWorkspace />);
    // 焦点在 document.body（既不在 workspace 也不在子元素）
    document.body.focus();
    fireEvent.keyDown(document.body, { key: "w", metaKey: true });
    // 给 100ms 等 effect / 异步
    await new Promise((r) => setTimeout(r, 50));
    expect(useFileEditorStore.getState().openFiles).toHaveLength(1);
  });

  // H1 hotfix（v0.9.0）：Cmd+W listener 必须挂在 pane root 元素，**不能**挂在
  // window 上。挂 window 会扰动 WKWebView 的 keydown 派发时序，破坏 xterm.js
  // issue #5374 workaround → Shift+ 标点字符双发。详见 FilePreviewWorkspace
  // 内注释。
  it("H1：Cmd+W listener attach 在 pane 元素而非 window（防止扰动 xterm 路径）", () => {
    pushFiles([{ path: "/x/a.ts" }], "/x/a.ts");
    const winSpy = vi.spyOn(window, "addEventListener");
    render(<FilePreviewWorkspace />);
    // workspace mount 完成后，window 上不该多出 keydown listener
    const keydownAdds = winSpy.mock.calls.filter((c) => c[0] === "keydown");
    expect(keydownAdds).toEqual([]);
    winSpy.mockRestore();
  });

  it("H1：window 层 keydown（终端 / 浏览器面板模拟）不会触发 Cmd+W close", async () => {
    pushFiles([{ path: "/x/a.ts" }], "/x/a.ts");
    render(<FilePreviewWorkspace />);
    // 直接在 window 上派发 keydown（终端 customKeyEvent → xterm 内部不会冒上来，
    // 这里只验证"挂 window 的旧实现会响应，pane scoped 后不响应"）
    fireEvent.keyDown(window, { key: "w", metaKey: true });
    await new Promise((r) => setTimeout(r, 30));
    expect(useFileEditorStore.getState().openFiles).toHaveLength(1);
  });

  // ===== v0.9.1 HR4-6 右键批量关闭集成 =====

  it("HR4-6：右键 '关闭其他' → 保留当前，关其他全部（non-dirty 直接关）", async () => {
    pushFiles(
      [
        { path: "/x/a.ts" },
        { path: "/y/b.rs" },
        { path: "/z/c.py" },
      ],
      "/x/a.ts",
    );
    render(<FilePreviewWorkspace />);
    fireEvent.contextMenu(screen.getByTestId("file-tab-/y/b.rs"));
    fireEvent.click(screen.getByTestId("file-tab-ctx-close-others"));
    await waitFor(() => {
      const ids = useFileEditorStore.getState().openFiles.map((f) => f.id);
      expect(ids).toEqual(["/y/b.rs"]);
    });
  });

  it("HR4-6：右键 '关闭右侧' → 保留当前及左侧，关右侧全部", async () => {
    pushFiles(
      [
        { path: "/x/a.ts" },
        { path: "/y/b.rs" },
        { path: "/z/c.py" },
        { path: "/w/d.md" },
      ],
      "/x/a.ts",
    );
    render(<FilePreviewWorkspace />);
    fireEvent.contextMenu(screen.getByTestId("file-tab-/y/b.rs"));
    fireEvent.click(screen.getByTestId("file-tab-ctx-close-right"));
    await waitFor(() => {
      const ids = useFileEditorStore.getState().openFiles.map((f) => f.id);
      expect(ids).toEqual(["/x/a.ts", "/y/b.rs"]);
    });
  });

  it("HR4-6：右键 '全部关闭' → 全部 non-dirty 直接关", async () => {
    pushFiles(
      [
        { path: "/x/a.ts" },
        { path: "/y/b.rs" },
        { path: "/z/c.py" },
      ],
      "/x/a.ts",
    );
    render(<FilePreviewWorkspace />);
    fireEvent.contextMenu(screen.getByTestId("file-tab-/x/a.ts"));
    fireEvent.click(screen.getByTestId("file-tab-ctx-close-all"));
    await waitFor(() => {
      expect(useFileEditorStore.getState().openFiles).toHaveLength(0);
    });
  });

  // ===== v1.1.0 F3 编辑器侧自动聚焦（US-3） =====

  it("F3：打开文件后自动聚焦编辑器（跟终端侧 isActive→term.focus() 对称）", async () => {
    pushFiles([{ path: "/x/a.ts" }], "/x/a.ts");
    render(<FilePreviewWorkspace />);
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByTestId("cm-stub-/x/a.ts"),
      );
    });
  });

  it("F3：切 tab 后焦点跟随到新的 active 编辑器，不用再点一下才能输入", async () => {
    pushFiles(
      [{ path: "/x/a.ts" }, { path: "/y/b.rs" }],
      "/x/a.ts",
    );
    render(<FilePreviewWorkspace />);
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByTestId("cm-stub-/x/a.ts"),
      );
    });

    fireEvent.click(screen.getByTestId("file-tab-/y/b.rs"));

    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByTestId("cm-stub-/y/b.rs"),
      );
    });
  });

  it("HR4-6：右键 '全部关闭' 含 dirty → 弹保存对话框（逐个）", async () => {
    pushFiles(
      [
        { path: "/x/a.ts", dirty: true },
        { path: "/y/b.rs" },
      ],
      "/x/a.ts",
    );
    render(<FilePreviewWorkspace />);
    fireEvent.contextMenu(screen.getByTestId("file-tab-/x/a.ts"));
    fireEvent.click(screen.getByTestId("file-tab-ctx-close-all"));
    // dirty 那个走 dialog；non-dirty 直接关
    expect(
      await screen.findByTestId("close-file-confirm-dialog"),
    ).toBeTruthy();
    await waitFor(() => {
      const ids = useFileEditorStore.getState().openFiles.map((f) => f.id);
      // /y/b.rs 已关；/x/a.ts dirty 仍在 + 弹 dialog
      expect(ids).toEqual(["/x/a.ts"]);
    });
  });

  // ===== v0.9.0 H6：useShortcuts.closeTab 转发的关编辑器 tab 事件 =====

  describe("aitm:request-close-editor-tab（焦点不在 workspace 内时的转发路径）", () => {
    it("non-dirty active tab → 直接关闭", async () => {
      pushFiles(
        [{ path: "/x/a.ts" }, { path: "/y/b.rs" }],
        "/y/b.rs",
      );
      render(<FilePreviewWorkspace />);

      act(() => {
        window.dispatchEvent(new Event("aitm:request-close-editor-tab"));
      });

      await waitFor(() => {
        const ids = useFileEditorStore.getState().openFiles.map((f) => f.id);
        expect(ids).toEqual(["/x/a.ts"]);
      });
    });

    it("dirty active tab → 弹 CloseFileConfirmDialog（跟直接 Cmd+W 走同一条 requestClose）", async () => {
      pushFiles([{ path: "/x/a.ts", dirty: true }], "/x/a.ts");
      render(<FilePreviewWorkspace />);

      act(() => {
        window.dispatchEvent(new Event("aitm:request-close-editor-tab"));
      });

      expect(
        await screen.findByTestId("close-file-confirm-dialog"),
      ).toBeTruthy();
    });

    it("没有 activeId（理论上不会发生，防御）→ 不报错也不关任何 tab", async () => {
      pushFiles([{ path: "/x/a.ts" }], null);
      render(<FilePreviewWorkspace />);
      // openFiles.length === 0 时组件本来就不渲染；这里手动清空 activeId
      // 模拟"有 tab 但没有 active"的边界，确认转发 handler 的 if(id) 守卫生效。
      act(() => {
        window.dispatchEvent(new Event("aitm:request-close-editor-tab"));
      });
      await new Promise((r) => setTimeout(r, 30));
      expect(useFileEditorStore.getState().openFiles).toHaveLength(1);
    });
  });

  // ===== v0.10.3 #10：外部改动轮询（open 时立即查一次 + 3s 周期） =====

  describe("外部改动轮询 / stale banner", () => {
    it("mtime 变化 + non-dirty → 静默 fsReadText + reloadFromDisk（无 banner）", async () => {
      fsStatMock.mockResolvedValue({
        exists: true,
        mtime_ms: 2,
        size: 0,
        is_dir: false,
      });
      fsReadTextMock.mockResolvedValueOnce("外部改过的新内容");
      pushFiles(
        [{ path: "/x/a.ts", content: "old", dirty: false, lastMtimeMs: 1 }],
        "/x/a.ts",
      );
      render(<FilePreviewWorkspace />);

      await waitFor(() => {
        const f = useFileEditorStore.getState().openFiles[0];
        expect(f.content).toBe("外部改过的新内容");
      });
      const f = useFileEditorStore.getState().openFiles[0];
      expect(f.dirty).toBe(false);
      expect(f.stale).toBe(false);
      expect(f.lastMtimeMs).toBe(2);
      expect(
        screen.queryByTestId("file-stale-banner"),
      ).toBeNull();
    });

    it("mtime 变化 + dirty → markStale 弹 banner，不静默覆盖 buffer", async () => {
      fsStatMock.mockResolvedValue({
        exists: true,
        mtime_ms: 2,
        size: 0,
        is_dir: false,
      });
      pushFiles(
        [
          {
            path: "/x/a.ts",
            content: "我的未保存修改",
            original: "old",
            dirty: true,
            lastMtimeMs: 1,
          },
        ],
        "/x/a.ts",
      );
      render(<FilePreviewWorkspace />);

      expect(await screen.findByTestId("file-stale-banner")).toBeTruthy();
      const f = useFileEditorStore.getState().openFiles[0];
      expect(f.stale).toBe(true);
      // dirty 分支不读盘覆盖
      expect(f.content).toBe("我的未保存修改");
      expect(fsReadTextMock).not.toHaveBeenCalled();
    });

    it("mtime 未变化 → 不触发任何 store 变化", async () => {
      fsStatMock.mockResolvedValue({
        exists: true,
        mtime_ms: 1,
        size: 0,
        is_dir: false,
      });
      pushFiles(
        [{ path: "/x/a.ts", content: "old", dirty: false, lastMtimeMs: 1 }],
        "/x/a.ts",
      );
      render(<FilePreviewWorkspace />);

      await waitFor(() => {
        expect(fsStatMock).toHaveBeenCalled();
      });
      await new Promise((r) => setTimeout(r, 20));
      const f = useFileEditorStore.getState().openFiles[0];
      expect(f.content).toBe("old");
      expect(fsReadTextMock).not.toHaveBeenCalled();
    });

    it("banner 点 '重新加载' → fsStat + fsReadText 成功后 reloadFromDisk", async () => {
      fsStatMock.mockResolvedValue({
        exists: true,
        mtime_ms: 2,
        size: 0,
        is_dir: false,
      });
      pushFiles(
        [
          {
            path: "/x/a.ts",
            content: "我的修改",
            original: "old",
            dirty: true,
            lastMtimeMs: 1,
          },
        ],
        "/x/a.ts",
      );
      render(<FilePreviewWorkspace />);
      await screen.findByTestId("file-stale-banner");
      fsReadTextMock.mockResolvedValueOnce("磁盘最新内容");

      fireEvent.click(screen.getByTestId("file-stale-reload"));

      await waitFor(() => {
        const f = useFileEditorStore.getState().openFiles[0];
        expect(f.content).toBe("磁盘最新内容");
        expect(f.stale).toBe(false);
      });
    });

    it("banner 点 '保留我的' → dismissStale，content 不变", async () => {
      fsStatMock.mockResolvedValue({
        exists: true,
        mtime_ms: 2,
        size: 0,
        is_dir: false,
      });
      pushFiles(
        [
          {
            path: "/x/a.ts",
            content: "我的修改",
            original: "old",
            dirty: true,
            lastMtimeMs: 1,
          },
        ],
        "/x/a.ts",
      );
      render(<FilePreviewWorkspace />);
      await screen.findByTestId("file-stale-banner");

      fireEvent.click(screen.getByTestId("file-stale-keep"));

      await waitFor(() => {
        expect(
          screen.queryByTestId("file-stale-banner"),
        ).toBeNull();
      });
      const f = useFileEditorStore.getState().openFiles[0];
      expect(f.content).toBe("我的修改");
      expect(f.stale).toBe(false);
    });
  });

  // ===== v0.10.0 HR9-11：mousedown 记 lastSurface=editor =====

  it("mousedown workspace 容器 → focus-surface 记为 editor", () => {
    pushFiles([{ path: "/x/a.ts" }], "/x/a.ts");
    render(<FilePreviewWorkspace />);
    fireEvent.mouseDown(screen.getByTestId("file-preview-workspace"));
    expect(useFocusSurfaceStore.getState().lastSurface).toBe("editor");
  });
});
