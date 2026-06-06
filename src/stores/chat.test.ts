import { beforeEach, describe, expect, it, vi } from "vitest";

// mock aiChatCancel + 1F 新加的 conv_* IPC：store 内部会触发但测试不关心副作用
vi.mock("../lib/tauri", async (orig) => {
  const real = await orig<typeof import("../lib/tauri")>();
  return {
    ...real,
    aiChatCancel: vi.fn().mockResolvedValue(undefined),
    convCreate: vi.fn().mockImplementation(async (_scope, title) => ({
      id: `db-${Date.now()}-${Math.random()}`,
      title,
      title_auto: true,
      provider_id: "",
      model_id: "",
      created_at: Math.floor(Date.now() / 1000),
      updated_at: Math.floor(Date.now() / 1000),
    })),
    convDelete: vi.fn().mockResolvedValue(undefined),
    convRename: vi.fn().mockResolvedValue(undefined),
    convSetModel: vi.fn().mockResolvedValue(undefined),
    convList: vi.fn().mockResolvedValue([]),
    convGetMessages: vi.fn().mockResolvedValue([]),
  };
});

import { useChatStore } from "./chat";
import { aiChatCancel } from "../lib/tauri";

const mockCancel = aiChatCancel as unknown as ReturnType<typeof vi.fn>;

/** 把 store 重置为单空对话 + 全局 scope 状态 — 每测试隔离。
 *
 * 1F 改动：store 启动时 conversations: []，由 AiSidebar 调 loadFromScope 注入。
 * 单测里直接 setState 一个完整状态即可。 */
