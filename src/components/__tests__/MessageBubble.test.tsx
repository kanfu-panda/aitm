import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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

describe("MessageBubble v1.1.0 F7 md 代码块语法高亮", () => {
  it("带语言的 fenced code block → hljs class + 语言标签 + token span", () => {
    const md = "```ts\nconst x: number = 1;\n```";
    const { container } = render(<MessageBubble message={assistant(md)} />);
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    const code = pre!.querySelector("code");
    expect(code).not.toBeNull();
    expect(code!.className).toMatch(/language-ts/);
    expect(code!.className).toMatch(/hljs/);
    expect(
      pre!.querySelectorAll("span[class*='hljs-']").length,
    ).toBeGreaterThan(0);
    // 语言标签（左上角小字）跟代码一起渲染在同一个 wrapper 内
    expect(container.textContent).toContain("ts");
  });

  it("代码块复制按钮取的是纯文本（不含高亮 span 标签），点击写入剪贴板", () => {
    const md = "```js\nconst greet = () => 'hi';\n```";
    const { container } = render(<MessageBubble message={assistant(md)} />);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const btn = container.querySelector("button");
    expect(btn).not.toBeNull();
    btn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(writeText).toHaveBeenCalledWith("const greet = () => 'hi';");
  });

  it("无语言的 fenced code block 仍正常渲染（rehype-highlight detect:false 不强行猜语言）", () => {
    const md = "```\nplain output\n```";
    const { container } = render(<MessageBubble message={assistant(md)} />);
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toContain("plain output");
  });

  it("data-theme 切 light 前后，高亮 DOM class 结构不变（纯 CSS 变量驱动）", () => {
    document.documentElement.dataset.theme = "dark";
    const md = "```rust\nfn main() {}\n```";
    const { container } = render(<MessageBubble message={assistant(md)} />);
    const before = container.querySelector("code")!.className;

    document.documentElement.dataset.theme = "light";
    // 无需重渲染：高亮 class 本身不含主题信息，只是 hljs-* 语义 class，
    // 颜色由 CSS 变量在 [data-theme="light"] 下重新取值。
    const after = container.querySelector("code")!.className;
    expect(after).toBe(before);
    document.documentElement.dataset.theme = "dark";
  });
});
