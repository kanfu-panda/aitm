import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ScopeBadge from "../ScopeBadge";
import type { ScopeDto } from "../../../lib/tauri";

describe("ScopeBadge", () => {
  it("scope=null 不渲染任何东西", () => {
    const { container } = render(<ScopeBadge scope={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("project 作用域渲染 success token 圆点 + basename", () => {
    const scope: ScopeDto = {
      kind: "project",
      uuid: "u1",
      root_path: "/Users/leo/demo/myapp",
    };
    const { container, getByLabelText } = render(<ScopeBadge scope={scope} />);
    const badge = getByLabelText(/项目 myapp/);
    expect(badge).toBeInTheDocument();
    expect(badge.textContent).toContain("myapp");
    expect(badge.getAttribute("title")).toContain("/Users/leo/demo/myapp");
    // 圆点应带 --c-success token class
    const dot = container.querySelector("span[aria-hidden]");
    expect(dot?.className).toContain("bg-[var(--c-success)]");
  });

  it("项目名超过 maxNameChars 截断 + 省略号", () => {
    const scope: ScopeDto = {
      kind: "project",
      uuid: "u1",
      root_path: "/Users/leo/demo/very-long-project-name-here",
    };
    const { container } = render(<ScopeBadge scope={scope} maxNameChars={10} />);
    const text = container.textContent ?? "";
    // 截断到 10 字符（含省略号）
    expect(text).toContain("…");
    // tooltip 仍是完整名
    const badge = container.querySelector("[data-scope-kind='project']");
    expect(badge?.getAttribute("title")).toContain(
      "very-long-project-name-here",
    );
  });

  it("global 作用域渲染 dim token 圆点 + '全局'", () => {
    const scope: ScopeDto = { kind: "global" };
    const { container, getByLabelText } = render(<ScopeBadge scope={scope} />);
    expect(getByLabelText(/全局/)).toBeInTheDocument();
    expect(container.textContent).toContain("全局");
    const dot = container.querySelector("span[aria-hidden]");
    expect(dot?.className).toContain("bg-[var(--c-text-dim)]");
  });

  it("needs_init 作用域渲染 warn token 圆点 + '未决议'", () => {
    const scope: ScopeDto = { kind: "needs_init", cwd: "/tmp/foo" };
    const { container, getByLabelText } = render(<ScopeBadge scope={scope} />);
    expect(getByLabelText(/未决议/)).toBeInTheDocument();
    expect(container.textContent).toContain("未决议");
    const dot = container.querySelector("span[aria-hidden]");
    expect(dot?.className).toContain("bg-[var(--c-warn)]");
  });

  it("compact=true 只显圆点不显文字", () => {
    const scope: ScopeDto = {
      kind: "project",
      uuid: "u1",
      root_path: "/Users/leo/foo",
    };
    const { container } = render(<ScopeBadge scope={scope} compact />);
    expect(container.textContent ?? "").not.toContain("foo");
    // 圆点仍在
    expect(container.querySelector("span[aria-hidden]")).not.toBeNull();
  });

  it("Windows 风格反斜杠路径也能 basename", () => {
    const scope: ScopeDto = {
      kind: "project",
      uuid: "u1",
      root_path: "C:\\Users\\leo\\demo\\myapp",
    };
    const { container } = render(<ScopeBadge scope={scope} />);
    expect(container.textContent).toContain("myapp");
  });

  it("路径以 / 结尾仍取倒数第二段", () => {
    const scope: ScopeDto = {
      kind: "project",
      uuid: "u1",
      root_path: "/Users/leo/demo/myapp/",
    };
    const { container } = render(<ScopeBadge scope={scope} />);
    expect(container.textContent).toContain("myapp");
  });
});
