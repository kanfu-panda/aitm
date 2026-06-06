import * as Dialog from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import { useBrowserModalGuard } from "../lib/useBrowserModalGuard";

interface Props {
  /** 待关 tab 的 title（dialog 显示用）；null = dialog 不显示 */
  pendingTabTitle: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 关闭 tab 二次确认（Phase 3A T5）。
 *
 * 触发条件：tab 的 PTY 子进程有运行中命令（session_has_running_command 返 true）。
 * 设计决议（plan §1.1 G6）：
 * - 文案明确告诉用户"会强制中断"
 * - 取消按钮优先（默认焦点 / Esc 走取消，避免误确认丢数据）
 * - 复用 Radix Dialog 跟其它弹窗一致
 */
export default function CloseTabConfirmDialog({
  pendingTabTitle,
  onConfirm,
  onCancel,
}: Props) {
  const { t } = useTranslation();
  const open = pendingTabTitle !== null;

  // 让浏览器 webview 在 modal 弹起时让位（v0.4.1 真机 smoke：WKWebView native overlay 盖住 React DOM）
  useBrowserModalGuard(open);

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 w-[420px] rounded-lg border border-[var(--c-border-strong)] bg-[var(--c-bg-elev-1)] p-5 text-[var(--c-text-base)] shadow-2xl"
          aria-label={t("closeTabDialog.dialogAria")}
        >
          <Dialog.Title className="text-base font-medium text-[var(--c-text-base)]">
            {t("closeTabDialog.title", { title: pendingTabTitle ?? "" })}
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-[var(--c-text-muted)]">
            {t("closeTabDialog.description")}
          </Dialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              autoFocus
              className="rounded border border-[var(--c-border-strong)] px-3 py-1.5 text-sm text-[var(--c-text-base)] hover:bg-[var(--c-bg-elev-2)]"
            >
              {t("closeTabDialog.cancel")}
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className="rounded bg-[var(--c-error)] px-3 py-1.5 text-sm text-white hover:opacity-90"
            >
              {t("closeTabDialog.forceClose")}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
