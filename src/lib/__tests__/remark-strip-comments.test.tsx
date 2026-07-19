import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkStripComments } from "../remark-strip-comments";

describe("remarkStripComments", () => {
  it("剥掉 HTML 注释，预览不再显示 <!-- --> 文本", () => {
    const md = "标题前\n\n<!-- 这是注释 SECRET_COMMENT -->\n\n正文";
    const { container } = render(
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkStripComments]}>
        {md}
      </ReactMarkdown>,
    );
    expect(container.textContent).not.toContain("SECRET_COMMENT");
    expect(container.textContent).toContain("正文");
  });

  it("不误删代码块里的注释文本", () => {
    const md = "```html\n<!-- 代码示例里的注释 KEEP_ME -->\n```";
    const { container } = render(
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkStripComments]}>
        {md}
      </ReactMarkdown>,
    );
    // 代码块内的注释是 code 节点，不是 html 节点，应保留
    expect(container.textContent).toContain("KEEP_ME");
  });
});
