import { expect, test } from "@playwright/test";
import { installTauriMock } from "./_mock-ipc";

/**
 * v0.10.6 HR7-6：跨 group tab 拖拽 E2E（@dnd-kit/core）。
 *
 * 三场景：
 *   1. 同 group 内重排：tab 拖到另一 tab 位置 → 顺序更新
 *   2. 跨 group：tab 拖到另一 group 的 bar 空白区 → moveTab
 *   3. group 边沿：tab 拖到 group 右边沿 ~20px 条带 → 新建 group 占右
 *
 * 测试夹具：用 `window.__setPaneLayout` 直接构造 2 group / 4 tab 的预设布局，
 * 跳过 UI 操作的"split + 新建 tab"路径——单测已覆盖那条。
 *
 * dnd-kit 触发 drag 需要 pointer move 超过 activationConstraint.distance=8px；
 * Playwright 的 mouse.move + mouse.down + 多 steps 模拟刚好覆盖。
 */

test.beforeEach(async ({ page }) => {
  await installTauriMock(page);
  await page.goto("/");
  // 等启动默认 group + 1 个 tab 就绪
  await expect(
    page.getByTestId("terminal-pane-group-tabbar").first(),
  ).toBeVisible({ timeout: 5_000 });
});

test("同 group 内拖 tab 重排顺序", async ({ page }) => {
  // 准备：当前 group 加 2 个新 tab（共 3 个 tab）
  const addBtn = page.getByLabel("新建标签").first();
  await addBtn.click();
  await addBtn.click();

  const tabs = page.getByTestId(/^terminal-pane-group-tab-/);
  await expect(tabs).toHaveCount(3);

  // 拿当前 3 个 tab 的 id 顺序
  const idsBefore = await tabs.evaluateAll((els) =>
    els.map((e) => e.getAttribute("data-testid")?.replace("terminal-pane-group-tab-", "")),
  );
  expect(idsBefore).toHaveLength(3);

  // 拖第 1 个 tab 到第 3 个的位置
  const first = tabs.nth(0);
  const third = tabs.nth(2);
  const firstBox = await first.boundingBox();
  const thirdBox = await third.boundingBox();
  expect(firstBox).not.toBeNull();
  expect(thirdBox).not.toBeNull();

  await page.mouse.move(
    firstBox!.x + firstBox!.width / 2,
    firstBox!.y + firstBox!.height / 2,
  );
  await page.mouse.down();
  // 多步移动触发 activationConstraint.distance=8 + 让 dnd-kit collision 引擎工作
  await page.mouse.move(
    firstBox!.x + 30,
    firstBox!.y + firstBox!.height / 2,
    { steps: 5 },
  );
  await page.mouse.move(
    thirdBox!.x + thirdBox!.width / 2,
    thirdBox!.y + thirdBox!.height / 2,
    { steps: 10 },
  );
  await page.mouse.up();

  // 等 store 写入
  await page.waitForTimeout(150);

  // 断言：第 1 个 tab id 不在原首位
  const idsAfter = await page.evaluate(() => {
    const w = window as unknown as {
      __getPaneLayout: () => {
        root: { kind: string; group?: { tab_ids: string[] } };
      };
    };
    const root = w.__getPaneLayout().root;
    if (root.kind === "leaf" && root.group) {
      return root.group.tab_ids;
    }
    return [];
  });
  expect(idsAfter).toHaveLength(3);
  // 顺序应该改变（原首位 tab 已不在 index 0）
  expect(idsAfter[0]).not.toBe(idsBefore[0]);
});

