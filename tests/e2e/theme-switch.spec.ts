import { expect, test } from "@playwright/test";
import { installTauriMock } from "./_mock-ipc";

/**
 * v0.4.1 T5 + v0.6.0 应用主题模式切换 E2E（v0.7.1-A T5）。
 *
 * 单测 (theme.test.ts) 已验过 applyTheme('dark'/'light'/'auto') 写
 * document.documentElement.dataset.theme。这里在真浏览器跑完整链路：
 *  - 默认 fixture theme_mode=dark → dataset.theme === "dark"
 *  - SettingsModal "外观" tab → 选 "浅色" radio → dataset.theme === "light"
 *  - 选 "跟随系统" → dataset.theme 为 dark 或 light（取决于 prefers-color-scheme）
 *  - 选回 "深色"
 *  - 关 modal 重开 → store theme_mode 保留（zustand 没重置）+ dataset.theme 同步
 *
 * playwright 默认 prefers-color-scheme: light（chromium 默认）。
 */

test.beforeEach(async ({ page }) => {
  await installTauriMock(page);
  await page.goto("/");
});

test("默认 dark：document.dataset.theme === 'dark'", async ({ page }) => {
  await expect
    .poll(async () => page.evaluate(() => document.documentElement.dataset.theme), {
      timeout: 2_000,
    })
    .toBe("dark");
});

test("切到 浅色 → dataset.theme === 'light' + settings_update", async ({
  page,
}) => {
  await page.getByLabel("设置").click();
  await page.getByRole("tab", { name: "外观" }).click();

  // 切 "浅色"
  await page.getByLabel("主题模式 浅色").click();

  await expect
    .poll(async () => page.evaluate(() => document.documentElement.dataset.theme), {
      timeout: 2_000,
    })
    .toBe("light");

  // 验 settings_update payload theme_mode=light（debounced 300ms）
  await expect
    .poll(
      async () =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __lastSavedSettings?: { ui?: { theme_mode?: string } };
              }
            ).__lastSavedSettings?.ui?.theme_mode,
        ),
      { timeout: 2_000 },
    )
    .toBe("light");
});

test("切到 跟随系统 → dataset.theme = 'dark' 或 'light'（取决于系统）", async ({
  page,
}) => {
  await page.getByLabel("设置").click();
  await page.getByRole("tab", { name: "外观" }).click();

  await page.getByLabel("主题模式 跟随系统").click();

  // auto 解析：matchMedia(prefers-color-scheme: light) 命中 → light，否则 dark
  // 不预设具体值，只断言取一个有效解析值
  await expect
    .poll(async () => page.evaluate(() => document.documentElement.dataset.theme), {
      timeout: 2_000,
    })
    .toMatch(/^(dark|light)$/);

  // settings_update payload theme_mode=auto
  await expect
    .poll(
      async () =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __lastSavedSettings?: { ui?: { theme_mode?: string } };
              }
            ).__lastSavedSettings?.ui?.theme_mode,
        ),
      { timeout: 2_000 },
    )
    .toBe("auto");
});

test("切回 深色 → dataset.theme === 'dark'", async ({ page }) => {
  await page.getByLabel("设置").click();
  await page.getByRole("tab", { name: "外观" }).click();

  // 先切到浅色
  await page.getByLabel("主题模式 浅色").click();
  await expect
    .poll(async () => page.evaluate(() => document.documentElement.dataset.theme), {
      timeout: 2_000,
    })
    .toBe("light");

  // 切回深色
  await page.getByLabel("主题模式 深色").click();
  await expect
    .poll(async () => page.evaluate(() => document.documentElement.dataset.theme), {
      timeout: 2_000,
    })
    .toBe("dark");
});

test("关 modal 重开 → 主题状态保留（store 不重置）", async ({ page }) => {
  await page.getByLabel("设置").click();
  await page.getByRole("tab", { name: "外观" }).click();

  await page.getByLabel("主题模式 浅色").click();
  await expect
    .poll(async () => page.evaluate(() => document.documentElement.dataset.theme), {
      timeout: 2_000,
    })
    .toBe("light");

  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "设置" })).not.toBeVisible();

  // 重开 — 仍在外观 tab + radio "浅色" checked + dataset.theme 仍 light
  await page.getByLabel("设置").click();
  await expect(page.getByRole("tab", { name: "外观" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByLabel("主题模式 浅色")).toBeChecked();
  await expect(page.evaluate(() => document.documentElement.dataset.theme)).resolves.toBe(
    "light",
  );
});
