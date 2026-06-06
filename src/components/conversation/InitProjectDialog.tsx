import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import {
  aiChatResume,
  markIgnored,
  projectInit,
  type AiInitRequiredEvent,
  type ScopeDto,
} from "../../lib/tauri";
import { useChatStore } from "../../stores/chat";
import { useSidebarStore } from "../../stores/sidebar";
import { useBrowserModalGuard } from "../../lib/useBrowserModalGuard";

/**
 * cwd 解析为 NeedsInit 时弹的"是否初始化为 aitm 项目"对话框。
 *
 * 文案严格按 spec §7.4(1)：
 *   "✨ 在这里开始一个 AI 项目？"
 *   3 个 radio 选项：
 *     - 是，初始化为项目（推荐）
 *     - 不用，这次临时用一下
 *     - 别再问我这个目录
 *   底部"确定"按钮提交选中项；右侧"关闭 AI 侧边栏"是逃生口。
 *
 * 行为：
 *   - "初始化为项目" → projectInit(cwd, name) → loadFromScope(project) → aiChatResume
 *   - "临时用一下"   → loadFromScope(global) → aiChatResume(global)
 *   - "别再问"       → markIgnored(cwd) → loadFromScope(global) → aiChatResume(global)
 *
 * 关闭 / Escape：等价于"临时用一下"——保证后端暂停的 chat 不卡死。
 *
 * busy 期间禁用所有按钮和输入框，避免重复点击。
 *
 * 注意：loadFromScope 必须在 aiChatResume 之前；store 切到新 scope 后再
 * 让后端流式 chunk 进来，前端 conversationId 才能匹配上。
 */
export type Choice = "init" | "temp_global" | "ignore";

interface Props {
  payload: AiInitRequiredEvent | null;
  onResolved: () => void;
}

