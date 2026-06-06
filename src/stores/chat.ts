import { create } from "zustand";
import i18n from "../lib/i18n";
import type {
  AiErrorEvent,
  ConversationDto,
  MessageDto,
  RiskClass,
  ScopeDto,
} from "../lib/tauri";
import {
  aiChatCancel,
  convCreate,
  convDelete,
  convGetMessages,
  convList,
  convRename,
  convSetModel,
} from "../lib/tauri";

export interface ChatError {
  message: string;
  kind: AiErrorEvent["kind"];
}

/** 工具调用条目（在聊天流里渲染成 ToolCallBubble）。 */
export interface ToolCallEntry {
  kind: "tool_call";
  call_id: string;
  name: string;
  args_preview: string;
  risk: RiskClass;
  /** L2 启发式归类原因（弹窗时显示，仅 run_command 弹窗有值）。 */
  risk_reason?: string;
  /** 自动批准原因（"L2：只读命令 ls" / "白名单：git status \*"）；走弹窗的留空。 */
  auto_approved_reason?: string;
  /** awaiting_approval | running | done | error | rejected */
  status: "awaiting_approval" | "running" | "done" | "error" | "rejected";
  /** 执行结果（done / error / rejected 时填）*/
  result?: { content: string; is_error: boolean };
}

export interface UserMessage {
  kind: "user";
  content: string;
}

export interface AssistantMessage {
  kind: "assistant";
  content: string;
}

export type ChatEntry = UserMessage | AssistantMessage | ToolCallEntry;

/** 单个对话的全部状态（1F 已对应 SQLite conversations 表）。 */
export interface SingleConversation {
  id: string;
  /** 自动派生（首条 user msg 前 30 字）或用户手动改的 */
  title: string;
  /** 用户手动改名后置 false，锁住自动派生 */
  titleAuto: boolean;
  messages: ChatEntry[];
  streaming: boolean;
  error: ChatError | null;
  usage: { input_tokens: number; output_tokens: number };
  /** 当前对话使用的 provider id（如 "qwen" / "anthropic"）；
   *  空字符串表示尚未选择，UI 兜底用 providers[0]。 */
  providerId: string;
  /** 当前对话使用的 model id；空字符串同上。 */
  modelId: string;
  createdAt: number;
  updatedAt: number;
}

interface ChatState {
  /** 顺序保持创建顺序；UI 渲染列表用 */
  conversations: SingleConversation[];
  activeId: string;
  /** 单调递增计数器，给"新对话 N"标题用，不复用 deleted 编号 */
  newConversationSerial: number;
  /** 1F：当前 store 绑定的 scope（决定写哪个 db bucket）。null = 未绑定（启动 / 跨 tab 切换中）。 */
  scope: ScopeDto | null;

  // === 镜像字段：active conversation 的 messages / streaming / error / usage / id
  // 每次 set 后同步刷新；保持现有 selector `useChatStore(s => s.messages)` 不破。
  messages: ChatEntry[];
  streaming: boolean;
  error: ChatError | null;
  usage: { input_tokens: number; output_tokens: number };
  /** 兼容老 API：等价于 activeId */
  conversationId: string;

  // === 老 actions（行为不变，全部默认操作 active）===
  appendUserMessage: (content: string) => void;
  startAssistant: () => void;
  appendAssistantDelta: (text: string) => void;
  finishAssistant: () => void;
  addToolCall: (entry: ToolCallEntry) => void;
  updateToolCall: (call_id: string, patch: Partial<ToolCallEntry>) => void;
  setError: (err: ChatError | null) => void;
  setUsage: (input_tokens: number, output_tokens: number) => void;

  // === 兼容老 API ===
  /** 清空当前 active 对话的消息（保留 conversation 本身） */
  clearMessages: () => void;
  /** 重置当前 active 对话（清空消息 + 重置 streaming/error/usage/title），等价于 "/clear" */
  resetConversation: () => void;

  // === 新增 actions ===
  /** 创建新对话并切到它。返回新对话 id；新对话 inherit 当前 active 的 model。 */
  createConversation: () => string;
  /** 切到指定对话；如当前对话 streaming 中会调 aiChatCancel 取消旧 task。 */
  switchConversation: (id: string) => void;
  /** 删除对话。如删的是 active：自动切到下一个；如是最后一个：先创建再删。 */
  deleteConversation: (id: string) => void;
  /** 用户手动改名；锁定 titleAuto = false 不再自动派生。 */
  renameConversation: (id: string, title: string) => void;
  /** 设置 active 对话的 provider + model（picker 改值时调）。 */
  setActiveModel: (providerId: string, modelId: string) => void;

