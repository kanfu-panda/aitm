import { expect, test, type Page } from "@playwright/test";
import { installTauriMock } from "./_mock-ipc";

/**
 * InitProjectDialog 3 分支闭环。
 *
 * 后端 emit ai:init_required → 前端 InitProjectDialog 弹出 → 用户三选一：
 *   - 初始化为项目      → projectInit + ai_chat_resume(scope=project)
 *   - 临时全局           → ai_chat_resume(scope=global)，不动 projectInit / markIgnored
 *   - 别再问我这个目录   → markIgnored + ai_chat_resume(scope=global)
 *
 * vitest 单测已盖到组件 + applyChoice helper；这里在真浏览器里走完整事件链路，
 * 验证 ai:init_required 监听 → Radix Dialog 渲染 → 用户点击 → IPC 调用顺序。
 */

interface InitPayload {
  conversation_id: string;
  cwd: string;
  default_name: string;
}

const PAYLOAD: InitPayload = {
  conversation_id: "conv-need-init-1",
  cwd: "/Users/test/myproj",
  default_name: "myproj",
};

/** 封装：installTauriMock + goto + 展开侧栏 + 等输入框就绪（订阅已建好）。 */
async function setup(page: Page) {
  await installTauriMock(page);
  await page.goto("/");
  await page.getByLabel("AI 助手").click();
  await expect(page.getByPlaceholder(/输入消息/)).toBeVisible({
    timeout: 5_000,
  });
}

/** 触发 ai:init_required，等 dialog 出现。 */
async function triggerInitDialog(page: Page, payload: InitPayload) {
  await page.evaluate((p) => {
    (
      window as unknown as { __triggerInitRequired: (p: unknown) => void }
    ).__triggerInitRequired(p);
  }, payload);
  // dialog 用 Radix Portal 渲到 body 末尾；等它可见再做下一步
  await expect(page.getByRole("dialog")).toBeVisible();
}

test.describe("InitProjectDialog 3 分支", () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
  });

  test("触发 ai:init_required → dialog 出现 + 3 个选项可见", async ({
    page,
  }) => {
    await triggerInitDialog(page, PAYLOAD);

    // 标题文案（spec §7.4(1)）
    await expect(page.getByText(/在这里开始一个 AI 项目/)).toBeVisible();
    // cwd 路径回显
    await expect(page.getByText(PAYLOAD.cwd)).toBeVisible();

    // 3 个 radio（按 aria-label 定位）
    await expect(
      page.getByLabel("是，初始化为项目（推荐）"),
    ).toBeVisible();
    await expect(page.getByLabel("不用，这次临时用一下")).toBeVisible();
    await expect(page.getByLabel("别再问我这个目录")).toBeVisible();

    // 默认选中 init
    await expect(page.getByLabel("是，初始化为项目（推荐）")).toBeChecked();

    // 项目名 input 默认填入 default_name
    await expect(page.getByLabel("项目名")).toHaveValue(
      PAYLOAD.default_name,
    );
  });

  test("选'初始化为项目' → 调 project_init + ai_chat_resume(scope.kind=project)", async ({
    page,
  }) => {
    await triggerInitDialog(page, PAYLOAD);

    // 改个名字验证 project_init 收的是用户输入的值
    const nameInput = page.getByLabel("项目名");
    await nameInput.fill("my-proj");
    await page.getByRole("button", { name: "确定" }).click();

    // dialog 关闭（onResolved 后 setPendingInit(null)）
    await expect(page.getByRole("dialog")).toBeHidden();

    // project_init 被调，参数 (cwd, name) 对
    const projectInitArgs = await page.evaluate(
      () =>
        (window as unknown as { __lastProjectInitArgs: unknown })
          .__lastProjectInitArgs,
    );
    expect(projectInitArgs).toEqual({
      cwd: PAYLOAD.cwd,
      name: "my-proj",
    });

    // ai_chat_resume 被调，scope.kind === "project"
    const resumeArgs = (await page.evaluate(
      () =>
        (window as unknown as { __lastResumeArgs: unknown })
          .__lastResumeArgs,
    )) as { cid: string; scope: { kind: string } };
    expect(resumeArgs.cid).toBe(PAYLOAD.conversation_id);
    expect(resumeArgs.scope.kind).toBe("project");

    // markIgnored 没被调
    const ignoredArgs = await page.evaluate(
      () =>
        (window as unknown as { __lastMarkIgnoredArgs: unknown })
          .__lastMarkIgnoredArgs,
    );
    expect(ignoredArgs).toBeUndefined();
  });

  test("选'临时全局' → 仅 ai_chat_resume(scope.kind=global)，不调 project_init / markIgnored", async ({
    page,
  }) => {
    await triggerInitDialog(page, PAYLOAD);

    await page.getByLabel("不用，这次临时用一下").click();
    await page.getByRole("button", { name: "确定" }).click();

    await expect(page.getByRole("dialog")).toBeHidden();

    const projectInitArgs = await page.evaluate(
      () =>
        (window as unknown as { __lastProjectInitArgs: unknown })
          .__lastProjectInitArgs,
    );
    expect(projectInitArgs).toBeUndefined();

    const ignoredArgs = await page.evaluate(
      () =>
        (window as unknown as { __lastMarkIgnoredArgs: unknown })
          .__lastMarkIgnoredArgs,
    );
    expect(ignoredArgs).toBeUndefined();

    const resumeArgs = (await page.evaluate(
      () =>
        (window as unknown as { __lastResumeArgs: unknown })
          .__lastResumeArgs,
    )) as { cid: string; scope: { kind: string } };
    expect(resumeArgs.cid).toBe(PAYLOAD.conversation_id);
    expect(resumeArgs.scope.kind).toBe("global");
  });

  test("选'别再问我这个目录' → 调 mark_ignored + ai_chat_resume(scope.kind=global)", async ({
    page,
  }) => {
    await triggerInitDialog(page, PAYLOAD);

    await page.getByLabel("别再问我这个目录").click();
    await page.getByRole("button", { name: "确定" }).click();

    await expect(page.getByRole("dialog")).toBeHidden();

    // mark_ignored 被调，cwd 对
    const ignoredArgs = (await page.evaluate(
      () =>
        (window as unknown as { __lastMarkIgnoredArgs: unknown })
          .__lastMarkIgnoredArgs,
    )) as { cwd: string };
    expect(ignoredArgs).toEqual({ cwd: PAYLOAD.cwd });

    // 仍然走 global 桶
    const resumeArgs = (await page.evaluate(
      () =>
        (window as unknown as { __lastResumeArgs: unknown })
          .__lastResumeArgs,
    )) as { cid: string; scope: { kind: string } };
    expect(resumeArgs.cid).toBe(PAYLOAD.conversation_id);
    expect(resumeArgs.scope.kind).toBe("global");

    // project_init 没被调
    const projectInitArgs = await page.evaluate(
      () =>
        (window as unknown as { __lastProjectInitArgs: unknown })
          .__lastProjectInitArgs,
    );
    expect(projectInitArgs).toBeUndefined();
  });
});
