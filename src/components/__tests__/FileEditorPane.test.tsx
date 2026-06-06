/* =============================================================================
 * FileEditorPane 单测（v0.9.0 T5e）
 * -----------------------------------------------------------------------------
 * 覆盖 T5e Markdown 预览 / 原文双模式：
 *   - 非 md 文件：不渲染 md-mode toolbar；走 CodeMirror
 *   - md 文件默认 mdMode=preview：渲染 ReactMarkdown（无 cm-stub）
 *   - md 文件点 "原文" → store.setMdMode("raw") → 显示 cm-stub
 *   - md 文件点 "预览" → store.setMdMode("preview") → 看到渲染结果
 *   - 切换不丢 file.content（store 字段不变）
 *   - "预览" / "原文" 按钮 aria-pressed 状态正确
 *
 * mock CodeMirrorViewer 防 jsdom 起重；只渲染含 path 的 stub div。
 * ========================================================================== */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

// mock CodeMirrorViewer：渲染 cm-stub-<path> + 显示 content / language（断言用）
vi.mock("../CodeMirrorViewer", () => ({
  __esModule: true,
  default: ({
    path,
    content,
    language,
  }: {
    path: string;
    content: string;
    language?: string;
  }) => (
    <div data-testid={`cm-stub-${path}`} data-language={language ?? ""}>
      {content}
    </div>
  ),
}));

vi.mock("../../lib/tauri", async (orig) => {
  const real = await orig<typeof import("../../lib/tauri")>();
  return {
    ...real,
    settingsUpdate: vi.fn().mockResolvedValue(undefined),
    settingsGet: vi.fn().mockResolvedValue({}),
    fileWrite: vi.fn().mockResolvedValue(undefined),
  };
});

import { fileWrite } from "../../lib/tauri";
import {
  __cancelPendingPersistForTest,
  __setPersistFnForTest,
  useFileEditorStore,
  type OpenFile,
} from "../../stores/file-editor";
import FileEditorPane from "../FileEditorPane";

const fileWriteMock = fileWrite as unknown as ReturnType<typeof vi.fn>;

function makeFile(overrides: Partial<OpenFile>): OpenFile {
  const path = overrides.path ?? overrides.id ?? "/x/a.txt";
  return {
    id: overrides.id ?? path,
    path,
    content: overrides.content ?? "",
    original: overrides.original ?? overrides.content ?? "",
    dirty: overrides.dirty ?? false,
    language: overrides.language,
    cursorLine: overrides.cursorLine ?? 1,
    cursorCol: overrides.cursorCol ?? 1,
    mdMode: overrides.mdMode,
  };
}

function pushFile(file: OpenFile) {
  useFileEditorStore.setState({ openFiles: [file], activeId: file.id });
}

