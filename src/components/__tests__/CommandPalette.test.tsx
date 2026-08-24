import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import CommandPalette from "../CommandPalette";

const handlers = {
  newTab: vi.fn(),
  closePane: vi.fn(),
  openSettings: vi.fn(),
};

function open() {
  return render(
    <CommandPalette open onOpenChange={vi.fn()} handlers={handlers} />,
  );
}

describe("命令面板", () => {
  beforeEach(() => {
    Object.values(handlers).forEach((h) => h.mockClear());
    // run() 走 requestAnimationFrame，测试里同步执行掉
    vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => {
      cb(0);
      return 0;
    });
  });

  it("列出命令并显示当前快捷键（顺带当快捷键学习入口）", () => {
    open();
    const item = screen.getByTestId("command-item-newTab");
    expect(item).toBeTruthy();
    expect(item.textContent).toContain("Cmd+T");
  });

  it("不把「打开命令面板」自己列进去", () => {
    open();
    expect(screen.queryByTestId("command-item-openCommandPalette")).toBeNull();
  });

  it("输入可过滤", () => {
    open();
    fireEvent.change(screen.getByTestId("command-palette-input"), {
      target: { value: "分屏" },
    });
    expect(screen.queryByTestId("command-item-newTab")).toBeNull();
    expect(screen.getByTestId("command-item-splitVertical")).toBeTruthy();
  });

  it("无匹配时给出明确提示，而不是一片空白", () => {
    open();
    fireEvent.change(screen.getByTestId("command-palette-input"), {
      target: { value: "zzzzz" },
    });
    expect(screen.getByTestId("command-palette-empty")).toBeTruthy();
  });

  it("点击执行的是传进来的 handler（与快捷键同一份逻辑）", () => {
    open();
    fireEvent.click(screen.getByTestId("command-item-newTab"));
    expect(handlers.newTab).toHaveBeenCalledTimes(1);
  });

  it("回车执行当前选中项", () => {
    open();
    const input = screen.getByTestId("command-palette-input");
    fireEvent.change(input, { target: { value: "设置" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(handlers.openSettings).toHaveBeenCalledTimes(1);
  });

  it("方向键移动选中项", () => {
    open();
    const input = screen.getByTestId("command-palette-input");
    const first = screen.getByTestId("command-item-newTab");
    expect(first.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(first.getAttribute("aria-selected")).toBe("false");
  });

  it("空列表时回车什么都不做，不抛错", () => {
    open();
    const input = screen.getByTestId("command-palette-input");
    fireEvent.change(input, { target: { value: "zzzzz" } });
    expect(() => fireEvent.keyDown(input, { key: "Enter" })).not.toThrow();
    expect(handlers.newTab).not.toHaveBeenCalled();
  });
});
