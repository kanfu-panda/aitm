import { expect, test } from "@playwright/test";
import { installTauriMock } from "./_mock-ipc";

// v0.4.2 patch T1：FileTree 从 v0.3.0 起就存在但 ActivityBar 漏接入口；
// 这一组 e2e 验证文件树按钮 ↔ FileTree 面板的可见性互通。

test("默认 FileTree 不可见", async ({ page }) => {
  await installTauriMock(page);
  await page.goto("/");

  // ActivityBar 起来后文件树按钮应可见
  await expect(page.getByTestId("activity-bar-item-file-tree")).toBeVisible({
    timeout: 5_000,
  });
  // FileTree 面板默认隐藏
  await expect(page.getByTestId("file-tree")).not.toBeVisible();
});

test("点 ActivityBar 文件树按钮 → FileTree 出现，再点 → 消失", async ({
  page,
}) => {
  await installTauriMock(page);
  await page.goto("/");

  const btn = page.getByTestId("activity-bar-item-file-tree");
  await expect(btn).toBeVisible({ timeout: 5_000 });

  // 第一次点：FileTree 出现
  await btn.click();
  await expect(page.getByTestId("file-tree")).toBeVisible();

  // 第二次点：FileTree 消失
  await btn.click();
  await expect(page.getByTestId("file-tree")).not.toBeVisible();
});

test("Cmd+B 快捷键也能切换 FileTree（与按钮等效）", async ({ page }) => {
  await installTauriMock(page);
  await page.goto("/");
  await expect(page.getByTestId("activity-bar-item-file-tree")).toBeVisible({
    timeout: 5_000,
  });

  await page.keyboard.press("Meta+b");
  await expect(page.getByTestId("file-tree")).toBeVisible();

  await page.keyboard.press("Meta+b");
  await expect(page.getByTestId("file-tree")).not.toBeVisible();
});
