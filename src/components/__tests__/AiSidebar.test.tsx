import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AiDoneEvent,
  AiErrorEvent,
  AiInitRequiredEvent,
  AiToolFinishedEvent,
  AiToolRequestEvent,
  AiToolStartedEvent,
  ConversationDto,
  ProviderEntry,
} from "../../lib/tauri";

/**
 * AiSidebar 组件测试。
 *
 * AiSidebar 本身不直接调用后端事件监听的底层 `listen`，而是通过 lib/tauri.ts
 * 导出的 `onAiToken` / `onAiDone` / ... 包装函数订阅。这里把这些包装函数整体
 * mock 成"记录回调 + 可手动触发"的桩，测试里模拟后端事件到达。
 *
 * 参照 ConfirmDialog.test.tsx / QuitConfirmDialog.test.tsx 的 mock 手法。
 */

// === 事件监听桩：用 vi.hoisted 声明，确保 vi.mock 工厂函数（会被提升到文件顶部）
// 能安全引用这些变量（直接用普通顶层 const 会因为 TDZ 报 "Cannot access before
// initialization" —— 这是 vitest 官方推荐的写法）。===
const {
  tokenListener,
  doneListener,
  errorListener,
  toolReqListener,
  toolStartListener,
  toolFinListener,
  initRequiredListener,
  providersChangedListener,
} = vi.hoisted(() => {
  // 按 conversationId 过滤的事件（token/done/error/tool_*）
  function makeScopedListener<E>() {
    const subs: Array<{ cid: string; cb: (e: E) => void }> = [];
    const on = vi.fn(async (cid: string, cb: (e: E) => void) => {
      const entry = { cid, cb };
      subs.push(entry);
      return () => {
        const i = subs.indexOf(entry);
        if (i >= 0) subs.splice(i, 1);
      };
    });
    const fire = (cid: string, payload: E) => {
      for (const s of [...subs]) if (s.cid === cid) s.cb(payload);
    };
    const reset = () => {
      subs.length = 0;
      on.mockClear();
    };
    return { on, fire, subs, reset };
  }

  // 无 cid 的全局事件（init_required / providers:changed）
  function makeGlobalListener<E>() {
    const subs: Array<(e: E) => void> = [];
    const on = vi.fn(async (cb: (e: E) => void) => {
      subs.push(cb);
      return () => {
        const i = subs.indexOf(cb);
        if (i >= 0) subs.splice(i, 1);
      };
    });
    const fire = (payload: E) => {
      for (const cb of [...subs]) cb(payload);
    };
    const reset = () => {
      subs.length = 0;
      on.mockClear();
    };
    return { on, fire, subs, reset };
  }

  return {
    tokenListener: makeScopedListener<string>(),
    doneListener: makeScopedListener<AiDoneEvent>(),
    errorListener: makeScopedListener<AiErrorEvent>(),
    toolReqListener: makeScopedListener<AiToolRequestEvent>(),
    toolStartListener: makeScopedListener<AiToolStartedEvent>(),
    toolFinListener: makeScopedListener<AiToolFinishedEvent>(),
    initRequiredListener: makeGlobalListener<AiInitRequiredEvent>(),
    providersChangedListener: makeGlobalListener<void>(),
  };
});

vi.mock("../../lib/tauri", async (orig) => {
  const real = await orig<typeof import("../../lib/tauri")>();
  return {
    ...real,
    listProviders: vi.fn(),
    aiChatSend: vi.fn().mockResolvedValue(undefined),
    aiChatCancel: vi.fn().mockResolvedValue(undefined),
    aiChatResume: vi.fn().mockResolvedValue(undefined),
    aiToolApprove: vi.fn().mockResolvedValue(undefined),
    aiToolReject: vi.fn().mockResolvedValue(undefined),
    scopeResolve: vi.fn(),
    sessionCurrentCwd: vi.fn(),
    projectInit: vi.fn(),
    markIgnored: vi.fn().mockResolvedValue(undefined),
    convList: vi.fn(),
    convGetMessages: vi.fn(),
    convCreate: vi.fn(),
    convDelete: vi.fn().mockResolvedValue(undefined),
    convRename: vi.fn().mockResolvedValue(undefined),
    convSetModel: vi.fn().mockResolvedValue(undefined),
    browserHideAllActive: vi.fn().mockResolvedValue(undefined),
    browserShowAllActive: vi.fn().mockResolvedValue(undefined),
    onAiToken: tokenListener.on,
    onAiDone: doneListener.on,
    onAiError: errorListener.on,
    onAiToolRequest: toolReqListener.on,
    onAiToolStarted: toolStartListener.on,
    onAiToolFinished: toolFinListener.on,
    onAiInitRequired: initRequiredListener.on,
    onProvidersChanged: providersChangedListener.on,
  };
});

