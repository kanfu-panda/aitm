/* =============================================================================
 * PreviewFallback.tsx —— 预览的提示态
 * -----------------------------------------------------------------------------
 * 居中显示原因与"用默认应用打开"；打开失败时把原因换成错误信息。
 * PreviewLoading 为加载中占位。样式与 PdfViewer 的提示态一致。
 * ========================================================================== */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { shellOpen } from "../../lib/tauri";
import { formatBackendError } from "../../lib/backendError";

interface Props {
  testId: string;
  message: string;
  path: string;
}

export default function PreviewFallback({ testId, message, path }: Props) {
  const { t } = useTranslation();
  const [openError, setOpenError] = useState<string | null>(null);

  useEffect(() => {
    setOpenError(null);
  }, [message, path]);

  const openDefault = () => {
    shellOpen(path).catch((e: unknown) => setOpenError(formatBackendError(e)));
  };

  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center"
      data-testid={testId}
    >
      <p className="text-sm text-[var(--c-text-muted)]">{openError ?? message}</p>
      <button
        onClick={openDefault}
        className="rounded border border-[var(--c-success)] bg-[var(--c-success-bg)] px-4 py-1.5 text-sm text-[var(--c-success-fg)] hover:opacity-90"
        data-testid="preview-open-default"
      >
        {t("preview.openWithDefault")}
      </button>
    </div>
  );
}

export function PreviewLoading() {
  const { t } = useTranslation();
  return (
    <div
      className="absolute inset-0 flex items-center justify-center text-sm text-[var(--c-text-dim)]"
      data-testid="preview-loading"
    >
      {t("preview.loading")}
    </div>
  );
}
