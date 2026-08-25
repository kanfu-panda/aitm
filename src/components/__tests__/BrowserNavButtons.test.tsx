import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const back = vi.fn(async (_id: string) => {});
const forward = vi.fn(async (_id: string) => {});
const reload = vi.fn(async (_id: string) => {});

vi.mock("../../lib/tauri", async (orig) => {
  const real = await orig<typeof import("../../lib/tauri")>();
  return {
    ...real,
    browserGoBack: (id: string) => back(id),
    browserGoForward: (id: string) => forward(id),
    browserReload: (id: string) => reload(id),
  };
});

import BrowserNavButtons from "../browser/BrowserNavButtons";
import { useBrowserStore } from "../../stores/browser";

function seed(id: string | null) {
  useBrowserStore.setState({
    tabs: [
      {
        id,
        url: "https://example.com",
        title: "Example",
        state: id ? "active" : "suspended",
        scrollY: 0,
        pinned: false,
        lastActiveAt: 0,
        key: "k1",
      },
    ],
    activeKey: "k1",
  });
}

describe("浏览器导航按钮", () => {
  beforeEach(() => {
    [back, forward, reload].forEach((f) => f.mockClear());
    seed("tab-1");
  });

  it("三个按钮都可用 —— 它们从 Phase 4A 起一直是硬编码 disabled 的占位符", () => {
    render(<BrowserNavButtons />);
    expect(screen.getByTestId("browser-back")).not.toBeDisabled();
    expect(screen.getByTestId("browser-forward")).not.toBeDisabled();
    expect(screen.getByTestId("browser-reload")).not.toBeDisabled();
  });

  it("点击分别调对应 IPC，并带上当前 tab id", async () => {
    render(<BrowserNavButtons />);
    fireEvent.click(screen.getByTestId("browser-back"));
    fireEvent.click(screen.getByTestId("browser-forward"));
    fireEvent.click(screen.getByTestId("browser-reload"));
    await waitFor(() => {
      expect(back).toHaveBeenCalledWith("tab-1");
      expect(forward).toHaveBeenCalledWith("tab-1");
      expect(reload).toHaveBeenCalledWith("tab-1");
    });
  });

  it("标签已 suspend（无 webview）时禁用，不给点了没反应的按钮", () => {
    seed(null);
    render(<BrowserNavButtons />);
    expect(screen.getByTestId("browser-back")).toBeDisabled();
  });

  it("IPC 失败只 warn，不抛错打断用户", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    back.mockRejectedValueOnce(new Error("webview 没了"));
    render(<BrowserNavButtons />);
    expect(() => fireEvent.click(screen.getByTestId("browser-back"))).not.toThrow();
    await waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
  });
});
