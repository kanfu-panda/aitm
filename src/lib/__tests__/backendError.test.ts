import { afterEach, describe, expect, it } from "vitest";

import i18n from "../i18n";
import { formatBackendError } from "../backendError";

// 后端错误原样显示为中文，英文 / 日文界面下读不懂
describe("formatBackendError", () => {
  const coded = (code: string, params: Record<string, string>, message: string) =>
    JSON.stringify({ code, params, message });

  afterEach(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  it("应该_当错误带编码且语言包有文案时_按界面语言显示并填入参数", async () => {
    i18n.addResource("en", "translation", "backendErrors.test.notDir", "Not a directory: {{path}}");
    await i18n.changeLanguage("en");
    expect(formatBackendError(coded("test.notDir", { path: "/a" }, "不是目录：/a"))).toBe(
      "Not a directory: /a",
    );
  });

  it("应该_当语言包没有该编码时_显示中文兜底", async () => {
    await i18n.changeLanguage("en");
    expect(formatBackendError(coded("test.missing", {}, "中文兜底"))).toBe("中文兜底");
  });

  it("应该_当错误不带编码时_原样显示", () => {
    expect(formatBackendError("普通错误")).toBe("普通错误");
    expect(formatBackendError(new Error("boom"))).toBe("boom");
    expect(formatBackendError('{"not":"coded"}')).toBe('{"not":"coded"}');
    expect(formatBackendError(42)).toBe("42");
  });

  it("应该_当参数本身也是编码时_内层同样按界面语言显示", async () => {
    i18n.addResource("en", "translation", "backendErrors.test.outer", "Failed: {{detail}}");
    i18n.addResource("en", "translation", "backendErrors.test.inner", "file {{path}} missing");
    await i18n.changeLanguage("en");
    const inner = coded("test.inner", { path: "/a" }, "文件 /a 不存在");
    expect(formatBackendError(coded("test.outer", { detail: inner }, "失败: 文件 /a 不存在"))).toBe(
      "Failed: file /a missing",
    );
  });

  it("应该_当参数里含特殊字符时_不做 HTML 转义", async () => {
    i18n.addResource("en", "translation", "backendErrors.test.path", "Path: {{path}}");
    await i18n.changeLanguage("en");
    expect(formatBackendError(coded("test.path", { path: "<a&b>" }, "x"))).toBe("Path: <a&b>");
  });
});
