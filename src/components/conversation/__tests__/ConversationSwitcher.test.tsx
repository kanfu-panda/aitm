import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/tauri", async (orig) => {
  const real = await orig<typeof import("../../../lib/tauri")>();
  return {
    ...real,
    aiChatCancel: vi.fn().mockResolvedValue(undefined),
  };
});

import ConversationSwitcher from "../ConversationSwitcher";
import { useChatStore, type SingleConversation } from "../../../stores/chat";

/**
 * ConversationSwitcher 浅渲染测 + dropdown 展开交互测。
 *
 * 2026-09-24 补充：曾认为 Radix DropdownMenu 在 jsdom 里开不了（"pointer events
 * 支持不完整"），实测发现根因很具体——DropdownMenuTrigger 内部用 onPointerDown
 * 判断 `event.button === 0 && event.ctrlKey === false` 才 toggle；这台环境的
 * jsdom 没有全局 `PointerEvent` 构造器，`fireEvent.pointerDown()` 生成的事件对象
 * 里 button/ctrlKey 都读不到值（undefined !== 0），条件恒为 false，所以永远打
 * 不开。绕过方法很简单：手动 `new MouseEvent("pointerdown", { button: 0 })`（jsdom
 * 原生支持 MouseEvent 构造器，字段能正确落地）用 `fireEvent(el, ev)` 派发。开了
 * 之后 Menu.Item 走的是普通 `onClick`，`fireEvent.click` 就完全正常。
 * 见本文件内 `openDropdown` helper。
 */
describe("ConversationSwitcher", () => {
  beforeEach(() => {
    // 重置 store 到默认单空对话
    // 1F：store 启动空，每测试自己 setState 一个完整状态
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
  });

  it("trigger 渲染 active 对话标题", () => {
    render(<ConversationSwitcher />);
    const trigger = screen.getByLabelText("切换对话");
    expect(trigger).toHaveTextContent("新对话 1");
  });

  it("默认不渲染 dropdown 内容", () => {
    render(<ConversationSwitcher />);
    expect(screen.queryByLabelText("新对话")).toBeNull();
  });

  it("trigger 标题随 store activeId 变化", () => {
    const newId = useChatStore.getState().createConversation();
    useChatStore.getState().renameConversation(newId, "我的工作笔记");

    render(<ConversationSwitcher />);
    const trigger = screen.getByLabelText("切换对话");
    expect(trigger).toHaveTextContent("我的工作笔记");
  });

  it("title 显示在 trigger 的 title 属性上（鼠标悬停 tooltip）", () => {
    useChatStore
      .getState()
      .renameConversation(useChatStore.getState().activeId, "超长的对话名超长的");

    render(<ConversationSwitcher />);
    const trigger = screen.getByLabelText("切换对话");
    expect(trigger.getAttribute("title")).toBe("超长的对话名超长的");
  });

  // === ScopeBadge ===

  it("trigger 内嵌 global ScopeBadge（compact 模式只显圆点）", () => {
    // beforeEach 已 setState scope: { kind: 'global' }
    render(<ConversationSwitcher />);
    const trigger = screen.getByLabelText("切换对话");
    // 找到 trigger 内的 scope 圆点
    const dot = trigger.querySelector("[data-scope-kind='global']");
    expect(dot).not.toBeNull();
    // compact 模式不带文字（trigger 上不应该显示"全局"二字）
    expect(trigger.textContent ?? "").not.toContain("全局");
  });

  it("scope=project 时 trigger 内嵌 emerald ScopeBadge", () => {
    useChatStore.setState({
      scope: {
        kind: "project",
        uuid: "u1",
        root_path: "/Users/leo/demo/myapp",
      },
    });
    render(<ConversationSwitcher />);
    const trigger = screen.getByLabelText("切换对话");
    const badge = trigger.querySelector("[data-scope-kind='project']");
    expect(badge).not.toBeNull();
    // tooltip 含完整路径
    expect(badge?.getAttribute("title")).toContain("/Users/leo/demo/myapp");
  });

  it("scope=null 时 trigger 不渲染 ScopeBadge", () => {
    useChatStore.setState({ scope: null });
    render(<ConversationSwitcher />);
    const trigger = screen.getByLabelText("切换对话");
    expect(trigger.querySelector("[data-scope-kind]")).toBeNull();
  });
});

