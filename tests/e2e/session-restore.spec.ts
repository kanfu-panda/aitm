import { expect, test } from "@playwright/test";
import { installTauriMock } from "./_mock-ipc";

/**
 * v0.5.0-D：SessionRestoreDialog 启动恢复 E2E（v0.7.1-A T5）。
 *
 * 单测（SessionRestoreDialog.test.tsx）已验过 dialog 渲染 + 3 callback 触发；
 * 这里在真浏览器跑完整 App 链路：
 *  - mock session_snapshot_load 返非空 snapshot（2 tab）→ App 启动后弹 dialog
 *  - 点"恢复"：snapshot.tabs 加载到 useTabsStore（tab 数量 = 2）
 *  - 点"全新"：session_snapshot_clear 被调一次，store 仍只有 1 空 tab
 *  - 点"跳过"：clear 不调，store 仍只有 1 空 tab
 *
 * 关键 mock（v0.7.1-A T5 新增）：
 *  - `__setSessionSnapshot(snap)`：spec 在 page.goto 前设置 load 返回值
 *  - `__snapshotCalls`：getter 返 {saveCount, clearCount}（验证副作用调用次数）
 *
 * Snapshot save 是 debounced 1s 写后端；spec 不依赖 save 时序，只断言 clear。
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

test.describe("SessionRestoreDialog 启动恢复", () => {
  test.describe("snapshot 存在 → dialog 出现", () => {
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

    test("启动后 dialog 出现 + 3 按钮可见 + 显示 tab 列表", async ({
      page,
    }) => {
      const dialog = page.getByRole("dialog", { name: "恢复上次会话" });
      await expect(dialog).toBeVisible({ timeout: 5_000 });

      // 3 按钮
      await expect(page.getByTestId("restore-btn-restore")).toBeVisible();
      await expect(page.getByTestId("restore-btn-fresh")).toBeVisible();
      await expect(page.getByTestId("restore-btn-skip")).toBeVisible();

      // tab 列表
      const list = page.getByTestId("restore-tab-list");
      await expect(list).toBeVisible();
      await expect(list).toContainText("main");
      await expect(list).toContainText("logs");
    });

    test("点 '恢复' → snapshot.tabs 加载到 store（tab 数量 = 2）", async ({
      page,
    }) => {
      await expect(page.getByRole("dialog", { name: "恢复上次会话" })).toBeVisible();

      await page.getByTestId("restore-btn-restore").click();

      // dialog 关闭
      await expect(
        page.getByRole("dialog", { name: "恢复上次会话" }),
      ).not.toBeVisible();

      // App 按 snapshot 逐个 addTab → TabBar 渲染 2 tab
      // TabBar 内部用 testid="tab-N" 或 button 来标记 tab；用 tab-bar 内
      // tab 数量断言更稳。这里用 page.locator('button') 不靠谱，改用
      // 直接读 zustand 暴露的钩子或在 TabBar selector 上断言。
      // 现有 mock 已 stub session_open 返 uuid，addTab 内部会 spawn session。
      // 用 role="tab" 等价不行（TabBar 不是 role=tab）；用 testid:
      // TabBar 没用 testid；每个 tab 都有一个 "关闭标签" 按钮。
      // restore 后应该有 2 个 tab（按 snapshot.tabs.length）。
      await expect(page.getByLabel("关闭标签")).toHaveCount(2, {
        timeout: 5_000,
      });
      // 标题对得上
      await expect(page.getByText("main").first()).toBeVisible();
      await expect(page.getByText("logs").first()).toBeVisible();
    });

    test("点 '全新' → session_snapshot_clear 被调 + store 只有 1 空 tab", async ({
      page,
    }) => {
      await expect(page.getByRole("dialog", { name: "恢复上次会话" })).toBeVisible();

      await page.getByTestId("restore-btn-fresh").click();

      // dialog 关闭
      await expect(
        page.getByRole("dialog", { name: "恢复上次会话" }),
      ).not.toBeVisible();

      // clear 被调一次
      await expect
        .poll(
          async () =>
            page.evaluate(
              () =>
                (
                  window as unknown as {
                    __snapshotCalls: { clearCount: number };
                  }
                ).__snapshotCalls.clearCount,
            ),
          { timeout: 2_000 },
        )
        .toBeGreaterThanOrEqual(1);

      // 只有 1 空 tab（App 在 snapshotResolved 后 addTab() 默认开 1 个）
      await expect(page.getByLabel("关闭标签")).toHaveCount(1, {
        timeout: 5_000,
      });
    });

    test("点 '跳过' → clear 不调 + 不恢复 + 默认开 1 空 tab", async ({
      page,
    }) => {
      await expect(page.getByRole("dialog", { name: "恢复上次会话" })).toBeVisible();

      await page.getByTestId("restore-btn-skip").click();

      // dialog 关闭
      await expect(
        page.getByRole("dialog", { name: "恢复上次会话" }),
      ).not.toBeVisible();

      // clear 仍是 0（跳过路径不清 snapshot）
      // 等一下让 store subscription 安静下来再断言
      await page.waitForTimeout(500);
      const calls = await page.evaluate(
        () =>
          (
            window as unknown as {
              __snapshotCalls: { clearCount: number };
            }
          ).__snapshotCalls,
      );
      expect(calls.clearCount).toBe(0);

      // 应该开 1 空 tab（snapshotResolved 后 addTab 默认逻辑）
      await expect(page.getByLabel("关闭标签")).toHaveCount(1, {
        timeout: 5_000,
      });
    });
  });

  test.describe("snapshot 为空 → 不弹 dialog", () => {
    test("默认 mock load 返 null → 直接走默认路径", async ({ page }) => {
      await installTauriMock(page);
      // 默认 sessionSnapshot=null（不需要 setSnap）
      await page.goto("/");

      // 不应该出现恢复 dialog
      await expect(
        page.getByRole("dialog", { name: "恢复上次会话" }),
      ).not.toBeVisible();
      // App 直接开 1 默认 tab（不验数量，避免与 tabbar.spec 重复）
    });
  });
});
