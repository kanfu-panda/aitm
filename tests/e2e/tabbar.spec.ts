import { expect, test } from "@playwright/test";
import { installTauriMock } from "./_mock-ipc";

test.beforeEach(async ({ page }) => {
  await installTauriMock(page);
});

// 终端 tab 用 role="tab" 计数，不依赖标题文案：
// 标题在 addTab() 时按当时 i18n 语言快照成普通字符串（启动早期常是默认
// 英文 "New Tab"），切语言后已存在 tab 不会重翻译，所以按 getByText(标题)
// 断言数量不稳。role="tab" 与 locale 无关，是稳健选择。

test("初次启动有 1 个 tab", async ({ page }) => {
  await page.goto("/");
  // 等 store 自动开 tab
  await expect(page.getByRole("tab")).toHaveCount(1, { timeout: 5_000 });
});

test("点 + 按钮后 tab 数量增加", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("tab")).toHaveCount(1, { timeout: 5_000 });

  await page.getByLabel("新建标签").click();
  await page.getByLabel("新建标签").click();

  await expect(page.getByRole("tab")).toHaveCount(3);
});

test("点 × 后 tab 数量减少", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("新建标签").click(); // 现在 2 个
  await expect(page.getByRole("tab")).toHaveCount(2);

  // 关掉第一个
  await page.getByLabel("关闭标签").first().click();
  await expect(page.getByRole("tab")).toHaveCount(1);
});

// 标签多到一行放不下时，以前超出的标签和 "+" 都被裁掉、
// 点不到。现在标签区横向滚动，"+" 在滚动区外始终可见，新建的标签自动滚进可视区。
test("标签放不下时 + 仍可见、新标签滚进可视区、滚轮能翻回第一个", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto("/");
  await expect(page.getByRole("tab")).toHaveCount(1, { timeout: 5_000 });

  const add = page.getByLabel("新建标签");
  for (let i = 0; i < 14; i++) await add.click();
  await expect(page.getByRole("tab")).toHaveCount(15);

  const strip = page.getByTestId("terminal-pane-group-tabstrip");
  // 确实溢出了，否则这条用例测不到东西
  const overflow = await strip.evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(overflow).toBe(true);
  await expect(add).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole("tab").last()).toBeInViewport({ ratio: 1 });

  // 鼠标竖向滚轮在标签栏上翻回最左
  await strip.hover();
  for (let i = 0; i < 10; i++) await page.mouse.wheel(0, -400);
  await expect
    .poll(() => strip.evaluate((el) => el.scrollLeft))
    .toBe(0);
  await expect(page.getByRole("tab").first()).toBeInViewport({ ratio: 1 });
});
