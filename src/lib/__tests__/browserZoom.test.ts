import { describe, expect, it } from "vitest";
import {
  DEFAULT_ZOOM,
  ZOOM_STEPS,
  formatZoom,
  snapZoom,
  stepZoom,
} from "../browserZoom";

describe("浏览器缩放档位", () => {
  it("100% 必须是档位之一（reset 要回到它）", () => {
    expect(ZOOM_STEPS).toContain(DEFAULT_ZOOM);
  });

  it("档位单调递增", () => {
    const sorted = [...ZOOM_STEPS].sort((a, b) => a - b);
    expect([...ZOOM_STEPS]).toEqual(sorted);
  });

  it("任意值吸附到最近档位", () => {
    expect(snapZoom(1)).toBe(1);
    expect(snapZoom(0.71)).toBe(0.67); // 0.67 与 0.75 之间偏近 0.67
    expect(snapZoom(0.73)).toBe(0.75);
    expect(snapZoom(999)).toBe(2); // 超范围吸到上限档
    expect(snapZoom(0.01)).toBe(0.5); // 超范围吸到下限档
  });

  it("放大 / 缩小各走一档", () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(1.25, 1)).toBe(1.5);
  });

  it("不在档位上的当前值先吸附再走一档，不会越调越偏", () => {
    expect(stepZoom(1.05, 1)).toBe(1.1);
    expect(stepZoom(1.05, -1)).toBe(0.9);
  });

  it("到头就停住，绝不回绕", () => {
    // 回绕会让"一直按放大"突然变成最小，是明确的反直觉行为
    expect(stepZoom(2, 1)).toBe(2);
    expect(stepZoom(0.5, -1)).toBe(0.5);
  });

  it("百分比文案取整", () => {
    expect(formatZoom(1)).toBe("100%");
    expect(formatZoom(0.67)).toBe("67%");
    expect(formatZoom(1.25)).toBe("125%");
  });
});
