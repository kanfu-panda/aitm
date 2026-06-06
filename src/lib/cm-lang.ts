/* =============================================================================
 * CodeMirror 6 语言推断 helper（aitm v0.9.0 T5a）
 * -----------------------------------------------------------------------------
 * 按文件扩展名 lazy import `@codemirror/lang-*` 包，让主 chunk 不预装语言
 * 解析器（vite 自动按 dynamic import 切独立 chunk）。
 *
 * 返回 Extension（即 LanguageSupport，CodeMirror 把它当 Extension 用）。
 * 未识别扩展名返回空数组（plain text）。
 *
 * 标签别名：
 *   ts/tsx/js/jsx → lang-javascript（typescript / jsx flags 区分）
 *   rs            → lang-rust
 *   py            → lang-python
 *   md / markdown → lang-markdown
 *   json          → lang-json
 *   html / htm    → lang-html
 *   css           → lang-css
 *   其它          → []
 * ========================================================================== */

import type { Extension } from "@codemirror/state";

/**
 * 按扩展名（不含 `.`）推断 CodeMirror 语言 Extension。
 *
 * 用法：
 *   const ext = await inferLanguageExtension("ts");
 *   const state = EditorState.create({ doc, extensions: [basicSetup, ext, ...] });
 */
export async function inferLanguageExtension(
  ext: string,
): Promise<Extension> {
  const key = ext.trim().toLowerCase();
  switch (key) {
    case "ts":
    case "tsx":
      return (await import("@codemirror/lang-javascript")).javascript({
        typescript: true,
        jsx: key === "tsx",
      });
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return (await import("@codemirror/lang-javascript")).javascript({
        jsx: key === "jsx",
      });
    case "rs":
      return (await import("@codemirror/lang-rust")).rust();
    case "py":
    case "pyi":
      return (await import("@codemirror/lang-python")).python();
    case "md":
    case "markdown":
    case "mdx":
      return (await import("@codemirror/lang-markdown")).markdown();
    case "json":
    case "jsonc":
      return (await import("@codemirror/lang-json")).json();
    case "html":
    case "htm":
      return (await import("@codemirror/lang-html")).html();
    case "css":
      return (await import("@codemirror/lang-css")).css();
    default:
      return [];
  }
}

/**
 * 从路径取扩展名（小写，不含点）。
 * 没扩展名返回空串。
 */
export function extFromPath(path: string): string {
  const base = path.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

/**
 * 把扩展名 / 语言标签映射成人类可读的语言显示名（用于 StatusBar）。
 * 未识别返回 "Plain Text"。
 */
export function languageLabel(extOrLang: string | undefined): string {
  const k = (extOrLang ?? "").toLowerCase();
  switch (k) {
    case "ts":
    case "typescript":
      return "TypeScript";
    case "tsx":
      return "TypeScript JSX";
    case "js":
    case "mjs":
    case "cjs":
    case "javascript":
      return "JavaScript";
    case "jsx":
      return "JavaScript JSX";
    case "rs":
    case "rust":
      return "Rust";
    case "py":
    case "pyi":
    case "python":
      return "Python";
    case "md":
    case "markdown":
    case "mdx":
      return "Markdown";
    case "json":
    case "jsonc":
      return "JSON";
    case "html":
    case "htm":
      return "HTML";
    case "css":
      return "CSS";
    default:
      return "Plain Text";
  }
}
