import * as Dialog from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";

import type { SessionSnapshot } from "../lib/tauri";

interface Props {
  /** 后端 load 出来的 snapshot；null 时 Dialog 不显示 */
  snapshot: SessionSnapshot | null;
  /** 用户点"恢复上次会话"→ 按 snapshot 重建 tabs */
  onRestore: () => void;
  /** 用户点"全新启动"→ 清 snapshot + 走默认 */
  onFresh: () => void;
  /** 用户点"一次性跳过" / 关闭 dialog → 不动 snapshot 也不恢复（本次会话用默认） */
  onSkip: () => void;
}

/**
 * v0.5.0-D：启动时检测到 snapshot 弹此 Dialog 让用户选恢复方式。
 *
 * 三选项（plan §0.4）：
 * - 恢复上次会话：按 snapshot 逐个 addTab + spawn PTY 在记录的 cwd
 * - 全新启动：清 snapshot + 开 1 空 tab
 * - 一次性跳过：本次走默认（不恢复），保留 snapshot 让下次再决定
 *
 * 设计：non-modal 但 forceMount false，关闭就 onSkip。优先级高于其他 Dialog
 * （启动期独占一段 UX 流程）。
 */
export default function SessionRestoreDialog({
  snapshot,
  onRestore,
  onFresh,
  onSkip,
}: Props) {
  const { t } = useTranslation();
  const open = !!snapshot;
  const tabCount = snapshot?.tabs.length ?? 0;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) onSkip();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 flex w-[480px] max-w-[90vw] flex-col gap-4 rounded-lg border border-[var(--c-border-strong)] bg-[var(--c-bg-elev-1)] p-6 text-[var(--c-text-base)] shadow-2xl"
          aria-label={t("sessionRestore.dialogAria")}
        >
          <Dialog.Title className="text-base font-medium">
            {t("sessionRestore.title")}
          </Dialog.Title>
          <Dialog.Description className="text-sm text-[var(--c-text-muted)]">
            {t("sessionRestore.description", { count: tabCount })}
          </Dialog.Description>

          {snapshot && snapshot.tabs.length > 0 && (
            <div
              className="max-h-32 overflow-y-auto rounded border border-[var(--c-border)] bg-[var(--c-bg-base)] px-3 py-2 text-xs"
              data-testid="restore-tab-list"
            >
              {snapshot.tabs.map((tab) => (
                <div
                  key={tab.tab_id}
                  className="font-mono text-[var(--c-text-muted)]"
                >
                  <span className="text-[var(--c-text-base)]">{tab.title}</span>
                  {tab.cwd && (
                    <span className="ml-2 text-[var(--c-text-dim)]">
                      {tab.cwd}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-col gap-2 pt-2">
            <button
              onClick={onRestore}
              className="rounded border border-[var(--c-success)] bg-[var(--c-success-bg)] px-4 py-2 text-sm text-[var(--c-success-fg)] hover:opacity-90"
              data-testid="restore-btn-restore"
            >
              {t("sessionRestore.restoreBtn", { count: tabCount })}
            </button>
            <button
              onClick={onFresh}
              className="rounded border border-[var(--c-border-strong)] bg-[var(--c-bg-elev-2)] px-4 py-2 text-sm text-[var(--c-text-base)] hover:bg-[var(--c-bg-elev-3)]"
              data-testid="restore-btn-fresh"
            >
              {t("sessionRestore.freshBtn")}
            </button>
            <button
              onClick={onSkip}
              className="rounded px-4 py-2 text-xs text-[var(--c-text-dim)] hover:text-[var(--c-text-base)]"
              data-testid="restore-btn-skip"
            >
              {t("sessionRestore.skipBtn")}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
