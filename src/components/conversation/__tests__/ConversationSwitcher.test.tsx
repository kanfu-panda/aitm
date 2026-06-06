import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/tauri", async (orig) => {
  const real = await orig<typeof import("../../../lib/tauri")>();
  return {
    ...real,
    aiChatCancel: vi.fn().mockResolvedValue(undefined),
  };
});

import ConversationSwitcher from "../ConversationSwitcher";
import { useChatStore } from "../../../stores/chat";

/**
 * ConversationSwitcher 浅渲染测。
 *
 * Radix DropdownMenu 的 portal + pointer events 在 jsdom 里支持不完整，
 * 完整交互（开 dropdown / 切换 / 删除 / 改名）放 Playwright E2E 测。
 * 这里只验证：trigger 渲染 active title + dropdown 关闭时 content 不在 DOM。
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
