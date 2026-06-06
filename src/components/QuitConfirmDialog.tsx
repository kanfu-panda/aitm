import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { appQuitConfirmed, onAppConfirmQuitRequested } from "../lib/tauri";
import { useBrowserModalGuard } from "../lib/useBrowserModalGuard";

/**
 * v0.9.0 T4：关闭应用二次确认对话框。
 *
 * 触发链路：
 * 1. 用户点窗口红叉 / Cmd+Q → Tauri `WindowEvent::CloseRequested`
 * 2. 后端 `on_window_event` hook 判 `settings.ui.confirm_quit=true`
 *    → `api.prevent_close()` + emit `app:confirm-quit-requested`
 * 3. 本组件订阅事件 → `setOpen(true)` 弹 Radix Dialog
 * 4. 用户点"退出" → `appQuitConfirmed()` → 后端 `app.exit(0)`
 *    用户点"取消" / Esc / 点遮罩 → `setOpen(false)` 不退
 *
 * v0.10.0 HR9-6：删 v0.9.0 HR2-3 的"有编辑器 tab 时先关 tab"保险丝。
 * 维护者 真机反馈：红叉点一次先关文件预览，再点才关应用 —— 行为非常反直觉。
 * 红叉 / Cmd+Q 始终弹退出确认；关编辑器 tab 这个事走 Cmd+W 路径（useShortcuts.closeTab）。
 *
 * 复用项目既有 Radix Dialog 风格（参考 `ConfirmDialog.tsx` /
 * `CloseTabConfirmDialog.tsx`），token-based 样式 `var(--c-*)`。
 */
export default function QuitConfirmDialog() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let alive = true;
    onAppConfirmQuitRequested(() => {
      if (!alive) return;
      setOpen(true);
    })
      .then((u) => {
        if (alive) unlisten = u;
        else u();
      })
      .catch(() => {
        // 监听注册失败：fail-soft，dialog 不会弹（用户实际遇不到，因为
        // 后端 hook 仍会 prevent_close，但用户看不到 dialog 会以为关不上 —
        // 真机出现时降级到"开发模式 console.warn"）。
      });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  // 让浏览器 webview 在 modal 弹起时让位（v0.4.1 真机 smoke：WKWebView native overlay 盖住 React DOM）
  useBrowserModalGuard(open);

  const onConfirm = async () => {
    // 先关 dialog 避免下一次事件再触发同一个 open；然后调后端真退出。
    setOpen(false);
    await appQuitConfirmed();
  };

  const onCancel = () => {
    setOpen(false);
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/60 backdrop-blur-sm" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-[70] w-[420px] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-[var(--c-border-strong)] bg-[var(--c-bg-elev-1)] p-5 text-[var(--c-text-base)] shadow-2xl focus:outline-none"
          aria-label={t("quitDialog.title")}
        >
          <Dialog.Title className="text-base font-medium text-[var(--c-text-base)]">
            {t("quitDialog.title")}
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-[var(--c-text-muted)]">
            {t("quitDialog.description")}
          </Dialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              autoFocus
              className="rounded border border-[var(--c-border-strong)] px-3 py-1.5 text-sm text-[var(--c-text-base)] hover:bg-[var(--c-bg-elev-2)]"
              data-testid="quit-btn-cancel"
            >
              {t("quitDialog.cancel")}
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className="rounded bg-[var(--c-error)] px-3 py-1.5 text-sm text-white hover:opacity-90"
              data-testid="quit-btn-confirm"
            >
              {t("quitDialog.confirm")}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
