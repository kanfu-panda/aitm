import { expect, test, type Page } from "@playwright/test";
import { installTauriMock } from "./_mock-ipc";

/**
 * 持久化 round-trip e2e。
 *
 * 模拟"上次留下了 N 条对话，本次启动加载"：
 * - chat store 启动时调 loadFromScope → conv_list → 拿到 mock 预填的对话 →
 *   conv_get_messages 拉出 active 的消息 → MessageBubble 渲染
 *
 * 关键技巧：mock 的 conversationsStore / messagesStore 通过
 * __seedConversations 在 page.goto **之前**预填，让首次 loadFromScope 就拿到
 * 非空数据。addInitScript 调用顺序就是执行顺序，installTauriMock 先调，
 * 这条 init script 后调，钩子已经存在。
 */

interface SeedConv {
  id: string;
  title: string;
  title_auto: boolean;
  provider_id: string;
  model_id: string;
  created_at: number;
  updated_at: number;
}

const NOW_SEC = 1_700_000_000;

function makeConv(id: string, title: string, updatedAt: number): SeedConv {
  return {
    id,
    title,
    title_auto: false,
    provider_id: "qwen",
    model_id: "qwen-max",
    created_at: NOW_SEC,
    updated_at: updatedAt,
  };
}

/** 在 page.goto 前注入 seed —— 调 __seedConversations。
 *  注意：必须在 installTauriMock 之后调（addInitScript 顺序保留）。 */
async function seed(
  page: Page,
  convs: SeedConv[],
  messagesByCid?: Record<
    string,
    Array<{
      kind: string;
      payload_json: string;
    }>
  >,
) {
  await page.addInitScript(
    ([convs, msgs]) => {
      const seeder = (
        window as unknown as {
          __seedConversations: (
            convs: unknown[],
            messagesByCid?: Record<string, unknown[]>,
          ) => void;
        }
      ).__seedConversations;
      seeder(convs as unknown[], msgs as Record<string, unknown[]> | undefined);
    },
    [convs, messagesByCid] as const,
  );
}

test.describe("持久化 round-trip", () => {
  test("seed 2 个对话 → sidebar 显示最新 active 标题 + 历史消息渲染", async ({
    page,
  }) => {
    await installTauriMock(page);
    // c1 updated_at 大 → 排前面成为 active；c2 偏旧
    await seed(
      page,
      [
        makeConv("c1", "昨天的对话", NOW_SEC + 100),
        makeConv("c2", "前天的对话", NOW_SEC),
      ],
      {
        c1: [
          {
            kind: "user",
            payload_json: JSON.stringify({ content: "你好" }),
          },
          {
            kind: "assistant",
            payload_json: JSON.stringify({ content: "你也好" }),
          },
        ],
      },
    );

    await page.goto("/");
    await page.getByLabel("AI 助手").click();

    // active 显示在 trigger 上
    await expect(page.getByLabel("切换对话")).toContainText("昨天的对话");

    // active 是 c1（DESC 排序后 c1 在前）
    const cid = await page.evaluate(() =>
      (window as unknown as { __getChatCid: () => string }).__getChatCid(),
    );
    expect(cid).toBe("c1");

    // 消息泡渲染（user "你好" + assistant "你也好"）
    await expect(page.getByText("你好")).toBeVisible();
    await expect(page.getByText("你也好")).toBeVisible();
  });

  test("seed 2 对话 → dropdown 显示 2 项，点击切换 active", async ({
    page,
  }) => {
    await installTauriMock(page);
    await seed(page, [
      makeConv("c1", "对话一", NOW_SEC + 100),
      makeConv("c2", "对话二", NOW_SEC),
    ]);

    await page.goto("/");
    await page.getByLabel("AI 助手").click();

    // 默认 active 是 "对话一"（updated_at 更新）
    await expect(page.getByLabel("切换对话")).toContainText("对话一");
    expect(
      await page.evaluate(() =>
        (
          window as unknown as { __getConversationCount: () => number }
        ).__getConversationCount(),
      ),
    ).toBe(2);

    // 展开 dropdown
    await page.getByLabel("切换对话").click();

    // 两个对话项都可见
    await expect(page.getByLabel("切换到对话 对话一")).toBeVisible();
    await expect(page.getByLabel("切换到对话 对话二")).toBeVisible();

    // 切到第二个
    await page.getByLabel("切换到对话 对话二").click();
    await expect(page.getByLabel("切换对话")).toContainText("对话二");

    const cid = await page.evaluate(() =>
      (window as unknown as { __getChatCid: () => string }).__getChatCid(),
    );
    expect(cid).toBe("c2");
  });

  test("seed 0 对话 → loadFromScope 自动 createConversation 显示'新对话 1'", async ({
    page,
  }) => {
    await installTauriMock(page);
    // 不调 __seedConversations，conversationsStore 默认空

    await page.goto("/");
    await page.getByLabel("AI 助手").click();

    // 等空对话创建 + UI 更新（chat store loadFromScope 内部 createConversation 异步）
    await expect(page.getByLabel("切换对话")).toContainText("新对话 1", {
      timeout: 5_000,
    });
    expect(
      await page.evaluate(() =>
        (
          window as unknown as { __getConversationCount: () => number }
        ).__getConversationCount(),
      ),
    ).toBe(1);
  });
});
