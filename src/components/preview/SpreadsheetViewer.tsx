/* =============================================================================
 * SpreadsheetViewer.tsx —— xlsx / xls 预览
 * -----------------------------------------------------------------------------
 * useBinaryFile 读字节 → loadWorkbook（SheetJS 按需加载）→ 当前 sheet 交给
 * SpreadsheetGrid；底部是 sheet 标签条。解析失败显示"无法解析"并可用默认应用打开。
 * ========================================================================== */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { loadWorkbook, type SheetData } from "../../lib/sheet";
import BinaryStatus from "./BinaryStatus";
import PreviewFallback, { PreviewLoading } from "./PreviewFallback";
import SpreadsheetGrid from "./SpreadsheetGrid";
import { useBinaryFile } from "./useBinaryFile";

interface Props {
  path: string;
  reloadKey: number | undefined;
}

type Parsed =
  | { status: "loading" }
  | { status: "ready"; sheets: SheetData[] }
  | { status: "invalid" };

export default function SpreadsheetViewer({ path, reloadKey }: Props) {
  const { t } = useTranslation();
  const file = useBinaryFile(path, reloadKey);
  const [parsed, setParsed] = useState<Parsed>({ status: "loading" });
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (file.status !== "ready") {
      setParsed({ status: "loading" });
      return;
    }
    let cancelled = false;
    setParsed({ status: "loading" });
    loadWorkbook(file.data).then(
      (sheets) => {
        if (cancelled) return;
        setActive(0);
        setParsed({ status: "ready", sheets });
      },
      () => {
        if (!cancelled) setParsed({ status: "invalid" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [file]);

  return (
    <div className="relative flex h-full w-full min-h-0 flex-col" data-testid="sheet-viewer">
      {file.status !== "ready" && <BinaryStatus state={file} path={path} />}
      {file.status === "ready" && parsed.status === "loading" && <PreviewLoading />}
      {parsed.status === "invalid" && (
        <PreviewFallback testId="preview-error" message={t("preview.invalid")} path={path} />
      )}
      {file.status === "ready" && parsed.status === "ready" && (
        <>
          <div className="min-h-0 flex-1">
            {parsed.sheets[active] && (
              <SpreadsheetGrid
                rows={parsed.sheets[active].rows}
                merges={parsed.sheets[active].merges}
                totalRows={parsed.sheets[active].totalRows}
                totalCols={parsed.sheets[active].totalCols}
              />
            )}
          </div>
          <div
            role="tablist"
            aria-label={t("preview.sheets")}
            className="flex shrink-0 items-center gap-1 overflow-x-auto border-t border-[var(--c-border)] bg-[var(--c-bg-elev-1)] px-2 py-1"
          >
            {parsed.sheets.map((s, i) => (
              <button
                key={i}
                type="button"
                role="tab"
                aria-selected={i === active}
                onClick={() => setActive(i)}
                data-testid={`sheet-tab-${i}`}
                className={
                  i === active
                    ? "whitespace-nowrap rounded bg-[var(--c-bg-elev-2)] px-2 py-0.5 text-xs text-[var(--c-text-base)]"
                    : "whitespace-nowrap rounded px-2 py-0.5 text-xs text-[var(--c-text-muted)] hover:bg-[var(--c-bg-elev-2)]"
                }
              >
                {s.name}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
