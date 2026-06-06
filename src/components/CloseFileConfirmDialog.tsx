import * as Dialog from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import { useBrowserModalGuard } from "../lib/useBrowserModalGuard";

/**
 * v0.9.0 T5b：dirty 状态关编辑器 tab 时的保存确认对话框。
 *
 * 三选项（参考 VSCode / Sublime 行为）：
 * - 保存并关闭（emerald）：调 saveFile → 成功后 closeFile；
 *   失败（T5b 阶段 saveFile 是占位 throw）由调用方降级到 onDiscard
 * - 丢弃改动（rose）：直接 closeFile，本次修改丢失
 * - 取消（默认聚焦）：保持 tab 不关
 *
 * 设计决议：
 * - 复用 Radix Dialog + token-based 样式，跟 ConfirmDialog / CloseTabConfirmDialog 一致
 * - Esc / 点遮罩 → onCancel（最稳的兜底）
 * - 文件名按 basename 显示（避免长路径撑爆 dialog）
 */
interface Props {
  /** dirty 文件路径；null 表示关闭 dialog。 */
  pendingPath: string | null;
  /** 保存并关闭。 */
  onSaveAndClose: () => void;
  /** 丢弃改动并关闭。 */
  onDiscard: () => void;
  /** 取消（保持 tab 开着）。 */
  onCancel: () => void;
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export default function CloseFileConfirmDialog({
  pendingPath,
  onSaveAndClose,
  onDiscard,
  onCancel,
}: Props) {
  const { t } = useTranslation();
  const open = pendingPath !== null;

  // 让浏览器 webview 在 modal 弹起时让位（v0.4.1 真机 smoke：WKWebView native overlay 盖住 React DOM）
  useBrowserModalGuard(open);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-[60] w-[460px] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-[var(--c-border-strong)] bg-[var(--c-bg-elev-1)] p-5 text-[var(--c-text-base)] shadow-2xl focus:outline-none"
          aria-label={t("closeFileConfirm.dialogAria")}
          data-testid="close-file-confirm-dialog"
        >
          <Dialog.Title className="text-base font-medium text-[var(--c-text-base)]">
            {t("closeFileConfirm.title", {
              name: pendingPath ? basename(pendingPath) : "",
            })}
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-[var(--c-text-muted)]">
            {t("closeFileConfirm.description")}
          </Dialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              autoFocus
              className="rounded border border-[var(--c-border-strong)] px-3 py-1.5 text-sm text-[var(--c-text-base)] hover:bg-[var(--c-bg-elev-2)]"
              data-testid="close-file-btn-cancel"
            >
              {t("closeFileDialog.cancel")}
            </button>
            <button
              type="button"
              onClick={onDiscard}
              className="rounded border border-[var(--c-border-strong)] px-3 py-1.5 text-sm text-[var(--c-error)] hover:bg-[var(--c-bg-elev-2)]"
              data-testid="close-file-btn-discard"
            >
              {t("closeFileDialog.discard")}
            </button>
            <button
              type="button"
              onClick={onSaveAndClose}
              className="rounded bg-[var(--c-success)] px-3 py-1.5 text-sm text-white hover:opacity-90"
              data-testid="close-file-btn-save"
            >
              {t("closeFileDialog.saveAndClose")}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
