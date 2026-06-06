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

// mock CodeMirrorViewer 避免在 jsdom 起重；只渲染 stub
vi.mock("../CodeMirrorViewer", () => ({
  __esModule: true,
  default: ({ path }: { path: string }) => (
    <div data-testid={`cm-stub-${path}`}>{path}</div>
  ),
}));

// tauri 层 partial mock：保留 browserHideAllActive 等 useBrowserModalGuard 依赖；
// 只覆盖本测试关心的 fsReadText / settings 路径，避免误把 dialog modal-guard 打断。
vi.mock("../../lib/tauri", async (orig) => {
  const real = await orig<typeof import("../../lib/tauri")>();
  return {
    ...real,
    fsReadText: vi.fn(),
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
import FilePreviewWorkspace from "../FilePreviewWorkspace";

function resetStore() {
  useFileEditorStore.setState({ openFiles: [], activeId: null });
  __cancelPendingPersistForTest();
  __setPersistFnForTest(() => {});
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

  it("dialog '保存并关闭'（T5b saveFile throw）→ 降级走 closeFile 仍关 tab", async () => {
    pushFiles(
      [{ path: "/x/a.ts", dirty: true }],
      "/x/a.ts",
    );
    render(<FilePreviewWorkspace />);
    fireEvent.click(screen.getByTestId("file-tab-close-/x/a.ts"));
    await screen.findByTestId("close-file-confirm-dialog");
    fireEvent.click(screen.getByTestId("close-file-btn-save"));
    // T5b 阶段 saveFile 占位 throw；FilePreviewWorkspace 内部 catch 后走 closeFile
    await waitFor(() => {
      expect(useFileEditorStore.getState().openFiles).toHaveLength(0);
    });
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
});
