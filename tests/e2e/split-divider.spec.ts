import { expect, test } from "@playwright/test";
import { installTauriMock } from "./_mock-ipc";

/**
 * v0.6.0-A T2/T3：SplitDivider 拖动 + 双击重置 + 持久化 E2E（v0.7.1-A T5）。
 *
 * 单测（SidebarSplitDivider.test.tsx）已用 vitest + fake rAF 测了 store 同步 +
 * IPC 调用。这里在真浏览器跑：
 *  - 默认 file_tree_width = 240（fixture）
 *  - FileTree 打开后 SplitDivider 渲染（role=separator）
 *  - mousedown + mousemove + mouseup → settings_update payload 含 file_tree_width != 240
 *  - 双击 SplitDivider → 调一次 settings_update，file_tree_width 回到 240
 *
 * playwright 默认 viewport 1280×720，SplitDivider clamp [180, 600] 内拖动安全。
 */

test.beforeEach(async ({ page }) => {
  await installTauriMock(page);
  await page.goto("/");
  // FileTree 默认隐藏 — 通过 ActivityBar 按钮打开它
  const fileTreeBtn = page.getByTestId("activity-bar-item-file-tree");
  await expect(fileTreeBtn).toBeVisible({ timeout: 5_000 });
  await fileTreeBtn.click();
  await expect(page.getByTestId("file-tree")).toBeVisible();
});

test("默认 file_tree_width = 240 + SplitDivider 渲染 (aria-valuenow=240)", async ({
  page,
}) => {
  const divider = page.getByRole("separator", { name: "调整文件树宽度" });
  await expect(divider).toBeVisible();
  await expect(divider).toHaveAttribute("aria-valuenow", "240");
  await expect(divider).toHaveAttribute("aria-orientation", "vertical");
  await expect(divider).toHaveAttribute("aria-valuemin", "180");
  await expect(divider).toHaveAttribute("aria-valuemax", "600");
});

test("拖动 SplitDivider → settings_update payload 含新宽度", async ({
  page,
}) => {
  const divider = page.getByRole("separator", { name: "调整文件树宽度" });

  // 取 divider 当前中心点
  const box = await divider.boundingBox();
  expect(box).not.toBeNull();
  const startX = box!.x + box!.width / 2;
  const startY = box!.y + box!.height / 2;

  // 鼠标按下 → 向右拖 120px → 抬起；fileTree 在左、direction="right"，
  // 鼠标右移 → file_tree_width 增加（240 → 360 区间）
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // playwright 拖动建议分步 move 以触发多次 mousemove
  await page.mouse.move(startX + 60, startY, { steps: 3 });
  await page.mouse.move(startX + 120, startY, { steps: 3 });
  await page.mouse.up();

  // mouseup → commitSidebarSettings 同步调 settings_update（无 debounce），
  // 但保险起见 poll 一下
  await expect
    .poll(
      async () =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __lastSavedSettings?: { ui?: { file_tree_width?: number } };
              }
            ).__lastSavedSettings?.ui?.file_tree_width,
        ),
      { timeout: 3_000 },
    )
    .not.toBe(240);

  // aria-valuenow 应该跟着拖动反映新值（>=  240，因为我们向右拖了）
  const valueNow = await divider.getAttribute("aria-valuenow");
  expect(Number(valueNow)).toBeGreaterThan(240);
});

test("双击 SplitDivider → 重置 240 + settings_update 收到 file_tree_width=240", async ({
  page,
}) => {
  const divider = page.getByRole("separator", { name: "调整文件树宽度" });

  // 先拖动一段距离改变宽度（前置）
  const box = await divider.boundingBox();
  expect(box).not.toBeNull();
  const startX = box!.x + box!.width / 2;
  const startY = box!.y + box!.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 80, startY, { steps: 3 });
  await page.mouse.up();

  // 等改宽到非 240
  await expect
    .poll(
      async () =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __lastSavedSettings?: { ui?: { file_tree_width?: number } };
              }
            ).__lastSavedSettings?.ui?.file_tree_width,
        ),
      { timeout: 3_000 },
    )
    .not.toBe(240);

  // 双击 SplitDivider 重置（dblclick 在 page.mouse.dblclick 上等效）
  // 重新拿 boundingBox（拖动后位置可能变）
  const box2 = await divider.boundingBox();
  expect(box2).not.toBeNull();
  await page.mouse.dblclick(
    box2!.x + box2!.width / 2,
    box2!.y + box2!.height / 2,
  );

  // 重置 → settings_update payload file_tree_width = 240
  await expect
    .poll(
      async () =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __lastSavedSettings?: { ui?: { file_tree_width?: number } };
              }
            ).__lastSavedSettings?.ui?.file_tree_width,
        ),
      { timeout: 3_000 },
    )
    .toBe(240);

  // aria-valuenow 同步
  await expect(divider).toHaveAttribute("aria-valuenow", "240");
});
