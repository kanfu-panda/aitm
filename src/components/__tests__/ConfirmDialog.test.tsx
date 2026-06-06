import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ConfirmDialog from "../ConfirmDialog";
import type { AiToolRequestEvent } from "../../lib/tauri";

// 测试夹具：把 onAiToolRequest 注入的 callback 暴露给测试代码，
// 测试主动触发"后端事件到达"。
const requestCallbacks: Array<(e: AiToolRequestEvent) => void> = [];

vi.mock("../../lib/tauri", async (orig) => {
  const real = await orig<typeof import("../../lib/tauri")>();
  return {
    ...real,
    aiToolApprove: vi.fn().mockResolvedValue(undefined),
    aiToolReject: vi.fn().mockResolvedValue(undefined),
    browserHideAllActive: vi.fn().mockResolvedValue(undefined),
    browserShowAllActive: vi.fn().mockResolvedValue(undefined),
    onAiToolRequest: vi.fn(
      async (_cid: string, cb: (e: AiToolRequestEvent) => void) => {
        requestCallbacks.push(cb);
        return () => {
          const idx = requestCallbacks.indexOf(cb);
          if (idx >= 0) requestCallbacks.splice(idx, 1);
        };
      },
    ),
  };
});

import {
  aiToolApprove,
  aiToolReject,
  browserHideAllActive,
  browserShowAllActive,
} from "../../lib/tauri";

const mockApprove = aiToolApprove as unknown as ReturnType<typeof vi.fn>;
const mockReject = aiToolReject as unknown as ReturnType<typeof vi.fn>;
const mockHide = browserHideAllActive as unknown as ReturnType<typeof vi.fn>;
const mockShow = browserShowAllActive as unknown as ReturnType<typeof vi.fn>;

function fireRequest(event: Partial<AiToolRequestEvent>) {
  const full: AiToolRequestEvent = {
    conversation_id: "conv-1",
    call_id: "call-1",
    name: "run_command",
    args_preview: '{"cmd":"ls -la"}',
    risk: "high",
    ...event,
  };
  act(() => {
    for (const cb of [...requestCallbacks]) cb(full);
  });
}

describe("ConfirmDialog", () => {
  beforeEach(() => {
    requestCallbacks.length = 0;
    mockApprove.mockClear();
    mockReject.mockClear();
    mockHide.mockClear();
    mockShow.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("HIGH 风险：默认聚焦拒绝按钮（防误点）", async () => {
    render(<ConfirmDialog conversationId="conv-1" />);
    // 等待 useEffect 注册回调
    await waitFor(() => expect(requestCallbacks.length).toBe(1));

    fireRequest({ risk: "high", name: "run_command" });

    await waitFor(() => {
      const rejectBtn = screen.getByRole("button", { name: "拒绝" });
      expect(document.activeElement).toBe(rejectBtn);
    });
  });

  it("DESTRUCTIVE 风险：输错字 → 批准按钮 disabled", async () => {
    render(<ConfirmDialog conversationId="conv-1" />);
    await waitFor(() => expect(requestCallbacks.length).toBe(1));

    fireRequest({ risk: "destructive", name: "run_command" });

    const input = await screen.findByLabelText("危险操作确认输入");
    fireEvent.change(input, { target: { value: "随便" } });

    const approveBtn = screen.getByRole("button", { name: "批准" });
    expect(approveBtn).toBeDisabled();
  });

  it("DESTRUCTIVE 风险：输入'确认' → 解锁批准 → 调用 aiToolApprove", async () => {
    render(<ConfirmDialog conversationId="conv-1" />);
    await waitFor(() => expect(requestCallbacks.length).toBe(1));

    fireRequest({
      risk: "destructive",
      name: "run_command",
      call_id: "call-destr-1",
    });

    const input = await screen.findByLabelText("危险操作确认输入");
    fireEvent.change(input, { target: { value: "确认" } });

    const approveBtn = screen.getByRole("button", { name: "批准" });
    expect(approveBtn).not.toBeDisabled();

    fireEvent.click(approveBtn);

    await waitFor(() => expect(mockApprove).toHaveBeenCalledTimes(1));
    expect(mockApprove).toHaveBeenCalledWith("call-destr-1");
    expect(mockReject).not.toHaveBeenCalled();
  });

  it("点拒绝按钮 → 调用 aiToolReject", async () => {
    render(<ConfirmDialog conversationId="conv-1" />);
    await waitFor(() => expect(requestCallbacks.length).toBe(1));

    fireRequest({ risk: "high", call_id: "call-r" });

    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));

    await waitFor(() => expect(mockReject).toHaveBeenCalledTimes(1));
    expect(mockReject).toHaveBeenCalledWith("call-r");
    expect(mockApprove).not.toHaveBeenCalled();
  });

  it("HIGH 风险：批准按钮可直接点击（无需输入确认）", async () => {
    render(<ConfirmDialog conversationId="conv-1" />);
    await waitFor(() => expect(requestCallbacks.length).toBe(1));

    fireRequest({ risk: "high", call_id: "call-h" });

    const approveBtn = await screen.findByRole("button", { name: "批准" });
    expect(approveBtn).not.toBeDisabled();
    fireEvent.click(approveBtn);

    await waitFor(() => expect(mockApprove).toHaveBeenCalledWith("call-h"));
  });

  it("risk_reason 字段：弹窗显示评分原因", async () => {
    render(<ConfirmDialog conversationId="conv-1" />);
    await waitFor(() => expect(requestCallbacks.length).toBe(1));

    fireRequest({
      risk: "high",
      name: "run_command",
      risk_reason: "L2：默认（无明显风险信号）",
    });

    const reason = await screen.findByLabelText("风险评分原因");
    expect(reason).toHaveTextContent("L2：默认");
  });

  it("无 risk_reason 不渲染评分原因区块", async () => {
    render(<ConfirmDialog conversationId="conv-1" />);
    await waitFor(() => expect(requestCallbacks.length).toBe(1));

    fireRequest({ risk: "high", name: "read_file" });

    await screen.findByText("read_file");
    expect(screen.queryByLabelText("风险评分原因")).toBeNull();
  });

  // v0.4.2 T3：useBrowserModalGuard 接入验证（WKWebView 让位）
  it("dialog 弹起时调 browserHideAllActive（webview 让位）", async () => {
    render(<ConfirmDialog conversationId="conv-1" />);
    await waitFor(() => expect(requestCallbacks.length).toBe(1));

    // 初始无 pending 不应触发 hide
    expect(mockHide).not.toHaveBeenCalled();

    fireRequest({ risk: "high", name: "run_command" });

    await waitFor(() => expect(mockHide).toHaveBeenCalledTimes(1));
  });

  it("dialog 关闭（批准）后调 browserShowAllActive（恢复 webview）", async () => {
    render(<ConfirmDialog conversationId="conv-1" />);
    await waitFor(() => expect(requestCallbacks.length).toBe(1));

    fireRequest({ risk: "high", name: "run_command", call_id: "call-guard" });
    await waitFor(() => expect(mockHide).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "批准" }));

    await waitFor(() => expect(mockShow).toHaveBeenCalledTimes(1));
  });
});
