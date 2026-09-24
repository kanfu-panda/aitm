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

test("E2E-05 新建会话 → 标签页 +1，且以输入的名字调用新建", async ({ page }) => {
  await installTauriMock(page);
  await page.goto("/");
  await expect(page.getByRole("tab")).toHaveCount(1, { timeout: 5_000 });

  await page.getByTestId("activity-bar-item-tmux").click();
  await page.getByTestId("tmux-new").click();
  const input = page.getByTestId("input-dialog-input");
  await input.fill("e2e-fresh");
  await page.getByTestId("input-dialog-ok").click();

  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __lastTmuxEdit?: { cmd: string; args: { name?: string } };
            }
          ).__lastTmuxEdit,
      ),
    )
    .toMatchObject({ cmd: "tmux_new_session", args: { name: "e2e-fresh" } });
});

test("E2E-06 展开会话 → 预览区出现输出", async ({ page }) => {
  await installTauriMock(page);
  await page.goto("/");

  await page.getByTestId("activity-bar-item-tmux").click();
  await page.getByTestId("tmux-expand-build-farm").click();

  const preview = page.getByTestId("tmux-preview-build-farm");
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("Finished preview for $1");
});

test("E2E-07 右键重命名 → 改名接口收到 id 与新名", async ({ page }) => {
  await installTauriMock(page);
  await page.goto("/");

  await page.getByTestId("activity-bar-item-tmux").click();
  await page
    .getByTestId("tmux-session-item-scratch")
    .click({ button: "right" });
  await page.getByTestId("tmux-menu-rename").click();
  const input = page.getByTestId("input-dialog-input");
  await expect(input).toHaveValue("scratch");
  await input.fill("scratch-2");
  await page.getByTestId("input-dialog-ok").click();

  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __lastTmuxEdit?: { cmd: string; args: Record<string, unknown> };
            }
          ).__lastTmuxEdit,
      ),
    )
    .toMatchObject({
      cmd: "tmux_rename_session",
      args: { id: "$2", name: "scratch-2" },
    });
});

test("E2E-08 分屏时点击会话：新标签出现在当前焦点分屏里", async ({ page }) => {
  await installTauriMock(page);
  await page.goto("/");
  await expect(page.getByRole("tab")).toHaveCount(1, { timeout: 5_000 });

  // 拆出第二个分屏（自带 1 个标签），焦点落在新分屏上
  await page.evaluate(() => {
    const w = window as unknown as {
      __getPaneLayout: () => {
        splitGroupWithNewTab: (gid: string, dir: string) => string | null;
        root: { kind: string; group?: { id: string } };
      };
    };
    const layout = w.__getPaneLayout();
    if (layout.root.kind === "leaf" && layout.root.group) {
      layout.splitGroupWithNewTab(layout.root.group.id, "horizontal");
    }
  });
  const groups = page.getByTestId("terminal-pane-group");
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(1).getByRole("tab")).toHaveCount(1);

  await page.getByTestId("activity-bar-item-tmux").click();
  await page.getByTestId("tmux-session-item-build-farm").click();

  // 1.6.0 的缺陷：新标签只进了标签列表、不属于任何分屏，界面上一个都不多
  await expect(groups.nth(1).getByRole("tab")).toHaveCount(2);
  await expect(
    groups.nth(1).getByText("tmux: build-farm").first(),
  ).toBeVisible();
});

test("E2E-09 右键结束会话：弹应用内确认框，确认后调结束接口", async ({
  page,
}) => {
  // 模拟 macOS 上的 WKWebView：window.confirm 不弹窗、直接返回 false
  await page.addInitScript(() => {
    window.confirm = () => false;
  });
  await installTauriMock(page);
  await page.goto("/");

  await page.getByTestId("activity-bar-item-tmux").click();
  await page
    .getByTestId("tmux-session-item-scratch")
    .click({ button: "right" });
  await page.getByTestId("tmux-menu-kill").click();

  await expect(page.getByTestId("confirm-action-dialog")).toBeVisible();
  await page.getByTestId("confirm-action-ok").click();

  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __lastTmuxAction?: { cmd: string; id: string };
            }
          ).__lastTmuxAction,
      ),
    )
    .toMatchObject({ cmd: "tmux_kill_session" });
  await expect(page.getByTestId("confirm-action-dialog")).not.toBeVisible();
});

test("E2E-10 面板接入后，快照里记下这个标签接的 tmux 会话", async ({
  page,
}) => {
  await installTauriMock(page);
  await page.goto("/");
  await page.getByTestId("activity-bar-item-tmux").click();
  await page.getByTestId("tmux-session-item-build-farm").click();

  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const snap = (
            window as unknown as {
              __lastSnapshotSave?: {
                tabs: { title: string; tmux_session_id?: string | null }[];
              };
            }
          ).__lastSnapshotSave;
          return snap?.tabs.map((t) => t.tmux_session_id ?? null) ?? [];
        }),
      { timeout: 5_000 },
    )
    .toContain("$1");
});

test("E2E-11 重启恢复：会话还在的 tmux 标签自动接回，已结束的恢复成普通标签", async ({
  page,
}) => {
  await installTauriMock(page);
  await page.addInitScript(() => {
    const set = (
      window as unknown as { __setSessionSnapshot?: (s: unknown) => void }
    ).__setSessionSnapshot;
    set?.({
      schema_version: 1,
      saved_at_ms: 1_700_000_000_000,
      tabs: [
        {
          tab_id: "t1",
          title: "tmux: build-farm",
          cwd: "/proj",
          unread: 0,
          group_id: "g-initial",
          tmux_session_id: "$1",
        },
        {
          tab_id: "t2",
          title: "tmux: gone",
          cwd: "/proj",
          unread: 0,
          group_id: "g-initial",
          tmux_session_id: "$404",
        },
      ],
      active_tab_id: "t1",
    });
  });
  await page.goto("/");

  await expect(page.getByRole("tab")).toHaveCount(2, { timeout: 5_000 });
  await expect(page.getByText("tmux: build-farm").first()).toBeVisible();
  // 已结束的会话不再顶着 tmux 标题
  await expect(page.getByText("tmux: gone")).toHaveCount(0);

  // 仍在的那个会话：接入命令被写进了终端
  await expect
    .poll(
      async () =>
        page.evaluate(() =>
          (window as unknown as { __sessionWrites: string[] }).__sessionWrites.join(
            "",
          ),
        ),
      { timeout: 5_000 },
    )
    .toContain("attach-session -t '$1'");
  const writes = await page.evaluate(() =>
    (window as unknown as { __sessionWrites: string[] }).__sessionWrites.join(""),
  );
  expect(writes).not.toContain("$404");
});
