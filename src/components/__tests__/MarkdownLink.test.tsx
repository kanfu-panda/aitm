import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MarkdownLink } from "../MarkdownLink";

const shellOpenMock = vi.fn();
vi.mock("../../lib/tauri", () => ({
  shellOpen: (url: string) => shellOpenMock(url),
}));

describe("MarkdownLink", () => {
  it("点击 → preventDefault（不导航 webview）+ shellOpen(href)", () => {
    shellOpenMock.mockClear();
    render(<MarkdownLink href="https://example.com">看这里</MarkdownLink>);
    const a = screen.getByText("看这里");
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    a.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(shellOpenMock).toHaveBeenCalledWith("https://example.com");
  });

  it("无 href → 不调 shellOpen，但仍 preventDefault", () => {
    shellOpenMock.mockClear();
    render(<MarkdownLink>纯文本链接</MarkdownLink>);
    const a = screen.getByText("纯文本链接");
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    a.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(shellOpenMock).not.toHaveBeenCalled();
  });
});
