import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type ActionName,
  DEFAULT_KEYBINDINGS,
  findConflicts,
  formatKeybinding,
  mergeKeybindings,
  parseKeybinding,
} from "../../lib/shortcuts";
import { useSettingsStore } from "../../stores/settings";

/**
 * v0.10.0 HR7-7：设置面板"快捷键"tab。
 *
 * UI 表格列：
 * | Action 中文名 | 当前 Binding | [修改] [恢复默认] |
 *
 * - 修改 → 弹 [`KeybindingCaptureDialog`]：监听 `keydown` 实时显示按键组合；
 *   "确认"调用 [`useSettingsStore.update`] 写 `settings.ui.keybindings`，自动持久化。
 * - 恢复默认 → 单 binding 删除该 action 的覆盖项，回到 [`DEFAULT_KEYBINDINGS`]。
 * - 冲突检测：渲染时跑 [`findConflicts`]，冲突的 action 行用 rose 边框 + 警告文案。
 */

export default function KeybindingsSection() {
  const { t } = useTranslation();
  const overrides = useSettingsStore((s) => s.settings.ui.keybindings);
  const update = useSettingsStore((s) => s.update);

  /** 给定 action 名 → 当前语言下的显示标签。 */
  const actionLabel = (a: ActionName): string => t(`keybindings.actions.${a}`);

  // 当前生效 binding（默认 + 覆盖合并）
  const effective = useMemo(() => mergeKeybindings(overrides), [overrides]);

  // 冲突分组（每组 ≥2 action 同 binding）
  const conflictGroups = useMemo(() => findConflicts(effective), [effective]);
  /** action → 冲突 group index 反查表（用于行级 UI 提示）。 */
  const conflictMap = useMemo(() => {
    const m = new Map<ActionName, number>();
    conflictGroups.forEach((group, idx) => {
      for (const a of group) m.set(a, idx);
    });
    return m;
  }, [conflictGroups]);

  // 当前正在修改的 action（null = 无）
  const [editingAction, setEditingAction] = useState<ActionName | null>(null);

  const handleSet = (action: ActionName, newBinding: string) => {
    // 覆盖：写入 keybindings；后续 useSettingsStore.update 会 debounce 落 toml。
    const nextOverrides = { ...overrides, [action]: newBinding };
    update({ ui: { keybindings: nextOverrides } });
  };

  const handleResetOne = (action: ActionName) => {
    // 删除该 action 的覆盖项（回到 DEFAULT_KEYBINDINGS）。
    const { [action]: _removed, ...rest } = overrides;
    void _removed;
    update({ ui: { keybindings: rest } });
  };

  const handleResetAll = () => {
    update({ ui: { keybindings: {} } });
  };

  // 用 DEFAULT_KEYBINDINGS 的 keys 保持权威列表（与 ACTION_NAMES 数量必须一致）。
  const actionList = Object.keys(DEFAULT_KEYBINDINGS) as ActionName[];

  return (
    <div className="space-y-4">
      <section>
        <div className="mb-3 flex items-baseline justify-between">
          <h3 className="text-sm font-medium text-[var(--c-text-muted)]">
            {t("keybindings.title")}
          </h3>
          <button
            type="button"
            onClick={handleResetAll}
            className="text-[10px] text-[var(--c-text-dim)] underline hover:text-[var(--c-text-muted)]"
            data-testid="keybindings-reset-all"
          >
            {t("keybindings.resetAll")}
          </button>
        </div>

        <p className="mb-3 text-[11px] text-[var(--c-text-dim)]">
          {t("keybindings.intro")}
        </p>

        <div className="overflow-hidden rounded border border-[var(--c-border)]">
          <table className="w-full text-xs">
            <thead className="bg-[var(--c-bg-base)] text-[var(--c-text-muted)]">
              <tr>
                <th className="px-3 py-2 text-left font-medium">{t("keybindings.columnAction")}</th>
                <th className="px-3 py-2 text-left font-medium">{t("keybindings.columnBinding")}</th>
                <th className="px-3 py-2 text-right font-medium">{t("keybindings.columnOps")}</th>
              </tr>
            </thead>
            <tbody>
              {actionList.map((action) => {
                const binding = effective[action];
                const isOverridden = overrides[action] !== undefined;
                const conflictIdx = conflictMap.get(action);
                const hasConflict = conflictIdx !== undefined;
                return (
                  <tr
                    key={action}
                    className={
                      "border-t border-[var(--c-border)] " +
                      (hasConflict ? "bg-[var(--c-danger)]/10" : "")
                    }
                    data-testid={`keybinding-row-${action}`}
                    data-conflict={hasConflict ? "true" : "false"}
                  >
                    <td className="px-3 py-2 text-[var(--c-text-base)]">
                      {actionLabel(action)}
                      {isOverridden && (
                        <span
                          className="ml-1 text-[9px] text-[var(--c-text-dim)]"
                          title={t("keybindings.overriddenBadgeTitle")}
                        >
                          {t("keybindings.overriddenBadge")}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono text-[var(--c-text-muted)]">
                      {binding}
                      {hasConflict && (
                        <span className="ml-2 text-[10px] text-[var(--c-danger)]">
                          {t("keybindings.conflictBadge")}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => setEditingAction(action)}
                        className="rounded border border-[var(--c-border-strong)] bg-[var(--c-bg-base)] px-2 py-0.5 text-[10px] text-[var(--c-text-muted)] hover:bg-[var(--c-bg-elev-2)] hover:text-[var(--c-text-base)]"
                        data-testid={`keybinding-edit-${action}`}
                      >
                        {t("keybindings.edit")}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleResetOne(action)}
                        disabled={!isOverridden}
                        className="ml-1 rounded border border-[var(--c-border-strong)] bg-[var(--c-bg-base)] px-2 py-0.5 text-[10px] text-[var(--c-text-muted)] hover:bg-[var(--c-bg-elev-2)] hover:text-[var(--c-text-base)] disabled:cursor-not-allowed disabled:opacity-30"
                        data-testid={`keybinding-reset-${action}`}
                      >
                        {t("keybindings.resetOne")}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {conflictGroups.length > 0 && (
          <p
            className="mt-2 text-[11px] text-[var(--c-danger)]"
            data-testid="keybindings-conflict-warning"
          >
            {t("keybindings.conflictWarning", { count: conflictGroups.length })}
          </p>
        )}
      </section>

      <KeybindingCaptureDialog
        open={editingAction !== null}
        currentBinding={editingAction ? effective[editingAction] : ""}
        actionLabel={editingAction ? actionLabel(editingAction) : ""}
        onSet={(newBinding) => {
          if (editingAction) handleSet(editingAction, newBinding);
          setEditingAction(null);
        }}
        onCancel={() => setEditingAction(null)}
      />
    </div>
  );
}

interface CaptureDialogProps {
  open: boolean;
  currentBinding: string;
  actionLabel: string;
  onSet: (newBinding: string) => void;
  onCancel: () => void;
}

/** v0.10.0 HR7-7：按键捕捉 dialog。
 *
 *  用户流程：
 *  1. 弹出 → 显示当前 binding，提示"按下新快捷键..."
 *  2. 用户按下 modifier+key → onKeyDown 实时更新预览字符串
 *  3. Esc 取消 / 点"取消"按钮取消 / 点"确认"提交
 *  4. 必须按下至少一个非修饰键才能"确认"
 */
function KeybindingCaptureDialog({
  open,
  currentBinding,
  actionLabel,
  onSet,
  onCancel,
}: CaptureDialogProps) {
  const { t } = useTranslation();
  // 捕获中的预览字符串；null = 还没按
  const [capture, setCapture] = useState<string | null>(null);

  // 每次打开 dialog 重置 capture 状态
  useEffect(() => {
    if (open) setCapture(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // Esc 直接取消
      if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        onCancel();
        return;
      }
      // 只 modifier 键按下时（如 Cmd 按住但还没按字母）忽略
      const modifierOnly = ["Meta", "Control", "Shift", "Alt"].includes(e.key);
      if (modifierOnly) return;

      e.preventDefault();
      e.stopPropagation();

      const key = e.key.length === 1 ? e.key : e.key; // 单字符 / 命名键
      const parsed = {
        meta: e.metaKey,
        ctrl: e.ctrlKey,
        shift: e.shiftKey,
        alt: e.altKey,
        key: key.toLowerCase(),
      };
      setCapture(formatKeybinding(parsed));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onCancel]);

  const canConfirm = capture !== null && parseKeybinding(capture) !== null;

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onCancel()}>
      <Dialog.Portal>
        {/* z-50 以盖住 SettingsModal（同 z-50，后开 portal 在后） */}
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-[60] w-[360px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-[var(--c-border)] bg-[var(--c-bg-elev-1)] p-5 text-[var(--c-text-base)] shadow-2xl focus:outline-none"
          data-testid="keybinding-capture-dialog"
        >
          <Dialog.Title className="mb-1 text-sm font-medium">
            {t("keybindings.captureTitle", { action: actionLabel })}
          </Dialog.Title>
          <Dialog.Description className="mb-4 text-[11px] text-[var(--c-text-dim)]">
            {t("keybindings.captureDescription")}
          </Dialog.Description>

          <div className="mb-3">
            <div className="mb-1 text-[10px] text-[var(--c-text-dim)]">
              {t("keybindings.captureCurrentLabel")}
            </div>
            <div className="rounded border border-[var(--c-border-strong)] bg-[var(--c-bg-base)] px-3 py-1.5 font-mono text-xs text-[var(--c-text-muted)]">
              {currentBinding || t("keybindings.captureCurrentEmpty")}
            </div>
          </div>

          <div className="mb-4">
            <div className="mb-1 text-[10px] text-[var(--c-text-dim)]">
              {t("keybindings.captureNewLabel")}
            </div>
            <div
              className="rounded border border-[var(--c-success)] bg-[var(--c-bg-base)] px-3 py-1.5 font-mono text-xs text-[var(--c-text-base)]"
              data-testid="keybinding-capture-preview"
            >
              {capture ?? t("keybindings.capturePlaceholder")}
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded border border-[var(--c-border-strong)] bg-[var(--c-bg-base)] px-3 py-1 text-xs text-[var(--c-text-muted)] hover:bg-[var(--c-bg-elev-2)]"
              data-testid="keybinding-capture-cancel"
            >
              {t("keybindings.captureCancel")}
            </button>
            <button
              type="button"
              onClick={() => capture && onSet(capture)}
              disabled={!canConfirm}
              className="rounded border border-[var(--c-success)] bg-[var(--c-success)] px-3 py-1 text-xs text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30"
              data-testid="keybinding-capture-confirm"
            >
              {t("keybindings.captureConfirm")}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
