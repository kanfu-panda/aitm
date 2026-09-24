import * as Dialog from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import { useBrowserModalGuard } from "../lib/useBrowserModalGuard";

export interface ConfirmActionRequest {
  /** 确认文案；可含 `\n`，按原样换行显示。 */
  message: string;
  /** 确认按钮文字，如"结束会话"。 */
  confirmLabel: string;
  onConfirm: () => void;
}

interface Props {
  /** null = 不显示。 */
  open: ConfirmActionRequest | null;
  onClose: () => void;
}

/**
 * 破坏性操作的二次确认框。
 *
 * **不要用 `window.confirm` 代替它**：aitm 在 macOS 上跑在 WKWebView 里，wry 没有实现
 * WKUIDelegate 的 JavaScript 确认面板，`window.confirm` 不弹任何窗口、直接返回 false——
 * 于是"确认后才执行"的操作会被静默取消（1.6.0 的结束 tmux 会话就是这样坏的）。
 *
 * 取消按钮拿默认焦点：回车 / Esc 都不会误触发破坏性操作。
 */
export default function ConfirmActionDialog({ open, onClose }: Props) {
  const { t } = useTranslation();

  // 浏览器面板的原生 webview 盖在 DOM 之上，弹框时要让位
  useBrowserModalGuard(open !== null);

  return (
    <Dialog.Root
      open={open !== null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content
          data-testid="confirm-action-dialog"
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-50 w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-[var(--c-border-strong)] bg-[var(--c-bg-elev-1)] p-5 text-[var(--c-text-base)] shadow-2xl"
        >
          <Dialog.Title className="whitespace-pre-line text-sm text-[var(--c-text-base)]">
            {open?.message}
          </Dialog.Title>
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              data-testid="confirm-action-cancel"
              onClick={onClose}
              autoFocus
              className="rounded border border-[var(--c-border-strong)] px-3 py-1.5 text-sm text-[var(--c-text-base)] hover:bg-[var(--c-bg-elev-2)]"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              data-testid="confirm-action-ok"
              onClick={() => {
                const req = open;
                onClose();
                req?.onConfirm();
              }}
              className="rounded bg-[var(--c-error)] px-3 py-1.5 text-sm text-white hover:opacity-90"
            >
              {open?.confirmLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
