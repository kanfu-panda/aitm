import { expect, test } from "@playwright/test";
import { installTauriMock } from "./_mock-ipc";

/**
 * tmux 会话管理器 E2E。
 *
 * mock 里固定三个会话：`build-farm`（已被 1 个客户端连接）、`scratch`（无人连接），
 * 以及名字里带单引号的 `it's mine`（边界用例）。
 */

test("E2E-01 默认面板不可见；点 ActivityBar tmux 图标可开关", async ({
  page,
}) => {
  await installTauriMock(page);
  await page.goto("/");

  const btn = page.getByTestId("activity-bar-item-tmux");
  await expect(btn).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId("tmux-panel")).not.toBeVisible();

  await btn.click();
  await expect(page.getByTestId("tmux-panel")).toBeVisible();

  await btn.click();
  await expect(page.getByTestId("tmux-panel")).not.toBeVisible();
});

test("E2E-02 面板打开后列出会话，名称与已连接标记可见", async ({ page }) => {
  await installTauriMock(page);
  await page.goto("/");

  await page.getByTestId("activity-bar-item-tmux").click();
  await expect(page.getByTestId("tmux-session-item-build-farm")).toBeVisible();
  await expect(page.getByTestId("tmux-session-item-scratch")).toBeVisible();

  // build-farm 有 1 个客户端连接 → 有标记；scratch 无人连接 → 没有
  await expect(page.getByTestId("tmux-attached-badge-build-farm")).toBeVisible();
  await expect(page.getByTestId("tmux-attached-badge-scratch")).toHaveCount(0);

  // 名字里带单引号的会话照样列出来、点得到（testid 里也含引号）
  await expect(page.getByTestId("tmux-session-item-it's mine")).toBeVisible();
});

test("E2E-03 点击会话项新开一个标题含会话名的终端标签页", async ({ page }) => {
  await installTauriMock(page);
  await page.goto("/");

  // 终端 tab 用 role="tab" 计数（与 tabbar.spec 同口径，不依赖标题文案）
  await expect(page.getByRole("tab")).toHaveCount(1, { timeout: 5_000 });

  await page.getByTestId("activity-bar-item-tmux").click();
  await page.getByTestId("tmux-session-item-build-farm").click();

  await expect(page.getByRole("tab")).toHaveCount(2);
  // 新标签页的标题由会话名拼出，是手动命名（不跟随 cwd 改写）
  await expect(page.getByText("tmux: build-farm").first()).toBeVisible();
});

test("E2E-04 右键会话项弹出菜单，接管 / 中断 / 结束三项可见", async ({
  page,
}) => {
  await installTauriMock(page);
  await page.goto("/");

  await page.getByTestId("activity-bar-item-tmux").click();
  await page
    .getByTestId("tmux-session-item-build-farm")
    .click({ button: "right" });

  await expect(page.getByTestId("tmux-menu-takeover")).toBeVisible();
  await expect(page.getByTestId("tmux-menu-interrupt")).toBeVisible();
  await expect(page.getByTestId("tmux-menu-kill")).toBeVisible();

  // 中断走的是 IPC，不弹确认框
  await page.getByTestId("tmux-menu-interrupt").click();
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          (window as unknown as { __lastTmuxAction?: { cmd: string } })
            .__lastTmuxAction?.cmd,
      ),
    )
    .toBe("tmux_interrupt_session");
});
