import { describe, expect, it } from "vitest";
import { ZOOM_STEPS, nextZoom } from "../zoom";

describe("nextZoom（PDF / 图片共用的缩放档位）", () => {
  it("应该_当放大时_取比当前大的最近档位", () => {
    expect(nextZoom(1, "in")).toBe(1.25);
    expect(nextZoom(1.1, "in")).toBe(1.25);
  });

  it("应该_当缩小时_取比当前小的最近档位", () => {
    expect(nextZoom(1, "out")).toBe(0.75);
    expect(nextZoom(1.1, "out")).toBe(1);
  });

  it("应该_当已在边界时_返回_null", () => {
    expect(nextZoom(ZOOM_STEPS[ZOOM_STEPS.length - 1], "in")).toBeNull();
    expect(nextZoom(ZOOM_STEPS[0], "out")).toBeNull();
  });

  it("应该_档位范围为_25%_到_400%", () => {
    expect(ZOOM_STEPS[0]).toBe(0.25);
    expect(ZOOM_STEPS[ZOOM_STEPS.length - 1]).toBe(4);
  });
});

