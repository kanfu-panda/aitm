import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "../../stores/settings";
import { useFileEditorStore, type OpenFile } from "../../stores/file-editor";
import { useTabsStore } from "../../stores/tabs";

// mock onSystemMetrics + 新加 IPC（fsDiskUsage / gitCurrentBranch）
const emitFns: Array<(e: { rss_mb: number; cpu_pct: number; active_sessions: number }) => void> = [];
const gitBranchMock = vi.fn<(cwd: string) => Promise<string | null>>();
const diskUsageMock = vi.fn<(cwd: string) => Promise<{
  free_bytes: number;
  total_bytes: number;
  used_pct: number;
}>>();

vi.mock("../../lib/tauri", async (orig) => {
  const real = await orig<typeof import("../../lib/tauri")>();
  return {
    ...real,
    onSystemMetrics: vi.fn(async (cb: (e: { rss_mb: number; cpu_pct: number; active_sessions: number }) => void) => {
      emitFns.push(cb);
      return () => {
        const i = emitFns.indexOf(cb);
        if (i >= 0) emitFns.splice(i, 1);
      };
    }),
    gitCurrentBranch: (cwd: string) => gitBranchMock(cwd),
    fsDiskUsage: (cwd: string) => diskUsageMock(cwd),
  };
});

import StatusBar from "../StatusBar";

function makeOpenFile(overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    id: "/proj/vite.config.ts",
    path: "/proj/vite.config.ts",
    content: "",
    original: "",
    dirty: false,
    language: "ts",
    cursorLine: 1,
    cursorCol: 1,
    ...overrides,
  };
}