vi.mock("../../lib/analytics", () => ({
  trackEvent: vi.fn(),
}));

import AiSidebar from "../AiSidebar";
import { useChatStore } from "../../stores/chat";
import { useSidebarStore } from "../../stores/sidebar";
import { useTabsStore } from "../../stores/tabs";
import {
  aiChatCancel,
  aiChatSend,
  aiToolApprove,
  aiToolReject,
  convGetMessages,
  convList,
  convSetModel,
  listProviders,
  scopeResolve,
  sessionCurrentCwd,
} from "../../lib/tauri";

const mockAiChatSend = aiChatSend as unknown as ReturnType<typeof vi.fn>;
const mockAiChatCancel = aiChatCancel as unknown as ReturnType<typeof vi.fn>;
const mockAiToolApprove = aiToolApprove as unknown as ReturnType<typeof vi.fn>;
const mockAiToolReject = aiToolReject as unknown as ReturnType<typeof vi.fn>;
const mockListProviders = listProviders as unknown as ReturnType<typeof vi.fn>;
const mockScopeResolve = scopeResolve as unknown as ReturnType<typeof vi.fn>;
const mockSessionCurrentCwd = sessionCurrentCwd as unknown as ReturnType<
  typeof vi.fn
>;
const mockConvList = convList as unknown as ReturnType<typeof vi.fn>;
const mockConvGetMessages = convGetMessages as unknown as ReturnType<
  typeof vi.fn
>;
const mockConvSetModel = convSetModel as unknown as ReturnType<typeof vi.fn>;

const PROVIDER_ANTHROPIC: ProviderEntry = {
  id: "anthropic",
  display_name: "Anthropic",
  models: [
    { id: "claude-3", display_name: "Claude 3", context_window: 200000 },
  ],
  capabilities: {
    supports_tools: true,
    supports_streaming_tools: true,
    needs_args_concat: false,
  },
};

const PROVIDER_DEEPSEEK: ProviderEntry = {
  id: "deepseek",
  display_name: "DeepSeek",
  models: [
    { id: "deepseek-chat", display_name: "DeepSeek Chat", context_window: 64000 },
  ],
  capabilities: {
    supports_tools: true,
    supports_streaming_tools: true,
    needs_args_concat: false,
  },
};

// eslint.config.js 的 no-undef globals 里没登记 HTMLSelectElement（只登记了
// div/button/input/textarea），为了不碰项目配置文件，这里用一个结构等价的
// 类型别名代替直接引用该全局类型名。
type SelectEl = HTMLElement & { value: string; options: { length: number } };

const BASE_CONV: ConversationDto = {
  id: "conv-1",
  title: "新对话 1",
  title_auto: true,
  provider_id: "",
  model_id: "",
  created_at: 1700000000,
  updated_at: 1700000000,
};

/** 等待挂载效果全部落定：providers 加载完 + scope 解析完 + provider 自动回填完。 */
async function waitReady() {
  await screen.findByText("和 AI 开始一段对话…");
  await waitFor(() => {
    const select = screen.getByLabelText("选择 provider") as SelectEl;
    expect(select.value).toBe("anthropic");
  });
}

function sendText(text: string) {
  const textarea = screen.getByPlaceholderText(
    "输入消息（Enter 发送，Shift+Enter 换行）",
  );
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.keyDown(textarea, { key: "Enter" });
}

