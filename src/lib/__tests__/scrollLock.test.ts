import { describe, expect, it } from "vitest";
import {
  computeScrollRestore,
  isScrolledUp,
  type BufSnapshot,
} from "../scrollLock";

const buf = (o: Partial<BufSnapshot>): BufSnapshot => ({
  type: "normal",
  viewportY: 0,
  baseY: 0,
  ...o,
});

describe("isScrolledUp", () => {
  it("普通缓冲区 + 视口在底部 → false（正常跟随）", () => {
    expect(isScrolledUp(buf({ viewportY: 100, baseY: 100 }))).toBe(false);
  });
  it("普通缓冲区 + 视口滚离底部 → true（需锁位置）", () => {
    expect(isScrolledUp(buf({ viewportY: 30, baseY: 100 }))).toBe(true);
  });
  it("备用屏(vim/less) → 恒 false（无 scrollback，不介入）", () => {
    expect(isScrolledUp(buf({ type: "alternate", viewportY: 0, baseY: 0 }))).toBe(
      false,
    );
  });
});

describe("computeScrollRestore", () => {
  it("写入前在底部(wasScrolledUp=false) → 不介入(null)", () => {
    expect(computeScrollRestore(false, 0, buf({ viewportY: 100, baseY: 100 }))).toBe(
      null,
    );
  });

  it("滚离底部 + 内部被拽到底 → 恢复到写前位置", () => {
    // 写前 viewportY=30；写后被 xterm 拽到 baseY=105
    expect(
      computeScrollRestore(true, 30, buf({ viewportY: 105, baseY: 105 })),
    ).toBe(30);
  });

  it("滚离底部但这次内部没被拽底(用户赢了竞态) → 不重复 scroll(null)", () => {
    // 写后 viewportY 仍是 30 = target
    expect(
      computeScrollRestore(true, 30, buf({ viewportY: 30, baseY: 105 })),
    ).toBe(null);
  });

  it("scrollback 裁剪致 baseY 变小、savedViewportY 越界 → clamp 到 baseY", () => {
    // 写前 viewportY=30；写后 baseY 只剩 20（老行被裁），恢复目标夹到 20
    expect(
      computeScrollRestore(true, 30, buf({ viewportY: 20, baseY: 20 })),
    ).toBe(null); // 20===20 不重复
    expect(
      computeScrollRestore(true, 30, buf({ viewportY: 25, baseY: 20 })),
    ).toBe(20); // 需要拉回 20
  });
});
