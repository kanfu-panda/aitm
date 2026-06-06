import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useBrowserModalGuard } from "../lib/useBrowserModalGuard";

interface Props {
  /** 受控开关。null = 关闭；非空对象 = 打开（含初始值 + 标题）。 */
  open: {
    title: string;
    label?: string;
    initialValue?: string;
    /** 占位符显示在 input 内（不填或空字符串时）。 */
    placeholder?: string;
    /** 校验函数：返非空字符串时显示错误 + 禁用 OK；返 null = ok。 */
    validate?: (value: string) => string | null;
    /** 用户点 OK 时传入最终值；resolve true 关 dialog，throw 时显示错误。 */
    onSubmit: (value: string) => Promise<void> | void;
    /** OK 按钮文字；默认"确认"。 */
    okLabel?: string;
  } | null;
  /** 用户取消 / 关闭 → 调此 setter 把 open 切 null。 */
  onClose: () => void;
}

/**
 * v0.10.2 #6：通用输入对话框。
 *
 * 用于 FileTree 右键菜单的"新建文件 / 新建文件夹 / 重命名" —— 三者
 * 都需要让用户输入一个字符串，UI 形态一致。
 *
 * 风格沿用 ConfirmDialog / CloseFileConfirmDialog / QuitConfirmDialog
 * 的 Radix Dialog + var(--c-*) token 配色。
 */
export default function InputDialog({ open, onClose }: Props) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // open 变化（打开新对话）时重置 input 到 initialValue
  useEffect(() => {
    if (open) {
      setValue(open.initialValue ?? "");
      setError(null);
      setSubmitting(false);
      // 等 dialog DOM 出现再 focus（Radix 内部 portal mount 异步）
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        // 文件名 .ext 时默认选 basename 不含扩展名，方便直接改名
        const input = inputRef.current;
        if (input && open.initialValue) {
          const dotIdx = open.initialValue.lastIndexOf(".");
          if (dotIdx > 0) {
            input.setSelectionRange(0, dotIdx);
          } else {
            input.select();
          }
        }
      });
    }
  }, [open]);

  useBrowserModalGuard(open !== null);

  if (!open) return null;

  const validationError = open.validate?.(value) ?? null;
  const canSubmit = !submitting && value.trim().length > 0 && !validationError;

  const handleSubmit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await open.onSubmit(value);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  return (
    <Dialog.Root open={true} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm"
          data-testid="input-dialog-overlay"
        />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-[101] w-[420px] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-[var(--c-border-strong)] bg-[var(--c-bg-elev-1)] p-5 shadow-2xl"
          data-testid="input-dialog"
        >
          <form onSubmit={handleSubmit}>
            <Dialog.Title className="mb-3 text-base font-semibold text-[var(--c-text-base)]">
              {open.title}
            </Dialog.Title>
            {open.label && (
              <Dialog.Description className="mb-2 text-sm text-[var(--c-text-muted)]">
                {open.label}
              </Dialog.Description>
            )}
            <input
              ref={inputRef}
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={open.placeholder}
              data-testid="input-dialog-input"
              className="w-full rounded border border-[var(--c-border-strong)] bg-[var(--c-bg-base)] px-3 py-2 text-sm text-[var(--c-text-base)] outline-none focus:border-[var(--c-success)]"
              autoComplete="off"
              spellCheck={false}
            />
            {(validationError || error) && (
              <div
                className="mt-2 text-xs text-[var(--c-error)]"
                data-testid="input-dialog-error"
                role="alert"
              >
                {error ?? validationError}
              </div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                data-testid="input-dialog-cancel"
                className="rounded border border-[var(--c-border-strong)] bg-[var(--c-bg-elev-2)] px-3 py-1.5 text-xs text-[var(--c-text-base)] hover:bg-[var(--c-bg-elev-3)] disabled:opacity-50"
              >
                {t("common.cancel")}
              </button>
              <button
                type="submit"
                disabled={!canSubmit}
                data-testid="input-dialog-ok"
                className="rounded bg-[var(--c-success)] px-3 py-1.5 text-xs text-[var(--c-bg-base)] font-medium hover:opacity-90 disabled:opacity-50"
              >
                {open.okLabel ?? t("common.confirm")}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
