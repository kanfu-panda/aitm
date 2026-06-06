import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import MessageBubble from "../MessageBubble";
import type { AssistantMessage, UserMessage } from "../../stores/chat";

function assistant(content: string): AssistantMessage {
  return { kind: "assistant", content };
}

function user(content: string): UserMessage {
  return { kind: "user", content };
}

describe("MessageBubble - 长 inline code 整行换行（T2c）", () => {
  it("真机 case：'工作目录：`/Users/.../AITM`' 长 code 加 inline-block + break-all", () => {
    const md = "工作目录：`/Users/someuser/project/AITM`";
    render(<MessageBubble message={assistant(md)} />);
    const code = screen.getByText("/Users/someuser/project/AITM");
    expect(code.tagName).toBe("CODE");
    expect(code.className).toMatch(/inline-block/);
    expect(code.className).toMatch(/break-all/);
    expect(code.className).toMatch(/max-w-full/);
  });

  it("短 inline code（<=20 字符）不加 break 类", () => {
    const md = "命令：`ls`";
    render(<MessageBubble message={assistant(md)} />);
    const code = screen.getByText("ls");
    expect(code.tagName).toBe("CODE");
    expect(code.className).not.toMatch(/inline-block/);
    expect(code.className).not.toMatch(/break-all/);
  });

  it("代码块（带 language- 的 fenced code）走 CodeBlock 不被 inline 规则污染", () => {
    const md = "```bash\nls -la /Users/someuser/project/AITM\n```";
    const { container } = render(<MessageBubble message={assistant(md)} />);
    // CodeBlock 渲染成 div.group > pre > code；查 pre 内的 code，不应被 break-all 标记
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    const blockCode = pre!.querySelector("code");
    expect(blockCode).not.toBeNull();
    expect(blockCode!.className).not.toMatch(/break-all/);
    expect(blockCode!.className).not.toMatch(/inline-block/);
  });

  it("阈值边界：恰好 21 字符的 inline code 算长", () => {
    const longText = "a".repeat(21);
    const md = `prefix \`${longText}\``;
    render(<MessageBubble message={assistant(md)} />);
    const code = screen.getByText(longText);
    expect(code.className).toMatch(/inline-block/);
  });

  it("阈值边界：恰好 20 字符的 inline code 不算长", () => {
    const shortish = "a".repeat(20);
    const md = `prefix \`${shortish}\``;
    render(<MessageBubble message={assistant(md)} />);
    const code = screen.getByText(shortish);
    expect(code.className).not.toMatch(/inline-block/);
  });

  it("user 消息不走 markdown 渲染（pre-wrap 纯文本）", () => {
    const md = "工作目录：`/Users/someuser/project/AITM`";
    const { container } = render(<MessageBubble message={user(md)} />);
    // user 消息直接渲染原文，不应该有 <code> 元素
    expect(container.querySelector("code")).toBeNull();
  });
});
