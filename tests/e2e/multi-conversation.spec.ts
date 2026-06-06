import { expect, test } from "@playwright/test";
import { installTauriMock } from "./_mock-ipc";

/**
 * 多对话切换 E2E。
 *
 * 完整 dropdown 交互在 vitest jsdom 里 Radix portal/pointer events 支持
 * 不完整，只能在真浏览器跑。这里测：
 * - 默认启动只有 "新对话 1"
 * - "+ 新对话" 创建并切换
 * - 切对话隔离消息上下文
 * - 删除对话切到下一个
 * - 删最后一个自动新建占位
 */

test.beforeEach(async ({ page }) => {
  await installTauriMock(page);
  await page.goto("/");
  await page.getByLabel("AI 助手").click();
});

async function openSwitcher(page: import("@playwright/test").Page) {
  await page.getByLabel("切换对话").click();
}

async function getCount(page: import("@playwright/test").Page) {
  return page.evaluate(() =>
    (window as unknown as { __getConversationCount: () => number }).__getConversationCount(),
  );
}

async function getActiveCid(page: import("@playwright/test").Page) {
  return page.evaluate(() =>
    (window as unknown as { __getChatCid: () => string }).__getChatCid(),
  );
}

test("默认启动 1 个对话，trigger 显示 '新对话 1'", async ({ page }) => {
  await expect(page.getByLabel("切换对话")).toContainText("新对话 1");
  expect(await getCount(page)).toBe(1);
});

test("点 + 新对话 创建并切到新的", async ({ page }) => {
  const cidBefore = await getActiveCid(page);

  await openSwitcher(page);
  await page.getByRole("menuitem", { name: "新建对话" }).click();

  // dropdown 关闭，trigger 变 "新对话 2"
  await expect(page.getByLabel("切换对话")).toContainText("新对话 2");
  expect(await getCount(page)).toBe(2);
  const cidAfter = await getActiveCid(page);
  expect(cidAfter).not.toBe(cidBefore);
});

test("切到旧对话再切回 — active 在两者间切换", async ({ page }) => {
  const id1 = await getActiveCid(page);

  await openSwitcher(page);
  await page.getByRole("menuitem", { name: "新建对话" }).click();
  const id2 = await getActiveCid(page);
  expect(id2).not.toBe(id1);

  // 切回 id1
  await openSwitcher(page);
  await page.getByLabel("切换到对话 新对话 1").click();
  expect(await getActiveCid(page)).toBe(id1);
  await expect(page.getByLabel("切换对话")).toContainText("新对话 1");

  // 再切到 id2
  await openSwitcher(page);
  await page.getByLabel("切换到对话 新对话 2").click();
  expect(await getActiveCid(page)).toBe(id2);
});

test("删除非 active 对话 — 列表少一项 active 不变", async ({ page }) => {
  // 创建第二个对话（active 切到它）
  await openSwitcher(page);
  await page.getByRole("menuitem", { name: "新建对话" }).click();
  const activeId = await getActiveCid(page);
  expect(await getCount(page)).toBe(2);

  // 删除"新对话 1"（不是 active）
  await openSwitcher(page);
  await page.getByLabel("删除对话 新对话 1").click();

  expect(await getCount(page)).toBe(1);
  expect(await getActiveCid(page)).toBe(activeId);
});

test("删除最后一个对话 — 自动新建占位保持 1 个", async ({ page }) => {
  const idBefore = await getActiveCid(page);
  expect(await getCount(page)).toBe(1);

  await openSwitcher(page);
  await page.getByLabel("删除对话 新对话 1").click();

  // 自动新建占位
  expect(await getCount(page)).toBe(1);
  const idAfter = await getActiveCid(page);
  expect(idAfter).not.toBe(idBefore);
});

test("✎ 重命名按钮：点击后 input 进入编辑态 + Enter 保存", async ({ page }) => {
  await openSwitcher(page);
  await page.getByLabel("重命名对话 新对话 1").click();

  const input = page.getByLabel("对话标题编辑");
  await expect(input).toBeVisible();
  await input.fill("我的工作笔记");
  await input.press("Enter");

  // 新标题反映到 trigger
  await expect(page.getByLabel("切换对话")).toContainText("我的工作笔记");
});