  // === 1F 新增 ===
  /** 切换 scope（当前 active tab 的 cwd 解析结果）。
   *  从对应 bucket 重新 load 对话列表（最新的 active）；如果 bucket 一条对话
   *  都没有自动 createConversation 拿到一个空对话。 */
  loadFromScope: (scope: ScopeDto) => Promise<void>;
}

let convCounter = 0;
function nextConversationId(): string {
  convCounter += 1;
  return `conv-${Date.now()}-${convCounter}`;
}

function makeEmptyConversation(
  serial: number,
  inherit?: { providerId: string; modelId: string },
): SingleConversation {
  const now = Date.now();
  return {
    id: nextConversationId(),
    title: i18n.t("chat.newConversationTitle", { n: serial }),
    titleAuto: true,
    messages: [],
    streaming: false,
    error: null,
    usage: { input_tokens: 0, output_tokens: 0 },
    providerId: inherit?.providerId ?? "",
    modelId: inherit?.modelId ?? "",
    createdAt: now,
    updatedAt: now,
  };
}

/** 给镜像字段抽 helper：从 conversations + activeId 派生顶层字段。 */
function mirrorActive(
  conversations: SingleConversation[],
  activeId: string,
): Pick<
  ChatState,
  "messages" | "streaming" | "error" | "usage" | "conversationId"
> {
  const active = conversations.find((c) => c.id === activeId);
  if (!active) {
    return {
      messages: [],
      streaming: false,
      error: null,
      usage: { input_tokens: 0, output_tokens: 0 },
      conversationId: activeId,
    };
  }
  return {
    messages: active.messages,
    streaming: active.streaming,
    error: active.error,
    usage: active.usage,
    conversationId: active.id,
  };
}

/** 修改 active 对话的字段，同步刷新顶层镜像。 */
function patchActive(
  state: ChatState,
  patch: (c: SingleConversation) => SingleConversation,
): Partial<ChatState> {
  const conversations = state.conversations.map((c) =>
    c.id === state.activeId ? { ...patch(c), updatedAt: Date.now() } : c,
  );
  return {
    conversations,
    ...mirrorActive(conversations, state.activeId),
  };
}

/** db DTO → 内存 SingleConversation（messages 单独 lazy load，先空）。 */
function dtoToConversation(dto: ConversationDto): SingleConversation {
  return {
    id: dto.id,
    title: dto.title,
    titleAuto: dto.title_auto,
    messages: [],
    streaming: false,
    error: null,
    usage: { input_tokens: 0, output_tokens: 0 },
    providerId: dto.provider_id,
    modelId: dto.model_id,
    createdAt: dto.created_at * 1000, // db 里是秒；前端用 ms
    updatedAt: dto.updated_at * 1000,
  };
}

/** db MessageDto[] → 内存 ChatEntry[]，按 seq ASC。 */
function messagesDtoToEntries(rows: MessageDto[]): ChatEntry[] {
  const out: ChatEntry[] = [];
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      if (row.kind === "user") {
        out.push({ kind: "user", content: String(payload.content ?? "") });
      } else if (row.kind === "assistant") {
        out.push({
          kind: "assistant",
          content: String(payload.content ?? ""),
        });
      } else if (row.kind === "tool_call") {
        // T8 简化：tool_call 暂未持久化；如果未来有也允许重放
        out.push({
          kind: "tool_call",
          call_id: String(payload.call_id ?? ""),
          name: String(payload.name ?? ""),
          args_preview: String(payload.args_preview ?? ""),
          risk: (payload.risk as RiskClass) ?? "low",
          status: "done",
          result: payload.result as
            | { content: string; is_error: boolean }
            | undefined,
        });
      }
    } catch {
      // 损坏 payload 跳过
    }
  }
  return out;
}

/** 给后端 IPC 用的 scope；为 null 时用 Global 兜底。 */
function effectiveScope(scope: ScopeDto | null): ScopeDto {
  return scope ?? { kind: "global" };
}

