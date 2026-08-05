/**
 * T-B3b：行级 diff 视图。给 write_file / edit_file 的 ToolPreview 渲染
 * 绿加 / 红删 / 灰未变行，取代 ConfirmDialog / ToolCallBubble 里纯文本
 * args_preview 展示。
 *
 * 依赖选择：项目未装 npm `diff` 包（package.json 无此依赖），按军规
 * §12 依赖最小化——不为单个组件引整包，自实现约 30 行 LCS 行 diff。
 * 算法是标准最长公共子序列（LCS）回溯法：先 O(n*m) 动态规划求两侧
 * 行序列的 LCS 长度表，再从起点正向回溯，相同行判 context，仅存在于
 * 旧侧的判 del，仅存在于新侧的判 add。对典型的审批场景（单文件、行数
 * 不大）性能足够；不追求 Myers diff 的 O(ND) 最优复杂度。
 */

export type DiffLineType = "add" | "del" | "context";

export interface DiffLine {
  type: DiffLineType;
  text: string;
}

/**
 * 把文本按 "\n" 拆行；空字符串视为「零行」而非「一个空行」——
 * 否则 write_file 新建文件（old_text=""）会在 diff 里多出一行
 * 虚假的「删除空行」。
 */
function splitLines(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}

/**
 * 轻量 LCS 行级 diff。返回按顺序排列的 add/del/context 行。
 */
export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const n = a.length;
  const m = b.length;

  // dp[i][j] = a[i:] 与 b[j:] 的最长公共子序列长度
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      result.push({ type: "context", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ type: "del", text: a[i] });
      i++;
    } else {
      result.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) {
    result.push({ type: "del", text: a[i] });
    i++;
  }
  while (j < m) {
    result.push({ type: "add", text: b[j] });
    j++;
  }
  return result;
}

interface Props {
  /** 被改动文件的绝对路径（或相对沙盒路径），显示在顶部。 */
  path: string;
  oldText: string;
  newText: string;
}

const ROW_CLASS: Record<DiffLineType, string> = {
  add: "bg-[var(--c-success-bg)] text-[var(--c-success-fg)]",
  del: "bg-[var(--c-error-bg,rgba(244,63,94,0.12))] text-[var(--c-error)]",
  context: "text-[var(--c-text-dim)]",
};

const ROW_PREFIX: Record<DiffLineType, string> = {
  add: "+",
  del: "-",
  context: " ",
};

/**
 * 行级 diff 视图组件。深浅色主题都走 tokens.css 的语义色变量，
 * 保证可读性（emerald 加行 / rose 删行 / 灰未变行）。
 */
export default function DiffView({ path, oldText, newText }: Props) {
  const lines = computeLineDiff(oldText, newText);

  return (
    <div
      className="overflow-hidden rounded border border-[var(--c-border)]"
      data-testid="diff-view"
    >
      <div
        className="truncate border-b border-[var(--c-border)] bg-[var(--c-bg-elev-2)] px-2 py-1 font-mono text-[11px] text-[var(--c-text-muted)]"
        title={path}
        data-testid="diff-view-path"
      >
        {path}
      </div>
      <div className="max-h-64 overflow-auto font-mono text-[11px] leading-5">
        {lines.map((line, idx) => (
          <div
            key={idx}
            className={`whitespace-pre px-2 ${ROW_CLASS[line.type]}`}
            data-testid={`diff-line-${line.type}`}
          >
            <span className="mr-1 select-none opacity-70" aria-hidden>
              {ROW_PREFIX[line.type]}
            </span>
            {line.text}
          </div>
        ))}
      </div>
    </div>
  );
}
