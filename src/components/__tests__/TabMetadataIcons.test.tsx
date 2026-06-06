import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) => mockInvoke(cmd, args),
}));

import TabMetadataIcons from "../TabMetadataIcons";

describe("TabMetadataIcons", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sessionId 为 null → 不渲染任何 icon", () => {
    const { container } = render(
      <TabMetadataIcons sessionId={null} poll={true} />,
    );
    expect(container.querySelector('[data-testid="tab-metadata-icons"]')).toBeNull();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("metadata 全空 → 不渲染", async () => {
    mockInvoke.mockResolvedValueOnce({
      git_branch: null,
      git_dirty: false,
      git_unpushed_count: null,
      cwd: null,
      listening_ports: [],
    });
    const { container } = render(
      <TabMetadataIcons sessionId="s1" poll={false} />,
    );
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("tab_get_metadata", { id: "s1" });
    });
    expect(container.querySelector('[data-testid="tab-metadata-icons"]')).toBeNull();
  });

  it("有 git_branch → 渲染 GitBranch icon + tooltip 含分支名", async () => {
    mockInvoke.mockResolvedValueOnce({
      git_branch: "main",
      git_dirty: false,
      git_unpushed_count: null,
      cwd: "/Users/x/proj",
      listening_ports: [],
    });
    const { findByTestId } = render(
      <TabMetadataIcons sessionId="s1" poll={false} />,
    );
    const icons = await findByTestId("tab-metadata-icons");
    expect(icons.getAttribute("title")).toContain("分支：main");
    expect(icons.getAttribute("title")).toContain("cwd：/Users/x/proj");
    expect(icons.querySelector('[data-testid="tab-meta-git"]')).toBeTruthy();
    expect(icons.querySelector('[data-testid="tab-meta-dirty"]')).toBeNull();
    expect(icons.querySelector('[data-testid="tab-meta-ports"]')).toBeNull();
  });

  it("git_dirty=true → 渲染 dirty dot", async () => {
    mockInvoke.mockResolvedValueOnce({
      git_branch: "main",
      git_dirty: true,
      git_unpushed_count: null,
      cwd: null,
      listening_ports: [],
    });
    const { findByTestId } = render(
      <TabMetadataIcons sessionId="s1" poll={false} />,
    );
    const icons = await findByTestId("tab-metadata-icons");
    expect(icons.querySelector('[data-testid="tab-meta-dirty"]')).toBeTruthy();
    expect(icons.getAttribute("title")).toContain("dirty");
  });

  it("有端口 → 渲染 Activity icon + tooltip 含端口", async () => {
    mockInvoke.mockResolvedValueOnce({
      git_branch: null,
      git_dirty: false,
      git_unpushed_count: null,
      cwd: null,
      listening_ports: [3000, 5173],
    });
    const { findByTestId } = render(
      <TabMetadataIcons sessionId="s1" poll={false} />,
    );
    const icons = await findByTestId("tab-metadata-icons");
    expect(icons.querySelector('[data-testid="tab-meta-ports"]')).toBeTruthy();
    expect(icons.getAttribute("title")).toContain("3000, 5173");
  });

  it("未推送 commits > 0 在 tooltip 显示", async () => {
    mockInvoke.mockResolvedValueOnce({
      git_branch: "feat/x",
      git_dirty: false,
      git_unpushed_count: 3,
      cwd: null,
      listening_ports: [],
    });
    const { findByTestId } = render(
      <TabMetadataIcons sessionId="s1" poll={false} />,
    );
    const icons = await findByTestId("tab-metadata-icons");
    expect(icons.getAttribute("title")).toContain("3 commits 未推送");
  });
});