beforeEach(() => {
  useFileEditorStore.setState({ openFiles: [], activeId: null });
  __cancelPendingPersistForTest();
  __setPersistFnForTest(() => {});
  fileWriteMock.mockReset();
  fileWriteMock.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe("FileEditorPane T5e Markdown 双模式", () => {
  it("非 md 文件 → 不渲染 toolbar，走 CodeMirror", () => {
    const file = makeFile({
      path: "/x/a.ts",
      content: "const x = 1;",
      language: "ts",
    });
    pushFile(file);
    render(<FileEditorPane file={file} />);
    expect(screen.queryByTestId(`md-mode-toolbar-${file.id}`)).toBeNull();
    expect(screen.getByTestId(`cm-stub-${file.path}`)).toBeTruthy();
  });

  it("md 文件默认 mdMode=preview → 渲染 ReactMarkdown，无 cm-stub", () => {
    const file = makeFile({
      path: "/x/README.md",
      content: "# 标题\n\n正文",
      language: "md",
      mdMode: "preview",
    });
    pushFile(file);
    render(<FileEditorPane file={file} />);
    expect(screen.getByTestId(`md-mode-toolbar-${file.id}`)).toBeTruthy();
    expect(screen.getByTestId(`md-preview-${file.id}`)).toBeTruthy();
    // ReactMarkdown 把 # 标题 渲染成 <h1>标题</h1>
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("标题");
    expect(screen.queryByTestId(`cm-stub-${file.path}`)).toBeNull();
  });

  it("点 \"原文\" 按钮 → store.setMdMode(raw) → 显示 cm-stub", () => {
    const file = makeFile({
      path: "/x/doc.md",
      content: "# hi",
      language: "md",
      mdMode: "preview",
    });
    pushFile(file);
    const { rerender } = render(<FileEditorPane file={file} />);

    fireEvent.click(screen.getByTestId(`md-mode-raw-${file.id}`));

    // store 已切到 raw
    const updated = useFileEditorStore.getState().openFiles[0];
    expect(updated.mdMode).toBe("raw");

    // 重新渲染带最新 file
    rerender(<FileEditorPane file={updated} />);
    expect(screen.queryByTestId(`md-preview-${file.id}`)).toBeNull();
    const cm = screen.getByTestId(`cm-stub-${file.path}`);
    expect(cm).toBeTruthy();
    // 切到 raw 时 CodeMirror 拿到原始 content（dirty 状态保留）
    expect(cm.textContent).toBe("# hi");
    expect(cm.getAttribute("data-language")).toBe("md");
  });

  it("raw 状态点 \"预览\" → 回到渲染结果", () => {
    const file = makeFile({
      path: "/x/doc.md",
      content: "# hi",
      language: "md",
      mdMode: "raw",
    });
    pushFile(file);
    const { rerender } = render(<FileEditorPane file={file} />);

    expect(screen.getByTestId(`cm-stub-${file.path}`)).toBeTruthy();

    fireEvent.click(screen.getByTestId(`md-mode-preview-${file.id}`));
    const updated = useFileEditorStore.getState().openFiles[0];
    expect(updated.mdMode).toBe("preview");

    rerender(<FileEditorPane file={updated} />);
    expect(screen.queryByTestId(`cm-stub-${file.path}`)).toBeNull();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("hi");
  });

  it("切换 preview / raw 不应改变 file.content（store 字段保留）", () => {
    const file = makeFile({
      path: "/x/doc.md",
      content: "# 原内容",
      language: "md",
      mdMode: "preview",
      dirty: true,
      original: "# 老盘",
    });
    pushFile(file);
    render(<FileEditorPane file={file} />);

    fireEvent.click(screen.getByTestId(`md-mode-raw-${file.id}`));
    const afterRaw = useFileEditorStore.getState().openFiles[0];
    expect(afterRaw.content).toBe("# 原内容");
    expect(afterRaw.dirty).toBe(true);
    expect(afterRaw.original).toBe("# 老盘");

    fireEvent.click(screen.getByTestId(`md-mode-preview-${afterRaw.id}`));
    const afterPreview = useFileEditorStore.getState().openFiles[0];
    expect(afterPreview.content).toBe("# 原内容");
    expect(afterPreview.dirty).toBe(true);
    expect(afterPreview.original).toBe("# 老盘");
  });

  it("aria-pressed 跟随 mdMode 状态", () => {
    const file = makeFile({
      path: "/x/doc.md",
      content: "x",
      language: "md",
      mdMode: "preview",
    });
    pushFile(file);
    const { rerender } = render(<FileEditorPane file={file} />);
    expect(
      screen.getByTestId(`md-mode-preview-${file.id}`).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByTestId(`md-mode-raw-${file.id}`).getAttribute("aria-pressed"),
    ).toBe("false");

    fireEvent.click(screen.getByTestId(`md-mode-raw-${file.id}`));
    const updated = useFileEditorStore.getState().openFiles[0];
    rerender(<FileEditorPane file={updated} />);
    expect(
      screen.getByTestId(`md-mode-preview-${file.id}`).getAttribute("aria-pressed"),
    ).toBe("false");
    expect(
      screen.getByTestId(`md-mode-raw-${file.id}`).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("markdown 语言（无扩展别名）也走 md 分支", () => {
    const f = makeFile({
      path: "/x/a.markdown",
      content: "## h2",
      language: "markdown",
      mdMode: "preview",
    });
    pushFile(f);
    render(<FileEditorPane file={f} />);
    expect(screen.getByTestId(`md-mode-toolbar-${f.id}`)).toBeTruthy();
    expect(screen.getByTestId(`md-preview-${f.id}`)).toBeTruthy();
  });

  it("mdx 语言也走 md 分支", () => {
    const f = makeFile({
      path: "/x/b.mdx",
      content: "## h2",
      language: "mdx",
      mdMode: "preview",
    });
    pushFile(f);
    render(<FileEditorPane file={f} />);
    expect(screen.getByTestId(`md-mode-toolbar-${f.id}`)).toBeTruthy();
    expect(screen.getByTestId(`md-preview-${f.id}`)).toBeTruthy();
  });
});

describe("FileEditorPane T5c Cmd+S 保存", () => {
  it("Cmd+S 焦点在 pane 内 → 调 file_write", async () => {
    const file = makeFile({
      path: "/proj/a.ts",
      content: "edited",
      original: "v1",
      dirty: true,
      language: "ts",
    });
    pushFile(file);
    const { getByTestId } = render(<FileEditorPane file={file} />);
    const pane = getByTestId(`file-editor-pane-${file.id}`);
    const inner = getByTestId(`cm-stub-${file.path}`);
    // jsdom：让焦点落在 pane 内部某节点上（用 tabIndex 临时可聚焦）
    inner.setAttribute("tabindex", "-1");
    (inner as HTMLElement).focus();
    expect(pane.contains(document.activeElement)).toBe(true);

    // H1 hotfix：listener 现在挂在 pane root 上；在 pane 元素上派发 keydown
    fireEvent.keyDown(pane, { key: "s", metaKey: true });
    // 等 microtask 让 promise 链跑完
    await Promise.resolve();
    await Promise.resolve();
    expect(fileWriteMock).toHaveBeenCalledTimes(1);
    expect(fileWriteMock).toHaveBeenCalledWith("/proj/a.ts", "edited");
  });

  it("Ctrl+S（Windows / Linux）同样触发", async () => {
    const file = makeFile({
      path: "/proj/b.ts",
      content: "x",
      language: "ts",
    });
    pushFile(file);
    const { getByTestId } = render(<FileEditorPane file={file} />);
    const pane = getByTestId(`file-editor-pane-${file.id}`);
    const inner = getByTestId(`cm-stub-${file.path}`);
    inner.setAttribute("tabindex", "-1");
    (inner as HTMLElement).focus();

    fireEvent.keyDown(pane, { key: "s", ctrlKey: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(fileWriteMock).toHaveBeenCalledTimes(1);
  });

  it("焦点在 pane 外 → 不触发 file_write", async () => {
    const file = makeFile({
      path: "/proj/c.ts",
      content: "x",
      language: "ts",
    });
    pushFile(file);
    // 渲染 pane + 一个外部按钮；让按钮拿焦点
    const outsideButton = document.createElement("button");
    outsideButton.textContent = "outside";
    document.body.appendChild(outsideButton);
    const { getByTestId } = render(<FileEditorPane file={file} />);
    const pane = getByTestId(`file-editor-pane-${file.id}`);
    outsideButton.focus();
    expect(document.activeElement).toBe(outsideButton);

    // pane element listener 路径：即便在 pane 上派发，焦点判定也会判 false 不触发
    fireEvent.keyDown(pane, { key: "s", metaKey: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(fileWriteMock).not.toHaveBeenCalled();

    document.body.removeChild(outsideButton);
  });

  it("只按 S（无 metaKey / ctrlKey）→ 不触发", async () => {
    const file = makeFile({ path: "/proj/d.ts", content: "x", language: "ts" });
    pushFile(file);
    const { getByTestId } = render(<FileEditorPane file={file} />);
    const pane = getByTestId(`file-editor-pane-${file.id}`);
    const inner = getByTestId(`cm-stub-${file.path}`);
    inner.setAttribute("tabindex", "-1");
    (inner as HTMLElement).focus();

    fireEvent.keyDown(pane, { key: "s" });
    await Promise.resolve();
    expect(fileWriteMock).not.toHaveBeenCalled();
  });

  it("Cmd+S 保存失败 → console.error，不抛到外层", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fileWriteMock.mockRejectedValueOnce("禁止写入系统目录");
    const file = makeFile({
      path: "/etc/passwd",
      content: "evil",
      language: "txt",
    });
    pushFile(file);
    const { getByTestId } = render(<FileEditorPane file={file} />);
    const pane = getByTestId(`file-editor-pane-${file.id}`);
    const inner = getByTestId(`cm-stub-${file.path}`);
    inner.setAttribute("tabindex", "-1");
    (inner as HTMLElement).focus();

    fireEvent.keyDown(pane, { key: "s", metaKey: true });
    // 等 promise 链
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(errSpy).toHaveBeenCalled();
    const args = errSpy.mock.calls[0];
    expect(String(args[0])).toContain("[FileEditorPane] 保存失败");
    errSpy.mockRestore();
  });

  // H1 hotfix（v0.9.0）：Cmd+S listener 必须挂在 pane 元素上，**不能**挂 window。
  // 否则会扰动 WKWebView keydown 派发，触发 xterm.js #5374 workaround 误判 →
  // Shift+ 标点双发回归。
  it("H1：Cmd+S listener 不挂 window（防止扰动 xterm 路径）", () => {
    const file = makeFile({ path: "/x/a.ts", content: "x", language: "ts" });
    pushFile(file);
    const winSpy = vi.spyOn(window, "addEventListener");
    render(<FileEditorPane file={file} />);
    const keydownAdds = winSpy.mock.calls.filter((c) => c[0] === "keydown");
    expect(keydownAdds).toEqual([]);
    winSpy.mockRestore();
  });

  it("H1：window 上派发 Cmd+S（终端层模拟）不会触发本 pane 的 saveFile", async () => {
    const file = makeFile({ path: "/x/a.ts", content: "x", language: "ts" });
    pushFile(file);
    render(<FileEditorPane file={file} />);
    fireEvent.keyDown(window, { key: "s", metaKey: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(fileWriteMock).not.toHaveBeenCalled();
  });
});
