import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ToolCallBubble, {
  formatArgsPreview,
  inferToolIcon,
} from "../ToolCallBubble";
import {
  FileText,
  Folder,
  Globe,
  History,
  Terminal,
  Wrench,
} from "../icons";
import type { ToolCallEntry } from "../../stores/chat";

function makeEntry(overrides: Partial<ToolCallEntry> = {}): ToolCallEntry {
  return {
    kind: "tool_call",
    call_id: "c1",
    name: "list_files",
    args_preview: '{"path":"src/components"}',
    risk: "low",
    status: "running",
    ...overrides,
  } as ToolCallEntry;
}

describe("ToolCallBubble", () => {
  describe("折叠态（默认）", () => {
    it("默认折叠：单行显示工具名 + 参数预览，args/result 不在 DOM", () => {
      render(
        <ToolCallBubble
          entry={makeEntry({
            status: "done",
            result: { content: "hello world", is_error: false },
          })}
        />,
      );

      // toggle 按钮存在
      const toggle = screen.getByTestId("tool-call-toggle");
      expect(toggle).toHaveAttribute("aria-expanded", "false");

      // 工具名 + 参数预览显示
      expect(screen.getByText("list_files")).toBeInTheDocument();
      expect(screen.getByText("path=src/components")).toBeInTheDocument();

      // 状态 icon 渲染（aria-label）
      expect(screen.getByRole("status")).toHaveAttribute("aria-label", "完成");

      // 详细区块不在 DOM
      expect(screen.queryByText("参数")).toBeNull();
      expect(screen.queryByText("结果")).toBeNull();
      expect(screen.queryByText("hello world")).toBeNull();
    });

    it("点击 toggle 展开：参数 JSON + 结果显示", () => {
      render(
        <ToolCallBubble
          entry={makeEntry({
            status: "done",
            result: { content: "hello world", is_error: false },
          })}
        />,
      );
      const toggle = screen.getByTestId("tool-call-toggle");

      fireEvent.click(toggle);

      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByText("参数")).toBeInTheDocument();
      expect(screen.getByText("结果")).toBeInTheDocument();
      expect(screen.getByText("hello world")).toBeInTheDocument();
      // 参数 JSON pretty 后包含 path
      expect(screen.getByText(/"path": "src\/components"/)).toBeInTheDocument();
    });

    it("再次点击折叠回去", () => {
      render(<ToolCallBubble entry={makeEntry({ status: "running" })} />);
      const toggle = screen.getByTestId("tool-call-toggle");

      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByText("参数")).toBeInTheDocument();

      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByText("参数")).toBeNull();
    });

    it("defaultExpanded=true 时初始展开", () => {
      render(
        <ToolCallBubble
          entry={makeEntry({ status: "running" })}
          defaultExpanded
        />,
      );
      expect(screen.getByText("参数")).toBeInTheDocument();
    });
  });

  describe("错误状态自动展开 + 红框", () => {
    it("status=error 时初始就展开，无需点击", () => {
      render(
        <ToolCallBubble
          entry={makeEntry({
            status: "error",
            result: { content: "boom", is_error: true },
          })}
        />,
      );

      expect(screen.getByText("参数")).toBeInTheDocument();
      expect(screen.getByText("错误结果")).toBeInTheDocument();
      expect(screen.getByText("boom")).toBeInTheDocument();
    });

    it("status=error 时 container 用红色 border / 背景", () => {
      render(
        <ToolCallBubble
          entry={makeEntry({
            status: "error",
            result: { content: "boom", is_error: true },
          })}
        />,
      );
      const bubble = screen.getByTestId("tool-call-bubble");
      expect(bubble.className).toContain("border-[var(--c-error)]");
    });

    it("status=error 时 status icon 红色 AlertCircle", () => {
      render(
        <ToolCallBubble
          entry={makeEntry({
            status: "error",
            result: { content: "boom", is_error: true },
          })}
        />,
      );
      const status = screen.getByRole("status");
      expect(status).toHaveAttribute("aria-label", "错误");
      expect(status.className).toContain("text-[var(--c-error)]");
    });
  });

  describe("各状态 icon + 颜色", () => {
    it("running 状态：sky 颜色 + Loader2 自旋", () => {
      render(<ToolCallBubble entry={makeEntry({ status: "running" })} />);
      const status = screen.getByRole("status");
      expect(status).toHaveAttribute("aria-label", "执行中…");
      expect(status.className).toContain("text-[var(--c-info)]");
      // Loader2 带 animate-spin
      const spinner = status.querySelector("svg");
      expect(spinner?.getAttribute("class")).toContain("animate-spin");
    });

    it("awaiting_approval 状态：amber 颜色 + AlertTriangle", () => {
      render(
        <ToolCallBubble entry={makeEntry({ status: "awaiting_approval" })} />,
      );
      const status = screen.getByRole("status");
      expect(status).toHaveAttribute("aria-label", "等待批准…");
      expect(status.className).toContain("text-[var(--c-warn)]");
    });

    it("done 状态：emerald 颜色 + Check", () => {
      render(<ToolCallBubble entry={makeEntry({ status: "done" })} />);
      const status = screen.getByRole("status");
      expect(status).toHaveAttribute("aria-label", "完成");
      expect(status.className).toContain("text-[var(--c-success)]");
    });

    it("rejected 状态：dim 颜色 + X", () => {
      render(<ToolCallBubble entry={makeEntry({ status: "rejected" })} />);
      const status = screen.getByRole("status");
      expect(status).toHaveAttribute("aria-label", "已拒绝");
      expect(status.className).toContain("text-[var(--c-text-dim)]");
    });
  });

  describe("auto_approved_reason 徽章", () => {
    it("有 reason → 展开后显示 emerald 徽章", () => {
      render(
        <ToolCallBubble
          entry={makeEntry({
            status: "done",
            auto_approved_reason: "白名单：git status *",
            result: { content: "ok", is_error: false },
          })}
        />,
      );
      // 默认折叠 → 徽章不可见；点击展开
      fireEvent.click(screen.getByTestId("tool-call-toggle"));
      const badge = screen.getByLabelText("自动批准原因");
      expect(badge).toHaveTextContent("白名单：git status *");
      expect(badge.className).toContain("text-[var(--c-success-fg)]");
    });

    it("无 reason 不渲染徽章", () => {
      render(<ToolCallBubble entry={makeEntry({ status: "running" })} />);
      fireEvent.click(screen.getByTestId("tool-call-toggle"));
      expect(screen.queryByLabelText("自动批准原因")).toBeNull();
    });
  });
});

