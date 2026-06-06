import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  aiChatSend,
  listProviders,
  onAiDone,
  onAiError,
  onAiInitRequired,
  onAiToken,
  onAiToolFinished,
  onAiToolRequest,
  onAiToolStarted,
  onProvidersChanged,
  scopeResolve,
  sessionCurrentCwd,
  type AiInitRequiredEvent,
  type AiMessage,
  type ProviderEntry,
  type ProviderModel,
  type ScopeDto,
} from "../lib/tauri";
import MessageBubble from "./MessageBubble";
import ToolCallBubble from "./ToolCallBubble";
import ConfirmDialog from "./ConfirmDialog";
import ConversationSwitcher from "./conversation/ConversationSwitcher";
import InitProjectDialog from "./conversation/InitProjectDialog";
import { Sparkles } from "./icons";
import { trackEvent } from "../lib/analytics";
import { collectRuntimeContext } from "../lib/aiContext";
import { useChatStore } from "../stores/chat";
import { useSidebarStore } from "../stores/sidebar";
import { useTabsStore } from "../stores/tabs";

export default function AiSidebar() {
  const open = useSidebarStore((s) => s.open);
  const toggle = useSidebarStore((s) => s.toggle);

  // v0.4.1 T2：原侧栏关闭时显示的 ✦ toggle 已迁移到 ActivityBar；
  // 关闭态 AiSidebar 不再渲染任何 DOM 节点，由 ActivityBar 的 Sparkles 按钮触发开启。
  if (!open) {
    return null;
  }

  // v0.6.0-A T3：宽度由外层 wrapper 控制（读 settings.ui.ai_sidebar_width），
  // 这里只占满 wrapper；border 由 wrapper 提供（让 SplitDivider 锚定边沿）。
  return (
    <aside className="flex h-full w-full min-w-0 flex-shrink-0 flex-col overflow-hidden bg-[var(--c-bg-elev-1)] text-[var(--c-text-base)]">
      <SidebarHeader onCollapse={toggle} />
      <SidebarBody />
    </aside>
  );
}

function SidebarHeader({ onCollapse }: { onCollapse: () => void }) {
  const { t } = useTranslation();
  return (
    <header className="flex items-center gap-1 border-b border-[var(--c-border)] px-2 py-2">
      <ConversationSwitcher />
      <button
        onClick={onCollapse}
        className="rounded p-1 text-[var(--c-text-dim)] hover:bg-[var(--c-bg-elev-2)] hover:text-[var(--c-text-base)]"
        aria-label={t("aiSidebar.collapseAria")}
        title={t("aiSidebar.collapseTitle")}
      >
        ›
      </button>
    </header>
  );
}

