import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useBrowserModalGuard } from "../lib/useBrowserModalGuard";

interface Props {
  /** null = 关闭；非空 = 待删除目标。 */
  pending: { path: string; name: string; isDir: boolean } | null;
  /** 用户点"删除"后调；resolve 关 dialog，throw 显示错误。 */
  onConfirm: (path: string) => Promise<void>;
  /** 取消 / Esc / 点遮罩。 */
  onCancel: () => void;
}

/**
 * v0.10.2 #6：文件树删除二次确认对话框。
 *
 * 类似 CloseFileConfirmDialog 但更简单 —— 没"保存/丢弃"分支，只 删 / 取消。
 * destructive 强调用 rose 色按钮 + 文案明确"不可撤销"。
 */
export default function FsDeleteConfirmDialog({
  pending,
  onConfirm,
  onCancel,
}: Props) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // v0.10.2 hotfix：pending 切换（开新对话）时 reset 内部 state。
  // 之前 bug：第一次 confirm 成功后 caller setPending(null)，组件不 unmount
  // （只 `if (!pending) return null`），submitting=true 残留。下次 pending
  // 切到新对象时按钮仍 disabled，用户感觉"点不中"。
  useEffect(() => {
    if (pending) {
      setError(null);
      setSubmitting(false);
    }
  }, [pending]);

  useBrowserModalGuard(pending !== null);

  if (!pending) return null;

  const handleConfirm = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm(pending.path);
      // 成功 → caller 应该 setPending(null) 关 dialog
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  };

  return (
    <Dialog.Root open={true} onOpenChange={(o) => !o && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm"
          data-testid="fs-delete-dialog-overlay"
        />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-[101] w-[420px] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-[var(--c-border-strong)] bg-[var(--c-bg-elev-1)] p-5 shadow-2xl"
          data-testid="fs-delete-dialog"
        >
          <Dialog.Title className="mb-2 text-base font-semibold text-[var(--c-text-base)]">
            {pending.isDir
              ? t("fsDeleteDialog.titleDir")
              : t("fsDeleteDialog.titleFile")}
          </Dialog.Title>
          <Dialog.Description className="mb-1 text-sm text-[var(--c-text-muted)]">
            {pending.isDir
              ? t("fsDeleteDialog.descriptionDir", { name: pending.name })
              : t("fsDeleteDialog.descriptionFile", { name: pending.name })}
          </Dialog.Description>
          <div className="mb-3 text-xs text-[var(--c-text-faint)] truncate" title={pending.path}>
            {pending.path}
          </div>
          {error && (
            <div
              className="mb-3 rounded border border-[var(--c-error)] bg-[var(--c-error)]/10 px-2 py-1 text-xs text-[var(--c-error)]"
              data-testid="fs-delete-dialog-error"
              role="alert"
            >
              {error}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={submitting}
              data-testid="fs-delete-dialog-cancel"
              className="rounded border border-[var(--c-border-strong)] bg-[var(--c-bg-elev-2)] px-3 py-1.5 text-xs text-[var(--c-text-base)] hover:bg-[var(--c-bg-elev-3)] disabled:opacity-50"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={submitting}
              data-testid="fs-delete-dialog-confirm"
              className="rounded bg-[var(--c-error)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {t("common.delete")}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
