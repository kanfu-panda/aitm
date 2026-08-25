import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { buildCommandList, filterCommands, moveSelection } from "../lib/commands";
import { mergeKeybindings, type ActionName } from "../lib/shortcuts";
import { useSettingsStore } from "../stores/settings";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 与 `useShortcuts` 用的是**同一个** handlers 对象，避免两套执行逻辑漂移。 */
  handlers: Partial<Record<ActionName, () => void>>;
}

/**
 * 命令面板（`Cmd+K`）。
 *
 * 只做**命令**：把快捷键注册表里的 action 变成可搜索、可执行的列表，并把当前
 * 生效的快捷键显示在右侧——顺带当快捷键的学习入口，用户不必去翻设置面板。
 *
 * 三点设计取舍：
 *
 * 1. **命令列表从 action 注册表派生**，不另维护一份。新增 action 自动出现在面板里，
 *    不会有"加了功能忘了加进面板"的漂移。
 * 2. **执行走 App 传进来的同一份 handlers**，跟按快捷键完全等价——不存在"面板里点
 *    和按快捷键行为不一致"的可能。
 * 3. **不做模糊打分排序**。命令只有十几条，子串 + 首字母够用；打分会让顺序随查询
 *    漂移，反而破坏肌肉记忆。
 */
export default function CommandPalette({ open, onOpenChange, handlers }: Props) {
  const { t } = useTranslation();
  const overrides = useSettingsStore((s) => s.settings.ui.keybindings);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const commands = useMemo(
    () => buildCommandList(mergeKeybindings(overrides), t),
    [overrides, t],
  );
  const visible = useMemo(() => filterCommands(commands, query), [commands, query]);

  // 每次打开都从干净状态开始：留着上次的查询串会让人以为面板"卡住了"
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelected(0);
    }
  }, [open]);

  // 查询变化后选中项可能越界（列表变短了）
  useEffect(() => {
    setSelected((s) => (s >= visible.length ? 0 : s));
  }, [visible.length]);

  // 键盘移动时把选中项滚进可视区，否则长列表下方的项选中了也看不见
  useEffect(() => {
    // 可选链到方法本身：jsdom 里没有 scrollIntoView，真实环境才有
    listRef.current
      ?.querySelector(`[data-index="${selected}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);

  const run = (action: ActionName) => {
    onOpenChange(false);
    // 先关面板再执行：有些命令（如打开设置）会弹自己的 UI，两层叠着很难看。
    // 放到下一帧执行，让 Radix 的关闭动画和焦点归还先跑完。
    requestAnimationFrame(() => handlers[action]?.());
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          className="fixed left-1/2 top-[15%] z-50 flex w-[560px] max-w-[90vw] -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-[var(--c-border-strong)] bg-[var(--c-bg-elev-1)] shadow-2xl"
          aria-label={t("commandPalette.dialogAria")}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSelected((s) => moveSelection(visible.length, s, 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSelected((s) => moveSelection(visible.length, s, -1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const cmd = visible[selected];
              if (cmd) run(cmd.action);
            }
          }}
        >
          <Dialog.Title className="sr-only">
            {t("commandPalette.dialogAria")}
          </Dialog.Title>
          <Dialog.Description className="sr-only">
            {t("commandPalette.placeholder")}
          </Dialog.Description>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("commandPalette.placeholder")}
            aria-label={t("commandPalette.placeholder")}
            data-testid="command-palette-input"
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            className="border-b border-[var(--c-border)] bg-transparent px-4 py-3 text-sm text-[var(--c-text-base)] placeholder:text-[var(--c-text-faint)] focus:outline-none"
          />
          <div
            ref={listRef}
            className="max-h-[320px] overflow-y-auto py-1"
            data-testid="command-palette-list"
          >
            {visible.length === 0 && (
              <p
                className="px-4 py-6 text-center text-xs text-[var(--c-text-dim)]"
                data-testid="command-palette-empty"
              >
                {t("commandPalette.empty")}
              </p>
            )}
            {visible.map((cmd, i) => (
              <button
                key={cmd.action}
                type="button"
                data-index={i}
                data-testid={`command-item-${cmd.action}`}
                aria-selected={i === selected}
                onMouseEnter={() => setSelected(i)}
                onClick={() => run(cmd.action)}
                className={[
                  "flex w-full items-center justify-between px-4 py-2 text-left text-[13px]",
                  i === selected
                    ? "bg-[var(--c-bg-elev-2)] text-[var(--c-text-base)]"
                    : "text-[var(--c-text-muted)]",
                ].join(" ")}
              >
                <span>{cmd.title}</span>
                {cmd.shortcut && (
                  <kbd className="ml-4 shrink-0 rounded border border-[var(--c-border)] px-1.5 py-0.5 text-[11px] text-[var(--c-text-dim)]">
                    {cmd.shortcut}
                  </kbd>
                )}
              </button>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
