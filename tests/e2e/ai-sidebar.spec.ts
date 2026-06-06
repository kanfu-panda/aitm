import { expect, test } from "@playwright/test";
import { installTauriMock } from "./_mock-ipc";

// v0.4.1 T2：AI sidebar toggle 已从侧栏顶部 ✦ 按钮迁移到 ActivityBar 的
// Sparkles 按钮（aria-label="AI 助手"）。原 "展开 AI 侧栏" label 不再存在。

test("默认侧栏折叠，点 ActivityBar AI 按钮展开", async ({ page }) => {
  await installTauriMock(page);
  await page.goto("/");

  await expect(page.getByLabel("AI 助手")).toBeVisible({ timeout: 5_000 });
  await page.getByLabel("AI 助手").click();
  await expect(page.getByLabel("切换对话")).toBeVisible();
});

test("Cmd+/ 切换侧栏", async ({ page }) => {
  await installTauriMock(page);
  await page.goto("/");
  await expect(page.getByLabel("AI 助手")).toBeVisible({ timeout: 5_000 });

  await page.keyboard.press("Meta+/");
  await expect(page.getByLabel("切换对话")).toBeVisible();
  await page.keyboard.press("Meta+/");
  // 关闭后 ConversationSwitcher 不再渲染（AiSidebar 收起时返回 null）
  await expect(page.getByLabel("切换对话")).not.toBeVisible();
});

test("有 provider 时显示输入框", async ({ page }) => {
  await installTauriMock(page);
  await page.goto("/");
  await page.getByLabel("AI 助手").click();

  await expect(
    page.getByPlaceholder(/输入消息/),
  ).toBeVisible({ timeout: 5_000 });
});

test("无 provider 时显示空态提示", async ({ page }) => {
  await installTauriMock(page, { noProviders: true });
  await page.goto("/");
  await page.getByLabel("AI 助手").click();

  await expect(page.getByText("请先配置 AI Provider")).toBeVisible({ timeout: 5_000 });
});
