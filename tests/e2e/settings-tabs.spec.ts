import { expect, test } from "@playwright/test";
import { installTauriMock } from "./_mock-ipc";

/**
 * B-1：SettingsModal Tab 布局 E2E。
 *
 * vitest 浅渲染只测了静态属性（默认 active / a11y / 关闭态）；
 * Radix Tabs 的 click 切换走 pointer events，jsdom 不可靠。
 * 这里在真浏览器里验证 tab 切换 + 各 tab 内容互斥可见。
 */

test.beforeEach(async ({ page }) => {
  await installTauriMock(page);
  await page.goto("/");
  await page.getByLabel("设置").click();
});

test("默认进入终端 tab，看到字体族 + 光标按钮", async ({ page }) => {
  await expect(
    page.getByRole("tab", { name: "终端" }),
  ).toHaveAttribute("aria-selected", "true");

  await expect(page.getByText("字体族")).toBeVisible();
  await expect(page.getByRole("button", { name: "■ 方块" })).toBeVisible();
});

test("切到 AI Provider → Provider 列表可见，字体族隐藏", async ({ page }) => {
  await page.getByRole("tab", { name: "AI Provider" }).click();

  await expect(
    page.getByRole("tab", { name: "AI Provider" }),
  ).toHaveAttribute("aria-selected", "true");

  // Provider 行可见
  await expect(
    page.getByText("Qwen (DashScope)", { exact: true }),
  ).toBeVisible();
  // 终端 tab 内容隐藏
  await expect(page.getByText("字体族")).toBeHidden();
});

test("切到 Safety → 白名单 + PatternTester 可见", async ({ page }) => {
  await page.getByRole("tab", { name: "Safety" }).click();

  await expect(
    page.getByRole("tab", { name: "Safety" }),
  ).toHaveAttribute("aria-selected", "true");

  await expect(
    page.getByRole("button", { name: "+ 添加模式" }),
  ).toBeVisible();
  await expect(page.getByLabel("命中测试输入")).toBeVisible();
  // 终端 tab 内容隐藏
  await expect(page.getByText("字体族")).toBeHidden();
});

test("关闭 modal 重新打开 → 记住上次选的 tab（plan §1.1 G4）", async ({
  page,
}) => {
  // 切到 Safety
  await page.getByRole("tab", { name: "Safety" }).click();
  await expect(
    page.getByRole("tab", { name: "Safety" }),
  ).toHaveAttribute("aria-selected", "true");

  // 关闭 modal
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("heading", { name: "设置" }),
  ).not.toBeVisible();

  // 重新打开 — 应仍在 Safety（useState 保持组件态，不重置）
  await page.getByLabel("设置").click();
  await expect(
    page.getByRole("tab", { name: "Safety" }),
  ).toHaveAttribute("aria-selected", "true");
});