export const useChatStore = create<ChatState>((set, get) => {
  // 1F：启动时**不**塞默认对话；等 AiSidebar 挂载调 loadFromScope 触发
  return {
    conversations: [],
    activeId: "",
    newConversationSerial: 0,
    scope: null,

    messages: [],
    streaming: false,
    error: null,
    usage: { input_tokens: 0, output_tokens: 0 },
    conversationId: "",

    appendUserMessage: (content) => {
      // 1. UI 立即更新（标题派生 + push 消息）
      let toPersist: { cid: string; payload: string } | null = null;
      set((s) => {
        const active = s.conversations.find((c) => c.id === s.activeId);
        const isFirstMsg = active && active.messages.length === 0;
        const shouldDerive = isFirstMsg && active?.titleAuto;
        const derivedTitle = shouldDerive
          ? content.slice(0, 30).replace(/\n/g, " ").trim() || active!.title
          : undefined;

        // 收集要持久化的信息（在锁内一次性算好，避免 race）
        if (active) {
          toPersist = {
            cid: active.id,
            payload: JSON.stringify({ content }),
          };
        }
        // 如果 title 自动派生了，需要持久化新标题
        if (derivedTitle !== undefined && active) {
          // 异步写 db（fire and forget）
          convRename(effectiveScope(s.scope), active.id, derivedTitle).catch(
            (e) => console.warn("conv_rename (auto) 失败", e),
          );
        }

        return patchActive(s, (c) => ({
          ...c,
          messages: [...c.messages, { kind: "user", content }],
          error: null,
          ...(derivedTitle !== undefined ? { title: derivedTitle } : {}),
        }));
      });

      // 2. 异步写 db（注意：后端 ai_chat_send 也会写 user msg，
      //    这里前端额外写一次 — 后端是为了"NeedsInit 暂停后重新发起"时能补
      //    一次写。两次写同一条会让 db 出现重复 user msg。
      //
      //    决定：**前端不写 user msg**，由后端 ai_chat_send 统一写。前端只
      //    管 UI。如果以后 chat 不走 ai_chat_send（如手动 import）再补。
      void toPersist; // intentionally unused — see comment above
    },

    startAssistant: () => {
      // UI 创建空 assistant 气泡用于流式追加；db 写在 finishAssistant
      set((s) =>
        patchActive(s, (c) => ({
          ...c,
          messages: [...c.messages, { kind: "assistant", content: "" }],
          streaming: true,
        })),
      );
    },

    appendAssistantDelta: (text) => {
      // 流式追加 — 不写 db（后端 PersistenceSink 已在 ai:done 时一次写最终文本）
      set((s) =>
        patchActive(s, (c) => {
          const msgs = [...c.messages];
          for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i];
            if (m.kind === "assistant") {
              msgs[i] = { ...m, content: m.content + text };
              return { ...c, messages: msgs };
            }
            if (m.kind === "user") break;
          }
          return c;
        }),
      );
    },

    finishAssistant: () => {
      // db 写由后端 PersistenceSink 在 ai:done 时完成
      set((s) => patchActive(s, (c) => ({ ...c, streaming: false })));
    },

    addToolCall: (entry) => {
      // T8 简化：tool_call 暂不持久化（前端 in-memory；重启后丢工具调用气泡）
      set((s) =>
        patchActive(s, (c) => ({
          ...c,
          messages: [...c.messages, entry],
        })),
      );
    },

    updateToolCall: (call_id, patch) => {
      set((s) =>
        patchActive(s, (c) => ({
          ...c,
          messages: c.messages.map((m) =>
            m.kind === "tool_call" && m.call_id === call_id
              ? ({ ...m, ...patch } as ToolCallEntry)
              : m,
          ),
        })),
      );
    },

    setError: (err) => {
      set((s) =>
        patchActive(s, (c) => ({ ...c, error: err, streaming: false })),
      );
    },

    setUsage: (input_tokens, output_tokens) => {
      // 仅 UI 累加；db 累加由后端 PersistenceSink 调 token_usage::accumulate
      set((s) =>
        patchActive(s, (c) => ({
          ...c,
          usage: {
            input_tokens: c.usage.input_tokens + input_tokens,
            output_tokens: c.usage.output_tokens + output_tokens,
          },
        })),
      );
    },

    clearMessages: () => {
      // UI only — 1F 没有"db 清空消息"的命令；用户应该走 deleteConversation
      set((s) => patchActive(s, (c) => ({ ...c, messages: [] })));
    },

    resetConversation: () => {
      set((s) => {
        const serial = s.newConversationSerial;
        return patchActive(s, () => ({
          ...makeEmptyConversation(serial),
          id: s.activeId,
        }));
      });
    },

    createConversation: () => {
      const cur = get().conversations.find((c) => c.id === get().activeId);
      if (cur?.streaming) {
        aiChatCancel().catch(() => {});
      }

      const newSerial = get().newConversationSerial + 1;
      const inherit = cur
        ? { providerId: cur.providerId, modelId: cur.modelId }
        : undefined;

      // **关键改动**：用后端 conv_create 拿真 db id，不再前端生成临时 id；
      // 这样后续 ai_chat_send 用同一个 cid 写消息时直接命中 db
      const scope = effectiveScope(get().scope);
      const title = i18n.t("chat.newConversationTitle", { n: newSerial });

      // 先用临时 id 占位 UI（避免等 await 的卡顿），等 db 返回换 id
      const tempId = nextConversationId();
      const tempFresh: SingleConversation = {
        ...makeEmptyConversation(newSerial, inherit),
        id: tempId,
        title,
      };
      set((s) => {
        const conversations = [
          ...s.conversations.map((c) =>
            c.id === s.activeId ? { ...c, streaming: false } : c,
          ),
          tempFresh,
        ];
        return {
          conversations,
          activeId: tempId,
          newConversationSerial: newSerial,
          ...mirrorActive(conversations, tempId),
        };
      });

      // 异步去 db 拿真 id 替换
      convCreate(scope, title)
        .then((dto) => {
          const real = dtoToConversation(dto);
          // 把 inherit 的 model 也同步到 db（conv_create 默认 provider/model 是空）
          if (inherit?.providerId || inherit?.modelId) {
            convSetModel(
              scope,
              dto.id,
              inherit.providerId,
              inherit.modelId,
            ).catch((e) => console.warn("conv_set_model 失败", e));
            real.providerId = inherit.providerId;
            real.modelId = inherit.modelId;
          }

          set((s) => {
            const conversations = s.conversations.map((c) =>
              c.id === tempId ? real : c,
            );
            const newActive =
              s.activeId === tempId ? real.id : s.activeId;
            return {
              conversations,
              activeId: newActive,
              ...mirrorActive(conversations, newActive),
            };
          });
        })
        .catch((e) => console.warn("conv_create 失败", e));

      return tempId;
    },

    switchConversation: (id) => {
      const cur = get().conversations.find((c) => c.id === get().activeId);
      if (cur && cur.id !== id && cur.streaming) {
        aiChatCancel().catch(() => {});
      }

      set((s) => {
        if (!s.conversations.find((c) => c.id === id)) return s;
        const conversations = s.conversations.map((c) =>
          c.id === s.activeId && c.streaming ? { ...c, streaming: false } : c,
        );
        return {
          conversations,
          activeId: id,
          ...mirrorActive(conversations, id),
        };
      });

      // 如果新 active 还没 load 过 messages，从 db 拉
      const target = get().conversations.find((c) => c.id === id);
      if (target && target.messages.length === 0) {
        const scope = effectiveScope(get().scope);
        convGetMessages(scope, id)
          .then((rows) => {
            if (rows.length === 0) return;
            const entries = messagesDtoToEntries(rows);
            set((s) => {
              const conversations = s.conversations.map((c) =>
                c.id === id ? { ...c, messages: entries } : c,
              );
              return {
                conversations,
                ...mirrorActive(conversations, s.activeId),
              };
            });
          })
          .catch((e) => console.warn("conv_get_messages 失败", e));
      }
    },

    deleteConversation: (id) => {
      const s = get();
      const idx = s.conversations.findIndex((c) => c.id === id);
      if (idx < 0) return;
      const scope = effectiveScope(s.scope);

      // 异步删 db
      convDelete(scope, id).catch((e) => console.warn("conv_delete 失败", e));

      if (s.conversations.length === 1) {
        s.createConversation();
        const after = get();
        const filtered = after.conversations.filter((c) => c.id !== id);
        set({
          conversations: filtered,
          ...mirrorActive(filtered, after.activeId),
        });
        return;
      }

      const isActive = s.activeId === id;
      const target = s.conversations[idx];
      if (isActive && target.streaming) {
        aiChatCancel().catch(() => {});
      }

      const filtered = s.conversations.filter((c) => c.id !== id);
      const nextActiveId = isActive
        ? (filtered[idx]?.id ?? filtered[filtered.length - 1].id)
        : s.activeId;

      set({
        conversations: filtered,
        activeId: nextActiveId,
        ...mirrorActive(filtered, nextActiveId),
      });
    },

    renameConversation: (id, title) => {
      const trimmed = title.trim();
      if (!trimmed) return;

      const scope = effectiveScope(get().scope);
      // 异步写 db
      convRename(scope, id, trimmed).catch((e) =>
        console.warn("conv_rename 失败", e),
      );

      set((s) => {
        const conversations = s.conversations.map((c) =>
          c.id === id
            ? { ...c, title: trimmed, titleAuto: false, updatedAt: Date.now() }
            : c,
        );
        return {
          conversations,
          ...mirrorActive(conversations, s.activeId),
        };
      });
    },

    setActiveModel: (providerId, modelId) => {
      const cid = get().activeId;
      const scope = effectiveScope(get().scope);
      // 异步写 db
      convSetModel(scope, cid, providerId, modelId).catch((e) =>
        console.warn("conv_set_model 失败", e),
      );

      set((s) => patchActive(s, (c) => ({ ...c, providerId, modelId })));
    },

    loadFromScope: async (scope) => {
      // 1. 取消正在 streaming 的对话
      const cur = get().conversations.find((c) => c.id === get().activeId);
      if (cur?.streaming) {
        aiChatCancel().catch(() => {});
      }

      try {
        const rows = await convList(scope);
        const conversations = rows.map(dtoToConversation);

        // 计算最大 newConversationSerial（避免标题撞号）。
        // v0.10.5 i18n：三语容错——历史 title 可能用任一语言创建，都要识别。
        const SERIAL_PATTERNS = [
          /^新对话 (\d+)$/, // zh-CN
          /^New conversation (\d+)$/, // en
          /^新規会話 (\d+)$/, // ja
        ];
        let maxSerial = 0;
        for (const c of conversations) {
          for (const re of SERIAL_PATTERNS) {
            const m = re.exec(c.title);
            if (m) {
              const n = Number(m[1]);
              if (Number.isFinite(n) && n > maxSerial) maxSerial = n;
              break;
            }
          }
        }

        if (conversations.length === 0) {
          // 该 bucket 还没对话 — 自动创建一个空的
          set({
            conversations: [],
            activeId: "",
            newConversationSerial: maxSerial,
            scope,
            messages: [],
            streaming: false,
            error: null,
            usage: { input_tokens: 0, output_tokens: 0 },
            conversationId: "",
          });
          // createConversation 会用 newConversationSerial + 1
          get().createConversation();
        } else {
          // 选最近活跃（list 已按 updated_at DESC，第一个就是）
          const active = conversations[0];

          // 给 active 拉一次 messages
          let activeMessages: ChatEntry[] = [];
          try {
            const msgs = await convGetMessages(scope, active.id);
            activeMessages = messagesDtoToEntries(msgs);
          } catch (e) {
            console.warn("conv_get_messages 失败", e);
          }

          const conversationsWithActiveMsgs = conversations.map((c) =>
            c.id === active.id ? { ...c, messages: activeMessages } : c,
          );

          set({
            conversations: conversationsWithActiveMsgs,
            activeId: active.id,
            newConversationSerial: maxSerial,
            scope,
            ...mirrorActive(conversationsWithActiveMsgs, active.id),
          });
        }
      } catch (e) {
        console.warn("loadFromScope 失败，store 保持空状态", e);
        set({ scope });
      }
    },
  };
});

/**
 * E2E 测试钩子。
 *
 * - `__getChatCid()` 返回 active 对话 id
 * - `__getConversationCount()` 给 multi-conversation.spec 断言对话总数
 *
 * 生产构建里这些钩子也保留——读取的是 store 的当前值，零副作用。
 */
if (typeof window !== "undefined") {
  (window as unknown as { __getChatCid: () => string }).__getChatCid = () =>
    useChatStore.getState().activeId;
  (
    window as unknown as { __getConversationCount: () => number }
  ).__getConversationCount = () =>
    useChatStore.getState().conversations.length;
}
