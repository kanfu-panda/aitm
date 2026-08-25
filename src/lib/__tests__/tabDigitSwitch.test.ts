import { describe, expect, it } from "vitest";
import { digitFromCode, resolveDigitTarget } from "../tabDigitSwitch";

const TABS = ["a", "b", "c"];

describe("resolveDigitTarget", () => {
  it("1..N 取对应位置的标签", () => {
    expect(resolveDigitTarget(TABS, 1)).toBe("a");
    expect(resolveDigitTarget(TABS, 2)).toBe("b");
    expect(resolveDigitTarget(TABS, 3)).toBe("c");
  });

  it("Cmd+9 跳最后一个，而不是第 9 个", () => {
    // Chrome / Safari / iTerm2 / Terminal.app 全是这个约定
    expect(resolveDigitTarget(TABS, 9)).toBe("c");
    expect(resolveDigitTarget(["only"], 9)).toBe("only");
  });

  it("越界返回 null —— 按错数字时什么都不做，而不是兜底跳某个标签", () => {
    expect(resolveDigitTarget(TABS, 4)).toBeNull();
    expect(resolveDigitTarget(TABS, 8)).toBeNull();
  });

  it("空标签列表返回 null", () => {
    expect(resolveDigitTarget([], 1)).toBeNull();
    expect(resolveDigitTarget([], 9)).toBeNull();
  });

  it("非法 digit 返回 null", () => {
    expect(resolveDigitTarget(TABS, 0)).toBeNull();
    expect(resolveDigitTarget(TABS, 10)).toBeNull();
    expect(resolveDigitTarget(TABS, 1.5)).toBeNull();
    expect(resolveDigitTarget(TABS, NaN)).toBeNull();
  });

  it("恰好 9 个标签时 9 既是第 9 个也是最后一个", () => {
    const nine = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
    expect(resolveDigitTarget(nine, 9)).toBe("9");
  });
});

describe("digitFromCode", () => {
  it("主键区数字", () => {
    expect(digitFromCode("Digit1")).toBe(1);
    expect(digitFromCode("Digit9")).toBe(9);
  });

  it("小键盘数字", () => {
    expect(digitFromCode("Numpad3")).toBe(3);
  });

  it("Digit0 不参与（Cmd+0 是字号重置）", () => {
    expect(digitFromCode("Digit0")).toBeNull();
    expect(digitFromCode("Numpad0")).toBeNull();
  });

  it("非数字键返回 null", () => {
    expect(digitFromCode("KeyT")).toBeNull();
    expect(digitFromCode("Minus")).toBeNull();
    expect(digitFromCode("")).toBeNull();
  });
});
