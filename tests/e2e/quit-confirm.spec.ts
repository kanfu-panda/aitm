import { expect, test } from "@playwright/test";
import { installTauriMock } from "./_mock-ipc";

/**
 * v0.9.0 T4：关闭应用二次确认 E2E。
 *
 * 触发链路（在真 Tauri 下）：
 * 1. 用户点窗口红叉 / Cmd+Q → Tauri 后端 `on_window_event` hook
 * 2. 判 `settings.ui.confirm_quit=true` 时 prevent_close + emit
 *    `app:confirm-quit-requested` 事件
 * 3. 前端 `QuitConfirmDialog` 订阅事件弹 dialog
 * 4. 用户点"退出" → `appQuitConfirmed()` IPC → `app.exit(0)`
 *
 * E2E 下用 `__emitMockEvent` 模拟步骤 2 的事件到达，验前端步骤 3-4 行为。
 */

test.describe("QuitConfirmDialog 关闭应用二次确认", () => {
  test.beforeEach(async ({ page }) => {
    await installTauriMock(page);
    await page.goto("/");
    // 等 App 初始 tab 渲染完成
    await expect(page.getByLabel("新建标签")).toBeVisible({ timeout: 5_000 });
  });

  test("初始不弹 dialog", async ({ page }) => {
    await expect(
      page.getByRole("dialog", { name: "确认退出 aitm" }),
    ).not.toBeVisible();
  });

  test("emit app:confirm-quit-requested → dialog 弹出 + 文案 + 两按钮", async ({
    page,
  }) => {
    await page.evaluate(() => {
      const emit = (
        window as unknown as {
          __emitMockEvent: (event: string, payload: unknown) => void;
        }
      ).__emitMockEvent;
      emit("app:confirm-quit-requested", null);
    });

    const dialog = page.getByRole("dialog", { name: "确认退出 aitm" });
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(dialog).toContainText("确认退出 aitm");
    await expect(dialog).toContainText("所有终端会话和未保存的文件编辑将会丢失");

    await expect(page.getByTestId("quit-btn-cancel")).toBeVisible();
    await expect(page.getByTestId("quit-btn-confirm")).toBeVisible();
  });

  test("点 '取消' → dialog 关闭，不调 app_quit_confirmed", async ({ page }) => {
    // 注册 app_quit_confirmed mock 调用计数
    await page.evaluate(() => {
      const internals = (
        window as unknown as {
          __TAURI_INTERNALS__: {
            invoke: (cmd: string, args: Record<string, unknown>) => unknown;
          };
        }
      ).__TAURI_INTERNALS__;
      const orig = internals.invoke;
      (
        window as unknown as { __quitConfirmedCalls: number }
      ).__quitConfirmedCalls = 0;
      internals.invoke = async (cmd: string, args: Record<string, unknown>) => {
        if (cmd === "app_quit_confirmed") {
          (
            window as unknown as { __quitConfirmedCalls: number }
          ).__quitConfirmedCalls += 1;
          return null;
        }
        return orig(cmd, args);
      };
    });

    await page.evaluate(() => {
      const emit = (
        window as unknown as {
          __emitMockEvent: (event: string, payload: unknown) => void;
        }
      ).__emitMockEvent;
      emit("app:confirm-quit-requested", null);
    });

    await expect(
      page.getByRole("dialog", { name: "确认退出 aitm" }),
    ).toBeVisible();

    await page.getByTestId("quit-btn-cancel").click();

    await expect(
      page.getByRole("dialog", { name: "确认退出 aitm" }),
    ).not.toBeVisible();

    const calls = await page.evaluate(
      () =>
        (window as unknown as { __quitConfirmedCalls: number })
          .__quitConfirmedCalls,
    );
    expect(calls).toBe(0);
  });

  test("点 '退出' → 调 app_quit_confirmed 一次 + dialog 关闭", async ({
    page,
  }) => {
    await page.evaluate(() => {
      const internals = (
        window as unknown as {
          __TAURI_INTERNALS__: {
            invoke: (cmd: string, args: Record<string, unknown>) => unknown;
          };
        }
      ).__TAURI_INTERNALS__;
      const orig = internals.invoke;
      (
        window as unknown as { __quitConfirmedCalls: number }
      ).__quitConfirmedCalls = 0;
      internals.invoke = async (cmd: string, args: Record<string, unknown>) => {
        if (cmd === "app_quit_confirmed") {
          (
            window as unknown as { __quitConfirmedCalls: number }
          ).__quitConfirmedCalls += 1;
          return null;
        }
        return orig(cmd, args);
      };
    });

    await page.evaluate(() => {
      const emit = (
        window as unknown as {
          __emitMockEvent: (event: string, payload: unknown) => void;
        }
      ).__emitMockEvent;
      emit("app:confirm-quit-requested", null);
    });

    await expect(
      page.getByRole("dialog", { name: "确认退出 aitm" }),
    ).toBeVisible();

    await page.getByTestId("quit-btn-confirm").click();

    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              (window as unknown as { __quitConfirmedCalls: number })
                .__quitConfirmedCalls,
          ),
        { timeout: 2_000 },
      )
      .toBe(1);

    await expect(
      page.getByRole("dialog", { name: "确认退出 aitm" }),
    ).not.toBeVisible();
  });
});