function SidebarBody() {
  const { t } = useTranslation();
  const [providers, setProviders] = useState<ProviderEntry[]>([]);
  const [loading, setLoading] = useState(true);

  // model 现在 per-conversation 存 store —— 切对话时自动跟随
  const activeId = useChatStore((s) => s.activeId);
  const providerId = useChatStore((s) => {
    const active = s.conversations.find((c) => c.id === s.activeId);
    return active?.providerId ?? "";
  });
  const modelId = useChatStore((s) => {
    const active = s.conversations.find((c) => c.id === s.activeId);
    return active?.modelId ?? "";
  });
  const setActiveModel = useChatStore((s) => s.setActiveModel);

  useEffect(() => {
    let alive = true;
    listProviders()
      .then((ps) => {
        if (!alive) return;
        setProviders(ps);
      })
      .catch((e) => console.warn("list_providers 失败", e))
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // AutoFill：providers 加载好且 active conv 缺 provider/model 时反应式回填。
  // 1F：T9 后 chat store 启动空，loadFromScope（异步建空 conv）和 listProviders
  // 完成顺序不定。把 autofill 放反应式 effect 能覆盖任意先后顺序 + 用户切对话。
  useEffect(() => {
    if (loading || providers.length === 0 || !activeId) return;
    if (!providerId) {
      // 缺 provider — 用 ps[0] + 它的 models[0]
      if (providers[0].models.length > 0) {
        setActiveModel(providers[0].id, providers[0].models[0].id);
      }
      return;
    }
    if (!modelId) {
      // 有 provider 但缺 model — 用对应 provider 的 models[0]
      const p = providers.find((x) => x.id === providerId);
      if (p && p.models.length > 0) {
        setActiveModel(providerId, p.models[0].id);
      }
    }
  }, [providers, providerId, modelId, activeId, loading, setActiveModel]);

  // 监听 providers:changed，settings 改后自动刷新列表
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let alive = true;
    onProvidersChanged(async () => {
      if (!alive) return;
      try {
        const ps = await listProviders();
        if (!alive) return;
        setProviders(ps);
        const exists = ps.find((p) => p.id === providerId);
        if (!exists) {
          if (ps.length > 0 && ps[0].models.length > 0) {
            setActiveModel(ps[0].id, ps[0].models[0].id);
          } else {
            setActiveModel("", "");
          }
        }
      } catch (e) {
        console.warn("providers:changed 后刷新失败", e);
      }
    }).then((u) => {
      if (alive) unlisten = u;
      else u();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [providerId, setActiveModel]);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-[var(--c-text-dim)]">
        {t("aiSidebar.loading")}
      </div>
    );
  }

  if (providers.length === 0) {
    return <EmptyProvidersState />;
  }

  return (
    // min-h-0 关键：在嵌套 flex-col 中允许子项 flex-1 + overflow 实际收缩；
    // 没它的话 ChatBody 的 messages 列表会撑开整个容器，把底部 footer
    // 挤出可视区域，导致输入框消失。
    <div className="flex min-h-0 flex-1 flex-col">
      <ProviderModelPicker
        providers={providers}
        providerId={providerId}
        modelId={modelId}
        onProviderChange={(pid) => {
          const p = providers.find((x) => x.id === pid);
          const newModelId = p && p.models.length > 0 ? p.models[0].id : "";
          setActiveModel(pid, newModelId);
        }}
        onModelChange={(mid) => setActiveModel(providerId, mid)}
      />
      <ChatBody providerId={providerId} modelId={modelId} />
    </div>
  );
}

function EmptyProvidersState() {
  const { t } = useTranslation();
  // 示例 env 段：跨语言保持英文 key + 顶部一行注释由 i18n 控制
  const envExample = `ANTHROPIC_API_KEY=sk-ant-...
DEEPSEEK_API_KEY=sk-...
QWEN_API_KEY=sk-...

${t("aiSidebar.envExampleComment")}
# QWEN_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1`;
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-sm text-[var(--c-text-muted)]">
      <Sparkles
        size={48}
        className="text-[var(--c-text-faint)]"
        aria-label={t("aiSidebar.emptyAria")}
      />
      <div className="font-medium text-[var(--c-text-base)]">
        {t("aiSidebar.emptyTitle")}
      </div>
      <p className="text-xs leading-relaxed text-[var(--c-text-dim)]">
        {t("aiSidebar.emptyDescPrefix")}{" "}
        <code className="rounded bg-[var(--c-bg-elev-2)] px-1 py-0.5 text-[11px]">
          ~/.aitm/.env
        </code>{" "}
        {t("aiSidebar.emptyDescSuffix")}
      </p>
      <pre className="mt-1 self-stretch rounded bg-[var(--c-bg-base)] p-2 text-left text-[10px] text-[var(--c-text-muted)]">
        {envExample}
      </pre>
      <p className="text-[10px] text-[var(--c-text-faint)]">
        {t("aiSidebar.emptyHint")}
      </p>
    </div>
  );
}

interface PickerProps {
  providers: ProviderEntry[];
  providerId: string;
  modelId: string;
  onProviderChange: (id: string) => void;
  onModelChange: (id: string) => void;
}

function ProviderModelPicker({
  providers,
  providerId,
  modelId,
  onProviderChange,
  onModelChange,
}: PickerProps) {
  const { t } = useTranslation();
  const currentProvider = providers.find((p) => p.id === providerId);
  const models: ProviderModel[] = currentProvider?.models ?? [];

  return (
    <div className="flex gap-2 border-b border-[var(--c-border)] px-3 py-2">
      <select
        value={providerId}
        onChange={(e) => onProviderChange(e.target.value)}
        className="rounded border border-[var(--c-border)] bg-[var(--c-bg-base)] px-2 py-1 text-xs text-[var(--c-text-base)] focus:border-[var(--c-text-dim)] focus:outline-none"
        aria-label={t("aiSidebar.providerSelectAria")}
      >
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.display_name}
          </option>
        ))}
      </select>
      <select
        value={modelId}
        onChange={(e) => onModelChange(e.target.value)}
        className="flex-1 rounded border border-[var(--c-border)] bg-[var(--c-bg-base)] px-2 py-1 text-xs text-[var(--c-text-base)] focus:border-[var(--c-text-dim)] focus:outline-none"
        aria-label={t("aiSidebar.modelSelectAria")}
      >
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.display_name}
          </option>
        ))}
      </select>
    </div>
  );
}

