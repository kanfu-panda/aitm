/* =============================================================================
 * cm-lang.ts 单测（v0.9.0 T5a）
 * -----------------------------------------------------------------------------
 * 覆盖：
 *   - extFromPath：标准 / 多点 / 无扩展 / 隐藏文件
 *   - languageLabel：已知 / 大小写 / 未知
 *   - inferLanguageExtension：每个分支至少 1 个 case + default
 * ========================================================================== */

import { describe, expect, it } from "vitest";

import {
  extFromPath,
  inferLanguageExtension,
  languageLabel,
} from "../cm-lang";

describe("extFromPath", () => {
  it("普通 .ts 文件", () => {
    expect(extFromPath("src/main.ts")).toBe("ts");
  });

  it("多点文件名取最后一段", () => {
    expect(extFromPath("vite.config.ts")).toBe("ts");
  });

  it("无扩展名返回空串", () => {
    expect(extFromPath("Makefile")).toBe("");
  });

  it("隐藏文件（.gitignore）算无扩展", () => {
    // dotfile 没真正的扩展名
    expect(extFromPath(".gitignore")).toBe("");
  });

  it("大写扩展名归一化为小写", () => {
    expect(extFromPath("README.MD")).toBe("md");
  });

  it("只有路径没文件名", () => {
    expect(extFromPath("src/")).toBe("");
  });
});

describe("languageLabel", () => {
  it("ts → TypeScript", () => {
    expect(languageLabel("ts")).toBe("TypeScript");
  });

  it("tsx → TypeScript JSX", () => {
    expect(languageLabel("tsx")).toBe("TypeScript JSX");
  });

  it("rs → Rust", () => {
    expect(languageLabel("rs")).toBe("Rust");
  });

  it("md → Markdown", () => {
    expect(languageLabel("md")).toBe("Markdown");
  });

  it("大小写不敏感", () => {
    expect(languageLabel("JSON")).toBe("JSON");
  });

  it("undefined → Plain Text", () => {
    expect(languageLabel(undefined)).toBe("Plain Text");
  });

  it("未知扩展 → Plain Text", () => {
    expect(languageLabel("xyz")).toBe("Plain Text");
  });
});

describe("inferLanguageExtension", () => {
  it("ts 返回非空 Extension", async () => {
    const ext = await inferLanguageExtension("ts");
    // LanguageSupport 是 array-like Extension（spread 可用），不是空数组
    expect(ext).not.toEqual([]);
  });

  it("rs 返回非空 Extension", async () => {
    const ext = await inferLanguageExtension("rs");
    expect(ext).not.toEqual([]);
  });

  it("py 返回非空 Extension", async () => {
    const ext = await inferLanguageExtension("py");
    expect(ext).not.toEqual([]);
  });

  it("md 返回非空 Extension", async () => {
    const ext = await inferLanguageExtension("md");
    expect(ext).not.toEqual([]);
  });

  it("json 返回非空 Extension", async () => {
    const ext = await inferLanguageExtension("json");
    expect(ext).not.toEqual([]);
  });

  it("html 返回非空 Extension", async () => {
    const ext = await inferLanguageExtension("html");
    expect(ext).not.toEqual([]);
  });

  it("css 返回非空 Extension", async () => {
    const ext = await inferLanguageExtension("css");
    expect(ext).not.toEqual([]);
  });

  it("未知扩展返回空数组", async () => {
    const ext = await inferLanguageExtension("xyz");
    expect(ext).toEqual([]);
  });

  it("空串返回空数组", async () => {
    const ext = await inferLanguageExtension("");
    expect(ext).toEqual([]);
  });
});
