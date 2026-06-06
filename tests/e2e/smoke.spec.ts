import { expect, test } from "@playwright/test";
import { installTauriMock } from "./_mock-ipc";

test.beforeEach(async ({ page }) => {
  await installTauriMock(page);
});

test("应用启动后有 tab 栏", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByLabel("新建标签")).toBeVisible({ timeout: 5_000 });
});