function ChatBody({ providerId, modelId }: { providerId: string; modelId: string }) {
  const { t } = useTranslation();
  const messages = useChatStore((s) => s.messages);
  const streaming = useChatStore((s) => s.streaming);
  const error = useChatStore((s) => s.error);
  const usage = useChatStore((s) => s.usage);
  const conversationId = useChatStore((s) => s.conversationId);
  // active tab 切换时重新 resolve scope
  const activeTabId = useTabsStore((s) => s.activeId);
  const activeSessionId = useTabsStore((s) =>
    s.tabs.find((t) => t.id === s.activeId)?.sessionId ?? null,
  );

  const [input, setInput] = useState("");
  const [pendingInit, setPendingInit] = useState<AiInitRequiredEvent | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // 自动滚到底
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  // 1F：active tab / session 变化 → 解析 scope → loadFromScope
  // 第一次挂载也走这条路径
  useEffect(() => {
    let alive = true;
    (async () => {
      // 拿 active session 的 cwd；session 还没开（没 sessionId）就用 HOME
      // 兜底（后端 scope_resolve 会 canonicalize 失败时 fallback）
      let cwd = "";
      if (activeSessionId) {
        try {
          const c = await sessionCurrentCwd(activeSessionId);
          if (c) cwd = c;
        } catch (e) {
          console.warn("session_current_cwd 失败", e);
        }
      }
      if (!cwd) {
        // 没拿到 cwd — 用空字符串后端会兜底 HOME
        cwd = "";
      }

      try {
        const resolved = await scopeResolve(cwd);
        if (!alive) return;
        // NeedsInit：先按全局桶 load（让侧栏不空），等用户在 InitDialog
        // 决议后 chat 流程里再调 ai_chat_resume；store 暂用 global 桶
        const loadScope: ScopeDto =
          resolved.kind === "needs_init"
            ? { kind: "global" }
            : resolved;
        await useChatStore.getState().loadFromScope(loadScope);
      } catch (e) {
        console.warn("scope_resolve / loadFromScope 失败", e);
      }
    })();
    return () => {
      alive = false;
    };
  }, [activeTabId, activeSessionId]);

  // 监 ai:init_required 事件
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let alive = true;
    onAiInitRequired((e) => {
      if (alive) setPendingInit(e);
    }).then((u) => {
      if (alive) unlisten = u;
      else u();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  // 订阅 AI 流事件 + 工具调用事件
  useEffect(() => {
    let unTok: (() => void) | undefined;
    let unDone: (() => void) | undefined;
    let unErr: (() => void) | undefined;
    let unToolReq: (() => void) | undefined;
    let unToolStart: (() => void) | undefined;
    let unToolFin: (() => void) | undefined;
    let alive = true;

    (async () => {
      unTok = await onAiToken(conversationId, (text) => {
        if (alive) useChatStore.getState().appendAssistantDelta(text);
      });
      unDone = await onAiDone(conversationId, (e) => {
        if (!alive) return;
        const s = useChatStore.getState();
        s.finishAssistant();
        if (e.usage) s.setUsage(e.usage.input_tokens, e.usage.output_tokens);
      });
      unErr = await onAiError(conversationId, (e) => {
        if (!alive) return;
        useChatStore.getState().setError({ message: e.message, kind: e.kind });
      });
      // tool_request：仅 high/destructive 风险触发；low 自动批准不进这里
      unToolReq = await onAiToolRequest(conversationId, (e) => {
        if (!alive) return;
        useChatStore.getState().addToolCall({
          kind: "tool_call",
          call_id: e.call_id,
          name: e.name,
          args_preview: e.args_preview,
          risk: e.risk,
          risk_reason: e.risk_reason ?? undefined,
          status: "awaiting_approval",
        });
      });
      // tool_started：low 风险首次出现也进这里（addToolCall 兜底插入）
      unToolStart = await onAiToolStarted(conversationId, (e) => {
        if (!alive) return;
        // v0.7.0-A：匿名统计——只传 tool 名（如 "read_file"），**不**传 args / call_id
        trackEvent("ai_tool_invoked", { name: e.name });
        const store = useChatStore.getState();
        const exists = store.messages.some(
          (m) => m.kind === "tool_call" && m.call_id === e.call_id,
        );
        if (!exists) {
          store.addToolCall({
            kind: "tool_call",
            call_id: e.call_id,
            name: e.name,
            args_preview: "",
            risk: "low",
            status: "running",
          });
        } else {
          store.updateToolCall(e.call_id, { status: "running" });
        }
      });
      unToolFin = await onAiToolFinished(conversationId, (e) => {
        if (!alive) return;
        useChatStore.getState().updateToolCall(e.call_id, {
          status: e.is_error ? "error" : "done",
          result: { content: e.content, is_error: e.is_error },
          auto_approved_reason: e.auto_approved_reason ?? undefined,
        });
      });
    })();

    return () => {
      alive = false;
      unTok?.();
      unDone?.();
      unErr?.();
      unToolReq?.();
      unToolStart?.();
      unToolFin?.();
    };
  }, [conversationId]);

  const send = async () => {
    const text = input.trim();
    if (!text || streaming) return;

    const store = useChatStore.getState();
    store.appendUserMessage(text);
    setInput("");

    // 在 startAssistant 之前 snapshot 历史消息发给后端：
    // 此刻 messages 已含刚加的 user，不含空 assistant 占位。
    // 后端只关心 user/assistant 文本，tool_call 卡片是前端展示，过滤掉。
    const all: AiMessage[] = useChatStore
      .getState()
      .messages.flatMap<AiMessage>((m) => {
        if (m.kind === "user") return [{ role: "user", content: m.content }];
        if (m.kind === "assistant")
          return [{ role: "assistant", content: m.content }];
        return [];
      });

    // 加空 assistant 气泡，streaming 期间显示加载动画
    store.startAssistant();

    // 取当前活跃 tab 的 session_id 和 cwd，给后端 scope 解析 + 工具兜底用
    const tabsState = useTabsStore.getState();
    const activeTab = tabsState.tabs.find((t) => t.id === tabsState.activeId);
    const activeSidLocal = activeTab?.sessionId ?? null;
    let cwd: string | null = null;
    if (activeSidLocal) {
      try {
        cwd = await sessionCurrentCwd(activeSidLocal);
      } catch {
        cwd = null;
      }
    }

    // v0.7.0-A：匿名统计——只传 provider id（如 "deepseek"），**不**传 model / 消息内容
    trackEvent("ai_chat_sent", { provider: providerId });

    // v0.9.2 HR5-1：收集当前 active 运行时上下文（终端 cwd / 浏览器 URL / 编辑器 / OS）
    // 走 store.getState() 同步路径，不发 IPC，开销可忽略。
    const runtimeContext = collectRuntimeContext();

    try {
      await aiChatSend({
        conversation_id: conversationId,
        provider_id: providerId,
        model: modelId,
        messages: all,
        active_session_id: activeSidLocal,
        cwd: cwd ?? null,
        runtime_context: runtimeContext,
      });
    } catch (e) {
      store.setError({ message: String(e), kind: "other" });
    }
  };



  return (
    // min-h-0 + flex flex-col 让自身能被父 flex 容器压缩，scrollRef 的
    // overflow-y-auto 才能真生效；否则 messages 太长会把 footer 挤到视口外。
    <div className="flex min-h-0 flex-1 flex-col">
      <ConfirmDialog conversationId={conversationId} />
      {/* T10：spec §7.4(1) 文案精确实现的 Radix Dialog */}
      <InitProjectDialog
        payload={pendingInit}
        onResolved={() => setPendingInit(null)}
      />

      {error && (
        <div
          className={
            "border-b border-[var(--c-border)] px-3 py-2 text-xs " +
            (error.kind === "unauthorized"
              ? "bg-[var(--c-bg-elev-2)] text-[var(--c-warn)]"
              : "bg-[var(--c-bg-elev-2)] text-[var(--c-error)]")
          }
        >
          {error.kind === "unauthorized"
            ? t("aiSidebar.errorUnauthorized")
            : t("aiSidebar.errorGeneric")}
          {t("aiSidebar.errorSeparator")}
          {error.message}
        </div>
      )}

      <div ref={scrollRef} className="min-w-0 flex-1 space-y-3 overflow-y-auto overflow-x-hidden px-3 py-3">
        {messages.length === 0 && (
          <div className="mt-8 text-center text-xs text-[var(--c-text-faint)]">
            {t("aiSidebar.emptyChatHint")}
          </div>
        )}
        {messages.map((m, i) => {
          if (m.kind === "tool_call") {
            return <ToolCallBubble key={`${m.call_id}-${i}`} entry={m} />;
          }
          return (
            <MessageBubble
              key={i}
              message={m}
              streaming={
                streaming &&
                i === messages.length - 1 &&
                m.kind === "assistant"
              }
            />
          );
        })}
      </div>

      <footer className="border-t border-[var(--c-border)] px-3 py-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // Enter 发送，Shift+Enter 换行；
            // Cmd+Enter（Mac）/ Ctrl+Enter（Win/Linux）不拦截，让浏览器走默认行为（例如换行）
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.metaKey &&
              !e.ctrlKey
            ) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={t("aiSidebar.inputPlaceholder")}
          rows={2}
          className="w-full resize-none rounded border border-[var(--c-border)] bg-[var(--c-bg-base)] px-2 py-1.5 text-sm text-[var(--c-text-base)] focus:border-[var(--c-text-dim)] focus:outline-none"
          disabled={streaming}
        />
        <div className="mt-1 text-[10px] text-[var(--c-text-faint)]">
          {t("aiSidebar.tokensLabel", {
            input: usage.input_tokens,
            output: usage.output_tokens,
          })}
        </div>
      </footer>
    </div>
  );
}

