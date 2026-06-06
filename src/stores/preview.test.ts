import { beforeEach, describe, expect, it, vi } from "vitest";

// v0.7.0-A：mock analytics 验证 trackEvent + kind 推断
vi.mock("../lib/analytics", () => ({
  trackEvent: vi.fn(),
}));

import { trackEvent } from "../lib/analytics";
import { kindFromPath, usePreviewStore } from "./preview";

const trackEventMock = trackEvent as unknown as ReturnType<typeof vi.fn>;

describe("usePreviewStore", () => {
  beforeEach(() => {
    usePreviewStore.setState({ previewPath: null });
    trackEventMock.mockClear();
  });

  it("初始 previewPath = null", () => {
    expect(usePreviewStore.getState().previewPath).toBeNull();
  });

  it("setPreviewPath 写入 / 清空", () => {
    usePreviewStore.getState().setPreviewPath("/tmp/README.md");
    expect(usePreviewStore.getState().previewPath).toBe("/tmp/README.md");
    usePreviewStore.getState().setPreviewPath(null);
    expect(usePreviewStore.getState().previewPath).toBeNull();
  });

  describe("匿名统计 (v0.7.0-A)", () => {
    it("setPreviewPath(非 null) 触发 file_previewed + kind", () => {
      usePreviewStore.getState().setPreviewPath("/tmp/README.md");
      expect(trackEventMock).toHaveBeenCalledTimes(1);
      expect(trackEventMock).toHaveBeenCalledWith("file_previewed", {
        kind: "markdown",
      });
    });

    it("setPreviewPath(null) 不触发事件（关闭预览）", () => {
      usePreviewStore.getState().setPreviewPath(null);
      expect(trackEventMock).not.toHaveBeenCalled();
    });

    it("不同扩展名推断不同 kind（不传 path 本身）", () => {
      const cases: Array<[string, string]> = [
        ["/a/b.md", "markdown"],
        ["/a/b.markdown", "markdown"],
        ["/a/b.MD", "markdown"],
        ["/a/b.png", "image"],
        ["/a/b.JPG", "image"],
        ["/a/b.svg", "image"],
        ["/a/b.ts", "code"],
        ["/a/b.tsx", "code"],
        ["/a/b.rs", "code"],
        ["/a/b.py", "code"],
        ["/a/b.json", "code"],
        ["/a/b.txt", "text"],
        ["/a/b.log", "text"],
        ["/a/b.env", "text"],
        ["/a/b.weird", "unknown"],
        ["/a/no-extension", "unknown"],
      ];
      for (const [path, expectedKind] of cases) {
        trackEventMock.mockClear();
        usePreviewStore.getState().setPreviewPath(path);
        expect(trackEventMock).toHaveBeenCalledWith("file_previewed", {
          kind: expectedKind,
        });
        // 关键：不允许 path / 文件名出现在 props 中
        const callProps = trackEventMock.mock.calls[0][1] as Record<
          string,
          unknown
        >;
        expect(Object.values(callProps)).not.toContain(path);
      }
    });
  });
});

describe("kindFromPath（独立 helper）", () => {
  it("识别 markdown 扩展名", () => {
    expect(kindFromPath("/x.md")).toBe("markdown");
    expect(kindFromPath("/x.markdown")).toBe("markdown");
  });

  it("识别 image 扩展名", () => {
    expect(kindFromPath("/x.png")).toBe("image");
    expect(kindFromPath("/x.jpg")).toBe("image");
    expect(kindFromPath("/x.jpeg")).toBe("image");
    expect(kindFromPath("/x.gif")).toBe("image");
    expect(kindFromPath("/x.webp")).toBe("image");
    expect(kindFromPath("/x.svg")).toBe("image");
  });

  it("识别 code 扩展名", () => {
    expect(kindFromPath("/x.ts")).toBe("code");
    expect(kindFromPath("/x.tsx")).toBe("code");
    expect(kindFromPath("/x.rs")).toBe("code");
    expect(kindFromPath("/x.py")).toBe("code");
    expect(kindFromPath("/x.go")).toBe("code");
    expect(kindFromPath("/x.yaml")).toBe("code");
  });

  it("识别 text 扩展名", () => {
    expect(kindFromPath("/x.txt")).toBe("text");
    expect(kindFromPath("/x.log")).toBe("text");
    expect(kindFromPath("/x.csv")).toBe("text");
  });

  it("未知扩展名兜底 unknown", () => {
    expect(kindFromPath("/x.xyz")).toBe("unknown");
    expect(kindFromPath("/no-ext")).toBe("unknown");
    expect(kindFromPath("")).toBe("unknown");
  });

  it("大小写不敏感", () => {
    expect(kindFromPath("/x.MD")).toBe("markdown");
    expect(kindFromPath("/x.PNG")).toBe("image");
    expect(kindFromPath("/x.TS")).toBe("code");
  });
});