/** 手动派发 pointerdown（见文件顶部注释）打开 DropdownMenu。 */
function openDropdown(trigger: HTMLElement) {
  fireEvent(
    trigger,
    new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }),
  );
}

function makeConv(
  id: string,
  title: string,
  extra: Partial<SingleConversation> = {},
): SingleConversation {
  return {
    id,
    title,
    titleAuto: true,
    messages: [],
    streaming: false,
    error: null,
    usage: { input_tokens: 0, output_tokens: 0 },
    providerId: "",
    modelId: "",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...extra,
  };
}

describe("ConversationSwitcher — 加载占位（active 找不到）", () => {
  it("conversations 为空时渲染禁用的加载占位按钮", () => {
    useChatStore.setState({ conversations: [], activeId: "missing" });
    render(<ConversationSwitcher />);
    const trigger = screen.getByLabelText("切换对话");
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveTextContent("加载中…");
    expect(trigger.getAttribute("title")).toBe("加载中");
  });
});

describe("ConversationSwitcher — dropdown 展开交互", () => {
  beforeEach(() => {
    const id = `t-${Date.now()}-${Math.random()}`;
    useChatStore.setState({
      conversations: [makeConv(id, "新对话 1")],
      activeId: id,
      newConversationSerial: 1,
      scope: { kind: "global" },
    });
  });

  it("点 trigger 打开 dropdown，显示作用域 + 对话计数", () => {
    render(<ConversationSwitcher />);
    const trigger = screen.getByLabelText("切换对话");
    openDropdown(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByLabelText("当前作用域")).toHaveTextContent("1 个对话");
  });

  it("点击非当前对话行 → 切换 active + 关闭 dropdown", () => {
    const otherId = "conv-b";
    useChatStore.setState((s) => ({
      conversations: [...s.conversations, makeConv(otherId, "第二个对话")],
    }));
    render(<ConversationSwitcher />);
    const trigger = screen.getByLabelText("切换对话");
    openDropdown(trigger);

    fireEvent.click(screen.getByLabelText("切换到对话 第二个对话"));

    expect(useChatStore.getState().activeId).toBe(otherId);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("点击当前已激活的对话行 → activeId 不变，dropdown 仍关闭", () => {
    const activeId = useChatStore.getState().activeId;
    useChatStore.setState((s) => ({
      conversations: [...s.conversations, makeConv("conv-c", "第三个对话")],
    }));
    render(<ConversationSwitcher />);
    const trigger = screen.getByLabelText("切换对话");
    openDropdown(trigger);

    fireEvent.click(screen.getByLabelText("切换到对话 新对话 1"));

    expect(useChatStore.getState().activeId).toBe(activeId);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("点 '+ 新对话' → 创建新对话并切到，dropdown 关闭", () => {
    render(<ConversationSwitcher />);
    const trigger = screen.getByLabelText("切换对话");
    const before = useChatStore.getState().conversations.length;
    openDropdown(trigger);

    fireEvent.click(screen.getByLabelText("新建对话"));

    expect(useChatStore.getState().conversations.length).toBe(before + 1);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("点 × 删除非当前对话 → 从列表移除，dropdown 保持打开", () => {
    useChatStore.setState((s) => ({
      conversations: [...s.conversations, makeConv("conv-d", "待删除对话")],
    }));
    render(<ConversationSwitcher />);
    const trigger = screen.getByLabelText("切换对话");
    openDropdown(trigger);

    fireEvent.click(screen.getByLabelText("删除对话 待删除对话"));

    expect(
      useChatStore.getState().conversations.some((c) => c.id === "conv-d"),
    ).toBe(false);
    // 删除后 dropdown 应该还开着，方便继续操作（组件注释里明确的设计）
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("消息数 > 0 时显示消息数徽标", () => {
    useChatStore.setState((s) => ({
      conversations: [
        {
          ...s.conversations[0],
          title: "带徽标的对话",
          messages: [
            { kind: "user", content: "a" },
            { kind: "assistant", content: "b" },
          ],
        },
      ],
    }));
    render(<ConversationSwitcher />);
    openDropdown(screen.getByLabelText("切换对话"));
    const row = screen.getByLabelText("切换到对话 带徽标的对话");
    expect(row).toHaveTextContent("2");
  });
});

describe("ConversationSwitcher — 重命名交互", () => {
  beforeEach(() => {
    const id = `t-${Date.now()}-${Math.random()}`;
    useChatStore.setState({
      conversations: [makeConv(id, "新对话 1")],
      activeId: id,
      newConversationSerial: 1,
      scope: { kind: "global" },
    });
  });

  it("点 ✎ 进入编辑态，input 预填当前标题并 stopPropagation 挡住 dropdown 键盘事件", () => {
    render(<ConversationSwitcher />);
    openDropdown(screen.getByLabelText("切换对话"));

    fireEvent.click(screen.getByLabelText("重命名对话 新对话 1"));

    const input = screen.getByLabelText("对话标题编辑") as HTMLInputElement;
    expect(input.value).toBe("新对话 1");
    // 编辑态外层 div 上的 onPointerDown/onKeyDown 是为了不让 Radix 抢事件，
    // 这里顺带触发一下不报错即可（无副作用可断言）。
    fireEvent.pointerDown(input.parentElement!);
  });

  it("编辑态输入新标题 + Enter → 提交改名，退出编辑态", () => {
    render(<ConversationSwitcher />);
    const trigger = screen.getByLabelText("切换对话");
    openDropdown(trigger);
    fireEvent.click(screen.getByLabelText("重命名对话 新对话 1"));

    const input = screen.getByLabelText("对话标题编辑") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "改名后的标题" } });
    fireEvent.keyDown(input, { key: "Enter" });

    const activeId = useChatStore.getState().activeId;
    expect(
      useChatStore
        .getState()
        .conversations.find((c) => c.id === activeId)?.title,
    ).toBe("改名后的标题");
    expect(screen.queryByLabelText("对话标题编辑")).toBeNull();
  });

  it("编辑态 Escape → 取消，标题不变，退出编辑态", () => {
    render(<ConversationSwitcher />);
    openDropdown(screen.getByLabelText("切换对话"));
    fireEvent.click(screen.getByLabelText("重命名对话 新对话 1"));

    const input = screen.getByLabelText("对话标题编辑") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "不应该生效的标题" } });
    fireEvent.keyDown(input, { key: "Escape" });

    const activeId = useChatStore.getState().activeId;
    expect(
      useChatStore
        .getState()
        .conversations.find((c) => c.id === activeId)?.title,
    ).toBe("新对话 1");
    expect(screen.queryByLabelText("对话标题编辑")).toBeNull();
  });

  it("编辑态失焦（blur）→ 等同提交", () => {
    render(<ConversationSwitcher />);
    openDropdown(screen.getByLabelText("切换对话"));
    fireEvent.click(screen.getByLabelText("重命名对话 新对话 1"));

    const input = screen.getByLabelText("对话标题编辑") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "失焦提交的标题" } });
    fireEvent.blur(input);

    const activeId = useChatStore.getState().activeId;
    expect(
      useChatStore
        .getState()
        .conversations.find((c) => c.id === activeId)?.title,
    ).toBe("失焦提交的标题");
  });

  it("编辑态提交空白标题 → trim 后为空，不改名", () => {
    render(<ConversationSwitcher />);
    openDropdown(screen.getByLabelText("切换对话"));
    fireEvent.click(screen.getByLabelText("重命名对话 新对话 1"));

    const input = screen.getByLabelText("对话标题编辑") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    const activeId = useChatStore.getState().activeId;
    expect(
      useChatStore
        .getState()
        .conversations.find((c) => c.id === activeId)?.title,
    ).toBe("新对话 1");
  });
});
