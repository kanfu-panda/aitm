import { expect, test } from "@playwright/test";
import { installTauriMock } from "./_mock-ipc";

test.beforeEach(async ({ page }) => {
  await installTauriMock(page);
});

test("初次启动有 1 个 tab", async ({ page }) => {
  await page.goto("/");
  // 等 store 自动开 tab
  await expect(page.getByText("新标签")).toBeVisible({ timeout: 5_000 });
});

test("点 + 按钮后 tab 数量增加", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("新标签").first()).toBeVisible({ timeout: 5_000 });

  await page.getByLabel("新建标签").click();
  await page.getByLabel("新建标签").click();

  const tabs = page.getByText("新标签");
  await expect(tabs).toHaveCount(3);
});

test("点 × 后 tab 数量减少", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("新建标签").click(); // 现在 2 个
  await expect(page.getByText("新标签")).toHaveCount(2);

  // 关掉第一个
  await page.getByLabel("关闭标签").first().click();
  await expect(page.getByText("新标签")).toHaveCount(1);
});
