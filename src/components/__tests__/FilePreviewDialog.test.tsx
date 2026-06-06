import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import FilePreviewDialog from "../FilePreviewDialog";
import { usePreviewStore } from "../../stores/preview";
import { useSettingsStore } from "../../stores/settings";

vi.mock("../../lib/tauri", async (orig) => {
  const real = await orig<typeof import("../../lib/tauri")>();
  return {
    ...real,
    fsReadPreview: vi.fn(),
    shellOpen: vi.fn().mockResolvedValue(undefined),
    browserHideAllActive: vi.fn().mockResolvedValue(undefined),
    browserShowAllActive: vi.fn().mockResolvedValue(undefined),
    settingsGet: vi.fn().mockResolvedValue(undefined),
    settingsUpdate: vi.fn().mockResolvedValue(undefined),
  };
});

import { fsReadPreview, shellOpen } from "../../lib/tauri";
const mockPreview = fsReadPreview as unknown as ReturnType<typeof vi.fn>;
const mockShellOpen = shellOpen as unknown as ReturnType<typeof vi.fn>;

function setPath(path: string | null) {
  act(() => {
    usePreviewStore.getState().setPreviewPath(path);
  });
}

/** 把 window viewport mock 成可控尺寸（默认 1920×1080）。 */
function mockViewport(w = 1920, h = 1080) {
  Object.defineProperty(window, "innerWidth", { value: w, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: h, configurable: true });
}

/** 重置 settings store 到默认值。 */
function resetSettings(partial?: Partial<typeof useSettingsStore.prototype>) {
  void partial;
  act(() => {
    const cur = useSettingsStore.getState().settings;
    useSettingsStore.setState({
      settings: {
        ...cur,
        ui: {
          ...cur.ui,
          file_preview_dialog: null,
        },
      },
    });
  });
}