/** 消息滚动区域容器：首条 user 消息会被自动派生成对话标题，同时出现在顶部
 *  ConversationSwitcher 的 trigger 里；断言消息内容时用它把查询范围收窄到
 *  消息列表本身，避免跟标题撞上导致 "Found multiple elements"。 */
function messageList(): HTMLElement {
  const el = document.querySelector(".overflow-y-auto.overflow-x-hidden");
  if (!el) throw new Error("未找到消息列表容器");
  return el as HTMLElement;
}

describe("AiSidebar", () => {
  beforeEach(() => {
    // 重置事件监听桩
    tokenListener.reset();
    doneListener.reset();
    errorListener.reset();
    toolReqListener.reset();
    toolStartListener.reset();
    toolFinListener.reset();
    initRequiredListener.reset();
    providersChangedListener.reset();

    // 重置 IPC mock 的调用记录 + 默认返回值
    mockAiChatSend.mockClear().mockResolvedValue(undefined);
    mockAiChatCancel.mockClear().mockResolvedValue(undefined);
    mockAiToolApprove.mockClear().mockResolvedValue(undefined);
    mockAiToolReject.mockClear().mockResolvedValue(undefined);
    mockConvSetModel.mockClear().mockResolvedValue(undefined);

    mockListProviders.mockReset().mockResolvedValue([PROVIDER_ANTHROPIC]);
    mockScopeResolve.mockReset().mockResolvedValue({ kind: "global" });
    mockSessionCurrentCwd.mockReset().mockResolvedValue(null);
    mockConvList.mockReset().mockResolvedValue([BASE_CONV]);
    mockConvGetMessages.mockReset().mockResolvedValue([]);

    // store 复位
    useSidebarStore.setState({ open: true });
    useTabsStore.setState({ tabs: [], activeId: null, unreadByTab: {} });
    useChatStore.setState({
      conversations: [],
      activeId: "",
      newConversationSerial: 0,
      scope: null,
      messages: [],
      streaming: false,
      error: null,
      usage: { input_tokens: 0, output_tokens: 0 },
      conversationId: "",
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("侧栏关闭时不渲染任何内容", () => {
    useSidebarStore.setState({ open: false });
    const { container } = render(<AiSidebar />);
    expect(container).toBeEmptyDOMElement();
  });

  it("挂载后先显示加载中，随后加载完成显示空聊天提示与初始 tokens", async () => {
    render(<AiSidebar />);
    // ConversationSwitcher（active 对话未就绪）与 SidebarBody（providers 未加载完）
    // 共用同一句文案"加载中…"，用 getAllByText 断言至少出现过，不强求唯一。
    expect(screen.getAllByText("加载中…").length).toBeGreaterThan(0);

    await waitReady();
    expect(screen.getByText(/tokens：in 0 · out 0/)).toBeInTheDocument();
  });

  it("没有配置 provider 时显示空态提示", async () => {
    mockListProviders.mockReset().mockResolvedValue([]);
    render(<AiSidebar />);

    await screen.findByText("请先配置 AI Provider");
    expect(screen.getByText("~/.aitm/.env")).toBeInTheDocument();
  });

  it("应该_当没有配置_provider_时_头部显示侧栏名称而不是一直转圈的会话切换器", async () => {
    mockListProviders.mockReset().mockResolvedValue([]);
    render(<AiSidebar />);

    await screen.findByText("请先配置 AI Provider");
    // 没有模型时不会加载对话，切换器只会永远停在"加载中"
    expect(screen.queryByText("加载中…")).toBeNull();
    expect(screen.getByRole("banner")).toHaveTextContent("AI 助手");
  });

  it("应该_当之后配置了_provider_时_头部恢复为会话切换器", async () => {
    mockListProviders.mockReset().mockResolvedValue([]);
    render(<AiSidebar />);
    await screen.findByText("请先配置 AI Provider");

    mockListProviders.mockResolvedValue([PROVIDER_ANTHROPIC]);
    act(() => providersChangedListener.fire(undefined));

    await waitReady();
    expect(screen.getByRole("banner")).not.toHaveTextContent("AI 助手");
  });

  it("listProviders 失败时也能收尾（loading 结束，落到空态提示）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockListProviders.mockReset().mockRejectedValue(new Error("boom"));
    render(<AiSidebar />);

    await screen.findByText("请先配置 AI Provider");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("scopeResolve 失败时 store 保持空但不崩溃", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockScopeResolve.mockReset().mockRejectedValue(new Error("boom"));
    render(<AiSidebar />);

    // providers 正常加载完成即可断言未崩溃；聊天区因 scope 失败不会出现空聊天提示
    await waitFor(() =>
      expect(screen.getByLabelText("选择 provider")).toBeInTheDocument(),
    );
    await waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
  });

  it("输入消息回车发送 → 调用 aiChatSend 且携带当前 provider/model/会话信息", async () => {
    render(<AiSidebar />);
    await waitReady();

    sendText("你好 aitm");

    // 首条消息会被派生成对话标题，同时出现在顶部切换器里；限定在消息列表容器内查找。
    expect(within(messageList()).getByText("你好 aitm")).toBeInTheDocument();

    await waitFor(() => expect(mockAiChatSend).toHaveBeenCalledTimes(1));
    const arg = mockAiChatSend.mock.calls[0][0];
    expect(arg.conversation_id).toBe("conv-1");
    expect(arg.provider_id).toBe("anthropic");
    expect(arg.model).toBe("claude-3");
    expect(arg.messages).toEqual([{ role: "user", content: "你好 aitm" }]);
    expect(arg.active_session_id).toBeNull();
    expect(arg.cwd).toBeNull();
    expect(arg.runtime_context).toBeTruthy();
  });

  it("发送时会带上当前活跃 tab 的 session_id 与 cwd", async () => {
    useTabsStore.setState({
      tabs: [{ id: "t1", title: "~", sessionId: "sess-1", auto_title: true }],
      activeId: "t1",
    });
    mockSessionCurrentCwd.mockResolvedValue("/Users/dev/project");

    render(<AiSidebar />);
    await waitReady();

    sendText("看下这个目录");

    await waitFor(() => expect(mockAiChatSend).toHaveBeenCalledTimes(1));
    const arg = mockAiChatSend.mock.calls[0][0];
    expect(arg.active_session_id).toBe("sess-1");
    expect(arg.cwd).toBe("/Users/dev/project");
  });

  it("空白输入 / streaming 中不触发发送", async () => {
    render(<AiSidebar />);
    await waitReady();

    sendText("   ");
    expect(mockAiChatSend).not.toHaveBeenCalled();
  });

  it("收到 ai:token 流式事件后助手气泡追加文本", async () => {
    render(<AiSidebar />);
    await waitReady();

    sendText("讲个笑话");
    await waitFor(() => expect(mockAiChatSend).toHaveBeenCalledTimes(1));

    act(() => {
      tokenListener.fire("conv-1", "从前，");
      tokenListener.fire("conv-1", "有座山。");
    });

    await screen.findByText("从前，有座山。");
    // streaming 中输入框应禁用，出现停止按钮
    expect(screen.getByPlaceholderText(
      "输入消息（Enter 发送，Shift+Enter 换行）",
    )).toBeDisabled();
    expect(screen.getByLabelText("停止生成")).toBeInTheDocument();
  });

  it("收到 ai:done 事件后结束 streaming 并累加 tokens 用量", async () => {
    render(<AiSidebar />);
    await waitReady();

    sendText("统计一下");
    await waitFor(() => expect(mockAiChatSend).toHaveBeenCalledTimes(1));

    const doneEvent: AiDoneEvent = {
      conversation_id: "conv-1",
      stop_reason: "end_turn",
      usage: { input_tokens: 12, output_tokens: 34 },
      hallucination: null,
    };
    act(() => doneListener.fire("conv-1", doneEvent));

    await waitFor(() =>
      expect(screen.getByText(/tokens：in 12 · out 34/)).toBeInTheDocument(),
    );
    expect(screen.queryByLabelText("停止生成")).toBeNull();
  });

  it("ai:done 带反幻觉警告时挂到末条 assistant 气泡", async () => {
    render(<AiSidebar />);
    await waitReady();

    sendText("帮我打开浏览器看一下");
    await waitFor(() => expect(mockAiChatSend).toHaveBeenCalledTimes(1));
    act(() => tokenListener.fire("conv-1", "已经打开好了 ✅"));

    act(() =>
      doneListener.fire("conv-1", {
        conversation_id: "conv-1",
        stop_reason: "end_turn",
        usage: null,
        hallucination: { missing: ["browser"] },
      }),
    );

    await screen.findByTestId("hallucination-warning");
  });

  it("点击停止按钮 → 调 aiChatCancel 并本地立即结束 streaming", async () => {
    render(<AiSidebar />);
    await waitReady();

    sendText("跑个长任务");
    await waitFor(() => expect(mockAiChatSend).toHaveBeenCalledTimes(1));
    act(() => tokenListener.fire("conv-1", "正在处理…"));

    fireEvent.click(screen.getByLabelText("停止生成"));

    await waitFor(() => expect(mockAiChatCancel).toHaveBeenCalledTimes(1));
    expect(screen.getByText("已停止")).toBeInTheDocument();
    expect(screen.queryByLabelText("停止生成")).toBeNull();
  });

  it("收到 ai:error（unauthorized）显示鉴权失败提示，点重试重新发送", async () => {
    render(<AiSidebar />);
    await waitReady();

    sendText("第一次尝试");
    await waitFor(() => expect(mockAiChatSend).toHaveBeenCalledTimes(1));

    act(() =>
      errorListener.fire("conv-1", {
        conversation_id: "conv-1",
        message: "invalid api key",
        kind: "unauthorized",
      }),
    );

    // 文案由 3 个相邻文本节点拼成（前缀 + 分隔符 + 原始 message），用正则局部匹配。
    await screen.findByText(/鉴权失败：检查 API key/);
    expect(screen.getByText(/invalid api key/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(mockAiChatSend).toHaveBeenCalledTimes(2));
  });

  it("收到 ai:error（其它类型）显示通用错误文案", async () => {
    render(<AiSidebar />);
    await waitReady();

    sendText("第一次尝试");
    await waitFor(() => expect(mockAiChatSend).toHaveBeenCalledTimes(1));

    act(() =>
      errorListener.fire("conv-1", {
        conversation_id: "conv-1",
        message: "网络超时",
        kind: "network",
      }),
    );

    await screen.findByText(/网络超时/);
    expect(screen.getByText(/错误/)).toBeInTheDocument();
  });

  it("低风险工具调用：ai:tool_started 展示运行中气泡，ai:tool_finished 展示完成结果", async () => {
    render(<AiSidebar />);
    await waitReady();

    act(() =>
      toolStartListener.fire("conv-1", {
        conversation_id: "conv-1",
        call_id: "call-low-1",
        name: "read_file",
      }),
    );

    const bubble = await screen.findByTestId("tool-call-bubble");
    expect(bubble).toHaveAttribute("data-status", "running");
    expect(bubble).toHaveTextContent("read_file");

    act(() =>
      toolFinListener.fire("conv-1", {
        conversation_id: "conv-1",
        call_id: "call-low-1",
        content: "文件内容...",
        is_error: false,
        elapsed_ms: 120,
        auto_approved_reason: "L2：只读命令",
      }),
    );

    await waitFor(() =>
      expect(screen.getByTestId("tool-call-bubble")).toHaveAttribute(
        "data-status",
        "done",
      ),
    );
  });

  it("高风险工具调用：弹出确认弹窗，批准后调用 aiToolApprove", async () => {
    render(<AiSidebar />);
    await waitReady();

    act(() =>
      toolReqListener.fire("conv-1", {
        conversation_id: "conv-1",
        call_id: "call-high-1",
        name: "run_command",
        args_preview: '{"cmd":"rm -rf tmp"}',
        risk: "high",
      }),
    );

    // 消息流里也应出现一张等待批准的工具气泡（ChatBody 自己的 onAiToolRequest 监听）
    const bubble = await screen.findByTestId("tool-call-bubble");
    expect(bubble).toHaveAttribute("data-status", "awaiting_approval");

    // ConfirmDialog 弹出
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("run_command");

    fireEvent.click(screen.getByRole("button", { name: "批准" }));

    await waitFor(() =>
      expect(mockAiToolApprove).toHaveBeenCalledWith("call-high-1", false),
    );
  });

  it("拒绝工具调用 → 调用 aiToolReject", async () => {
    render(<AiSidebar />);
    await waitReady();

    act(() =>
      toolReqListener.fire("conv-1", {
        conversation_id: "conv-1",
        call_id: "call-reject-1",
        name: "run_command",
        args_preview: '{"cmd":"ls"}',
        risk: "high",
      }),
    );

    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));

    await waitFor(() =>
      expect(mockAiToolReject).toHaveBeenCalledWith("call-reject-1"),
    );
  });

  it("收到 ai:init_required 事件弹出项目初始化对话框", async () => {
    render(<AiSidebar />);
    await waitReady();

    act(() =>
      initRequiredListener.fire({
        conversation_id: "conv-1",
        cwd: "/Users/dev/newproj",
        default_name: "newproj",
      }),
    );

    await screen.findByText("✨ 在这里开始一个 AI 项目？");
  });

  it("providers:changed 事件触发重新拉取 provider 列表", async () => {
    render(<AiSidebar />);
    await waitReady();

    mockListProviders.mockResolvedValue([PROVIDER_ANTHROPIC, PROVIDER_DEEPSEEK]);
    act(() => providersChangedListener.fire(undefined));

    await waitFor(() => {
      const select = screen.getByLabelText("选择 provider") as SelectEl;
      expect(select.options.length).toBe(2);
    });
  });

  it("切换 provider 下拉框 → 自动选中新 provider 的首个模型并写回 store", async () => {
    mockListProviders.mockReset().mockResolvedValue([
      PROVIDER_ANTHROPIC,
      PROVIDER_DEEPSEEK,
    ]);

    render(<AiSidebar />);
    await waitReady();

    const providerSelect = screen.getByLabelText(
      "选择 provider",
    ) as SelectEl;
    fireEvent.change(providerSelect, { target: { value: "deepseek" } });

    await waitFor(() => {
      const modelSelect = screen.getByLabelText("选择模型") as SelectEl;
      expect(modelSelect.value).toBe("deepseek-chat");
    });
    expect(mockConvSetModel).toHaveBeenCalledWith(
      { kind: "global" },
      "conv-1",
      "deepseek",
      "deepseek-chat",
    );
  });

  it("卸载后取消所有事件订阅", async () => {
    const { unmount } = render(<AiSidebar />);
    await waitReady();

    expect(tokenListener.subs.length).toBeGreaterThan(0);
    expect(doneListener.subs.length).toBeGreaterThan(0);
    expect(errorListener.subs.length).toBeGreaterThan(0);
    expect(toolReqListener.subs.length).toBeGreaterThan(0);
    expect(toolStartListener.subs.length).toBeGreaterThan(0);
    expect(toolFinListener.subs.length).toBeGreaterThan(0);
    expect(initRequiredListener.subs.length).toBeGreaterThan(0);
    expect(providersChangedListener.subs.length).toBeGreaterThan(0);

    unmount();

    await waitFor(() => {
      expect(tokenListener.subs.length).toBe(0);
      expect(doneListener.subs.length).toBe(0);
      expect(errorListener.subs.length).toBe(0);
      expect(initRequiredListener.subs.length).toBe(0);
      expect(providersChangedListener.subs.length).toBe(0);
    });

    // 挂载时先以 conversationId="" 订阅一轮，解析出真实 id
    // 后切换重订。旧一轮的清理若早于后几个订阅落定，那几个订阅以前会永久残留。
    // 现在迟到落定的订阅发现已被清理会立即退订，所以卸载后必须全部清零。
    await waitFor(() => {
      expect(toolReqListener.subs.length).toBe(0);
      expect(toolStartListener.subs.length).toBe(0);
      expect(toolFinListener.subs.length).toBe(0);
    });
  });
});
