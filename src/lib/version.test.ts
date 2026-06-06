import { describe, expect, it } from "vitest";
import { appVersion, isSemverLike } from "./version";

describe("appVersion", () => {
  it("返回非空字符串", () => {
    expect(appVersion()).toBeTruthy();
    expect(typeof appVersion()).toBe("string");
  });

  it("符合 semver 格式", () => {
    expect(isSemverLike(appVersion())).toBe(true);
  });
});

describe("isSemverLike", () => {
  it.each([
    ["0.0.1", true],
    ["1.2.3", true],
    ["10.20.30", true],
    ["1.2", false],
    ["1.2.3.4", false],
    ["a.b.c", false],
    ["", false],
  ])("isSemverLike(%s) === %s", (input, expected) => {
    expect(isSemverLike(input)).toBe(expected);
  });
});
