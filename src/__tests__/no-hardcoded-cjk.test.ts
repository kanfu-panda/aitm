import { describe, expect, it } from "vitest";

/**
 * 界面支持中 / 英 / 日，但不少组件把中文文案直接写在代码里，
 * 英文、日文界面下照样显示中文。这里静态扫描界面代码，界面文案必须走语言包。
 *
 * 忽略：注释、console.* 日志。确实要保留原文的（如语言选择里各语言的自称）
 * 不应放在这些目录里。
 */
const SOURCES = import.meta.glob<string>(
  [
    "../components/**/*.{ts,tsx}",
    "../lib/systemNotification.ts",
    "!**/__tests__/**",
    "!**/*.test.*",
  ],
  { query: "?raw", import: "default", eager: true },
);
const CJK = /[一-鿿]/;

function hardcodedLines(file: string, raw: string): string[] {
  // 块注释与 JSX 注释换成等量空行，保持行号
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, (m) =>
    "\n".repeat(m.split("\n").length - 1),
  );
  const out: string[] = [];
  let inConsoleCall = false;
  src.split("\n").forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, "");
    if (/console\.(warn|error|log|debug|info)\(/.test(code)) {
      // 多行的 console 调用一直跳到收尾的 `);`
      inConsoleCall = !/\);\s*$/.test(code);
    } else if (inConsoleCall) {
      if (/\);\s*$/.test(code)) inConsoleCall = false;
    } else if (CJK.test(code)) {
      out.push(`${file}:${i + 1}: ${line.trim()}`);
    }
  });
  return out;
}

describe("界面代码不写死中文", () => {
  it("扫描范围非空（防止路径写错导致守卫形同虚设）", () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(50);
  });

  it("应该_当界面切到英文或日文时_没有写死在代码里的中文文案", () => {
    const hits = Object.entries(SOURCES).flatMap(([file, raw]) =>
      hardcodedLines(file, raw),
    );
    expect(hits).toEqual([]);
  });
});
