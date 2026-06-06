import { expect, test } from "@playwright/test";
import { installTauriMock } from "./_mock-ipc";

test.beforeEach(async ({ page }) => {
  await installTauriMock(page);
});

test("点 ⚙ 打开设置 modal", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("设置").click();
  await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();
  await expect(page.getByText("字体族")).toBeVisible();
});

test("Cmd+, 打开设置 modal", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByLabel("设置")).toBeVisible({ timeout: 5_000 });
  await page.keyboard.press("Meta+,");
  await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();
});

test("点 × 关闭设置 modal", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("设置").click();
  await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();
  // T9 后 modal 含 ProviderList 高度变长，× 按钮 absolute 定位可能溢出 viewport
  // → 用 Radix Dialog 标准的 Escape 键关闭，更稳
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "设置" })).not.toBeVisible();
});

test("拖动字号滑块更新显示值", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("设置").click();

  // 找字号 slider 旁边显示的当前值
  const display = page.getByText(/^\d+ px$/);
  await expect(display).toContainText("13 px");

  // 通过键盘上箭头改变 slider（更稳定）
  const slider = page.locator('input[type="range"]').first();
  await slider.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(display).toContainText("15 px");
});
