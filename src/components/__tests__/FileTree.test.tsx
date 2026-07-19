import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TreeNode } from "../../lib/tauri";

/**
 * FileTree 单测覆盖 Phase 3A T2：
 * - mock fs_tree + sessionCurrentCwd（lib/tauri 全模块 mock）
 * - 默认 / 假树渲染 / 点 dir 懒加载 / 点 .md / 点非 .md / cwd=null 占位
 */

// === lib/tauri mock：fsTree + sessionCurrentCwd + gitStatus 各自一份 spy ===
const fsTreeMock = vi.fn();
const sessionCurrentCwdMock = vi.fn();
const gitStatusMock = vi.fn();
// v1.1.0 F5：fs watcher mock。onFsChangedMock 记录最近一次注册的回调，
// 测试里手动调用它模拟后端 emit `fs:changed`；返回的 unlisten 是可断言的 spy。
const fsWatchStartMock = vi.fn();
const fsWatchStopMock = vi.fn();
const onFsChangedMock = vi.fn();
const fsChangedUnlistenMock = vi.fn();
vi.mock("../../lib/tauri", async (orig) => {
  const real = await orig<typeof import("../../lib/tauri")>();
  return {
    ...real,
    fsTree: (...args: Parameters<typeof real.fsTree>) =>
      fsTreeMock(...args),
    sessionCurrentCwd: (...args: Parameters<typeof real.sessionCurrentCwd>) =>
      sessionCurrentCwdMock(...args),
    gitStatus: (...args: Parameters<typeof real.gitStatus>) =>
      gitStatusMock(...args),
    fsWatchStart: (...args: Parameters<typeof real.fsWatchStart>) =>
      fsWatchStartMock(...args),
    fsWatchStop: (...args: Parameters<typeof real.fsWatchStop>) =>
      fsWatchStopMock(...args),
    onFsChanged: (...args: Parameters<typeof real.onFsChanged>) =>
      onFsChangedMock(...args),
  };
});

import FileTree from "../FileTree";
import { useTabsStore } from "../../stores/tabs";
import { useFileEditorStore } from "../../stores/file-editor";
import { useGitStatusStore } from "../../stores/git-status";
import { useSidebarStore } from "../../stores/sidebar";
import {
  INITIAL_GROUP_ID,
  usePaneLayoutStore,
} from "../../stores/pane-layout";

function fakeRootTree(): TreeNode {
  return {
    name: "myproj",
    path: "/Users/me/myproj",
    kind: "dir",
    children: [
      {
        name: "src",
        path: "/Users/me/myproj/src",
        kind: "dir",
        children: null, // 懒加载占位
      },
      {
        name: "README.md",
        path: "/Users/me/myproj/README.md",
        kind: "file",
        children: null,
      },
      {
        name: "Cargo.toml",
        path: "/Users/me/myproj/Cargo.toml",
        kind: "file",
        children: null,
      },
    ],
  };
}

