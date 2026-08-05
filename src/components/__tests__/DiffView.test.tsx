import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import DiffView, { computeLineDiff } from "../DiffView";

describe("computeLineDiff（自实现 LCS 行 diff 纯函数）", () => {
  it("给定新旧文本，正确产出增删行", () => {
    const oldText = "line1\nline2\nline3";
    const newText = "line1\nline2-changed\nline3";
    const result = computeLineDiff(oldText, newText);

    expect(result).toEqual([
      { type: "context", text: "line1" },
      { type: "del", text: "line2" },
      { type: "add", text: "line2-changed" },
      { type: "context", text: "line3" },
    ]);
  });

  it("old 为空（全新增）：所有行都是 add，无 context/del", () => {
    const result = computeLineDiff("", "a\nb\nc");
    expect(result).toEqual([
      { type: "add", text: "a" },
      { type: "add", text: "b" },
      { type: "add", text: "c" },
    ]);
  });

  it("new 为空（纯删除）：所有行都是 del，无 context/add", () => {
    const result = computeLineDiff("a\nb\nc", "");
    expect(result).toEqual([
      { type: "del", text: "a" },
      { type: "del", text: "b" },
      { type: "del", text: "c" },
    ]);
  });

  it("完全相同：全部 context，无 add/del", () => {
    const text = "a\nb\nc";
    const result = computeLineDiff(text, text);
    expect(result).toEqual([
      { type: "context", text: "a" },
      { type: "context", text: "b" },
      { type: "context", text: "c" },
    ]);
  });

  it("old/new 都为空：空数组", () => {
    expect(computeLineDiff("", "")).toEqual([]);
  });
});

describe("DiffView 组件", () => {
  it("顶部显示文件路径", () => {
    render(<DiffView path="/tmp/hello.txt" oldText="" newText="hi" />);
    expect(screen.getByTestId("diff-view-path")).toHaveTextContent(
      "/tmp/hello.txt",
    );
  });

  it("渲染绿加行（+ 前缀 + success token 样式）", () => {
    render(<DiffView path="hello.txt" oldText="" newText="new line" />);
    const addLine = screen.getByTestId("diff-line-add");
    expect(addLine).toHaveTextContent("new line");
    expect(addLine.className).toContain("var(--c-success-bg)");
  });

  it("渲染红删行（- 前缀 + error token 样式）", () => {
    render(<DiffView path="hello.txt" oldText="old line" newText="" />);
    const delLine = screen.getByTestId("diff-line-del");
    expect(delLine).toHaveTextContent("old line");
    expect(delLine.className).toContain("var(--c-error)");
  });

  it("无变化时渲染 context 行，不出现 add/del 行", () => {
    render(<DiffView path="hello.txt" oldText="same" newText="same" />);
    expect(screen.getByTestId("diff-line-context")).toHaveTextContent("same");
    expect(screen.queryByTestId("diff-line-add")).toBeNull();
    expect(screen.queryByTestId("diff-line-del")).toBeNull();
  });
});