function resetStore() {
  const id = `t-${Date.now()}-${Math.random()}`;
  useChatStore.setState({
    conversations: [
      {
        id,
        title: "新对话 1",
        titleAuto: true,
        messages: [],
        streaming: false,
        error: null,
        usage: { input_tokens: 0, output_tokens: 0 },
        providerId: "",
        modelId: "",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
    activeId: id,
    newConversationSerial: 1,
    scope: { kind: "global" },
    messages: [],
    streaming: false,
    error: null,
    usage: { input_tokens: 0, output_tokens: 0 },
    conversationId: id,
  });
}

describe("useChatStore", () => {
  beforeEach(() => {
    resetStore();
    mockCancel.mockClear();
  });

  // ===== 启动 / 镜像字段 =====

  it("启动有 1 个空对话且 activeId 指向它", () => {
    const s = useChatStore.getState();
    expect(s.conversations).toHaveLength(1);
    expect(s.activeId).toBe(s.conversations[0].id);
    expect(s.messages).toEqual([]);
    expect(s.streaming).toBe(false);
  });

  it("conversationId 镜像字段等于 activeId（兼容老 API）", () => {
    const s = useChatStore.getState();
    expect(s.conversationId).toBe(s.activeId);
  });

  // ===== 老 actions：行为不破 =====

  it("appendUserMessage 追加到 active 对话", () => {
    useChatStore.getState().appendUserMessage("hello");
    const s = useChatStore.getState();
    expect(s.messages).toHaveLength(1);
    const m = s.messages[0];
    expect(m.kind).toBe("user");
    if (m.kind === "user") expect(m.content).toBe("hello");
  });

  it("startAssistant + appendAssistantDelta + finishAssistant 累积", () => {
    const { startAssistant, appendAssistantDelta, finishAssistant } =
      useChatStore.getState();
    startAssistant();
    expect(useChatStore.getState().streaming).toBe(true);

    appendAssistantDelta("Hi ");
    appendAssistantDelta("there");
    const last = useChatStore.getState().messages.at(-1);
    expect(last?.kind).toBe("assistant");
    if (last && last.kind === "assistant") {
      expect(last.content).toBe("Hi there");
    }

    finishAssistant();
    expect(useChatStore.getState().streaming).toBe(false);
  });

  it("addToolCall + updateToolCall 流转状态", () => {
    const s = useChatStore.getState();
    s.addToolCall({
      kind: "tool_call",
      call_id: "c1",
      name: "list_files",
      args_preview: '{"path":"."}',
      risk: "low",
      status: "awaiting_approval",
    });
    expect(useChatStore.getState().messages).toHaveLength(1);

    s.updateToolCall("c1", { status: "running" });
    const m = useChatStore.getState().messages[0];
    if (m.kind === "tool_call") expect(m.status).toBe("running");

    s.updateToolCall("c1", {
      status: "done",
      result: { content: "ok", is_error: false },
    });
    const m2 = useChatStore.getState().messages[0];
    if (m2.kind === "tool_call") {
      expect(m2.status).toBe("done");
      expect(m2.result?.content).toBe("ok");
    }
  });

  it("appendAssistantDelta 在 user 之后无 assistant 时不写入", () => {
    const s = useChatStore.getState();
    s.appendUserMessage("u1");
    s.appendAssistantDelta("应该被丢弃");
    const m = useChatStore.getState().messages[0];
    if (m.kind === "user") expect(m.content).toBe("u1");
  });

  it("setError 写入 error 镜像", () => {
    useChatStore.getState().setError({ message: "401", kind: "unauthorized" });
    expect(useChatStore.getState().error?.kind).toBe("unauthorized");
  });

  it("clearMessages 清空 active 对话的 messages", () => {
    useChatStore.getState().appendUserMessage("a");
    useChatStore.getState().appendUserMessage("b");
    useChatStore.getState().clearMessages();
    expect(useChatStore.getState().messages).toEqual([]);
  });

  // ===== 新增：标题自动派生 =====

  it("首条 user 消息触发标题自动派生（去换行 + trim 前 30 字）", () => {
    useChatStore.getState().appendUserMessage("看下 git status\n顺便讲讲是什么");
    const active = useChatStore
      .getState()
      .conversations.find(
        (c) => c.id === useChatStore.getState().activeId,
      );
    expect(active?.title).toMatch(/^看下 git status/);
    expect(active?.title.length).toBeLessThanOrEqual(30);
    expect(active?.title.includes("\n")).toBe(false);
  });

  it("第二条 user 消息不再覆盖标题", () => {
    useChatStore.getState().appendUserMessage("第一条");
    useChatStore.getState().appendUserMessage("第二条");
    const active = useChatStore
      .getState()
      .conversations.find(
        (c) => c.id === useChatStore.getState().activeId,
      );
    expect(active?.title).toBe("第一条");
  });

  // ===== 新增：createConversation =====

  it("createConversation 增加并切到新对话", () => {
    const oldId = useChatStore.getState().activeId;
    const newId = useChatStore.getState().createConversation();
    const s = useChatStore.getState();
    expect(s.conversations).toHaveLength(2);
    expect(s.activeId).toBe(newId);
    expect(s.activeId).not.toBe(oldId);
    // 新对话 messages 是空
    expect(s.messages).toEqual([]);
    // serial 递增
    expect(s.newConversationSerial).toBe(2);
  });

  it("createConversation 在 streaming 中调 aiChatCancel", () => {
    useChatStore.getState().startAssistant();
    expect(useChatStore.getState().streaming).toBe(true);
    useChatStore.getState().createConversation();
    expect(mockCancel).toHaveBeenCalledTimes(1);
    // 新对话不应继承 streaming
    expect(useChatStore.getState().streaming).toBe(false);
  });

  // ===== 新增：switchConversation =====

  it("switchConversation 切到已存在的 id", () => {
    const oldId = useChatStore.getState().activeId;
    const newId = useChatStore.getState().createConversation();
    useChatStore.getState().switchConversation(oldId);
    expect(useChatStore.getState().activeId).toBe(oldId);

    useChatStore.getState().switchConversation(newId);
    expect(useChatStore.getState().activeId).toBe(newId);
  });

  it("switchConversation 不存在的 id 静默忽略", () => {
    const before = useChatStore.getState().activeId;
    useChatStore.getState().switchConversation("conv-不存在");
    expect(useChatStore.getState().activeId).toBe(before);
  });

  it("switchConversation streaming 中调 aiChatCancel + 清旧 streaming flag", () => {
    const oldId = useChatStore.getState().activeId;
    const newId = useChatStore.getState().createConversation();
    // 切回旧对话准备测试
    useChatStore.getState().switchConversation(oldId);
    mockCancel.mockClear();

    useChatStore.getState().startAssistant();
    expect(useChatStore.getState().streaming).toBe(true);

    useChatStore.getState().switchConversation(newId);
    expect(mockCancel).toHaveBeenCalledTimes(1);
    // 新 active 的 streaming 应为 false
    expect(useChatStore.getState().streaming).toBe(false);
    // 旧 active 的 streaming 也应被清回 false
    const oldConv = useChatStore
      .getState()
      .conversations.find((c) => c.id === oldId);
    expect(oldConv?.streaming).toBe(false);
  });

  it("switchConversation 切到自己不调 aiChatCancel", () => {
    const cur = useChatStore.getState().activeId;
    useChatStore.getState().startAssistant();
    mockCancel.mockClear();

    useChatStore.getState().switchConversation(cur);
    expect(mockCancel).not.toHaveBeenCalled();
  });

  // ===== 新增：deleteConversation =====

  it("deleteConversation 删非 active 不切 active", () => {
    const oldId = useChatStore.getState().activeId;
    const newId = useChatStore.getState().createConversation();
    // 现在 active = newId；删 oldId
    useChatStore.getState().deleteConversation(oldId);
    expect(useChatStore.getState().conversations).toHaveLength(1);
    expect(useChatStore.getState().activeId).toBe(newId);
  });

  it("deleteConversation 删 active 切到下一个", () => {
    const id1 = useChatStore.getState().activeId;
    const id2 = useChatStore.getState().createConversation();
    const id3 = useChatStore.getState().createConversation();
    // active = id3；删 id3 应切到 id2（在原列表里 idx=2 处的下一项越界，取末尾）
    useChatStore.getState().deleteConversation(id3);
    expect(useChatStore.getState().conversations).toHaveLength(2);
    expect(useChatStore.getState().activeId).toBe(id2);
    expect(id1).toBeTruthy();
  });

  it("deleteConversation 最后一个：自动新建占位再删", () => {
    const oldId = useChatStore.getState().activeId;
    expect(useChatStore.getState().conversations).toHaveLength(1);

    useChatStore.getState().deleteConversation(oldId);

    const s = useChatStore.getState();
    expect(s.conversations).toHaveLength(1);
    expect(s.conversations[0].id).not.toBe(oldId);
    expect(s.activeId).toBe(s.conversations[0].id);
  });

  // ===== 新增：renameConversation =====

  it("renameConversation 改名并锁定 titleAuto=false", () => {
    const id = useChatStore.getState().activeId;
    useChatStore.getState().renameConversation(id, "我的工作笔记");
    const c = useChatStore
      .getState()
      .conversations.find((c) => c.id === id);
    expect(c?.title).toBe("我的工作笔记");
    expect(c?.titleAuto).toBe(false);
  });

  it("手动改名后首条 user 消息不再覆盖标题", () => {
    const id = useChatStore.getState().activeId;
    useChatStore.getState().renameConversation(id, "锁定标题");
    useChatStore.getState().appendUserMessage("应该不会改 title");
    const c = useChatStore
      .getState()
      .conversations.find((c) => c.id === id);
    expect(c?.title).toBe("锁定标题");
  });

  it("renameConversation 空字符串忽略", () => {
    const id = useChatStore.getState().activeId;
    const before = useChatStore
      .getState()
      .conversations.find((c) => c.id === id)?.title;
    useChatStore.getState().renameConversation(id, "   ");
    const after = useChatStore
      .getState()
      .conversations.find((c) => c.id === id)?.title;
    expect(after).toBe(before);
  });

  // ===== Model per-conversation（修真机 smoke 暴露的 bug 1）=====

  it("setActiveModel 写入 active 对话的 providerId / modelId", () => {
    useChatStore.getState().setActiveModel("qwen", "qwen-max");
    const id = useChatStore.getState().activeId;
    const c = useChatStore
      .getState()
      .conversations.find((c) => c.id === id);
    expect(c?.providerId).toBe("qwen");
    expect(c?.modelId).toBe("qwen-max");
  });

  it("切对话后读到的 model 是新对话的（model 跟随对话）", () => {
    // 给对话 1 设 qwen-max
    useChatStore.getState().setActiveModel("qwen", "qwen-max");
    const id1 = useChatStore.getState().activeId;

    // 创建对话 2，inherit qwen-max
    const id2 = useChatStore.getState().createConversation();
    let active = useChatStore
      .getState()
      .conversations.find((c) => c.id === id2);
    expect(active?.providerId).toBe("qwen");
    expect(active?.modelId).toBe("qwen-max");

    // 对话 2 切 anthropic
    useChatStore.getState().setActiveModel("anthropic", "claude-opus-4-7");
    active = useChatStore.getState().conversations.find((c) => c.id === id2);
    expect(active?.modelId).toBe("claude-opus-4-7");

    // 对话 1 仍是 qwen-max
    const conv1 = useChatStore
      .getState()
      .conversations.find((c) => c.id === id1);
    expect(conv1?.modelId).toBe("qwen-max");

    // 切回对话 1 — store 视角 active 的 model 是 qwen
    useChatStore.getState().switchConversation(id1);
    const activeNow = useChatStore
      .getState()
      .conversations.find(
        (c) => c.id === useChatStore.getState().activeId,
      );
    expect(activeNow?.providerId).toBe("qwen");
  });

  it("createConversation 没有任何 model 时新对话也不 inherit（不崩）", () => {
    // 默认启动对话的 providerId/modelId 是空字符串
    const newId = useChatStore.getState().createConversation();
    const c = useChatStore
      .getState()
      .conversations.find((c) => c.id === newId);
    expect(c?.providerId).toBe("");
    expect(c?.modelId).toBe("");
  });

  // ===== 多对话隔离 =====

  it("切对话后消息互不可见", () => {
    useChatStore.getState().appendUserMessage("第一对话的话");
    const id2 = useChatStore.getState().createConversation();
    expect(useChatStore.getState().messages).toEqual([]);

    useChatStore.getState().appendUserMessage("第二对话的话");
    expect(useChatStore.getState().messages).toHaveLength(1);

    // 切回第一个
    const id1 = useChatStore
      .getState()
      .conversations.find((c) => c.id !== id2)!.id;
    useChatStore.getState().switchConversation(id1);
    expect(useChatStore.getState().messages).toHaveLength(1);
    const m = useChatStore.getState().messages[0];
    if (m.kind === "user") expect(m.content).toBe("第一对话的话");
  });
});
