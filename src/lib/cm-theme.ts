/* =============================================================================
 * CodeMirror 6 自定义主题（aitm v0.9.0 T5a + v0.9.1 HR3-2）
 * -----------------------------------------------------------------------------
 * 颜色全部走 tokens.css 的 CSS 变量，避免 dark/light 双份维护。
 * 切换主题（applyTheme(mode)）时 CodeMirror 自动跟随，无需重建 EditorView。
 *
 * 注意：`EditorView.theme(..., { dark: true })` 第二参的 dark 标志影响
 * CodeMirror 内置 syntax highlight 默认配色。aitm 默认 dark 主题；light 时
 * 仍然标 dark:true 也不影响——我们用自定义 vscodeHighlightStyle 覆盖了内置高亮，
 * 且高亮颜色走 CSS 变量自动跟 data-theme 切。
 *
 * HR3-2（v0.9.1）：补自定义 HighlightStyle。CodeMirror 6 不带默认 syntax
 * highlight，basicSetup 内置的 highlight 是低对比 fallback。
 *
 * v0.10.5 hotfix：syntax 颜色从硬编码 Dark+ hex 抽到 --c-syntax-* CSS 变量，
 * dark / light 两套 palette（VS Code Dark+ / Light+）在 tokens.css 维护，
 * applyTheme(mode) 改 data-theme 后高亮自动跟随，修浅色模式对比度过低问题。
 * ========================================================================== */

import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

export const customTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: "var(--c-bg-base)",
      color: "var(--c-text-base)",
      height: "100%",
      // v0.10.6 T4：字号优先读 --cm-font-size（adjustFontSize / settings.editor.font_size 写入），
      // 缺省 fallback 到全局 --t-base。
      fontSize: "var(--cm-font-size, var(--t-base))",
      fontFamily: "var(--f-mono)",
    },
    ".cm-scroller": {
      fontFamily: "var(--f-mono)",
      lineHeight: "1.5",
    },
    ".cm-content": {
      caretColor: "var(--c-success)",
      padding: "var(--s-2) 0",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "var(--c-success)",
      borderLeftWidth: "2px",
    },
    ".cm-gutters": {
      backgroundColor: "var(--c-bg-elev-1)",
      color: "var(--c-text-dim)",
      border: "none",
      borderRight: "1px solid var(--c-border)",
    },
    ".cm-activeLine": {
      backgroundColor: "var(--c-bg-elev-1)",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "var(--c-bg-elev-2)",
      color: "var(--c-text-base)",
    },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection":
      {
        backgroundColor: "var(--c-selection) !important",
      },
    ".cm-selectionMatch": {
      backgroundColor: "var(--c-bg-elev-2)",
    },
    ".cm-searchMatch": {
      backgroundColor: "var(--c-success-bg)",
      outline: "1px solid var(--c-success)",
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
      backgroundColor: "var(--c-success-bg)",
      outline: "1px solid var(--c-success-fg)",
    },
    ".cm-foldPlaceholder": {
      backgroundColor: "var(--c-bg-elev-2)",
      color: "var(--c-text-muted)",
      border: "1px solid var(--c-border)",
      borderRadius: "var(--r-sm)",
      padding: "0 var(--s-1)",
    },
    ".cm-tooltip": {
      backgroundColor: "var(--c-bg-elev-1)",
      color: "var(--c-text-base)",
      border: "1px solid var(--c-border)",
      borderRadius: "var(--r-md)",
    },
    ".cm-panels": {
      backgroundColor: "var(--c-bg-elev-1)",
      color: "var(--c-text-base)",
    },
    ".cm-panels.cm-panels-top": {
      borderBottom: "1px solid var(--c-border)",
    },
    ".cm-panels.cm-panels-bottom": {
      borderTop: "1px solid var(--c-border)",
    },
  },
  { dark: true },
);

/**
 * VS Code Dark+ / Light+ 风格的 syntax highlight。
 *
 * tag mapping 参考 @lezer/highlight 标准 tag 集合 + lang-* parser 的 styleTags。
 * 颜色走 tokens.css 的 --c-syntax-* CSS 变量，dark / light 各自一套 palette
 * （Dark+ vs Light+），applyTheme(mode) 切 data-theme 后自动跟随，无需重建 view
 * 或 Compartment reconfigure。
 *
 * v0.10.5 hotfix：从硬编码 hex 抽到 CSS 变量，修浅色模式 syntax 对比度过低
 * （原来全套 Dark+ hex 在白底上几乎看不清）。
 */
export const vscodeHighlightStyle = HighlightStyle.define([
  // Keywords
  { tag: [t.keyword, t.modifier], color: "var(--c-syntax-keyword)" },
  { tag: [t.controlKeyword, t.operatorKeyword], color: "var(--c-syntax-control)" },

  // Strings
  { tag: [t.string, t.special(t.string)], color: "var(--c-syntax-string)" },
  { tag: t.regexp, color: "var(--c-syntax-regexp)" },

  // Numbers / atoms
  { tag: [t.number, t.bool, t.null], color: "var(--c-syntax-number)" },

  // Functions / names
  {
    tag: [t.function(t.variableName), t.function(t.propertyName)],
    color: "var(--c-syntax-function)",
  },
  { tag: [t.className, t.typeName, t.namespace], color: "var(--c-syntax-class)" },
  { tag: t.propertyName, color: "var(--c-syntax-property)" },
  { tag: t.variableName, color: "var(--c-syntax-variable)" },

  // Comments
  { tag: t.comment, color: "var(--c-syntax-comment)", fontStyle: "italic" },

  // Punctuation / operators
  { tag: [t.punctuation, t.bracket, t.brace, t.paren], color: "var(--c-syntax-operator)" },
  { tag: t.operator, color: "var(--c-syntax-operator)" },

  // Tags / attributes (HTML/JSX/XML)
  { tag: t.tagName, color: "var(--c-syntax-tag)" },
  { tag: t.attributeName, color: "var(--c-syntax-attr-name)" },
  { tag: t.attributeValue, color: "var(--c-syntax-attr-value)" },

  // Markdown
  { tag: t.heading, color: "var(--c-syntax-heading)", fontWeight: "bold" },
  { tag: t.link, color: "var(--c-syntax-link)", textDecoration: "underline" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "bold" },

  // Diff
  { tag: t.inserted, color: "var(--c-syntax-inserted)" },
  { tag: t.deleted, color: "var(--c-syntax-deleted)" },
]);

/**
 * customTheme + vscodeHighlightStyle 的复合 extension。
 * CodeMirrorViewer 直接 import 这个即可，避免组件层零散 import。
 */
export const vscodeSyntaxHighlighting = syntaxHighlighting(
  vscodeHighlightStyle,
);