describe("StatusBar", () => {
  beforeEach(() => {
    emitFns.length = 0;
    useSettingsStore.setState({ statusBarEnabled: true });
    useFileEditorStore.setState({ openFiles: [], activeId: null });
    useTabsStore.setState({ tabs: [], activeId: null });
    gitBranchMock.mockReset();
    diskUsageMock.mockReset();
    // 默认：IPC 返 null / reject，让段隐藏，避免污染其它 test
    gitBranchMock.mockResolvedValue(null);
    diskUsageMock.mockRejectedValue(new Error("no disk in test"));
  });

  it("初次渲染显示占位符 —", () => {
    render(<StatusBar />);
    const bar = screen.getByTestId("status-bar");
    expect(bar).toBeInTheDocument();
    expect(bar).toHaveTextContent("—");
  });

  it("收到 metrics 事件后渲染 RSS / CPU / sessions", async () => {
    render(<StatusBar />);
    // 等 useEffect + then 把 cb 推进 emitFns
    await vi.waitFor(() => {
      expect(emitFns.length).toBe(1);
    });
    act(() => {
      emitFns[0]({ rss_mb: 27, cpu_pct: 1.5, active_sessions: 5 });
    });
    const bar = screen.getByTestId("status-bar");
    expect(bar).toHaveTextContent("RSS");
    expect(bar).toHaveTextContent("27");
    expect(bar).toHaveTextContent("MB");
    expect(bar).toHaveTextContent("CPU");
    expect(bar).toHaveTextContent("2"); // toFixed(0) of 1.5 → "2"
    expect(bar).toHaveTextContent("%");
    expect(bar).toHaveTextContent("5");
    expect(bar).toHaveTextContent("sessions");
  });

  it("statusBarEnabled = false 时不渲染", () => {
    useSettingsStore.setState({ statusBarEnabled: false });
    const { container } = render(<StatusBar />);
    expect(container.firstChild).toBeNull();
  });

  it("CPU > 50% 高亮 warn token", async () => {
    render(<StatusBar />);
    await vi.waitFor(() => expect(emitFns.length).toBe(1));
    act(() => {
      emitFns[0]({ rss_mb: 30, cpu_pct: 75, active_sessions: 1 });
    });
    const bar = screen.getByTestId("status-bar");
    // 找出文本为 75 的 span，应带 --c-warn token class
    const allSpans = Array.from(bar.querySelectorAll("span"));
    const cpuSpan = allSpans.find((s) => s.textContent === "75");
    expect(cpuSpan).not.toBeUndefined();
    expect(cpuSpan?.className).toContain("text-[var(--c-warn)]");
  });

  // ====== T5d：编辑器行列号 / 语言段 ======

  describe("编辑器行列号段（T5d）", () => {
    it("无 active file 时不显示编辑器段", () => {
      render(<StatusBar />);
      expect(screen.queryByTestId("status-bar-editor-info")).toBeNull();
    });

    it("focus 不在编辑器容器内时不显示编辑器段（即便有 active file）", () => {
      useFileEditorStore.setState({
        openFiles: [
          makeOpenFile({ cursorLine: 12, cursorCol: 34, language: "ts" }),
        ],
        activeId: "/proj/vite.config.ts",
      });
      render(<StatusBar />);
      // 没有 file-preview-workspace 容器存在 → surface != "editor"
      expect(screen.queryByTestId("status-bar-editor-info")).toBeNull();
    });

    it("focus 落入 [data-testid=file-preview-workspace] 容器后显示行列号 / UTF-8 / 语言 / LF", () => {
      useFileEditorStore.setState({
        openFiles: [
          makeOpenFile({ cursorLine: 12, cursorCol: 34, language: "ts" }),
        ],
        activeId: "/proj/vite.config.ts",
      });
      // 模拟 FilePreviewWorkspace 锚点已经挂载且持有焦点
      const root = document.createElement("div");
      root.setAttribute("data-testid", "file-preview-workspace");
      root.tabIndex = -1;
      document.body.appendChild(root);
      root.focus();

      render(<StatusBar />);
      // 触发 focusin 让 hook 重算（initial state 可能在 focus() 调用前 mount）
      act(() => {
        root.dispatchEvent(new Event("focusin", { bubbles: true }));
      });

      const seg = screen.getByTestId("status-bar-editor-info");
      expect(seg).toBeInTheDocument();
      expect(seg).toHaveTextContent("Ln 12, Col 34");
      expect(seg).toHaveTextContent("UTF-8");
      expect(seg).toHaveTextContent("TypeScript");
      expect(seg).toHaveTextContent("LF");

      root.remove();
    });

    it("languageLabel 按 language 字段映射（rs → Rust）", () => {
      useFileEditorStore.setState({
        openFiles: [
          makeOpenFile({
            id: "/proj/main.rs",
            path: "/proj/main.rs",
            language: "rs",
            cursorLine: 5,
            cursorCol: 9,
          }),
        ],
        activeId: "/proj/main.rs",
      });
      const root = document.createElement("div");
      root.setAttribute("data-testid", "file-preview-workspace");
      root.tabIndex = -1;
      document.body.appendChild(root);
      root.focus();

      render(<StatusBar />);
      act(() => {
        root.dispatchEvent(new Event("focusin", { bubbles: true }));
      });

      expect(screen.getByTestId("status-bar-language")).toHaveTextContent(
        "Rust",
      );
      expect(screen.getByTestId("status-bar-editor-info")).toHaveTextContent(
        "Ln 5, Col 9",
      );

      root.remove();
    });

    it("切换 active file 时数字 / 语言更新", () => {
      const tsFile = makeOpenFile({
        id: "/proj/a.ts",
        path: "/proj/a.ts",
        language: "ts",
        cursorLine: 3,
        cursorCol: 4,
      });
      const mdFile = makeOpenFile({
        id: "/proj/README.md",
        path: "/proj/README.md",
        language: "md",
        cursorLine: 100,
        cursorCol: 1,
      });
      useFileEditorStore.setState({
        openFiles: [tsFile, mdFile],
        activeId: "/proj/a.ts",
      });
      const root = document.createElement("div");
      root.setAttribute("data-testid", "file-preview-workspace");
      root.tabIndex = -1;
      document.body.appendChild(root);
      root.focus();

      render(<StatusBar />);
      act(() => {
        root.dispatchEvent(new Event("focusin", { bubbles: true }));
      });

      expect(screen.getByTestId("status-bar-editor-info")).toHaveTextContent(
        "Ln 3, Col 4",
      );
      expect(screen.getByTestId("status-bar-language")).toHaveTextContent(
        "TypeScript",
      );

      act(() => {
        useFileEditorStore.setState({ activeId: "/proj/README.md" });
      });
      expect(screen.getByTestId("status-bar-editor-info")).toHaveTextContent(
        "Ln 100, Col 1",
      );
      expect(screen.getByTestId("status-bar-language")).toHaveTextContent(
        "Markdown",
      );

      root.remove();
    });

    it("focus 离开编辑器容器后隐藏（focusout 重算）", () => {
      useFileEditorStore.setState({
        openFiles: [makeOpenFile()],
        activeId: "/proj/vite.config.ts",
      });
      const root = document.createElement("div");
      root.setAttribute("data-testid", "file-preview-workspace");
      root.tabIndex = -1;
      document.body.appendChild(root);
      const other = document.createElement("button");
      other.textContent = "outside";
      document.body.appendChild(other);

      root.focus();
      render(<StatusBar />);
      act(() => {
        root.dispatchEvent(new Event("focusin", { bubbles: true }));
      });
      expect(screen.queryByTestId("status-bar-editor-info")).not.toBeNull();

      // 焦点移出
      other.focus();
      act(() => {
        document.dispatchEvent(new Event("focusin", { bubbles: true }));
      });
      expect(screen.queryByTestId("status-bar-editor-info")).toBeNull();

      root.remove();
      other.remove();
    });

    it("点击行列号触发 prompt（stub），用户取消时不报错", () => {
      useFileEditorStore.setState({
        openFiles: [makeOpenFile({ cursorLine: 1, cursorCol: 1 })],
        activeId: "/proj/vite.config.ts",
      });
      const root = document.createElement("div");
      root.setAttribute("data-testid", "file-preview-workspace");
      root.tabIndex = -1;
      document.body.appendChild(root);
      root.focus();

      const promptSpy = vi
        .spyOn(window, "prompt")
        .mockReturnValueOnce(null);

      render(<StatusBar />);
      act(() => {
        root.dispatchEvent(new Event("focusin", { bubbles: true }));
      });

      const goto = screen.getByTestId("status-bar-goto-line");
      fireEvent.click(goto);
      expect(promptSpy).toHaveBeenCalledTimes(1);

      promptSpy.mockRestore();
      root.remove();
    });
  });

  // ====== v0.9.1 HR3-3：左 / 中 / 右段重排 ======

  describe("左段 文件路径 + 复制（HR3-3）", () => {
    it("无 active editor / 无 active terminal cwd 时不显示路径段", () => {
      render(<StatusBar />);
      expect(screen.queryByTestId("status-bar-file-path")).toBeNull();
    });

    it("有 active editor 时显示文件路径", () => {
      useFileEditorStore.setState({
        openFiles: [makeOpenFile({ path: "/proj/app/src/main.ts" })],
        activeId: "/proj/vite.config.ts",
      });
      render(<StatusBar />);
      const btn = screen.getByTestId("status-bar-file-path");
      expect(btn).toHaveTextContent("/proj/app/src/main.ts");
    });

    it("无 editor 但有 terminal cwd 时显示 cwd 路径", () => {
      useTabsStore.setState({
        tabs: [
          {
            id: "tab-1",
            title: "term",
            sessionId: "s1",
            auto_title: true,
            cwd: "/Users/leo/work/aitm",
          },
        ],
        activeId: "tab-1",
      });
      render(<StatusBar />);
      const btn = screen.getByTestId("status-bar-file-path");
      expect(btn).toHaveTextContent("/Users/leo/work/aitm");
    });

    it("点击文件路径调 navigator.clipboard.writeText", async () => {
      useFileEditorStore.setState({
        openFiles: [makeOpenFile({ path: "/proj/app/src/foo.ts" })],
        activeId: "/proj/vite.config.ts",
      });
      const writeText = vi.fn().mockResolvedValue(undefined);
      // jsdom 默认无 clipboard；mock 注入
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText },
        configurable: true,
      });

      render(<StatusBar />);
      const btn = screen.getByTestId("status-bar-file-path");
      fireEvent.click(btn);

      await vi.waitFor(() => {
        expect(writeText).toHaveBeenCalledWith("/proj/app/src/foo.ts");
      });
    });
  });

  describe("中段 git 分支（HR3-3）", () => {
    it("非 git repo（IPC 返 null）时不显示中段", async () => {
      useTabsStore.setState({
        tabs: [
          {
            id: "tab-1",
            title: "term",
            sessionId: "s1",
            auto_title: true,
            cwd: "/tmp/not-a-repo",
          },
        ],
        activeId: "tab-1",
      });
      gitBranchMock.mockResolvedValue(null);

      render(<StatusBar />);
      // 等首次 IPC 完成
      await vi.waitFor(() => {
        expect(gitBranchMock).toHaveBeenCalledWith("/tmp/not-a-repo");
      });
      expect(screen.queryByTestId("status-bar-git-branch")).toBeNull();
    });

    it("git repo 显示分支名", async () => {
      useTabsStore.setState({
        tabs: [
          {
            id: "tab-1",
            title: "term",
            sessionId: "s1",
            auto_title: true,
            cwd: "/proj/aitm",
          },
        ],
        activeId: "tab-1",
      });
      gitBranchMock.mockResolvedValue("feat/v0.9.1");

      render(<StatusBar />);
      const seg = await screen.findByTestId("status-bar-git-branch");
      expect(seg).toHaveTextContent("feat/v0.9.1");
    });

    it("active editor 时用文件父目录调 git_current_branch", async () => {
      useFileEditorStore.setState({
        openFiles: [
          makeOpenFile({ path: "/Users/leo/proj/aitm/src/main.rs" }),
        ],
        activeId: "/proj/vite.config.ts",
      });
      gitBranchMock.mockResolvedValue("master");

      render(<StatusBar />);
      await vi.waitFor(() => {
        expect(gitBranchMock).toHaveBeenCalledWith(
          "/Users/leo/proj/aitm/src",
        );
      });
    });
  });

  describe("右段 网络 / 磁盘（HR3-3）", () => {
    it("navigator.onLine = true 时显示 Wifi 图标", () => {
      Object.defineProperty(navigator, "onLine", {
        value: true,
        configurable: true,
      });
      render(<StatusBar />);
      const net = screen.getByTestId("status-bar-network");
      expect(net.getAttribute("data-online")).toBe("true");
    });

    it("navigator.onLine = false 时显示 WifiOff", () => {
      Object.defineProperty(navigator, "onLine", {
        value: false,
        configurable: true,
      });
      render(<StatusBar />);
      const net = screen.getByTestId("status-bar-network");
      expect(net.getAttribute("data-online")).toBe("false");
    });

    it("offline → online 事件切换图标", () => {
      Object.defineProperty(navigator, "onLine", {
        value: false,
        configurable: true,
      });
      render(<StatusBar />);
      expect(
        screen.getByTestId("status-bar-network").getAttribute("data-online"),
      ).toBe("false");

      act(() => {
        Object.defineProperty(navigator, "onLine", {
          value: true,
          configurable: true,
        });
        window.dispatchEvent(new Event("online"));
      });
      expect(
        screen.getByTestId("status-bar-network").getAttribute("data-online"),
      ).toBe("true");
    });

    it("有 cwd + fsDiskUsage 成功 → 显示百分比", async () => {
      useTabsStore.setState({
        tabs: [
          {
            id: "tab-1",
            title: "term",
            sessionId: "s1",
            auto_title: true,
            cwd: "/Users/leo",
          },
        ],
        activeId: "tab-1",
      });
      diskUsageMock.mockResolvedValue({
        free_bytes: 100 * 1024 ** 3,
        total_bytes: 500 * 1024 ** 3,
        used_pct: 80,
      });

      render(<StatusBar />);
      const seg = await screen.findByTestId("status-bar-disk");
      expect(seg).toHaveTextContent("80%");
    });

    it("fsDiskUsage 失败时不显示磁盘段", async () => {
      useTabsStore.setState({
        tabs: [
          {
            id: "tab-1",
            title: "term",
            sessionId: "s1",
            auto_title: true,
            cwd: "/bad/path",
          },
        ],
        activeId: "tab-1",
      });
      diskUsageMock.mockRejectedValue(new Error("no disk"));

      render(<StatusBar />);
      await vi.waitFor(() => {
        expect(diskUsageMock).toHaveBeenCalled();
      });
      expect(screen.queryByTestId("status-bar-disk")).toBeNull();
    });

    it("used_pct >= 90% 使用 warn 配色", async () => {
      useTabsStore.setState({
        tabs: [
          {
            id: "tab-1",
            title: "term",
            sessionId: "s1",
            auto_title: true,
            cwd: "/almost-full",
          },
        ],
        activeId: "tab-1",
      });
      diskUsageMock.mockResolvedValue({
        free_bytes: 5 * 1024 ** 3,
        total_bytes: 500 * 1024 ** 3,
        used_pct: 95,
      });

      render(<StatusBar />);
      const seg = await screen.findByTestId("status-bar-disk");
      expect(seg.className).toContain("text-[var(--c-warn)]");
    });
  });
});
