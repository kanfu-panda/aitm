import { expect, test } from "@playwright/test";
import { installTauriMock } from "./_mock-ipc";

/**
 * Safety section + 白名单 E2E。
 *
 * 后端 L2/L3 决策由 `tool_loop` 单测 + safety_ipc 集成测试覆盖；
 * 这里只测前端：
 * - SettingsModal 加 Safety 标题 + 白名单增删 + show_low 切换
 * - PatternTester：命中 / 不命中 / 元字符防注入的反馈
 * - 添加非法模式 → 红色错误 + 不入列表
 */

test.beforeEach(async ({ page }) => {
  await installTauriMock(page);
  await page.goto("/");
});

async function openSettings(page: import("@playwright/test").Page) {
  await page.getByLabel("设置").click();
  // B-1：SettingsModal 改 Tab 布局后，Safety 内容默认隐藏在 Safety tab；先切过去
  await page.getByRole("tab", { name: "安全" }).click();
}

test("Safety tab 默认空白名单", async ({ page }) => {
  await openSettings(page);
  await expect(page.getByText("（暂无条目；点下方按钮添加）")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "+ 添加模式" }),
  ).toBeVisible();
});

test("添加合法 pattern → 入列表", async ({ page }) => {
  await openSettings(page);

  await page.getByRole("button", { name: "+ 添加模式" }).click();
  const input = page.getByLabel("新白名单模式");
  await input.fill("git status *");
  await page.keyboard.press("Enter");

  // 入列表
  await expect(page.getByLabel("白名单条目列表")).toBeVisible();
  await expect(page.getByText("git status *")).toBeVisible();
});

test("添加非法 pattern（中括号未闭合）→ 红色错误 + 不入列表", async ({
  page,
}) => {
  await openSettings(page);

  await page.getByRole("button", { name: "+ 添加模式" }).click();
  const input = page.getByLabel("新白名单模式");
  await input.fill("[invalid");
  await page.keyboard.press("Enter");

  // 错误提示出现
  await expect(page.getByLabel("模式语法错误")).toBeVisible();
  // 列表本身根本没渲染（whitelist 仍空，且仍在添加状态 → 显示 "暂无条目" 文案）
  await expect(page.getByLabel("白名单条目列表")).not.toBeVisible();
});

test("删除 pattern → 列表恢复空", async ({ page }) => {
  await openSettings(page);

  // 先加一条
  await page.getByRole("button", { name: "+ 添加模式" }).click();
  await page.getByLabel("新白名单模式").fill("ls *");
  await page.keyboard.press("Enter");
  await expect(page.getByText("ls *")).toBeVisible();

  // 点删除
  await page.getByLabel("删除模式 ls *").click();
  await expect(page.getByText("（暂无条目；点下方按钮添加）")).toBeVisible();
});

test("PatternTester 命中：emerald ✓", async ({ page }) => {
  await openSettings(page);

  // 加一条 git status *
  await page.getByRole("button", { name: "+ 添加模式" }).click();
  await page.getByLabel("新白名单模式").fill("git status *");
  await page.keyboard.press("Enter");

  // 在测试器里输入一条会命中的 cmd
  const tester = page.getByLabel("命中测试输入");
  await tester.fill("git status -sb");

  const result = page.getByLabel("命中测试结果");
  await expect(result).toBeVisible();
  await expect(result).toHaveText(/✓ 命中：git status \*/);
});

test("PatternTester 不命中：zinc ✗", async ({ page }) => {
  await openSettings(page);

  // 不加任何 pattern，直接测一条不会命中的 cmd
  const tester = page.getByLabel("命中测试输入");
  await tester.fill("npm install");

  const result = page.getByLabel("命中测试结果");
  await expect(result).toBeVisible();
  await expect(result).toHaveText(/✗ 不命中/);
});

test("PatternTester 元字符防注入：含 ; 的 cmd 即使前缀命中也不命中", async ({
  page,
}) => {
  await openSettings(page);

  // 加 ls *
  await page.getByRole("button", { name: "+ 添加模式" }).click();
  await page.getByLabel("新白名单模式").fill("ls *");
  await page.keyboard.press("Enter");

  // 用含 ; 的 cmd 测
  const tester = page.getByLabel("命中测试输入");
  await tester.fill("ls; rm -rf .");

  const result = page.getByLabel("命中测试结果");
  await expect(result).toBeVisible();
  await expect(result).toHaveText(/✗ 不命中/);
});

test("show_low_auto_approved 复选框可切换", async ({ page }) => {
  await openSettings(page);

  const cb = page.getByLabel("自动批准时在工具气泡上显示徽章");
  await expect(cb).not.toBeChecked();
  await cb.check();
  await expect(cb).toBeChecked();
});
