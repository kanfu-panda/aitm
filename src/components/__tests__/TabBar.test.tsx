import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TabBar from "../TabBar";
import { useTabsStore } from "../../stores/tabs";

// 默认 sessionHasRunningCommand 返 false（无运行中命令 → 直接 closeTab）；
// 单测内 mockResolvedValue(true) 模拟有运行中命令的分支。
vi.mock("../../lib/tauri", async (orig) => {
  const real = await orig<typeof import("../../lib/tauri")>();
  return {
    ...real,
    sessionHasRunningCommand: vi.fn().mockResolvedValue(false),
  };
});

import { sessionHasRunningCommand } from "../../lib/tauri";
const mockHasRunning = sessionHasRunningCommand as unknown as ReturnType<
  typeof vi.fn
>;

/**
 * TabBar 单测覆盖：
 * - Phase 2A T3：双击 → inline 编辑 → Enter / Escape / blur / 空字符串语义
 * - Phase 2A T4：未读小圆点的可见性
 * - Phase 3A T5：关闭 tab 二次确认（无 sessionId 直关 / 有运行中命令弹 dialog /
 *   取消保留 / 确认关 / 检测失败 fallback 直关）
 */
describe("TabBar", () => {
  beforeEach(() => {
    // 重置 store + counter 不可控但 id 唯一性测试不关心
    useTabsStore.setState({ tabs: [], activeId: null, unreadByTab: {} });
    mockHasRunning.mockReset();
    mockHasRunning.mockResolvedValue(false);
  });

  it("默认渲染 tab title", () => {
    const id = useTabsStore.getState().addTab();
    useTabsStore.getState().setTitle(id, "我的标签");
    render(<TabBar />);
    expect(screen.getByText("我的标签")).toBeTruthy();
  });

  it("双击 title → 出现 input 含原 title", () => {
    const id = useTabsStore.getState().addTab();
    useTabsStore.getState().setTitle(id, "原始名");
    render(<TabBar />);

    const titleSpan = screen.getByText("原始名");
    fireEvent.doubleClick(titleSpan);

    const input = screen.getByLabelText("标签标题编辑") as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.value).toBe("原始名");
  });

  it("编辑态隐藏关闭按钮", () => {
    const id = useTabsStore.getState().addTab();
    useTabsStore.getState().setTitle(id, "测试");
    render(<TabBar />);

    expect(screen.getByLabelText("关闭标签")).toBeTruthy();
    fireEvent.doubleClick(screen.getByText("测试"));
    expect(screen.queryByLabelText("关闭标签")).toBeNull();
  });

  it("改值 + Enter → setTitle 被调用", () => {
    const id = useTabsStore.getState().addTab();
    useTabsStore.getState().setTitle(id, "旧名");
    render(<TabBar />);

    fireEvent.doubleClick(screen.getByText("旧名"));
    const input = screen.getByLabelText("标签标题编辑") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "新名" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(useTabsStore.getState().tabs.find((t) => t.id === id)?.title).toBe(
      "新名",
    );
  });

  it("改值 + Escape → setTitle 不被调用（保留原值）", () => {
    const id = useTabsStore.getState().addTab();
    useTabsStore.getState().setTitle(id, "旧名");
    render(<TabBar />);

    fireEvent.doubleClick(screen.getByText("旧名"));
    const input = screen.getByLabelText("标签标题编辑") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "随便改改" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(useTabsStore.getState().tabs.find((t) => t.id === id)?.title).toBe(
      "旧名",
    );
  });

  it("空字符串提交 → setTitle 不被调用，保留原 title", () => {
    const id = useTabsStore.getState().addTab();
    useTabsStore.getState().setTitle(id, "保留我");
    render(<TabBar />);

    fireEvent.doubleClick(screen.getByText("保留我"));
    const input = screen.getByLabelText("标签标题编辑") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(useTabsStore.getState().tabs.find((t) => t.id === id)?.title).toBe(
      "保留我",
    );
  });

  it("blur 提交 → setTitle 被调用（非空）", () => {
    const id = useTabsStore.getState().addTab();
    useTabsStore.getState().setTitle(id, "前");
    render(<TabBar />);

    fireEvent.doubleClick(screen.getByText("前"));
    const input = screen.getByLabelText("标签标题编辑") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "后" } });
    fireEvent.blur(input);

    expect(useTabsStore.getState().tabs.find((t) => t.id === id)?.title).toBe(
      "后",
    );
  });

  it("unread > 0 → 圆点可见", () => {
    const a = useTabsStore.getState().addTab();
    const b = useTabsStore.getState().addTab();
    useTabsStore.getState().setActive(a);
    useTabsStore.getState().markUnread(b);
    render(<TabBar />);

    expect(screen.getByLabelText("1 条未读")).toBeTruthy();
  });

  it("unread === 0 → 圆点不在 DOM", () => {
    useTabsStore.getState().addTab();
    render(<TabBar />);

    expect(screen.queryByLabelText(/条未读/)).toBeNull();
  });

  // === Phase 3A T5：关闭 tab 二次确认 ===

  it("T5：sessionId 为 null（session 未开）→ 点 × 直接 closeTab，不查后端", async () => {
    const id = useTabsStore.getState().addTab();
    useTabsStore.getState().setTitle(id, "未开 session");
    render(<TabBar />);

    fireEvent.click(screen.getByLabelText("关闭标签"));

    await waitFor(() => {
      expect(useTabsStore.getState().tabs.find((t) => t.id === id)).toBeUndefined();
    });
    // 没 sessionId 就不应该调后端检测
    expect(mockHasRunning).not.toHaveBeenCalled();
  });

  it("T5：无运行中命令 → 直接 closeTab，不弹 dialog", async () => {
    mockHasRunning.mockResolvedValue(false);
    const id = useTabsStore.getState().addTab();
    useTabsStore.getState().setSessionId(id, "sess-1");
    useTabsStore.getState().setTitle(id, "干净 tab");
    render(<TabBar />);

    fireEvent.click(screen.getByLabelText("关闭标签"));

    await waitFor(() => {
      expect(mockHasRunning).toHaveBeenCalledWith("sess-1");
    });
    await waitFor(() => {
      expect(useTabsStore.getState().tabs.find((t) => t.id === id)).toBeUndefined();
    });
    // 不应该弹 dialog
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("T5：有运行中命令 → 弹 dialog 含 tab title，tab 不被关", async () => {
    mockHasRunning.mockResolvedValue(true);
    const id = useTabsStore.getState().addTab();
    useTabsStore.getState().setSessionId(id, "sess-2");
    useTabsStore.getState().setTitle(id, "跑 npm install 的 tab");
    render(<TabBar />);

    fireEvent.click(screen.getByLabelText("关闭标签"));

    // dialog 出现 + 含 title
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("跑 npm install 的 tab");
    // tab 还在
    expect(useTabsStore.getState().tabs.find((t) => t.id === id)).toBeDefined();
  });

  it("T5：dialog 点取消 → tab 保留，dialog 关闭", async () => {
    mockHasRunning.mockResolvedValue(true);
    const id = useTabsStore.getState().addTab();
    useTabsStore.getState().setSessionId(id, "sess-3");
    useTabsStore.getState().setTitle(id, "保留我");
    render(<TabBar />);

    fireEvent.click(screen.getByLabelText("关闭标签"));
    await screen.findByRole("dialog");

    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(useTabsStore.getState().tabs.find((t) => t.id === id)).toBeDefined();
  });

  it("T5：dialog 点强制关闭 → closeTab 被调", async () => {
    mockHasRunning.mockResolvedValue(true);
    const id = useTabsStore.getState().addTab();
    useTabsStore.getState().setSessionId(id, "sess-4");
    useTabsStore.getState().setTitle(id, "强关我");
    render(<TabBar />);

    fireEvent.click(screen.getByLabelText("关闭标签"));
    await screen.findByRole("dialog");

    fireEvent.click(screen.getByRole("button", { name: "关闭" }));

    await waitFor(() => {
      expect(useTabsStore.getState().tabs.find((t) => t.id === id)).toBeUndefined();
    });
  });

  // === v0.9.0 T3：右键菜单"重置为自动跟随目录" ===

  it("T3：auto_title=true 时右键不弹菜单", () => {
    const id = useTabsStore.getState().addTab();
    // auto_title 默认 true
    render(<TabBar />);
    const span = screen.getByText("新建标签");
    fireEvent.contextMenu(span.parentElement!);
    expect(screen.queryByRole("menu")).toBeNull();
    // 防止 lint 警告未使用 id
    expect(id).toBeTruthy();
  });

  it("T3：auto_title=false 时右键弹菜单含'重置为自动跟随目录'", () => {
    const id = useTabsStore.getState().addTab();
    useTabsStore.getState().setTitle(id, "我命名的"); // 转 false
    render(<TabBar />);
    fireEvent.contextMenu(screen.getByText("我命名的").parentElement!);
    const menu = screen.getByRole("menu");
    expect(menu).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: "重置为自动跟随目录" }),
    ).toBeTruthy();
  });

  it("T3：点击菜单项 → auto_title 切回 true 且按 cwd 刷 title", () => {
    const { addTab, setSessionId, applyCwdChange, setTitle } =
      useTabsStore.getState();
    const id = addTab();
    setSessionId(id, "sid-x");
    applyCwdChange("sid-x", "/Users/leo/aitm"); // title=aitm（auto=true）
    setTitle(id, "我命名的"); // 转 false
    render(<TabBar />);
    fireEvent.contextMenu(screen.getByText("我命名的").parentElement!);
    fireEvent.click(
      screen.getByRole("menuitem", { name: "重置为自动跟随目录" }),
    );
    const tab = useTabsStore.getState().tabs.find((t) => t.id === id);
    expect(tab?.auto_title).toBe(true);
    expect(tab?.title).toBe("aitm");
    // 菜单关闭
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("T5：检测失败 reject → 静默 fallback 直关，不阻塞用户", async () => {
    mockHasRunning.mockRejectedValue(new Error("ipc 炸了"));
    const id = useTabsStore.getState().addTab();
    useTabsStore.getState().setSessionId(id, "sess-5");
    useTabsStore.getState().setTitle(id, "fallback");
    // 抑制 console.warn 噪音
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(<TabBar />);

    fireEvent.click(screen.getByLabelText("关闭标签"));

    await waitFor(() => {
      expect(useTabsStore.getState().tabs.find((t) => t.id === id)).toBeUndefined();
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    warnSpy.mockRestore();
  });
});
