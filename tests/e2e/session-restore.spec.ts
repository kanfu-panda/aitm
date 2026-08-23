import { expect, test } from "@playwright/test";
import { installTauriMock } from "./_mock-ipc";

/**
 * 启动静默恢复上次会话的 E2E。
 *
 * 以前启动会弹 SessionRestoreDialog 让用户三选一（恢复 / 全新 / 跳过），
 * 现在默认直接恢复，不再问。这个 spec 守三件事：
 *  - snapshot 存在 + 开关默认开 → 启动后 tab 自动回来，且**不弹任何 dialog**
 *  - 开关关掉 → 不恢复，只开 1 个空 tab
 *  - snapshot 为空 → 开 1 个空 tab（跟以前一样）
 *
 * 关键 mock：
 *  - `__setSessionSnapshot(snap)`：spec 在 page.goto 前设置 load 返回值
 *  - `__setRestoreSession(false)`：模拟用户在设置里关掉恢复
 *  - `__snapshotCalls`：getter 返 {saveCount, clearCount}
 */

const SAMPLE_SNAPSHOT = {
  schema_version: 1,
  saved_at_ms: 1_700_000_000_000,
  tabs: [
    { tab_id: "t1", title: "main", cwd: "/proj", unread: 0, group_id: "g-initial" },
    { tab_id: "t2", title: "logs", cwd: "/var/log", unread: 3, group_id: "g-initial" },
  ],
  active_tab_id: "t1",
};

test.describe("启动静默恢复会话", () => {
  test.describe("snapshot 存在 + 恢复开着", () => {
    test.beforeEach(async ({ page }) => {
      await installTauriMock(page);
      await page.addInitScript((snap) => {
        const setSnap = (
          window as unknown as {
            __setSessionSnapshot?: (s: unknown) => void;
          }
        ).__setSessionSnapshot;
        if (setSnap) setSnap(snap);
      }, SAMPLE_SNAPSHOT);
      await page.goto("/");
    });

    test("tab 自动恢复（2 个）且标题对得上", async ({ page }) => {
      await expect(page.getByLabel("关闭标签")).toHaveCount(2, {
        timeout: 5_000,
      });
      await expect(page.getByText("main").first()).toBeVisible();
      await expect(page.getByText("logs").first()).toBeVisible();
    });

    test("不弹任何询问 dialog（这就是这次改动的全部意义）", async ({
      page,
    }) => {
      // 等恢复真的发生，再断言"没有 dialog"——否则断言可能只是跑在恢复之前
      await expect(page.getByLabel("关闭标签")).toHaveCount(2, {
        timeout: 5_000,
      });
      await expect(page.getByRole("dialog")).toHaveCount(0);
    });

    test("恢复路径不清 snapshot", async ({ page }) => {
      await expect(page.getByLabel("关闭标签")).toHaveCount(2, {
        timeout: 5_000,
      });
      const calls = await page.evaluate(
        () =>
          (window as unknown as { __snapshotCalls: { clearCount: number } })
            .__snapshotCalls,
      );
      expect(calls.clearCount).toBe(0);
    });
  });

  test.describe("恢复开关关掉", () => {
    test("有 snapshot 也不恢复，只开 1 个空 tab", async ({ page }) => {
      await installTauriMock(page);
      await page.addInitScript((snap) => {
        const w = window as unknown as {
          __setSessionSnapshot?: (s: unknown) => void;
          __setRestoreSession?: (v: boolean) => void;
        };
        w.__setSessionSnapshot?.(snap);
        w.__setRestoreSession?.(false);
      }, SAMPLE_SNAPSHOT);
      await page.goto("/");

      await expect(page.getByLabel("关闭标签")).toHaveCount(1, {
        timeout: 5_000,
      });
      // snapshot 没被清（重新打开开关还能恢复最近一次）
      await page.waitForTimeout(300);
      const calls = await page.evaluate(
        () =>
          (window as unknown as { __snapshotCalls: { clearCount: number } })
            .__snapshotCalls,
      );
      expect(calls.clearCount).toBe(0);
    });
  });

  test.describe("snapshot 为空", () => {
    test("默认 mock load 返 null → 开 1 个空 tab", async ({ page }) => {
      await installTauriMock(page);
      await page.goto("/");

      await expect(page.getByLabel("关闭标签")).toHaveCount(1, {
        timeout: 5_000,
      });
      await expect(page.getByRole("dialog")).toHaveCount(0);
    });
  });
});
