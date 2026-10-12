/* BinaryStatus：把 useBinaryFile 的非就绪状态渲染成加载中 / 超限 / 读取失败提示。 */

import { useTranslation } from "react-i18next";
import { formatBackendError } from "../../lib/backendError";
import PreviewFallback, { PreviewLoading } from "./PreviewFallback";
import type { BinaryState } from "./useBinaryFile";

const MB = 1024 * 1024;
export const formatMb = (bytes: number) => `${(bytes / MB).toFixed(1)} MB`;

export default function BinaryStatus({ state, path }: { state: BinaryState; path: string }) {
  const { t } = useTranslation();
  switch (state.status) {
    case "loading":
      return <PreviewLoading />;
    case "tooLarge":
      return (
        <PreviewFallback
          testId="preview-too-large"
          message={t("preview.tooLarge", { size: formatMb(state.size), max: formatMb(state.max) })}
          path={path}
        />
      );
    case "error":
      return (
        <PreviewFallback testId="preview-error" message={formatBackendError(state.error)} path={path} />
      );
    default:
      return null;
  }
}