describe("FileTree", () => {
  beforeEach(() => {
    fsTreeMock.mockReset();
    sessionCurrentCwdMock.mockReset();
    gitStatusMock.mockReset();
    // 默认 git_status mock：返空数组（无脏文件）。单 case 可 mockResolvedValueOnce 覆盖。
    gitStatusMock.mockResolvedValue([]);
    // v1.1.0 F5：fs watcher mock 默认行为 —— start/stop 都 resolve undefined，
    // onFsChanged 默认 resolve 一个可断言的 unlisten spy。单 case 可覆盖捕获回调。
    fsWatchStartMock.mockReset().mockResolvedValue(undefined);
    fsWatchStopMock.mockReset().mockResolvedValue(undefined);
    fsChangedUnlistenMock.mockReset();
    onFsChangedMock.mockReset().mockResolvedValue(fsChangedUnlistenMock);
    useTabsStore.setState({ tabs: [], activeId: null, unreadByTab: {} });
    useFileEditorStore.setState({ openFiles: [], activeId: null });
    useGitStatusStore.setState({ byPath: {} });
    // v0.10.0 HR7-4：reset pane-layout 到默认根（单 terminal group）
    usePaneLayoutStore.setState({
      root: {
        kind: "leaf",
        group: {
          id: INITIAL_GROUP_ID,
          type: "terminal",
          tab_ids: [],
          active_tab_id: null,
        },
      },
      active_group_id: INITIAL_GROUP_ID,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("无 active session（cwd=null）→ 显示占位文字", async () => {
    sessionCurrentCwdMock.mockResolvedValue(null);
    render(<FileTree />);
    await waitFor(() => {
      expect(screen.getByText("未检测到当前目录")).toBeTruthy();
    });
    expect(fsTreeMock).not.toHaveBeenCalled();
  });

  it("有 cwd → 调 fsTree(cwd, 1) + 渲染子节点", async () => {
    const tabId = useTabsStore.getState().addTab();
    useTabsStore.getState().setSessionId(tabId, "session-uuid-1");
    sessionCurrentCwdMock.mockResolvedValue("/Users/me/myproj");
    fsTreeMock.mockResolvedValue(fakeRootTree());

    render(<FileTree />);

    await waitFor(() => {
      expect(fsTreeMock).toHaveBeenCalledWith("/Users/me/myproj", 1);
    });
    await waitFor(() => {
      expect(screen.getByText("src")).toBeTruthy();
      expect(screen.getByText("README.md")).toBeTruthy();
      expect(screen.getByText("Cargo.toml")).toBeTruthy();
    });
  });

  it("点 dir → 状态变展开 + 调用 fsTree 第二次拉子节点", async () => {
    const tabId = useTabsStore.getState().addTab();
    useTabsStore.getState().setSessionId(tabId, "sid");
    sessionCurrentCwdMock.mockResolvedValue("/Users/me/myproj");
    fsTreeMock.mockResolvedValueOnce(fakeRootTree()); // root
    fsTreeMock.mockResolvedValueOnce({
      name: "src",
      path: "/Users/me/myproj/src",
      kind: "dir",
      children: [
        {
          name: "main.rs",
          path: "/Users/me/myproj/src/main.rs",
          kind: "file",
          children: null,
        },
      ],
    } as TreeNode); // 展开 src 后

    render(<FileTree />);
    await waitFor(() => {
      expect(screen.getByText("src")).toBeTruthy();
    });

    // 点 src dir → 应触发 fsTree(src.path, 1)
    fireEvent.click(screen.getByText("src"));

    await waitFor(() => {
      expect(fsTreeMock).toHaveBeenCalledWith("/Users/me/myproj/src", 1);
    });
    await waitFor(() => {
      expect(screen.getByText("main.rs")).toBeTruthy();
    });
  });

  // v0.9.0 H5：点文件 → useFileEditorStore.openFile（不再调 setPreviewPath）
  it("点 .md 文件 → 调 useFileEditorStore.openFile", async () => {
    const openFileSpy = vi
      .spyOn(useFileEditorStore.getState(), "openFile")
      .mockResolvedValue();
    const tabId = useTabsStore.getState().addTab();
    useTabsStore.getState().setSessionId(tabId, "sid");
    sessionCurrentCwdMock.mockResolvedValue("/Users/me/myproj");
    fsTreeMock.mockResolvedValue(fakeRootTree());

    render(<FileTree />);
    await waitFor(() => {
      expect(screen.getByText("README.md")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("README.md"));
    expect(openFileSpy).toHaveBeenCalledWith("/Users/me/myproj/README.md");
  });

  // v1.1.0：预览面板被收起（filePreviewVisible=false）时，点文件应强制展开预览，
  // 否则 openFile 了但面板不显示、用户看不到文件（对齐 VS Code 等工具）。
  it("预览面板收起时点文件 → 强制 setFilePreviewVisible(true) 展开预览", async () => {
    vi.spyOn(useFileEditorStore.getState(), "openFile").mockResolvedValue();
    // 模拟用户先把预览面板收起
    useSidebarStore.getState().setFilePreviewVisible(false);
    expect(useSidebarStore.getState().filePreviewVisible).toBe(false);
    const tabId = useTabsStore.getState().addTab();
    useTabsStore.getState().setSessionId(tabId, "sid");
    sessionCurrentCwdMock.mockResolvedValue("/Users/me/myproj");
    fsTreeMock.mockResolvedValue(fakeRootTree());

    render(<FileTree />);
    await waitFor(() => {
      expect(screen.getByText("README.md")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("README.md"));
    // 点文件后预览面板恢复可见
    expect(useSidebarStore.getState().filePreviewVisible).toBe(true);
  });

  it("点非 .md 文件也触发 openFile（编辑器内部按扩展名推断语言）", async () => {
    const openFileSpy = vi
      .spyOn(useFileEditorStore.getState(), "openFile")
      .mockResolvedValue();
    const tabId = useTabsStore.getState().addTab();
    useTabsStore.getState().setSessionId(tabId, "sid");
    sessionCurrentCwdMock.mockResolvedValue("/Users/me/myproj");
    fsTreeMock.mockResolvedValue(fakeRootTree());

    render(<FileTree />);
    await waitFor(() => {
      expect(screen.getByText("Cargo.toml")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Cargo.toml"));
    expect(openFileSpy).toHaveBeenCalledWith("/Users/me/myproj/Cargo.toml");
  });

  it("fsTree 失败 → 显示错误占位文字", async () => {
    const tabId = useTabsStore.getState().addTab();
    useTabsStore.getState().setSessionId(tabId, "sid");
    sessionCurrentCwdMock.mockResolvedValue("/some/missing");
    fsTreeMock.mockRejectedValue(new Error("路径不存在"));

    render(<FileTree />);
    await waitFor(() => {
      expect(screen.getByText(/读取失败/)).toBeTruthy();
    });
  });

  it(".markdown 后缀（大小写不敏感）也触发 openFile", async () => {
    const openFileSpy = vi
      .spyOn(useFileEditorStore.getState(), "openFile")
      .mockResolvedValue();
    const tabId = useTabsStore.getState().addTab();
    useTabsStore.getState().setSessionId(tabId, "sid");
    sessionCurrentCwdMock.mockResolvedValue("/Users/me/myproj");
    fsTreeMock.mockResolvedValue({
      name: "myproj",
      path: "/Users/me/myproj",
      kind: "dir",
      children: [
        {
          name: "NOTES.MARKDOWN",
          path: "/Users/me/myproj/NOTES.MARKDOWN",
          kind: "file",
          children: null,
        },
      ],
    } as TreeNode);

    render(<FileTree />);
    await waitFor(() => {
      expect(screen.getByText("NOTES.MARKDOWN")).toBeTruthy();
    });
    fireEvent.click(screen.getByText("NOTES.MARKDOWN"));
    expect(openFileSpy).toHaveBeenCalledWith("/Users/me/myproj/NOTES.MARKDOWN");
  });

  // v0.5.0-C T3：cwd 轮询跟随逻辑（真机 smoke 验，vitest 跳过 — vi.useFakeTimers +
  // setInterval 内 async 闭包 + waitFor 组合在 jsdom 下不稳；逻辑简单 ~10 行直接看代码）

  // === v0.9.1 HR3-6：git status 染色 ===

  it("有 cwd → 调 gitStatus(cwd) 至少一次", async () => {
    const tabId = useTabsStore.getState().addTab();
    useTabsStore.getState().setSessionId(tabId, "sid");
    sessionCurrentCwdMock.mockResolvedValue("/Users/me/myproj");
    fsTreeMock.mockResolvedValue(fakeRootTree());

    render(<FileTree />);
    await waitFor(() => {
      expect(gitStatusMock).toHaveBeenCalledWith("/Users/me/myproj");
    });
  });

  it("modified 文件 → 文件名加 text-amber-400", async () => {
    const tabId = useTabsStore.getState().addTab();
    useTabsStore.getState().setSessionId(tabId, "sid");
    sessionCurrentCwdMock.mockResolvedValue("/Users/me/myproj");
    fsTreeMock.mockResolvedValue(fakeRootTree());
    gitStatusMock.mockResolvedValue([
      { path: "/Users/me/myproj/README.md", status: "modified" },
    ]);

    render(<FileTree />);
    await waitFor(() => {
      expect(screen.getByText("README.md")).toBeTruthy();
    });
    // 等 git store refresh 完
    await waitFor(() => {
      const span = screen.getByText("README.md");
      expect(span.className).toContain("text-amber-400");
    });
  });

  it("untracked 文件 → text-emerald-500 + italic（v0.10.2 #11：从 zinc 改成 VS Code 风格绿色）", async () => {
    const tabId = useTabsStore.getState().addTab();
    useTabsStore.getState().setSessionId(tabId, "sid");
    sessionCurrentCwdMock.mockResolvedValue("/Users/me/myproj");
    fsTreeMock.mockResolvedValue(fakeRootTree());
    gitStatusMock.mockResolvedValue([
      { path: "/Users/me/myproj/Cargo.toml", status: "untracked" },
    ]);

    render(<FileTree />);
    await waitFor(() => {
      expect(screen.getByText("Cargo.toml")).toBeTruthy();
    });
    await waitFor(() => {
      const span = screen.getByText("Cargo.toml");
      expect(span.className).toContain("text-emerald-500");
      expect(span.className).toContain("italic");
    });
  });

  it("dir 下有脏文件 → 显示 amber 圆点", async () => {
    const tabId = useTabsStore.getState().addTab();
    useTabsStore.getState().setSessionId(tabId, "sid");
    sessionCurrentCwdMock.mockResolvedValue("/Users/me/myproj");
    fsTreeMock.mockResolvedValue(fakeRootTree());
    // src/ 下有改文件
    gitStatusMock.mockResolvedValue([
      { path: "/Users/me/myproj/src/main.rs", status: "modified" },
    ]);

    render(<FileTree />);
    await waitFor(() => {
      expect(screen.getByText("src")).toBeTruthy();
    });
    await waitFor(() => {
      const dots = screen.queryAllByTestId("git-dir-dirty-dot");
      expect(dots.length).toBeGreaterThan(0);
    });
  });

  // ============================================================
  // v0.10.0 HR9-1：点文件 → openFile（不再 auto-create editor pane group）
  // ============================================================

  it("点文件 → openFile（FilePreviewWorkspace 全局单例，不再创建 editor group）", async () => {
    const openFileSpy = vi
      .spyOn(useFileEditorStore.getState(), "openFile")
      .mockResolvedValue();
    const splitSpy = vi.spyOn(
      usePaneLayoutStore.getState(),
      "splitGroupWithNewTab",
    );
    const addTabSpy = vi.spyOn(
      usePaneLayoutStore.getState(),
      "addTabToGroup",
    );

    const tabId = useTabsStore.getState().addTab();
    useTabsStore.getState().setSessionId(tabId, "sid");
    sessionCurrentCwdMock.mockResolvedValue("/Users/me/myproj");
    fsTreeMock.mockResolvedValue(fakeRootTree());

    render(<FileTree />);
    await waitFor(() => {
      expect(screen.getByText("README.md")).toBeTruthy();
    });
    fireEvent.click(screen.getByText("README.md"));

    // openFile 必被调
    expect(openFileSpy).toHaveBeenCalledWith("/Users/me/myproj/README.md");
    // 不应再创建 editor pane group（HR9-1：editor 是全局单例）
    expect(splitSpy).not.toHaveBeenCalled();
    expect(addTabSpy).not.toHaveBeenCalled();
  });

  it("无脏文件 → 不显示任何圆点", async () => {
    const tabId = useTabsStore.getState().addTab();
    useTabsStore.getState().setSessionId(tabId, "sid");
    sessionCurrentCwdMock.mockResolvedValue("/Users/me/myproj");
    fsTreeMock.mockResolvedValue(fakeRootTree());
    gitStatusMock.mockResolvedValue([]); // 干净

    render(<FileTree />);
    await waitFor(() => {
      expect(screen.getByText("src")).toBeTruthy();
    });
    // 等一拍确保 git refresh 已跑
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryAllByTestId("git-dir-dirty-dot")).toHaveLength(0);
  });

  // ============================================================
  // v1.1.0 F5：目录树 fs 自动刷新（notify watcher → fs:changed）
  // ============================================================

  it("有 cwd → 启动 fs watcher（fsWatchStart(cwd)）并订阅 fs:changed", async () => {
    const tabId = useTabsStore.getState().addTab();
    useTabsStore.getState().setSessionId(tabId, "sid");
    sessionCurrentCwdMock.mockResolvedValue("/Users/me/myproj");
    fsTreeMock.mockResolvedValue(fakeRootTree());

    render(<FileTree />);

    await waitFor(() => {
      expect(fsWatchStartMock).toHaveBeenCalledWith("/Users/me/myproj");
    });
    await waitFor(() => {
      expect(onFsChangedMock).toHaveBeenCalledTimes(1);
    });
  });

  it("收到 fs:changed 事件 → debounce 后重新拉取目录树", async () => {
    const tabId = useTabsStore.getState().addTab();
    useTabsStore.getState().setSessionId(tabId, "sid");
    sessionCurrentCwdMock.mockResolvedValue("/Users/me/myproj");
    fsTreeMock.mockResolvedValue(fakeRootTree());

    let fsChangedHandler: ((e: { paths: string[] }) => void) | null = null;
    onFsChangedMock.mockImplementation((cb: (e: { paths: string[] }) => void) => {
      fsChangedHandler = cb;
      return Promise.resolve(fsChangedUnlistenMock);
    });

    render(<FileTree />);
    await waitFor(() => {
      expect(screen.getByText("src")).toBeTruthy();
    });
    await waitFor(() => {
      expect(fsChangedHandler).not.toBeNull();
    });

    const callsBefore = fsTreeMock.mock.calls.length;
    fsChangedHandler!({ paths: ["/Users/me/myproj/new.txt"] });

    // 前端再 debounce ~200ms 才触发 reloadTree（内部又调一次 fsTree(rootCwd, 1)）
    await waitFor(
      () => {
        expect(fsTreeMock.mock.calls.length).toBeGreaterThan(callsBefore);
      },
      { timeout: 1000 },
    );
    expect(fsTreeMock).toHaveBeenCalledWith("/Users/me/myproj", 1);
  });

  it("组件卸载 → 停止 fs watcher + 取消事件订阅", async () => {
    const tabId = useTabsStore.getState().addTab();
    useTabsStore.getState().setSessionId(tabId, "sid");
    sessionCurrentCwdMock.mockResolvedValue("/Users/me/myproj");
    fsTreeMock.mockResolvedValue(fakeRootTree());

    const { unmount } = render(<FileTree />);
    await waitFor(() => {
      expect(fsWatchStartMock).toHaveBeenCalledWith("/Users/me/myproj");
    });
    await waitFor(() => {
      expect(onFsChangedMock).toHaveBeenCalledTimes(1);
    });

    unmount();

    await waitFor(() => {
      expect(fsWatchStopMock).toHaveBeenCalled();
    });
    expect(fsChangedUnlistenMock).toHaveBeenCalled();
  });

  it("无 cwd（cwd=null）→ 不启动 fs watcher", async () => {
    sessionCurrentCwdMock.mockResolvedValue(null);
    render(<FileTree />);
    await waitFor(() => {
      expect(screen.getByText("未检测到当前目录")).toBeTruthy();
    });
    expect(fsWatchStartMock).not.toHaveBeenCalled();
    expect(onFsChangedMock).not.toHaveBeenCalled();
  });
});
