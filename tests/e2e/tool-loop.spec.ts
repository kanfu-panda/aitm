import { expect, test } from "@playwright/test";
import { installTauriMock } from "./_mock-ipc";

/**
 * 工具调用循环 UI E2E。
 *
 * 后端事件机制由集成测试 `tool_loop_integration.rs` 覆盖；这里只测前端：
 * - ai:tool_started / ai:tool_finished → ToolCallBubble 状态流转
 * - ai:tool_request risk=high → ConfirmDialog 弹出 + 拒绝按钮
 * - risk=destructive → 必须输入"确认"才解锁批准按钮
 *
 * 关键技巧：onAiToolRequest 等订阅会按 conversation_id 过滤，spec 通过
 * `window.__getChatCid()` 读取 store 当前 cid，再用 `__emitMockEvent` 注入。
 */

test.beforeEach(async ({ page }) => {
  await installTauriMock(page);
  await page.goto("/");
  await page.getByLabel("AI 助手").click();
  // 等聊天输入框出现，确保 store 已挂 + 订阅已建立
  await expect(page.getByPlaceholder(/输入消息/)).toBeVisible({ timeout: 5_000 });
});

test("LOW 风险：tool_started → tool_finished 直接显示完成气泡", async ({ page }) => {
  const cid = await page.evaluate(() =>
    (window as unknown as { __getChatCid: () => string }).__getChatCid(),
  );

  // 模拟后端：低风险工具不发 tool_request，直接 started + finished
  await page.evaluate((cid) => {
    const emit = (window as unknown as {
      __emitMockEvent: (e: string, p: unknown) => void;
    }).__emitMockEvent;
    emit("ai:tool_started", {
      conversation_id: cid,
      call_id: "low-1",
      name: "read_file",
    });
    emit("ai:tool_finished", {
      conversation_id: cid,
      call_id: "low-1",
      content: "hello world",
      is_error: false,
    });
  }, cid);

  // ConfirmDialog 不应弹出（只过 started/finished 不过 request）
  await expect(page.getByText("AI 请求执行工具")).toBeHidden();

  // ToolCallBubble 显示完成状态（v0.10.0 HR6-2 折叠态：状态文字进 aria-label，
  // role="status" 内只剩 icon；用 aria-label 选择代替 hasText）
  await expect(page.getByRole("status", { name: "完成" })).toBeVisible();
  await expect(page.getByText("read_file")).toBeVisible();
});

test("HIGH 风险：弹 ConfirmDialog → 点拒绝 → 关闭并记录拒绝", async ({ page }) => {
  const cid = await page.evaluate(() =>
    (window as unknown as { __getChatCid: () => string }).__getChatCid(),
  );

  await page.evaluate((cid) => {
    const emit = (window as unknown as {
      __emitMockEvent: (e: string, p: unknown) => void;
    }).__emitMockEvent;
    emit("ai:tool_request", {
      conversation_id: cid,
      call_id: "high-1",
      name: "run_command",
      args_preview: '{\n  "cmd": "ls"\n}',
      risk: "high",
    });
  }, cid);

  // 对话框出现（用 role=dialog 限定，避免和 ToolCallBubble 的 args 重影）
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('"cmd": "ls"')).toBeVisible();

  // 点拒绝
  await page.getByRole("button", { name: "拒绝" }).click();

  // 对话框关闭
  await expect(page.getByText("AI 请求执行工具")).toBeHidden();

  // mock 收到 ai_tool_reject
  const decision = await page.evaluate(
    () =>
      (window as unknown as {
        __lastApprovalDecision: { call_id?: string; approved?: boolean };
      }).__lastApprovalDecision,
  );
  expect(decision.call_id).toBe("high-1");
  expect(decision.approved).toBe(false);
});

test("DESTRUCTIVE 风险：未输入'确认'时批准按钮 disabled", async ({ page }) => {
  const cid = await page.evaluate(() =>
    (window as unknown as { __getChatCid: () => string }).__getChatCid(),
  );

  await page.evaluate((cid) => {
    const emit = (window as unknown as {
      __emitMockEvent: (e: string, p: unknown) => void;
    }).__emitMockEvent;
    emit("ai:tool_request", {
      conversation_id: cid,
      call_id: "dest-1",
      name: "run_command",
      args_preview: '{\n  "cmd": "rm -rf node_modules"\n}',
      risk: "destructive",
    });
  }, cid);

  // 危险变体的标题
  await expect(page.getByText("⚠ AI 请求执行危险操作")).toBeVisible();

  // 批准按钮初始 disabled
  const approveBtn = page.getByRole("button", { name: "批准" });
  await expect(approveBtn).toBeDisabled();

  // 输入错字仍 disabled
  await page.getByLabel("危险操作确认输入").fill("ok");
  await expect(approveBtn).toBeDisabled();
});

test("DESTRUCTIVE：输入'确认'解锁批准 → 点批准 → 记录批准", async ({ page }) => {
  const cid = await page.evaluate(() =>
    (window as unknown as { __getChatCid: () => string }).__getChatCid(),
  );

  await page.evaluate((cid) => {
    const emit = (window as unknown as {
      __emitMockEvent: (e: string, p: unknown) => void;
    }).__emitMockEvent;
    emit("ai:tool_request", {
      conversation_id: cid,
      call_id: "dest-2",
      name: "run_command",
      args_preview: '{\n  "cmd": "rm -rf build"\n}',
      risk: "destructive",
    });
  }, cid);

  await expect(page.getByText("⚠ AI 请求执行危险操作")).toBeVisible();
  const approveBtn = page.getByRole("button", { name: "批准" });
  await expect(approveBtn).toBeDisabled();

  // 输入"确认"
  await page.getByLabel("危险操作确认输入").fill("确认");
  await expect(approveBtn).toBeEnabled();

  await approveBtn.click();
  await expect(page.getByText("⚠ AI 请求执行危险操作")).toBeHidden();

  const decision = await page.evaluate(
    () =>
      (window as unknown as {
        __lastApprovalDecision: { call_id?: string; approved?: boolean };
      }).__lastApprovalDecision,
  );
  expect(decision.call_id).toBe("dest-2");
  expect(decision.approved).toBe(true);
});
