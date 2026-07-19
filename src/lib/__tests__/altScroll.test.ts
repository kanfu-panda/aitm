import { describe, expect, it } from "vitest";
import { altScrollSequence, shouldAltScroll } from "../altScroll";

describe("shouldAltScroll", () => {
  it("备用屏 + 无鼠标追踪 → true", () => {
    expect(shouldAltScroll("alternate", "none")).toBe(true);
  });
  it("正常屏 → false（走 xterm 默认滚 scrollback）", () => {
    expect(shouldAltScroll("normal", "none")).toBe(false);
  });
  it("备用屏但应用开了鼠标追踪 → false（滚轮交给应用）", () => {
    expect(shouldAltScroll("alternate", "vt200")).toBe(false);
    expect(shouldAltScroll("alternate", "any")).toBe(false);
  });
});

describe("altScrollSequence", () => {
  it("向上滚 → Up；向下滚 → Down（普通光标键模式 ESC[）", () => {
    expect(
      altScrollSequence({ deltaY: -120, deltaMode: 0, applicationCursorKeys: false }),
    ).toContain("\x1b[A");
    expect(
      altScrollSequence({ deltaY: 120, deltaMode: 0, applicationCursorKeys: false }),
    ).toContain("\x1b[B");
  });

  it("应用光标键模式(DECCKM) → 用 ESC O 前缀", () => {
    expect(
      altScrollSequence({ deltaY: -120, deltaMode: 0, applicationCursorKeys: true }),
    ).toContain("\x1bOA");
    expect(
      altScrollSequence({ deltaY: 120, deltaMode: 0, applicationCursorKeys: true }),
    ).toContain("\x1bOB");
  });

  it("像素档位 ~40px/行：deltaY=120 → 3 行", () => {
    const seq = altScrollSequence({
      deltaY: -120,
      deltaMode: 0,
      applicationCursorKeys: false,
    });
    // "\x1b[A" 重复 3 次
    expect(seq).toBe("\x1b[A".repeat(3));
  });

  it("line 档位：deltaY 直接当行数", () => {
    const seq = altScrollSequence({
      deltaY: 2,
      deltaMode: 1,
      applicationCursorKeys: false,
    });
    expect(seq).toBe("\x1b[B".repeat(2));
  });

  it("极小 delta 至少 1 行", () => {
    const seq = altScrollSequence({
      deltaY: -3,
      deltaMode: 0,
      applicationCursorKeys: false,
    });
    expect(seq).toBe("\x1b[A");
  });

  it("快速甩动夹到最多 10 行", () => {
    const seq = altScrollSequence({
      deltaY: -9999,
      deltaMode: 0,
      applicationCursorKeys: false,
    });
    expect(seq).toBe("\x1b[A".repeat(10));
  });

  it("deltaY=0（纯横向）返回空串", () => {
    expect(
      altScrollSequence({ deltaY: 0, deltaMode: 0, applicationCursorKeys: false }),
    ).toBe("");
  });
});
