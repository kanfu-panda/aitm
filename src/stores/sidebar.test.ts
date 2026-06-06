import { beforeEach, describe, expect, it } from "vitest";
import { useSidebarStore } from "./sidebar";

describe("useSidebarStore", () => {
  beforeEach(() => {
    useSidebarStore.setState({ open: false, fileTreeOpen: false });
  });

  it("AI 侧栏默认关闭，toggle 切换", () => {
    expect(useSidebarStore.getState().open).toBe(false);
    useSidebarStore.getState().toggle();
    expect(useSidebarStore.getState().open).toBe(true);
    useSidebarStore.getState().toggle();
    expect(useSidebarStore.getState().open).toBe(false);
  });

  it("setOpen 直接写入", () => {
    useSidebarStore.getState().setOpen(true);
    expect(useSidebarStore.getState().open).toBe(true);
  });

  it("FileTree 默认关闭（节约空间），toggleFileTree 切换", () => {
    expect(useSidebarStore.getState().fileTreeOpen).toBe(false);
    useSidebarStore.getState().toggleFileTree();
    expect(useSidebarStore.getState().fileTreeOpen).toBe(true);
    useSidebarStore.getState().toggleFileTree();
    expect(useSidebarStore.getState().fileTreeOpen).toBe(false);
  });

  it("setFileTreeOpen 直接写入", () => {
    useSidebarStore.getState().setFileTreeOpen(true);
    expect(useSidebarStore.getState().fileTreeOpen).toBe(true);
  });

  it("两侧栏开关相互独立", () => {
    useSidebarStore.getState().toggle();
    expect(useSidebarStore.getState().open).toBe(true);
    expect(useSidebarStore.getState().fileTreeOpen).toBe(false);

    useSidebarStore.getState().toggleFileTree();
    expect(useSidebarStore.getState().open).toBe(true);
    expect(useSidebarStore.getState().fileTreeOpen).toBe(true);
  });
});
