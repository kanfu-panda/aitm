/* =============================================================================
 * SpreadsheetGrid.tsx —— 表格网格
 * -----------------------------------------------------------------------------
 * 纯展示：列号表头 A/B/C、行号列、合并块（只渲染左上角并设 rowSpan/colSpan）、
 * 截断提示、空表提示。表头行与行号列 sticky。单元格内容一律作为文本节点插入。
 * ========================================================================== */

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { colName, type Merge } from "../../lib/sheet";

interface Props {
  rows: string[][];
  merges?: Merge[];
  totalRows: number;
  totalCols: number;
}

export default function SpreadsheetGrid({ rows, merges, totalRows, totalCols }: Props) {
  const { t } = useTranslation();
  const cols = useMemo(() => rows.reduce((m, r) => Math.max(m, r.length), 0), [rows]);

  // 合并块：左上角 → 跨度；其余被覆盖格 → 跳过
  const { spans, covered } = useMemo(() => {
    const spans = new Map<string, { rs: number; cs: number }>();
    const covered = new Set<string>();
    for (const m of merges ?? []) {
      spans.set(`${m.s.r}:${m.s.c}`, { rs: m.e.r - m.s.r + 1, cs: m.e.c - m.s.c + 1 });
      for (let r = m.s.r; r <= m.e.r; r++) {
        for (let c = m.s.c; c <= m.e.c; c++) {
          if (r !== m.s.r || c !== m.s.c) covered.add(`${r}:${c}`);
        }
      }
    }
    return { spans, covered };
  }, [merges]);

  if (rows.length === 0) {
    return (
      <div
        className="flex h-full items-center justify-center text-sm text-[var(--c-text-dim)]"
        data-testid="sheet-empty"
      >
        {t("preview.emptySheet")}
      </div>
    );
  }

  const truncated = totalRows > rows.length || totalCols > cols;
  const cellBorder = "border border-[var(--c-border)]";

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="sheet-grid">
      {truncated && (
        <div
          className="border-b border-[var(--c-border)] bg-[var(--c-bg-elev-1)] px-3 py-1 text-xs text-[var(--c-text-muted)]"
          data-testid="sheet-truncated"
        >
          {t("preview.truncated", { rows: rows.length, cols, totalRows, totalCols })}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="border-separate border-spacing-0 text-xs text-[var(--c-text-base)]">
          <thead>
            <tr>
              <th
                className={`sticky left-0 top-0 z-20 bg-[var(--c-bg-elev-2)] ${cellBorder}`}
                aria-hidden="true"
              />
              {Array.from({ length: cols }, (_, c) => (
                <th
                  key={c}
                  scope="col"
                  className={`sticky top-0 z-10 bg-[var(--c-bg-elev-2)] px-2 py-0.5 font-normal text-[var(--c-text-muted)] ${cellBorder}`}
                >
                  {colName(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                <th
                  scope="row"
                  className={`sticky left-0 z-10 bg-[var(--c-bg-elev-2)] px-2 py-0.5 text-right font-normal text-[var(--c-text-muted)] ${cellBorder}`}
                >
                  {r + 1}
                </th>
                {Array.from({ length: cols }, (_, c) => {
                  if (covered.has(`${r}:${c}`)) return null;
                  const span = spans.get(`${r}:${c}`);
                  const text = row[c] ?? "";
                  return (
                    <td
                      key={c}
                      data-cell={`${colName(c)}${r + 1}`}
                      rowSpan={span?.rs}
                      colSpan={span?.cs}
                      title={text}
                      className={`max-w-[320px] overflow-hidden text-ellipsis whitespace-pre px-2 py-0.5 ${cellBorder}`}
                    >
                      {text}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
