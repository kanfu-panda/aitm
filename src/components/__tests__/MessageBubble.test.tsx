import { fireEvent, render, screen } from "@testing-library/react";
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

describe("MessageBubble A1 已停止标记", () => {
  it("assistant.stopped=true 时气泡尾部显示「已停止」", () => {
    render(
      <MessageBubble message={{ kind: "assistant", content: "部分内容", stopped: true }} />,
    );
    expect(screen.getByText("已停止")).toBeInTheDocument();
  });

  it("assistant.stopped 缺省（正常完成）不显示「已停止」", () => {
    render(<MessageBubble message={assistant("正常回答")} />);
    expect(screen.queryByText("已停止")).not.toBeInTheDocument();
  });

  it("user 消息不受 stopped 影响（类型上 user 没有该字段，纯防御性验证渲染不炸）", () => {
    render(<MessageBubble message={user("你好")} />);
    expect(screen.queryByText("已停止")).not.toBeInTheDocument();
  });
});

describe("MessageBubble A2 重试按钮", () => {
  it("最后一条 assistant 气泡、非 streaming、传了 onRetry → 显示重试按钮", () => {
    const onRetry = vi.fn();
    render(
      <MessageBubble
        message={assistant("回答完毕")}
        isLast
        onRetry={onRetry}
      />,
    );
    const btn = screen.getByRole("button", { name: "重试此回复" });
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("streaming 中不显示重试按钮（哪怕是最后一条 + 传了 onRetry）", () => {
    render(
      <MessageBubble
        message={assistant("正在生成…")}
        isLast
        streaming
        onRetry={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "重试此回复" }),
    ).not.toBeInTheDocument();
  });

  it("不是最后一条消息（isLast=false）不显示重试按钮", () => {
    render(
      <MessageBubble message={assistant("更早的一轮回答")} onRetry={vi.fn()} />,
    );
    expect(
      screen.queryByRole("button", { name: "重试此回复" }),
    ).not.toBeInTheDocument();
  });

  it("未传 onRetry 不显示重试按钮", () => {
    render(<MessageBubble message={assistant("回答")} isLast />);
    expect(
      screen.queryByRole("button", { name: "重试此回复" }),
    ).not.toBeInTheDocument();
  });

  it("user 消息永不显示重试按钮（哪怕是最后一条 + 传了 onRetry）", () => {
    render(<MessageBubble message={user("你好")} isLast onRetry={vi.fn()} />);
    expect(
      screen.queryByRole("button", { name: "重试此回复" }),
    ).not.toBeInTheDocument();
  });
});

describe("MessageBubble v1.3.0 反幻觉警告", () => {
  it("带 hallucination 时渲染警告条并点名缺失的工具类别", () => {
    render(
      <MessageBubble
        message={{
          kind: "assistant",
          content: "已跳转到 GitHub ✅",
          hallucination: { missing: ["browser"] },
        }}
      />,
    );
    const warn = screen.getByTestId("hallucination-warning");
    expect(warn).toBeInTheDocument();
    expect(warn).toHaveTextContent("浏览器");
    expect(warn).toHaveTextContent("可能不属实");
  });

  it("多类缺失时用「/」并列", () => {
    render(
      <MessageBubble
        message={{
          kind: "assistant",
          content: "已改好文件并跳转了",
          hallucination: { missing: ["browser", "file"] },
        }}
      />,
    );
    expect(screen.getByTestId("hallucination-warning")).toHaveTextContent(
      "浏览器 / 文件",
    );
  });

  it("没有 hallucination 的正常回复不渲染警告条", () => {
    render(<MessageBubble message={assistant("正常回答")} />);
    expect(
      screen.queryByTestId("hallucination-warning"),
    ).not.toBeInTheDocument();
  });

  it("user 消息不渲染警告条", () => {
    render(<MessageBubble message={user("你好")} />);
    expect(
      screen.queryByTestId("hallucination-warning"),
    ).not.toBeInTheDocument();
  });
});
