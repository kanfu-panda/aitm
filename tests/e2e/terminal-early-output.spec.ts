import { expect, test } from "@playwright/test";

import { installTauriMock } from "./_mock-ipc";

/**
 * 终端打开后第一行提示符丢失。
 *
 * 后端建好 PTY 就开始发 `session:data`，shell 的提示符可能在前端订阅建立之前就发出。
 * mock 在 `session_open` 返回之前派发一段输出来模拟这个时序。
 */
test("E2E-TERM-01 PTY 在打开返回前就输出的内容也显示在终端里", async ({
  page,
}) => {
  await installTauriMock(page);
  await page.addInitScript(() => {
    (
      window as unknown as { __sessionOpenEarlyOutput?: string }
    ).__sessionOpenEarlyOutput = "EARLY-PROMPT% ";
  });
  await page.goto("/");

  await expect(page.getByRole("tab")).toHaveCount(1, { timeout: 5_000 });
  await expect(page.locator(".xterm-rows").first()).toContainText(
    "EARLY-PROMPT%",
    { timeout: 5_000 },
  );
});
