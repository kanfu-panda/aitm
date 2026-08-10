import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// mock window.open（jsdom 默认实现，但要确认 spec 里能 spy）
const openSpy = vi.fn();

// mock updateCheck IPC：默认返"无更新"，每个 test 可覆盖
let mockResult: {
  available: boolean;
  current_version: string;
  latest_version: string | null;
  release_url: string | null;
  release_notes: string | null;
  error: string | null;
} = {
  available: false,
  current_version: "0.2.1",
  latest_version: null,
  release_url: null,
  release_notes: null,
  error: null,
};

vi.mock("../../lib/tauri", async (orig) => {
  const real = await orig<typeof import("../../lib/tauri")>();
  return {
    ...real,
    updateCheck: vi.fn(async () => mockResult),
  };
});

import UpdateBadge, { OPEN_ABOUT_EVENT } from "../UpdateBadge";

describe("UpdateBadge", () => {
  beforeEach(() => {
    openSpy.mockReset();
    // 替换 window.open 用 spy
    vi.stubGlobal("open", openSpy);
    mockResult = {
      available: false,
      current_version: "0.2.1",
      latest_version: null,
      release_url: null,
      release_notes: null,
      error: null,
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("无更新时不渲染", async () => {
    const { container } = render(<UpdateBadge />);
    // updateCheck 是 async；等一帧让 useEffect 跑完
    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
  });

  it("有更新时渲染按钮 + 显示最新版本号", async () => {
    mockResult = {
      available: true,
      current_version: "0.2.1",
      latest_version: "0.3.0",
      release_url: "https://github.com/kanfu-panda/aitm/releases/tag/v0.3.0",
      release_notes: "v0.3.0 加了树形目录 + MD 预览",
      error: null,
    };
    render(<UpdateBadge />);
    const btn = await screen.findByTestId("update-badge");
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveTextContent("v0.3.0 可用");
    expect(btn.getAttribute("aria-label")).toBe("升级到 v0.3.0");
  });

  it("有更新时 title 含当前版本 + 最新版本 + release notes", async () => {
    mockResult = {
      available: true,
      current_version: "0.2.1",
      latest_version: "0.3.0",
      release_url: "https://example.com/r/v0.3.0",
      release_notes: "新功能 X / Y / Z",
      error: null,
    };
    render(<UpdateBadge />);
    const btn = await screen.findByTestId("update-badge");
    const title = btn.getAttribute("title") ?? "";
    expect(title).toContain("0.2.1");
    expect(title).toContain("0.3.0");
    expect(title).toContain("新功能 X / Y / Z");
  });

  it("点击派发打开\"关于\"页事件（不再直接开浏览器）", async () => {
    mockResult = {
      available: true,
      current_version: "0.2.1",
      latest_version: "0.3.0",
      release_url: "https://example.com/release",
      release_notes: null,
      error: null,
    };
    const onOpenAbout = vi.fn();
    window.addEventListener(OPEN_ABOUT_EVENT, onOpenAbout);
    render(<UpdateBadge />);
    const btn = await screen.findByTestId("update-badge");
    btn.click();
    window.removeEventListener(OPEN_ABOUT_EVENT, onOpenAbout);

    expect(onOpenAbout).toHaveBeenCalledTimes(1);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("release_url 缺失也照常提示（关于页里还能再查一次）", async () => {
    mockResult = {
      available: true,
      current_version: "0.2.1",
      latest_version: "0.3.0",
      release_url: null,
      release_notes: null,
      error: null,
    };
    render(<UpdateBadge />);
    expect(await screen.findByTestId("update-badge")).toBeTruthy();
  });
});