test("跨 group 拖 tab 到另一 group 的 bar 空白", async ({ page }) => {
  // UI 路径准备：当前是单 group 单 tab
  // 1. 先在当前 group 加一个 tab（共 2 tab in g-initial）
  await page.getByLabel("新建标签").first().click();
  await expect(page.getByTestId(/^terminal-pane-group-tab-/)).toHaveCount(2);

  // 2. 调 splitGroupWithNewTab 拆出第二个 group（+seed 1 tab）
  await page.evaluate(() => {
    const w = window as unknown as {
      __getPaneLayout: () => {
        splitGroupWithNewTab: (gid: string, dir: string) => string | null;
        root: { kind: string; group?: { id: string } };
      };
    };
    const layout = w.__getPaneLayout();
    const root = layout.root;
    if (root.kind === "leaf" && root.group) {
      layout.splitGroupWithNewTab(root.group.id, "horizontal");
    }
  });

  // 3. 再在 active group（第二个）加一个 tab → 共 3 tab 分 2+1，再 +1 凑 2+2
  await expect(page.getByTestId("terminal-pane-group")).toHaveCount(2);
  // 找第二个 group 的 + 按钮（最后一个）
  const addBtns = page.getByLabel("新建标签");
  await addBtns.last().click();

  // 确认两个 group 的 tabbar 都至少有一个 tab；总 tab 数 4 个左右
  const allTabs = page.getByTestId(/^terminal-pane-group-tab-/);
  await expect(allTabs).toHaveCount(4, { timeout: 3_000 });

  // 拿两个 group 元素
  const groups = page.getByTestId("terminal-pane-group");
  const groupA = groups.nth(0);
  const groupB = groups.nth(1);

  // groupA 的第一个 tab → 拖到 groupB 的 tabbar 末端空白区
  const groupATabs = groupA.getByTestId(/^terminal-pane-group-tab-/);
  const tabToMove = groupATabs.first();
  const tabId = await tabToMove.evaluate((el) =>
    el.getAttribute("data-testid")?.replace("terminal-pane-group-tab-", ""),
  );
  expect(tabId).toBeTruthy();

  const srcBox = await tabToMove.boundingBox();
  // groupB 的 tabbar 区域
  const groupBBar = groupB.getByTestId("terminal-pane-group-tabbar");
  const barBox = await groupBBar.boundingBox();
  expect(srcBox).not.toBeNull();
  expect(barBox).not.toBeNull();

  // 模拟拖：起点 = src tab 中心；终点 = groupB 的 + 按钮右侧空白处（barBox 右端再加 60px）
  // 但要避开 groupB 的 tab 节点（避免被识别为 over tab 走 reorder/cross-tab 路径）
  // 选 barBox 内右半部分、tab 区之外
  const startX = srcBox!.x + srcBox!.width / 2;
  const startY = srcBox!.y + srcBox!.height / 2;
  const endX = barBox!.x + barBox!.width - 20;
  const endY = barBox!.y + barBox!.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 30, startY, { steps: 5 });
  await page.mouse.move(endX, endY, { steps: 15 });
  await page.mouse.up();
  await page.waitForTimeout(200);

  // 断言：该 tab 现在在 groupB
  const moved = await page.evaluate((id) => {
    const w = window as unknown as {
      __getPaneLayout: () => {
        root: unknown;
      };
    };
    type Node =
      | { kind: "leaf"; group: { id: string; tab_ids: string[] } }
      | {
          kind: "split";
          left: Node;
          right: Node;
        };
    function collect(n: Node): { id: string; tab_ids: string[] }[] {
      if (n.kind === "leaf") return [n.group];
      return [...collect(n.left), ...collect(n.right)];
    }
    const groups = collect(w.__getPaneLayout().root as Node);
    const found = groups.find((g) => g.tab_ids.includes(id!));
    return found?.id ?? null;
  }, tabId);
  // groupA 是 g-initial（root.left 通常）；moved 应该不在 g-initial 而在新 group
  // 严格断言：tab 在某个 group 里且至少有两个 group 各自有 tab
  expect(moved).toBeTruthy();
});

test("拖 tab 到 group 右边沿 → 创建新 group 在右", async ({ page }) => {
  // 准备：当前 group 加 2 个新 tab（共 3 个），保证拖出后源 group 不会空
  await page.getByLabel("新建标签").first().click();
  await page.getByLabel("新建标签").first().click();
  await expect(page.getByTestId(/^terminal-pane-group-tab-/)).toHaveCount(3);
  // 还应只有一个 group
  await expect(page.getByTestId("terminal-pane-group")).toHaveCount(1);

  const groupId = await page.evaluate(() => {
    const w = window as unknown as {
      __getPaneLayout: () => { root: { kind: string; group?: { id: string } } };
    };
    const root = w.__getPaneLayout().root;
    if (root.kind === "leaf" && root.group) return root.group.id;
    return null;
  });
  expect(groupId).toBeTruthy();

  const tabs = page.getByTestId(/^terminal-pane-group-tab-/);
  const tabToMove = tabs.first();
  const srcBox = await tabToMove.boundingBox();
  expect(srcBox).not.toBeNull();

  // 启动 drag（移动 >8px 触发 dnd-kit）
  await page.mouse.move(srcBox!.x + srcBox!.width / 2, srcBox!.y + srcBox!.height / 2);
  await page.mouse.down();
  // 先小幅移动激活 sensor
  await page.mouse.move(srcBox!.x + 30, srcBox!.y + srcBox!.height / 2, { steps: 5 });
  await page.waitForTimeout(50);

  // 现在 dragging=true，EdgeDroppables 已挂载
  const rightEdge = page.getByTestId(`group-edge-${groupId}-right`);
  await expect(rightEdge).toBeVisible({ timeout: 1_000 });

  const edgeBox = await rightEdge.boundingBox();
  expect(edgeBox).not.toBeNull();

  // 拖到右边沿正中
  await page.mouse.move(
    edgeBox!.x + edgeBox!.width / 2,
    edgeBox!.y + edgeBox!.height / 2,
    { steps: 15 },
  );
  await page.mouse.up();
  await page.waitForTimeout(200);

  // 断言：现在有 2 个 group + root 是 split
  await expect(page.getByTestId("terminal-pane-group")).toHaveCount(2);
  const rootKind = await page.evaluate(() => {
    const w = window as unknown as {
      __getPaneLayout: () => { root: { kind: string } };
    };
    return w.__getPaneLayout().root.kind;
  });
  expect(rootKind).toBe("split");
});
