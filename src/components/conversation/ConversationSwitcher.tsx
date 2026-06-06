import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useChatStore, type SingleConversation } from "../../stores/chat";
import ScopeBadge from "./ScopeBadge";

/**
 * 侧栏顶部的对话切换器。
 *
 * 设计参考调研结论（plan §0）：不死绑 tab，按任务粒度让用户手动管理对话。
 * 形态接近 Claude Code 的 `/clear` + `/resume`。
 *
 * 交互：
 * - 点 trigger 展开 dropdown 显示所有对话；当前 active 项 emerald 高亮
 * - trigger 标题前 + dropdown 头部显 ScopeBadge 标识当前作用域
 * - 每行：标题（28 字截断）+ 消息数 + × 删除（hover 显示）
 * - 底部 "+ 新对话" 项创建并切到
 * - 双击对话标题进入 inline 编辑；Enter 提交 / Escape 取消
 *
 * 注：1F 设计决议（plan §1.1 G6）：chat store 一次只 load 一个 scope，
 * 跨 scope 切对话留 Phase 2 做。所以 dropdown 不需要分组——仅需头部
 * 标明"当前在 X scope，下面是该 scope 下的 N 个对话"。
 */
export default function ConversationSwitcher() {
  const { t } = useTranslation();
  const conversations = useChatStore((s) => s.conversations);
  const activeId = useChatStore((s) => s.activeId);
  const scope = useChatStore((s) => s.scope);
  const switchConversation = useChatStore((s) => s.switchConversation);
  const createConversation = useChatStore((s) => s.createConversation);
  const deleteConversation = useChatStore((s) => s.deleteConversation);
  const renameConversation = useChatStore((s) => s.renameConversation);

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const active =
    conversations.find((c) => c.id === activeId) ?? conversations[0];

  // 1F：startup 时 store 暂为空（loadFromScope 还在跑），渲染占位避免 active.title 崩
  if (!active) {
    return (
      <button
        className="flex min-w-0 flex-1 items-center gap-1 rounded px-2 py-1 text-sm text-[var(--c-text-dim)]"
        aria-label={t("conversationSwitcher.switchAria")}
        title={t("conversationSwitcher.loadingTitle")}
        disabled
      >
        <span className="truncate">{t("conversationSwitcher.loadingPlaceholder")}</span>
      </button>
    );
  }

  const handleSwitch = (id: string) => {
    if (id !== activeId) switchConversation(id);
    setOpen(false);
  };

  const handleCreate = () => {
    createConversation();
    setOpen(false);
  };

  const handleDelete = (id: string) => {
    deleteConversation(id);
    // 删除后保持 dropdown 打开让用户接着操作（除非删了 active 切到别的）
  };

  const handleRenameSubmit = (id: string, title: string) => {
    if (title.trim()) renameConversation(id, title);
    setEditingId(null);
  };

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-2 py-1 text-sm text-[var(--c-text-base)] hover:bg-[var(--c-bg-elev-2)] focus:bg-[var(--c-bg-elev-2)] focus:outline-none"
          aria-label={t("conversationSwitcher.switchAria")}
          title={active.title}
        >
          <ScopeBadge scope={scope} compact maxNameChars={12} />
          <span className="truncate">{active.title}</span>
          <span className="text-xs text-[var(--c-text-dim)]" aria-hidden>
            ▾
          </span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="z-[55] w-72 rounded-md border border-[var(--c-border-strong)] bg-[var(--c-bg-elev-1)] p-1 text-sm text-[var(--c-text-base)] shadow-2xl"
          align="start"
          sideOffset={4}
        >
          <DropdownMenu.Label
            className="flex items-center gap-2 px-2 pt-1.5 pb-1 text-[11px] text-[var(--c-text-dim)]"
            aria-label={t("conversationSwitcher.currentScopeAria")}
          >
            <ScopeBadge scope={scope} maxNameChars={16} />
            <span className="ml-auto" aria-hidden>
              {t("conversationSwitcher.countSuffix", {
                count: conversations.length,
              })}
            </span>
          </DropdownMenu.Label>
          <DropdownMenu.Separator className="my-1 h-px bg-[var(--c-border)]" />
          {conversations.map((conv) => (
            <ConversationRow
              key={conv.id}
              conv={conv}
              isActive={conv.id === activeId}
              isEditing={editingId === conv.id}
              onSwitch={() => handleSwitch(conv.id)}
              onDelete={() => handleDelete(conv.id)}
              onStartEdit={() => setEditingId(conv.id)}
              onSubmitEdit={(title) => handleRenameSubmit(conv.id, title)}
              onCancelEdit={() => setEditingId(null)}
            />
          ))}

          <DropdownMenu.Separator className="my-1 h-px bg-[var(--c-border)]" />
          <DropdownMenu.Item
            onSelect={(e) => {
              e.preventDefault();
              handleCreate();
            }}
            className="cursor-pointer rounded px-2 py-1.5 text-[var(--c-success-fg)] outline-none data-[highlighted]:bg-[var(--c-bg-elev-2)]"
            aria-label={t("conversationSwitcher.newAria")}
          >
            {t("conversationSwitcher.newItem")}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

interface RowProps {
  conv: SingleConversation;
  isActive: boolean;
  isEditing: boolean;
  onSwitch: () => void;
  onDelete: () => void;
  onStartEdit: () => void;
  onSubmitEdit: (title: string) => void;
  onCancelEdit: () => void;
}

function ConversationRow({
  conv,
  isActive,
  isEditing,
  onSwitch,
  onDelete,
  onStartEdit,
  onSubmitEdit,
  onCancelEdit,
}: RowProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(conv.title);

  useEffect(() => {
    if (isEditing) {
      setDraft(conv.title);
      // 等 input 渲染完聚焦 + 全选
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [isEditing, conv.title]);

  const msgCount = conv.messages.length;

  // 编辑态：用普通 div 不走 DropdownMenu.Item（避免 Radix 抢键盘事件）
  // input 上 stopPropagation 防止 Esc/Enter 冒泡触发 Radix dropdown 关闭。
  if (isEditing) {
    return (
      <div
        className={
          "flex items-center gap-2 rounded px-2 py-1.5 " +
          (isActive ? "bg-[var(--c-bg-elev-2)]" : "")
        }
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {isActive && (
          <span
            className="h-4 w-0.5 rounded bg-[var(--c-success)]"
            aria-hidden
          />
        )}
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // 防 Radix DropdownMenu 拦 Esc 关 dropdown / Enter 触发 highlighted item
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              onSubmitEdit(draft);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancelEdit();
            }
          }}
          onBlur={() => onSubmitEdit(draft)}
          aria-label={t("conversationSwitcher.titleEditAria")}
          className="flex-1 rounded border border-[var(--c-border-strong)] bg-[var(--c-bg-base)] px-1.5 py-0.5 text-sm text-[var(--c-text-base)] focus:border-[var(--c-text-muted)] focus:outline-none"
        />
      </div>
    );
  }

  return (
    <DropdownMenu.Item
      onSelect={(e) => {
        e.preventDefault();
        onSwitch();
      }}
      className={
        "group flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 outline-none data-[highlighted]:bg-[var(--c-bg-elev-2)] " +
        (isActive ? "bg-[var(--c-bg-elev-2)]" : "")
      }
      aria-label={t("conversationSwitcher.switchToAria", { title: conv.title })}
    >
      <span
        className={
          "h-4 w-0.5 rounded " + (isActive ? "bg-[var(--c-success)]" : "bg-transparent")
        }
        aria-hidden
      />
      <span
        className="min-w-0 flex-1 truncate text-left text-[var(--c-text-base)]"
        title={conv.title}
      >
        {conv.title}
      </span>
      {msgCount > 0 && (
        <span className="text-[10px] text-[var(--c-text-dim)]" aria-hidden>
          {msgCount}
        </span>
      )}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onStartEdit();
        }}
        aria-label={t("conversationSwitcher.renameToAria", { title: conv.title })}
        className="rounded px-1.5 py-0.5 text-xs text-[var(--c-text-dim)] hover:bg-[var(--c-bg-elev-3)] hover:text-[var(--c-success-fg)]"
        title={t("conversationSwitcher.renameTitle")}
      >
        ✎
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        aria-label={t("conversationSwitcher.deleteToAria", { title: conv.title })}
        className="rounded px-1.5 py-0.5 text-xs text-[var(--c-text-dim)] hover:bg-[var(--c-bg-elev-3)] hover:text-[var(--c-error)]"
      >
        ×
      </button>
    </DropdownMenu.Item>
  );
}