export default function InitProjectDialog({ payload, onResolved }: Props) {
  const [choice, setChoice] = useState<Choice>("init");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const toggleSidebar = useSidebarStore((s) => s.toggle);

  // payload 变化时（新一次 NeedsInit）重置默认选项 + 名字
  useEffect(() => {
    if (payload) {
      setChoice("init");
      setName(payload.default_name);
      setBusy(false);
    }
  }, [payload]);

  // 让浏览器 webview 在 modal 弹起时让位（v0.4.1 真机 smoke：WKWebView native overlay 盖住 React DOM）
  useBrowserModalGuard(!!payload);

  if (!payload) return null;

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await applyChoice(choice, payload, name);
    } catch (e) {
      console.warn("InitProjectDialog 决议失败", e);
    } finally {
      setBusy(false);
      onResolved();
    }
  };

  // Escape / 点遮罩 = 临时全局（避免 chat 卡死）
  const handleOpenChange = (open: boolean) => {
    if (open || busy) return;
    setBusy(true);
    (async () => {
      try {
        await applyChoice("temp_global", payload, name);
      } catch (e) {
        console.warn("InitProjectDialog 隐式临时全局失败", e);
      } finally {
        setBusy(false);
        onResolved();
      }
    })();
  };

  const handleCloseSidebar = () => {
    // 先按"临时全局"语义恢复后端 chat（不然 pending_chats 残留），再收侧栏
    handleOpenChange(false);
    toggleSidebar();
  };

  return (
    <Dialog.Root open={!!payload} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[60] w-[520px] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-[var(--c-border-strong)] bg-[var(--c-bg-elev-1)] p-5 text-[var(--c-text-base)] shadow-2xl focus:outline-none">
          <Dialog.Title className="mb-2 text-base font-medium text-[var(--c-text-base)]">
            ✨ 在这里开始一个 AI 项目？
          </Dialog.Title>

          <Dialog.Description className="mb-4 text-xs leading-relaxed text-[var(--c-text-muted)]">
            你正在使用 AI 助手，但当前目录还不是 aitm 项目。要不要让 AI 长期记住这里？
          </Dialog.Description>

          <div className="mb-4 space-y-2">
            <label
              htmlFor="init-project-name"
              className="block text-[11px] text-[var(--c-text-dim)]"
            >
              项目名
            </label>
            <input
              id="init-project-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy || choice !== "init"}
              aria-label="项目名"
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded border border-[var(--c-border-strong)] bg-[var(--c-bg-base)] px-2 py-1 text-sm text-[var(--c-text-base)] focus:border-[var(--c-border-strong)] focus:outline-none disabled:opacity-50"
            />
            <div className="text-[11px] text-[var(--c-text-dim)]">
              路径：
              <code className="ml-1 break-all rounded bg-[var(--c-bg-elev-2)] px-1 py-0.5 text-[10px] text-[var(--c-text-muted)]">
                {payload.cwd}
              </code>
            </div>
          </div>

          <div className="mb-4 space-y-2 border-t border-[var(--c-border)] pt-3">
            <ChoiceRow
              value="init"
              current={choice}
              onChange={setChoice}
              disabled={busy}
              title="是，初始化为项目（推荐）"
              desc="在 ./.aitm/ 创建标记，AI 记住对话和命令上下文。适合：长期工作目录、git 仓库。"
            />
            <ChoiceRow
              value="temp_global"
              current={choice}
              onChange={setChoice}
              disabled={busy}
              title="不用，这次临时用一下"
              desc="对话存到全局桶；下次再来此目录会再问一次。"
            />
            <ChoiceRow
              value="ignore"
              current={choice}
              onChange={setChoice}
              disabled={busy}
              title="别再问我这个目录"
              desc="永久加入忽略名单，纯终端模式。"
            />
          </div>

          <div className="flex justify-end gap-2 border-t border-[var(--c-border)] pt-3">
            <button
              type="button"
              onClick={handleCloseSidebar}
              disabled={busy}
              className="rounded border border-[var(--c-border-strong)] px-3 py-1 text-sm text-[var(--c-text-muted)] hover:bg-[var(--c-bg-elev-2)] disabled:opacity-50"
              aria-label="关闭 AI 侧边栏"
            >
              关闭 AI 侧边栏
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={busy || (choice === "init" && name.trim() === "")}
              className="rounded bg-[var(--c-success)] px-3 py-1 text-sm text-white hover:opacity-90 disabled:cursor-not-allowed disabled:bg-[var(--c-bg-elev-3)] disabled:text-[var(--c-text-dim)]"
              aria-label="确定"
            >
              {busy ? "处理中…" : "确定"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ChoiceRow({
  value,
  current,
  onChange,
  disabled,
  title,
  desc,
}: {
  value: Choice;
  current: Choice;
  onChange: (v: Choice) => void;
  disabled: boolean;
  title: string;
  desc: string;
}) {
  const active = current === value;
  return (
    <label
      className={
        "flex cursor-pointer items-start gap-2 rounded border px-2 py-2 text-xs transition-colors " +
        (active
          ? "border-[var(--c-success)] bg-[var(--c-success-bg)]"
          : "border-[var(--c-border)] hover:border-[var(--c-border-strong)] hover:bg-[var(--c-bg-base)]") +
        (disabled ? " cursor-not-allowed opacity-50" : "")
      }
    >
      <input
        type="radio"
        name="init-project-choice"
        value={value}
        checked={active}
        disabled={disabled}
        onChange={() => onChange(value)}
        className="mt-0.5 accent-[var(--c-success)]"
        aria-label={title}
      />
      <div className="flex-1">
        <div className={active ? "text-[var(--c-text-base)]" : "text-[var(--c-text-base)]"}>{title}</div>
        <div className="mt-0.5 text-[11px] leading-relaxed text-[var(--c-text-dim)]">
          {desc}
        </div>
      </div>
    </label>
  );
}

/**
 * 把 choice 翻译成实际 IPC 调用序列。抽出来方便单测：
 * 让测试可以单独验证"init → projectInit + loadFromScope + aiChatResume 顺序"
 * 而不必跨 Radix Dialog portal。
 *
 * 顺序约束：
 *   loadFromScope 必须在 aiChatResume 之前 — 后者会触发后端流式 chunk，
 *   前端 chat store 必须已切到新 scope，conversationId 才能 match。
 */
export async function applyChoice(
  choice: Choice,
  payload: AiInitRequiredEvent,
  name: string,
): Promise<void> {
  if (choice === "init") {
    const r = await projectInit(payload.cwd, name.trim() || payload.default_name);
    const scope: ScopeDto = {
      kind: "project",
      uuid: r.uuid,
      root_path: r.root_path,
    };
    await useChatStore.getState().loadFromScope(scope);
    await aiChatResume(payload.conversation_id, scope);
    return;
  }

  if (choice === "ignore") {
    try {
      await markIgnored(payload.cwd);
    } catch (e) {
      console.warn("mark_ignored 失败，仍按临时全局走", e);
    }
  }

  const scope: ScopeDto = { kind: "global" };
  await useChatStore.getState().loadFromScope(scope);
  await aiChatResume(payload.conversation_id, scope);
}
