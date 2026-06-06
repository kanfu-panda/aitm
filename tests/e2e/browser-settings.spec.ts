import { expect, test } from "@playwright/test";
import { installTauriMock } from "./_mock-ipc";

/**
 * Phase 4A T5：浏览器设置 tab E2E。
 *
 * vitest 已覆盖 BrowserSettingsSection 渲染 + clamp 边界 + store 写入；
 * 这里在真浏览器里验证：
 * - SettingsModal 加了第 4 个 "浏览器" tab，可点击切换到
 * - 改 input → mock IPC settings_update payload 含 browser 字段
 *
 * Radix Tabs 的 click 切换走 pointer events，jsdom 不可靠，必须 e2e。
 */

test.beforeEach(async ({ page }) => {
  await installTauriMock(page);
  await page.goto("/");
  await page.getByLabel("设置").click();
});

test("SettingsModal 显示全部 tab（外观 / 终端 / AI Provider / Safety / 浏览器）", async ({
  page,
}) => {
  // v0.4.1 T2 加了"外观"tab；其余保持
  await expect(page.getByRole("tab", { name: "外观" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "终端" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "AI Provider" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Safety" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "浏览器" })).toBeVisible();
});

test("切到浏览器 tab → 看到 active 上限 + 失焦超时 input", async ({
  page,
}) => {
  await page.getByRole("tab", { name: "浏览器" }).click();
  await expect(
    page.getByRole("tab", { name: "浏览器" }),
  ).toHaveAttribute("aria-selected", "true");

  await expect(page.getByLabel("同时 active 上限")).toBeVisible();
  await expect(
    page.getByLabel("失焦自动 suspend 时间（分钟）"),
  ).toBeVisible();
  // 默认值显示
  await expect(page.getByLabel("同时 active 上限")).toHaveValue("3");
  await expect(
    page.getByLabel("失焦自动 suspend 时间（分钟）"),
  ).toHaveValue("5");
  // 内存预算文案
  await expect(page.getByText(/\+450\s*MB/)).toBeVisible();
});

test("改 max_active_tabs → settings_update payload 含 browser 字段", async ({
  page,
}) => {
  await page.getByRole("tab", { name: "浏览器" }).click();

  const input = page.getByLabel("同时 active 上限");
  await input.fill("5");
  // input 后默认 onchange 已写入 store；debounced 300ms 后调 settings_update
  await page.waitForTimeout(400);

  // 内存预算从 450 → 750 MB
  await expect(page.getByText(/\+750\s*MB/)).toBeVisible();

  // mock IPC 记录的最后一条 settings_update payload 应含 browser
  const saved = await page.evaluate(
    () =>
      (
        window as unknown as {
          __lastSavedSettings: {
            browser?: { max_active_tabs: number; suspend_timer_minutes: number };
          };
        }
      ).__lastSavedSettings,
  );
  expect(saved?.browser?.max_active_tabs).toBe(5);
});

test("改 suspend_timer_minutes 输入超 60 → 自动夹紧到 60", async ({
  page,
}) => {
  await page.getByRole("tab", { name: "浏览器" }).click();

  const input = page.getByLabel("失焦自动 suspend 时间（分钟）");
  await input.fill("999");
  // 触发 React onchange 后 input 显示已被 clamp 改写
  // input.fill 会触发 change/blur，但 React 受控输入需要等下一帧
  await page.waitForTimeout(50);

  await expect(input).toHaveValue("60");
});
