import { expect, test } from "@playwright/test";
import { installTauriMock } from "./_mock-ipc";

/**
 * v0.7.0-A：SettingsModal 隐私 section toggle E2E（v0.7.1-A T5）。
 *
 * 单测（PrivacySection.test.tsx）已验过 toggle → store 翻转 + 文案。
 * 这里在真浏览器里走完整链路：
 *  - 打开 SettingsModal → 切到"隐私"tab → toggle 默认 ON
 *  - 点击 toggle → mock 收到 settings_update payload，privacy.analytics_opt_in=false
 *  - 再点 → settings_update payload，privacy.analytics_opt_in=true
 *  - 关闭重开 → toggle 状态保留（zustand store 没重置）
 *
 * 注：settings store update 是 debounced 300ms 写后端，断言 `__lastSavedSettings`
 *     时用 expect.poll 避免 timing flake。
 */

test.beforeEach(async ({ page }) => {
  await installTauriMock(page);
  await page.goto("/");
  await page.getByLabel("设置").click();
  await page.getByRole("tab", { name: "隐私" }).click();
});

test("隐私 tab 默认 ON（fixture analytics_opt_in=true）", async ({ page }) => {
  await expect(page.getByRole("tab", { name: "隐私" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  const toggle = page.getByLabel("参与匿名使用统计");
  await expect(toggle).toBeVisible();
  await expect(toggle).toBeChecked();
});

test("点击 toggle → settings_update payload privacy.analytics_opt_in=false", async ({
  page,
}) => {
  const toggle = page.getByLabel("参与匿名使用统计");
  await expect(toggle).toBeChecked();

  await toggle.click();
  await expect(toggle).not.toBeChecked();

  // debounced 300ms 写后端，轮询 mock 收到的 settings
  await expect
    .poll(
      async () =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __lastSavedSettings?: {
                  privacy?: { analytics_opt_in?: boolean };
                };
              }
            ).__lastSavedSettings?.privacy?.analytics_opt_in,
        ),
      { timeout: 2_000 },
    )
    .toBe(false);
});

test("再点 toggle → 回到 ON + payload analytics_opt_in=true", async ({
  page,
}) => {
  const toggle = page.getByLabel("参与匿名使用统计");

  // 先关一次
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect
    .poll(
      async () =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __lastSavedSettings?: {
                  privacy?: { analytics_opt_in?: boolean };
                };
              }
            ).__lastSavedSettings?.privacy?.analytics_opt_in,
        ),
      { timeout: 2_000 },
    )
    .toBe(false);

  // 再开
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect
    .poll(
      async () =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __lastSavedSettings?: {
                  privacy?: { analytics_opt_in?: boolean };
                };
              }
            ).__lastSavedSettings?.privacy?.analytics_opt_in,
        ),
      { timeout: 2_000 },
    )
    .toBe(true);
});

test("关闭 modal 重开 → toggle 状态保留", async ({ page }) => {
  const toggle = page.getByLabel("参与匿名使用统计");
  await toggle.click();
  await expect(toggle).not.toBeChecked();

  // 等 debounced 写后端确认 store 已同步
  await expect
    .poll(
      async () =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __lastSavedSettings?: {
                  privacy?: { analytics_opt_in?: boolean };
                };
              }
            ).__lastSavedSettings?.privacy?.analytics_opt_in,
        ),
      { timeout: 2_000 },
    )
    .toBe(false);

  // 关 modal
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "设置" })).not.toBeVisible();

  // 重开 → 仍在隐私 tab + toggle 仍 OFF（SettingsModal useState 不重置 +
  // store privacy 字段不变）
  await page.getByLabel("设置").click();
  await expect(page.getByRole("tab", { name: "隐私" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByLabel("参与匿名使用统计")).not.toBeChecked();
});
