import { expect, test, type Page } from "@playwright/test";
import { installTauriMock } from "./_mock-ipc";
import {
  PNG_2X1_BASE64,
  makeDocxBase64,
  makePptxBase64,
  makeXlsxBase64,
} from "./fixtures/office";

// 文件树点开图片 / Office / CSV → 文件工作区只读标签页，各解析库真实运行
const CWD = "/mock/proj";

type Mock = { base64?: string; error?: string };

/** 挂好 mock：目录里只有一个文件，fs_read_binary / fs_read_text 按需返回。 */
async function openFile(page: Page, name: string, opts: { binary?: Mock; text?: string } = {}) {
  const path = `${CWD}/${name}`;
  await installTauriMock(page);
  await page.addInitScript(
    ([cwd, file, p, binary, text]) => {
      const w = window as unknown as {
        __setMockCwd: (c: string, f: Array<{ name: string; path: string }>) => void;
        __setFsReadBinary: (r: Mock, path?: string) => void;
        __setFsReadText: (path: string, content: string) => void;
      };
      w.__setMockCwd(cwd as string, [{ name: file as string, path: p as string }]);
      if (binary) w.__setFsReadBinary(binary as Mock);
      if (typeof text === "string") w.__setFsReadText(p as string, text);
    },
    [CWD, name, path, opts.binary ?? null, opts.text ?? null] as const,
  );
  await page.goto("/");
  await page.keyboard.press("Meta+b");
  await page.getByText(name, { exact: true }).click();
}

test("点开图片：显示尺寸，实际大小与适应窗口切换", async ({ page }) => {
  await openFile(page, "shot.png", { binary: { base64: PNG_2X1_BASE64 } });
  await expect(page.getByTestId("image-content")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("image-size")).toContainText("2 × 1");
  await page.getByTestId("image-actual").click();
  await expect(page.getByTestId("image-zoom-level")).toHaveText("100%");
  await page.getByTestId("image-fit").click();
  await expect(page.getByTestId("image-zoom-level")).toHaveText("");
});

test("点开 xlsx：显示第一个工作表并可切换", async ({ page }) => {
  await openFile(page, "sales.xlsx", { binary: { base64: makeXlsxBase64() } });
  const grid = page.getByTestId("sheet-grid");
  await expect(grid).toContainText("苹果", { timeout: 10_000 });
  await expect(page.getByTestId("sheet-tab-0")).toHaveText("Q1");
  await page.getByTestId("sheet-tab-1").click();
  await expect(grid).toContainText("香蕉");
  await expect(grid).not.toContainText("苹果");
});

test("点开 csv：默认表格，可切到文本", async ({ page }) => {
  const name = "data.csv";
  await openFile(page, name, { text: 'city,note\nBeijing,"a, b"\n' });
  const grid = page.getByTestId("sheet-grid");
  await expect(grid).toBeVisible({ timeout: 10_000 });
  await expect(grid.locator('td[data-cell="B2"]')).toHaveText("a, b");
  await page.getByTestId(`md-mode-raw-${CWD}/${name}`).click();
  await expect(grid).toHaveCount(0);
});

test("点开 docx：正文可见", async ({ page }) => {
  await openFile(page, "spec.docx", { binary: { base64: await makeDocxBase64("文档正文 hello") } });
  await expect(page.getByTestId("docx-body")).toContainText("文档正文 hello", { timeout: 10_000 });
});

test("点开 pptx：每张幻灯片的文字与标注", async ({ page }) => {
  await openFile(page, "deck.pptx", { binary: { base64: await makePptxBase64(["第一页标题", "第二页标题"]) } });
  await expect(page.getByTestId("pptx-slide-0")).toContainText("第一页标题", { timeout: 10_000 });
  await expect(page.getByTestId("pptx-slide-1")).toContainText("第二页标题");
  await expect(page.getByTestId("pptx-slide-label-0")).toContainText("第 1 张 / 共 2 张");
});

test("点开 .doc：显示暂不支持与用默认应用打开", async ({ page }) => {
  await openFile(page, "legacy.doc");
  await expect(page.getByTestId("preview-unsupported")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("preview-open-default")).toBeVisible();
});

test("Office 超过 20MB：显示超限提示", async ({ page }) => {
  await openFile(page, "huge.docx", {
    binary: {
      error: JSON.stringify({
        code: "fs.fileTooLarge",
        params: { size: String(21 * 1024 * 1024), max: String(20 * 1024 * 1024) },
        message: "文件过大",
      }),
    },
  });
  await expect(page.getByTestId("preview-too-large")).toContainText("21.0 MB", { timeout: 10_000 });
  await expect(page.getByTestId("preview-too-large")).toContainText("20.0 MB");
});
