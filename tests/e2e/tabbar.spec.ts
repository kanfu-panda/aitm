import { expect, test } from "@playwright/test";
import { installTauriMock } from "./_mock-ipc";

test.beforeEach(async ({ page }) => {
  await installTauriMock(page);
});

// 终端 tab 用 role="tab" 计数，不依赖标题文案：
// 标题在 addTab() 时按当时 i18n 语言快照成普通字符串（启动早期常是默认
// 英文 "New Tab"），切语言后已存在 tab 不会重翻译，所以按 getByText(标题)
// 断言数量不稳。role="tab" 与 locale 无关，是稳健选择。

test("初次启动有 1 个 tab", async ({ page }) => {
  await page.goto("/");
  // 等 store 自动开 tab
  await expect(page.getByRole("tab")).toHaveCount(1, { timeout: 5_000 });
});

test("点 + 按钮后 tab 数量增加", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("tab")).toHaveCount(1, { timeout: 5_000 });

  await page.getByLabel("新建标签").click();
  await page.getByLabel("新建标签").click();

  await expect(page.getByRole("tab")).toHaveCount(3);
});

test("点 × 后 tab 数量减少", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("新建标签").click(); // 现在 2 个
  await expect(page.getByRole("tab")).toHaveCount(2);

  // 关掉第一个
  await page.getByLabel("关闭标签").first().click();
  await expect(page.getByRole("tab")).toHaveCount(1);
});
