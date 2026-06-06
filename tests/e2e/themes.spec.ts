import { expect, test } from "@playwright/test";
import { installTauriMock } from "./_mock-ipc";

/**
 * 终端主题切换 E2E。
 *
 * 主题色卡 click 切换在 jsdom 不可靠（涉及 Radix Tabs 的 pointer 事件
 * 内的子组件），所以放真浏览器跑。这里测：
 * - 默认 8 个色卡，default 是 active
 * - 点 Dracula → store/settings_update payload 含 theme="dracula"
 * - 点击其他主题 → active 切换
 */

test.beforeEach(async ({ page }) => {
  await installTauriMock(page);
  await page.goto("/");
  await page.getByLabel("设置").click();
  // 终端 tab 默认 active；主题 section 在终端 tab 内，无需切换
});

test("终端 tab 渲染 8 个主题色卡", async ({ page }) => {
  const radioGroup = page.getByRole("radiogroup", { name: "终端主题" });
  await expect(radioGroup).toBeVisible();

  for (const name of [
    "默认",
    "Dracula",
    "Solarized Dark",
    "Solarized Light",
    "One Dark",
    "Homebrew",
    "Warp",
    "Catppuccin Mocha",
  ]) {
    await expect(
      page.getByRole("radio", { name: `主题 ${name}` }),
    ).toBeVisible();
  }
});

test("默认 active 是 default 主题", async ({ page }) => {
  const def = page.getByRole("radio", { name: "主题 默认" });
  await expect(def).toHaveAttribute("aria-checked", "true");
});

test("点 Dracula → settings_update payload 含 theme='dracula'", async ({
  page,
}) => {
  await page.getByRole("radio", { name: "主题 Dracula" }).click();

  // active 切到 Dracula
  await expect(
    page.getByRole("radio", { name: "主题 Dracula" }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(
    page.getByRole("radio", { name: "主题 默认" }),
  ).toHaveAttribute("aria-checked", "false");

  // store update 是 debounced 写后端（300ms）；轮询拿 mock 收到的 settings
  await expect
    .poll(
      async () =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __lastSavedSettings?: { terminal?: { theme?: string } };
              }
            ).__lastSavedSettings?.terminal?.theme,
        ),
      { timeout: 2_000 },
    )
    .toBe("dracula");
});

test("切多个主题 → active 跟随最新选择", async ({ page }) => {
  await page.getByRole("radio", { name: "主题 One Dark" }).click();
  await expect(
    page.getByRole("radio", { name: "主题 One Dark" }),
  ).toHaveAttribute("aria-checked", "true");

  await page.getByRole("radio", { name: "主题 Solarized Light" }).click();
  await expect(
    page.getByRole("radio", { name: "主题 Solarized Light" }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(
    page.getByRole("radio", { name: "主题 One Dark" }),
  ).toHaveAttribute("aria-checked", "false");
});