describe("FilePreviewDialog", () => {
  // 把 rAF mock 成同步：拖动 / resize 测试里立刻拿到 rect 更新结果
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rafSpy: any;

  beforeEach(() => {
    mockViewport(1920, 1080);
    usePreviewStore.setState({ previewPath: null });
    resetSettings();
    mockPreview.mockReset();
    mockShellOpen.mockClear();
    rafSpy = vi
      .spyOn(globalThis, "requestAnimationFrame")
      .mockImplementation(((cb: (t: number) => void) => {
        cb(0);
        return 0;
      }) as typeof requestAnimationFrame);
  });

  afterEach(() => {
    setPath(null);
    rafSpy?.mockRestore();
    vi.clearAllMocks();
  });

  // ===== 原有 v0.5.0-C 行为回归 =====

  it("空 store → 不渲染 dialog", () => {
    render(<FilePreviewDialog />);
    expect(document.body.querySelector("[role='dialog']")).toBeNull();
  });

  it("kind=markdown → 渲染 H1 + GFM 表格", async () => {
    mockPreview.mockResolvedValue({
      kind: "markdown",
      content: "# Hello\n\n| a | b |\n| - | - |\n| 1 | 2 |",
      truncated: false,
    });
    render(<FilePreviewDialog />);
    setPath("/tmp/x.md");

    await screen.findByRole("heading", { level: 1, name: "Hello" });
    await waitFor(() => {
      expect(document.body.querySelector("table")).not.toBeNull();
    });
  });

  it("kind=code → 渲染 <code class='language-rust'>", async () => {
    mockPreview.mockResolvedValue({
      kind: "code",
      content: "fn main() {}",
      language: "rust",
      truncated: false,
    });
    render(<FilePreviewDialog />);
    setPath("/tmp/main.rs");

    await waitFor(() => {
      const code = document.body.querySelector("code.language-rust");
      expect(code).not.toBeNull();
      expect(code?.textContent).toContain("fn main()");
    });
  });

  it("kind=text → 渲染 <pre> 纯文本", async () => {
    mockPreview.mockResolvedValue({
      kind: "text",
      content: "hello plain",
      truncated: false,
    });
    render(<FilePreviewDialog />);
    setPath("/tmp/notes.txt");

    await waitFor(() => {
      expect(screen.getByText("hello plain")).toBeTruthy();
    });
  });

  it("kind=image → 渲染 <img src='data:...'>", async () => {
    mockPreview.mockResolvedValue({
      kind: "image",
      mime: "image/png",
      base64: "iVBORw0KGgo=",
    });
    render(<FilePreviewDialog />);
    setPath("/tmp/x.png");

    const img = await screen.findByTestId("preview-image");
    expect(img.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
  });

  it("kind=binary → 显示 UnsupportedFallback + 按钮 + 点击调 shellOpen", async () => {
    mockPreview.mockResolvedValue({ kind: "binary", reason: "NUL 字节" });
    render(<FilePreviewDialog />);
    setPath("/tmp/x.dmg");

    const btn = await screen.findByTestId("preview-open-default-app");
    expect(btn.textContent).toContain("用默认应用打开");
    expect(screen.getByText(/NUL 字节/)).toBeTruthy();

    btn.click();
    await waitFor(() => {
      expect(mockShellOpen).toHaveBeenCalledWith("/tmp/x.dmg");
    });
  });

  it("kind=too_large → 显示 UnsupportedFallback 含大小说明", async () => {
    mockPreview.mockResolvedValue({
      kind: "too_large",
      size: 2_000_000,
      max_size: 1_000_000,
    });
    render(<FilePreviewDialog />);
    setPath("/tmp/big.txt");

    await screen.findByTestId("preview-unsupported");
    expect(screen.getByText(/超过.*1MB.*上限/)).toBeTruthy();
  });

  it("kind=text 含 truncated=true → 显示截断提示", async () => {
    mockPreview.mockResolvedValue({
      kind: "text",
      content: "x",
      truncated: true,
    });
    render(<FilePreviewDialog />);
    setPath("/tmp/big.txt");

    await waitFor(() => {
      const status = screen.getByRole("status");
      expect(status.textContent).toContain("内容已截断");
    });
  });

  it("fsReadPreview reject → 显示读取失败 alert", async () => {
    mockPreview.mockRejectedValue(new Error("不存在"));
    render(<FilePreviewDialog />);
    setPath("/tmp/missing.txt");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("读取失败");
    expect(alert.textContent).toContain("不存在");
  });

  // ===== v0.6.0-A T4 浮动窗口行为 =====

  it("首次打开（file_preview_dialog=null）→ 居中 + 800×600", async () => {
    mockPreview.mockResolvedValue({ kind: "text", content: "x", truncated: false });
    render(<FilePreviewDialog />);
    setPath("/tmp/a.txt");

    const dialog = await screen.findByTestId("file-preview-dialog");
    // 1920×1080 viewport，800×600 居中 → left=(1920-800)/2=560, top=(1080-600)/2=240
    expect(dialog.style.width).toBe("800px");
    expect(dialog.style.height).toBe("600px");
    expect(dialog.style.left).toBe("560px");
    expect(dialog.style.top).toBe("240px");
  });

  it("file_preview_dialog 有值 → 渲染在该 rect", async () => {
    mockPreview.mockResolvedValue({ kind: "text", content: "x", truncated: false });
    act(() => {
      const cur = useSettingsStore.getState().settings;
      useSettingsStore.setState({
        settings: {
          ...cur,
          ui: {
            ...cur.ui,
            file_preview_dialog: { x: 100, y: 80, w: 500, h: 400 },
          },
        },
      });
    });
    render(<FilePreviewDialog />);
    setPath("/tmp/a.txt");

    const dialog = await screen.findByTestId("file-preview-dialog");
    expect(dialog.style.left).toBe("100px");
    expect(dialog.style.top).toBe("80px");
    expect(dialog.style.width).toBe("500px");
    expect(dialog.style.height).toBe("400px");
  });

  it("off-screen rect (x + w > innerWidth) → fallback 居中", async () => {
    mockPreview.mockResolvedValue({ kind: "text", content: "x", truncated: false });
    // 把 viewport 设小，让 persisted rect 整体跑出屏
    mockViewport(1024, 768);
    act(() => {
      const cur = useSettingsStore.getState().settings;
      useSettingsStore.setState({
        settings: {
          ...cur,
          ui: {
            ...cur.ui,
            // x+w = 1800+500 = 2300 > innerWidth 1024 → off-screen
            file_preview_dialog: { x: 1800, y: 100, w: 500, h: 400 },
          },
        },
      });
    });
    render(<FilePreviewDialog />);
    setPath("/tmp/a.txt");

    const dialog = await screen.findByTestId("file-preview-dialog");
    // viewport 1024×768，default 800×600 全 fit；居中 left=(1024-800)/2=112
    expect(dialog.style.width).toBe("800px");
    expect(dialog.style.height).toBe("600px");
    expect(dialog.style.left).toBe("112px");
    expect(dialog.style.top).toBe("84px");
  });

  it("标题栏 mousedown + mousemove → 位置更新（local state）", async () => {
    mockPreview.mockResolvedValue({ kind: "text", content: "x", truncated: false });
    render(<FilePreviewDialog />);
    setPath("/tmp/a.txt");

    const titleBar = await screen.findByTestId("file-preview-title-bar");
    const dialog = screen.getByTestId("file-preview-dialog");
    // 初始：左 560、顶 240
    expect(dialog.style.left).toBe("560px");

    fireEvent.mouseDown(titleBar, { clientX: 600, clientY: 250, button: 0 });
    fireEvent.mouseMove(document, { clientX: 700, clientY: 280 });

    // rect 应右移 100、下移 30 → left=660, top=270
    expect(dialog.style.left).toBe("660px");
    expect(dialog.style.top).toBe("270px");
    // cleanup
    fireEvent.mouseUp(document);
  });

  it("mouseup 后调 settingsUpdate（store 持久化新 rect）", async () => {
    mockPreview.mockResolvedValue({ kind: "text", content: "x", truncated: false });
    render(<FilePreviewDialog />);
    setPath("/tmp/a.txt");

    const titleBar = await screen.findByTestId("file-preview-title-bar");
    fireEvent.mouseDown(titleBar, { clientX: 600, clientY: 250, button: 0 });
    fireEvent.mouseMove(document, { clientX: 700, clientY: 280 });
    fireEvent.mouseUp(document);

    // commit 同步写到 zustand（IPC 写盘是 300ms debounced，这里只查 store）
    const persisted =
      useSettingsStore.getState().settings.ui.file_preview_dialog;
    expect(persisted).not.toBeNull();
    expect(persisted?.x).toBe(660);
    expect(persisted?.y).toBe(270);
    expect(persisted?.w).toBe(800);
    expect(persisted?.h).toBe(600);
  });

  it("resize handle 'br'（右下角）拖动 → w + h 增大", async () => {
    mockPreview.mockResolvedValue({ kind: "text", content: "x", truncated: false });
    render(<FilePreviewDialog />);
    setPath("/tmp/a.txt");

    const dialog = await screen.findByTestId("file-preview-dialog");
    const brHandle = screen.getByTestId("file-preview-resize-br");
    // 初始 800×600
    expect(dialog.style.width).toBe("800px");
    fireEvent.mouseDown(brHandle, { clientX: 1360, clientY: 840, button: 0 });
    // 右下拖 100px、80px
    fireEvent.mouseMove(document, { clientX: 1460, clientY: 920 });
    expect(dialog.style.width).toBe("900px");
    expect(dialog.style.height).toBe("680px");
    fireEvent.mouseUp(document);
  });

  it("resize 最小约束：w < 400 / h < 300 → clamp 到 400×300", async () => {
    mockPreview.mockResolvedValue({ kind: "text", content: "x", truncated: false });
    render(<FilePreviewDialog />);
    setPath("/tmp/a.txt");

    const dialog = await screen.findByTestId("file-preview-dialog");
    const brHandle = screen.getByTestId("file-preview-resize-br");
    fireEvent.mouseDown(brHandle, { clientX: 1360, clientY: 840, button: 0 });
    // 往左上拖大幅 → w/h 都会被 clamp 到 400×300 最小值
    fireEvent.mouseMove(document, { clientX: 100, clientY: 100 });
    expect(dialog.style.width).toBe("400px");
    expect(dialog.style.height).toBe("300px");
    fireEvent.mouseUp(document);
  });

  it("resize 最大约束：超过 window 90% → clamp", async () => {
    mockPreview.mockResolvedValue({ kind: "text", content: "x", truncated: false });
    render(<FilePreviewDialog />);
    setPath("/tmp/a.txt");

    const dialog = await screen.findByTestId("file-preview-dialog");
    const brHandle = screen.getByTestId("file-preview-resize-br");
    fireEvent.mouseDown(brHandle, { clientX: 1360, clientY: 840, button: 0 });
    // 右下拖出屏：1920+1000 → 应被 clamp 到 1920*0.9=1728；1080*0.9=972
    fireEvent.mouseMove(document, { clientX: 5000, clientY: 5000 });
    expect(dialog.style.width).toBe("1728px");
    expect(dialog.style.height).toBe("972px");
    fireEvent.mouseUp(document);
  });

  it("双击标题栏 → maximize（rect = 90% 屏幕居中）", async () => {
    mockPreview.mockResolvedValue({ kind: "text", content: "x", truncated: false });
    render(<FilePreviewDialog />);
    setPath("/tmp/a.txt");

    const titleBar = await screen.findByTestId("file-preview-title-bar");
    const dialog = screen.getByTestId("file-preview-dialog");
    fireEvent.doubleClick(titleBar);

    // 1920×1080 → 90% = 1728×972；居中 left=(1920-1728)/2=96, top=(1080-972)/2=54
    expect(dialog.style.width).toBe("1728px");
    expect(dialog.style.height).toBe("972px");
    expect(dialog.style.left).toBe("96px");
    expect(dialog.style.top).toBe("54px");
  });

  it("再次双击 → 还原 preMaximize rect", async () => {
    mockPreview.mockResolvedValue({ kind: "text", content: "x", truncated: false });
    render(<FilePreviewDialog />);
    setPath("/tmp/a.txt");

    const titleBar = await screen.findByTestId("file-preview-title-bar");
    const dialog = screen.getByTestId("file-preview-dialog");
    // 起始 560/240/800/600
    fireEvent.doubleClick(titleBar);
    expect(dialog.style.width).toBe("1728px");
    fireEvent.doubleClick(titleBar);
    // 还原到 normal
    expect(dialog.style.width).toBe("800px");
    expect(dialog.style.height).toBe("600px");
    expect(dialog.style.left).toBe("560px");
    expect(dialog.style.top).toBe("240px");
  });

  it("关闭按钮调 onClose（setPreviewPath(null)）", async () => {
    mockPreview.mockResolvedValue({ kind: "text", content: "x", truncated: false });
    render(<FilePreviewDialog />);
    setPath("/tmp/a.txt");

    const closeBtn = await screen.findByTestId("file-preview-close");
    expect(usePreviewStore.getState().previewPath).toBe("/tmp/a.txt");
    fireEvent.click(closeBtn);
    expect(usePreviewStore.getState().previewPath).toBeNull();
  });

  it("8 个 resize handle 均渲染", async () => {
    mockPreview.mockResolvedValue({ kind: "text", content: "x", truncated: false });
    render(<FilePreviewDialog />);
    setPath("/tmp/a.txt");

    for (const dir of ["t", "b", "l", "r", "tl", "tr", "bl", "br"]) {
      expect(
        await screen.findByTestId(`file-preview-resize-${dir}`),
      ).toBeInTheDocument();
    }
  });

  it("maximize 状态下拖标题栏保持 max size + 跟随鼠标 drag（v0.6.0 维护者 反馈）", async () => {
    mockPreview.mockResolvedValue({ kind: "text", content: "x", truncated: false });
    render(<FilePreviewDialog />);
    setPath("/tmp/a.txt");

    const titleBar = await screen.findByTestId("file-preview-title-bar");
    const dialog = screen.getByTestId("file-preview-dialog");
    // 双击进 max
    fireEvent.doubleClick(titleBar);
    const maxLeft = dialog.style.left;
    const maxWidth = dialog.style.width;
    // 在 max 标题栏 mousedown + mousemove
    fireEvent.mouseDown(titleBar, { clientX: 600, clientY: 50, button: 0 });
    fireEvent.mouseMove(document, { clientX: 700, clientY: 100 });
    // size 保持 max（不退 max）
    expect(dialog.style.width).toBe(maxWidth);
    // 位置改变（跟随鼠标移动）
    expect(dialog.style.left).not.toBe(maxLeft);
    fireEvent.mouseUp(document);
  });

  it("点击 dialog 外区域关闭（v0.6.0 维护者 反馈）", async () => {
    mockPreview.mockResolvedValue({ kind: "text", content: "x", truncated: false });
    render(<FilePreviewDialog />);
    setPath("/tmp/a.txt");

    await screen.findByTestId("file-preview-dialog");
    // 在 body 上 mousedown（非 dialog 内部）→ 应触发关闭
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId("file-preview-dialog")).not.toBeInTheDocument();
  });

  it("ESC 键关闭", async () => {
    mockPreview.mockResolvedValue({ kind: "text", content: "x", truncated: false });
    render(<FilePreviewDialog />);
    setPath("/tmp/a.txt");

    await screen.findByTestId("file-preview-dialog");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("file-preview-dialog")).not.toBeInTheDocument();
  });

  it("maximize 状态不持久化（双击后 store rect 仍是 maximize 前的 normal）", async () => {
    mockPreview.mockResolvedValue({ kind: "text", content: "x", truncated: false });
    render(<FilePreviewDialog />);
    setPath("/tmp/a.txt");

    // mouseup 一次拖动 → 持久化 normal rect
    const titleBar = await screen.findByTestId("file-preview-title-bar");
    fireEvent.mouseDown(titleBar, { clientX: 600, clientY: 250, button: 0 });
    fireEvent.mouseMove(document, { clientX: 650, clientY: 270 });
    fireEvent.mouseUp(document);
    const normalRect =
      useSettingsStore.getState().settings.ui.file_preview_dialog;
    expect(normalRect).not.toBeNull();
    // 双击 maximize；不应该改 store
    fireEvent.doubleClick(titleBar);
    expect(useSettingsStore.getState().settings.ui.file_preview_dialog).toEqual(
      normalRect,
    );
  });
});
