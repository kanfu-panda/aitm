import { expect, test } from "@playwright/test";
import { installTauriMock } from "./_mock-ipc";

/**
 * 覆盖设置面板里"AI Provider"section 的 E2E 流。
 * 依赖 _mock-ipc.ts 的 providerStore + 事件 mock：
 *   - providers_get_config / providers_save_config / providers_test_connection
 *   - 保存后自动 emit "providers:changed" 触发 AiSidebar 重新拉 listProviders
 */

test.beforeEach(async ({ page }) => {
  await installTauriMock(page);
});

/** B-1：SettingsModal 改 Tab 后，Provider 内容默认隐藏在 "AI Provider" tab 下 */
async function openProvidersTab(page: import("@playwright/test").Page) {
  await page.getByLabel("设置").click();
  await page.getByRole("tab", { name: "AI Provider" }).click();
}

test("打开设置 → AI Provider tab 渲染 6 行", async ({ page }) => {
  await page.goto("/");
  await openProvidersTab(page);

  // 6 个 provider display_name 都能看到
  for (const name of [
    "Qwen (DashScope)",
    "Claude",
    "DeepSeek",
    "智谱 GLM",
    "Moonshot Kimi",
    "OpenAI",
  ]) {
    await expect(page.getByText(name, { exact: true })).toBeVisible();
  }
});

test("已配置的 qwen 显示 mask 标签和 '已配置' 徽标", async ({ page }) => {
  await page.goto("/");
  await openProvidersTab(page);

  // qwen 行：能看到"已配置"徽标
  await expect(page.getByText("已配置", { exact: true })).toBeVisible();

  // mask 文本含 "sk-" 前缀和 "1234" 末尾（在"已配置：…"提示里）
  await expect(page.getByText(/sk-.*1234/)).toBeVisible();
});

test("测试连接 已配置的 qwen → 绿 ✓ + OK 文案", async ({ page }) => {
  await page.goto("/");
  await openProvidersTab(page);

  // qwen 行的"测试连接"按钮（第一个 provider 行）
  const qwenRow = page
    .getByText("Qwen (DashScope)", { exact: true })
    .locator("xpath=ancestor::div[contains(@class, 'rounded')][1]");
  await qwenRow.getByRole("button", { name: "测试连接" }).click();

  // 等结果出现：绿色 ✓ 文案 "OK"
  const result = qwenRow.getByRole("status");
  await expect(result).toBeVisible({ timeout: 5_000 });
  await expect(result).toContainText("✓");
  await expect(result).toContainText("OK");
});

test("输入新 key 保存 deepseek → mock 收到 api_key、再测试连接 ✓", async ({
  page,
}) => {
  await page.goto("/");
  await openProvidersTab(page);

  // 找到 deepseek 行
  const dsRow = page
    .getByText("DeepSeek", { exact: true })
    .locator("xpath=ancestor::div[contains(@class, 'rounded')][1]");

  // 输入新 key
  await dsRow.getByLabel("DeepSeek API Key").fill("sk-new");

  // 点保存
  await dsRow.getByRole("button", { name: "保存" }).click();

  // 等 mock 写入 __lastSavedPayload
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __lastSavedPayload?: { id: string; api_key: string };
            }
          ).__lastSavedPayload,
      ),
    )
    .toMatchObject({ id: "deepseek", api_key: "sk-new" });

  // 保存后再点测试连接 → 现在 key_source === "config"，应返回绿 ✓
  await dsRow.getByRole("button", { name: "测试连接" }).click();
  const result = dsRow.getByRole("status");
  await expect(result).toBeVisible({ timeout: 5_000 });
  await expect(result).toContainText("✓");
});

test("保存 deepseek 后 AiSidebar provider 下拉出现 'DeepSeek'", async ({
  page,
}) => {
  await page.goto("/");

  // 先展开 AiSidebar，初始只有 qwen（已配置的）在下拉里，还没 deepseek
  await page.getByLabel("AI 助手").click();
  await expect(page.getByPlaceholder(/输入消息/)).toBeVisible({
    timeout: 5_000,
  });

  // 验证初始下拉里没有 DeepSeek（只有 Qwen）
  const providerSelect = page.locator("select").first();
  await expect(providerSelect).toBeVisible();
  // 此时 listProviders 只返回 enabled+configured 的 qwen
  const initialOptions = await providerSelect
    .locator("option")
    .allTextContents();
  expect(initialOptions).toContain("Qwen (DashScope)");
  expect(initialOptions).not.toContain("DeepSeek");

  // 打开设置，切到 Provider tab，配置 deepseek
  await openProvidersTab(page);
  const dsRow = page
    .getByText("DeepSeek", { exact: true })
    .locator("xpath=ancestor::div[contains(@class, 'rounded')][1]");
  await dsRow.getByLabel("DeepSeek API Key").fill("sk-new");
  await dsRow.getByRole("button", { name: "保存" }).click();

  // 等 providers:changed 事件触发 AiSidebar 重新拉
  await expect(async () => {
    const opts = await providerSelect.locator("option").allTextContents();
    expect(opts).toContain("DeepSeek");
  }).toPass({ timeout: 5_000 });
});