describe("inferToolIcon", () => {
  it("browser_* → Globe", () => {
    expect(inferToolIcon("browser_navigate")).toBe(Globe);
    expect(inferToolIcon("browser_screenshot")).toBe(Globe);
  });

  it("read_file → FileText", () => {
    expect(inferToolIcon("read_file")).toBe(FileText);
  });

  it("list_files → Folder", () => {
    expect(inferToolIcon("list_files")).toBe(Folder);
  });

  it("run_command → Terminal", () => {
    expect(inferToolIcon("run_command")).toBe(Terminal);
  });

  it("含 history → History（如 terminal_history）", () => {
    expect(inferToolIcon("terminal_history")).toBe(History);
    expect(inferToolIcon("session_history")).toBe(History);
  });

  it("兜底 → Wrench", () => {
    expect(inferToolIcon("custom_tool")).toBe(Wrench);
    expect(inferToolIcon("foo_bar")).toBe(Wrench);
  });
});

describe("formatArgsPreview", () => {
  it("空 / null / 空字符串 → 空字符串", () => {
    expect(formatArgsPreview(undefined)).toBe("");
    expect(formatArgsPreview(null)).toBe("");
    expect(formatArgsPreview("")).toBe("");
    expect(formatArgsPreview("   ")).toBe("");
    expect(formatArgsPreview({})).toBe("");
  });

  it("Record：单 key 取首参数", () => {
    expect(formatArgsPreview({ path: "src/lib.rs" })).toBe(
      "path=src/lib.rs",
    );
  });

  it("Record：多 key 取首 key", () => {
    // 注意：Object.keys 顺序保证按插入顺序
    expect(
      formatArgsPreview({ command: "ls", session_id: "abc" }),
    ).toBe("command=ls");
  });

  it("JSON 字符串：自动 parse 后等价于 Record", () => {
    expect(formatArgsPreview('{"path":"src/lib.rs"}')).toBe(
      "path=src/lib.rs",
    );
  });

  it("超过 40 字符的字符串值 → truncate 加引号", () => {
    const long = "a".repeat(60);
    const result = formatArgsPreview({ msg: long });
    expect(result).toBe(`msg="${"a".repeat(40)}..."`);
    expect(result.length).toBeLessThan(60);
  });

  it("数字 / 布尔值 用 JSON.stringify", () => {
    expect(formatArgsPreview({ count: 42 })).toBe("count=42");
    expect(formatArgsPreview({ on: true })).toBe("on=true");
  });

  it("非 JSON 字符串：直接 truncate 当摘要", () => {
    expect(formatArgsPreview("just a summary")).toBe("just a summary");
    const long = "x".repeat(60);
    expect(formatArgsPreview(long)).toBe(`${"x".repeat(40)}...`);
  });
});
