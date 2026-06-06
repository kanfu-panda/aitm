/* =============================================================================
 * FileTabBar 单测（v0.9.0 T5b）
 * -----------------------------------------------------------------------------
 * 覆盖：
 *   - 0 个文件 → 不渲染
 *   - N 个文件 → 渲染 N 个 tab
 *   - active tab 标 aria-selected=true
 *   - dirty tab 有圆点
 *   - 点 tab → onActivate
 *   - 点 X → onCloseRequested
 *   - 中键 mousedown → onCloseRequested
 * ========================================================================== */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

import FileTabBar from "../FileTabBar";
import type { OpenFile } from "../../stores/file-editor";

function makeFile(overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    id: "/proj/a.ts",
    path: "/proj/a.ts",
    content: "",
    original: "",
    dirty: false,
    language: "ts",
    cursorLine: 1,
    cursorCol: 1,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe("FileTabBar", () => {
  let onActivate: ReturnType<typeof vi.fn>;
  let onCloseRequested: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onActivate = vi.fn();
    onCloseRequested = vi.fn();
  });

  it("文件列表为空 → 不渲染", () => {
    const { container } = render(
      <FileTabBar
        files={[]}
        activeId={null}
        onActivate={onActivate}
        onCloseRequested={onCloseRequested}
      />,
    );
    expect(container.querySelector('[data-testid="file-tab-bar"]')).toBeNull();
  });

  it("渲染多个 tab，basename 显示", () => {
    const files = [
      makeFile({ id: "/x/a.ts", path: "/x/a.ts" }),
      makeFile({ id: "/y/b.rs", path: "/y/b.rs" }),
    ];
    render(
      <FileTabBar
        files={files}
        activeId="/x/a.ts"
        onActivate={onActivate}
        onCloseRequested={onCloseRequested}
      />,
    );
    const bar = screen.getByTestId("file-tab-bar");
    expect(bar.textContent).toContain("a.ts");
    expect(bar.textContent).toContain("b.rs");
  });

  it("active tab data-active=true; 非 active false", () => {
    const files = [
      makeFile({ id: "/x/a.ts", path: "/x/a.ts" }),
      makeFile({ id: "/y/b.rs", path: "/y/b.rs" }),
    ];
    render(
      <FileTabBar
        files={files}
        activeId="/y/b.rs"
        onActivate={onActivate}
        onCloseRequested={onCloseRequested}
      />,
    );
    expect(
      screen.getByTestId("file-tab-/x/a.ts").getAttribute("data-active"),
    ).toBe("false");
    expect(
      screen.getByTestId("file-tab-/y/b.rs").getAttribute("data-active"),
    ).toBe("true");
  });

  it("dirty tab 显示圆点 data-testid", () => {
    const files = [
      makeFile({ id: "/x/a.ts", path: "/x/a.ts", dirty: true }),
    ];
    render(
      <FileTabBar
        files={files}
        activeId="/x/a.ts"
        onActivate={onActivate}
        onCloseRequested={onCloseRequested}
      />,
    );
    expect(screen.getByTestId("file-tab-dirty-dot-/x/a.ts")).toBeTruthy();
  });

  it("点 tab 触发 onActivate(id)", () => {
    const files = [
      makeFile({ id: "/x/a.ts", path: "/x/a.ts" }),
      makeFile({ id: "/y/b.rs", path: "/y/b.rs" }),
    ];
    render(
      <FileTabBar
        files={files}
        activeId="/x/a.ts"
        onActivate={onActivate}
        onCloseRequested={onCloseRequested}
      />,
    );
    fireEvent.click(screen.getByTestId("file-tab-/y/b.rs"));
    expect(onActivate).toHaveBeenCalledWith("/y/b.rs");
  });

  it("点 X 触发 onCloseRequested(id) 不冒泡到 onActivate", () => {
    const files = [
      makeFile({ id: "/x/a.ts", path: "/x/a.ts" }),
    ];
    render(
      <FileTabBar
        files={files}
        activeId="/x/a.ts"
        onActivate={onActivate}
        onCloseRequested={onCloseRequested}
      />,
    );
    fireEvent.click(screen.getByTestId("file-tab-close-/x/a.ts"));
    expect(onCloseRequested).toHaveBeenCalledWith("/x/a.ts");
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("中键 mousedown 触发 onCloseRequested", () => {
    const files = [
      makeFile({ id: "/x/a.ts", path: "/x/a.ts" }),
    ];
    render(
      <FileTabBar
        files={files}
        activeId="/x/a.ts"
        onActivate={onActivate}
        onCloseRequested={onCloseRequested}
      />,
    );
    fireEvent.mouseDown(screen.getByTestId("file-tab-/x/a.ts"), { button: 1 });
    expect(onCloseRequested).toHaveBeenCalledWith("/x/a.ts");
  });

  // ===== v0.9.1 HR4-6 折行 + 右键菜单 =====

  it("HR4-6：12 个 tab 容器 flex-wrap 折行（不出滚动条 className）", () => {
    const files = Array.from({ length: 12 }, (_, i) =>
      makeFile({ id: `/proj/f${i}.ts`, path: `/proj/f${i}.ts` }),
    );
    render(
      <FileTabBar
        files={files}
        activeId="/proj/f0.ts"
        onActivate={onActivate}
        onCloseRequested={onCloseRequested}
      />,
    );
    const bar = screen.getByTestId("file-tab-bar");
    // 所有 tab 都渲染
    for (let i = 0; i < 12; i++) {
      expect(screen.getByTestId(`file-tab-/proj/f${i}.ts`)).toBeTruthy();
    }
    // 容器走 flex-wrap，不出现 overflow-x-auto
    expect(bar.className).toContain("flex-wrap");
    expect(bar.className).not.toContain("overflow-x-auto");
  });

  it("HR4-6：右键 tab → context menu 出现，含 4 个操作项", () => {
    const files = [
      makeFile({ id: "/x/a.ts", path: "/x/a.ts" }),
      makeFile({ id: "/y/b.rs", path: "/y/b.rs" }),
    ];
    render(
      <FileTabBar
        files={files}
        activeId="/x/a.ts"
        onActivate={onActivate}
        onCloseRequested={onCloseRequested}
        onCloseOthers={vi.fn()}
        onCloseRight={vi.fn()}
        onCloseAll={vi.fn()}
      />,
    );
    fireEvent.contextMenu(screen.getByTestId("file-tab-/x/a.ts"));
    expect(screen.getByTestId("file-tab-context-menu")).toBeTruthy();
    expect(screen.getByTestId("file-tab-ctx-close")).toBeTruthy();
    expect(screen.getByTestId("file-tab-ctx-close-others")).toBeTruthy();
    expect(screen.getByTestId("file-tab-ctx-close-right")).toBeTruthy();
    expect(screen.getByTestId("file-tab-ctx-close-all")).toBeTruthy();
  });

  it("HR4-6：右键菜单 '关闭' → onCloseRequested(id) + 菜单关闭", () => {
    const files = [
      makeFile({ id: "/x/a.ts", path: "/x/a.ts" }),
      makeFile({ id: "/y/b.rs", path: "/y/b.rs" }),
    ];
    render(
      <FileTabBar
        files={files}
        activeId="/x/a.ts"
        onActivate={onActivate}
        onCloseRequested={onCloseRequested}
      />,
    );
    fireEvent.contextMenu(screen.getByTestId("file-tab-/y/b.rs"));
    fireEvent.click(screen.getByTestId("file-tab-ctx-close"));
    expect(onCloseRequested).toHaveBeenCalledWith("/y/b.rs");
    expect(screen.queryByTestId("file-tab-context-menu")).toBeNull();
  });

  it("HR4-6：右键菜单 '关闭其他' → onCloseOthers(id)", () => {
    const onCloseOthers = vi.fn();
    const files = [
      makeFile({ id: "/x/a.ts", path: "/x/a.ts" }),
      makeFile({ id: "/y/b.rs", path: "/y/b.rs" }),
      makeFile({ id: "/z/c.py", path: "/z/c.py" }),
    ];
    render(
      <FileTabBar
        files={files}
        activeId="/x/a.ts"
        onActivate={onActivate}
        onCloseRequested={onCloseRequested}
        onCloseOthers={onCloseOthers}
      />,
    );
    fireEvent.contextMenu(screen.getByTestId("file-tab-/y/b.rs"));
    fireEvent.click(screen.getByTestId("file-tab-ctx-close-others"));
    expect(onCloseOthers).toHaveBeenCalledWith("/y/b.rs");
  });

  it("HR4-6：右键菜单 '关闭右侧' → onCloseRight(id)", () => {
    const onCloseRight = vi.fn();
    const files = [
      makeFile({ id: "/x/a.ts", path: "/x/a.ts" }),
      makeFile({ id: "/y/b.rs", path: "/y/b.rs" }),
      makeFile({ id: "/z/c.py", path: "/z/c.py" }),
    ];
    render(
      <FileTabBar
        files={files}
        activeId="/x/a.ts"
        onActivate={onActivate}
        onCloseRequested={onCloseRequested}
        onCloseRight={onCloseRight}
      />,
    );
    fireEvent.contextMenu(screen.getByTestId("file-tab-/y/b.rs"));
    fireEvent.click(screen.getByTestId("file-tab-ctx-close-right"));
    expect(onCloseRight).toHaveBeenCalledWith("/y/b.rs");
  });

  it("HR4-6：右键菜单 '全部关闭' → onCloseAll()", () => {
    const onCloseAll = vi.fn();
    const files = [
      makeFile({ id: "/x/a.ts", path: "/x/a.ts" }),
      makeFile({ id: "/y/b.rs", path: "/y/b.rs" }),
    ];
    render(
      <FileTabBar
        files={files}
        activeId="/x/a.ts"
        onActivate={onActivate}
        onCloseRequested={onCloseRequested}
        onCloseAll={onCloseAll}
      />,
    );
    fireEvent.contextMenu(screen.getByTestId("file-tab-/x/a.ts"));
    fireEvent.click(screen.getByTestId("file-tab-ctx-close-all"));
    expect(onCloseAll).toHaveBeenCalled();
  });

  it("HR4-6：最后一个 tab 右键 '关闭右侧' 应禁用", () => {
    const files = [
      makeFile({ id: "/x/a.ts", path: "/x/a.ts" }),
      makeFile({ id: "/y/b.rs", path: "/y/b.rs" }),
    ];
    render(
      <FileTabBar
        files={files}
        activeId="/x/a.ts"
        onActivate={onActivate}
        onCloseRequested={onCloseRequested}
        onCloseRight={vi.fn()}
      />,
    );
    fireEvent.contextMenu(screen.getByTestId("file-tab-/y/b.rs"));
    const btn = screen.getByTestId("file-tab-ctx-close-right");
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it("HR4-6：单 tab 右键 '关闭其他' 应禁用", () => {
    const files = [makeFile({ id: "/x/a.ts", path: "/x/a.ts" })];
    render(
      <FileTabBar
        files={files}
        activeId="/x/a.ts"
        onActivate={onActivate}
        onCloseRequested={onCloseRequested}
        onCloseOthers={vi.fn()}
      />,
    );
    fireEvent.contextMenu(screen.getByTestId("file-tab-/x/a.ts"));
    const btn = screen.getByTestId("file-tab-ctx-close-others");
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it("HR4-6：Escape 关闭右键菜单", () => {
    const files = [makeFile({ id: "/x/a.ts", path: "/x/a.ts" })];
    render(
      <FileTabBar
        files={files}
        activeId="/x/a.ts"
        onActivate={onActivate}
        onCloseRequested={onCloseRequested}
      />,
    );
    fireEvent.contextMenu(screen.getByTestId("file-tab-/x/a.ts"));
    expect(screen.getByTestId("file-tab-context-menu")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("file-tab-context-menu")).toBeNull();
  });
});
