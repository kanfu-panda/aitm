import { create } from "zustand";
import { trackEvent } from "../lib/analytics";

/**
 * Phase 3A T2 引入：跨组件共享"当前预览的文件路径"。
 *
 * - FileTree 点 .md / .markdown 文件时调 `setPreviewPath(path)`
 * - T3 `MarkdownPreviewDialog` 订阅 `previewPath` 决定打开 / 关闭
 *
 * T2 + T3 并行实施，T2 负责建 store；T3 只读它。
 *
 * 设计：极简，只有 path + setter；什么后缀算"可预览"由调用方决定（v0.3.0 范围
 * 只支持 markdown，v0.3.x 后续可能加文本预览）。
 */
interface PreviewState {
  /** 当前预览的文件绝对路径；null = 关闭。 */
  previewPath: string | null;
  /** 触发预览（FileTree 点 .md 文件调）；非 .md 后缀也可调，dialog 内部决定怎么处理。 */
  setPreviewPath: (path: string | null) => void;
}

/** v0.7.0-A 匿名统计可上报的 kind 分类。 */
export type PreviewKind = "markdown" | "code" | "text" | "image" | "unknown";

/**
 * v0.7.0-A：从文件路径推断 kind（仅按扩展名）。
 *
 * **重要**：返回值只用于 trackEvent 的 categorical props，**不**会把 path 本身
 * 上报；调用方只把推断结果传出去。
 */
export function kindFromPath(path: string): PreviewKind {
  const lower = path.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  if (/\.(png|jpg|jpeg|gif|webp|svg|bmp|ico)$/.test(lower)) return "image";
  if (
    /\.(ts|tsx|js|jsx|mjs|cjs|rs|py|go|java|c|cpp|cc|h|hpp|cs|rb|php|swift|kt|scala|sh|bash|zsh|fish|lua|sql|html|css|scss|less|vue|svelte|toml|yaml|yml|json|xml)$/.test(
      lower,
    )
  ) {
    return "code";
  }
  if (/\.(txt|log|csv|tsv|env|ini|cfg|conf)$/.test(lower)) return "text";
  return "unknown";
}

export const usePreviewStore = create<PreviewState>((set) => ({
  previewPath: null,
  setPreviewPath: (path) => {
    set({ previewPath: path });
    if (path) {
      // v0.7.0-A：匿名统计——只传 kind 分类，**不**传 path / 文件名
      trackEvent("file_previewed", { kind: kindFromPath(path) });
    }
  },
}));
