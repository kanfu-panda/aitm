import { expect, test, type Page } from "@playwright/test";
import { installTauriMock } from "./_mock-ipc";
import { makePdfBase64 } from "./fixtures/pdf";

// 文件树点开 PDF → 文件工作区只读标签页，pdf.js 真实渲染
const CWD = "/mock/proj";
const PDF = `${CWD}/doc.pdf`;

async function openPdf(page: Page, mock: { base64?: string; error?: string }) {
  await installTauriMock(page);
  await page.addInitScript(
    ([cwd, pdf, m]) => {
      const w = window as unknown as {
        __setMockCwd: (c: string, f: Array<{ name: string; path: string }>) => void;
        __setFsReadPdf: (r: { base64?: string; error?: string }) => void;
      };
      w.__setMockCwd(cwd as string, [{ name: "doc.pdf", path: pdf as string }]);
      w.__setFsReadPdf(m as { base64?: string; error?: string });
    },
    [CWD, PDF, mock] as const,
  );
  await page.goto("/");
  await page.keyboard.press("Meta+b");
  await page.getByText("doc.pdf", { exact: true }).click();
}

test("点开 PDF：显示页数、渲染页面与文字层", async ({ page }) => {
  await openPdf(page, { base64: makePdfBase64(["hello one", "two", "hello three"]) });
  await expect(page.getByTestId("pdf-toolbar")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("pdf-page-count")).toContainText("3");
  await expect(page.locator(".pdfViewer .page canvas").first()).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".pdfViewer .textLayer").first()).toContainText("hello one");
});

test("缩放与跳页", async ({ page }) => {
  await openPdf(page, { base64: makePdfBase64(["a", "b", "c"]) });
  const level = page.getByTestId("pdf-zoom-level");
  await expect(level).toHaveText(/\d+%/, { timeout: 10_000 });
  const before = parseInt((await level.textContent()) ?? "0", 10);
  await page.getByTestId("pdf-zoom-in").click();
  await expect
    .poll(async () => parseInt((await level.textContent()) ?? "0", 10))
    .toBeGreaterThan(before);

  const input = page.getByTestId("pdf-page-input");
  await input.fill("3");
  await input.press("Enter");
  await expect(input).toHaveValue("3");
});

test("页内搜索：计数与无匹配", async ({ page }) => {
  await openPdf(page, { base64: makePdfBase64(["hello one", "two", "hello three"]) });
  await expect(page.locator(".pdfViewer .textLayer").first()).toContainText("hello", {
    timeout: 10_000,
  });
  await page.getByTestId("pdf-viewer").click();
  await page.keyboard.press("Meta+f");
  const box = page.getByTestId("pdf-search-input");
  await box.fill("hello");
  await box.press("Enter");
  // 计数由 pdf.js worker 抽取文字后给出，全量并行跑时较慢
  await expect(page.getByTestId("pdf-search-count")).toContainText("/ 2", { timeout: 10_000 });
  await box.fill("zzz-none");
  await box.press("Enter");
  await expect(page.getByTestId("pdf-search-count")).toContainText("无匹配", { timeout: 10_000 });
});

test("超过大小上限：显示提示与用默认应用打开", async ({ page }) => {
  await openPdf(page, {
    error: JSON.stringify({
      code: "fs.pdfTooLarge",
      params: { size: String(60 * 1024 * 1024), max: String(50 * 1024 * 1024) },
      message: "PDF 文件过大",
    }),
  });
  await expect(page.getByTestId("pdf-too-large")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("pdf-too-large")).toContainText("60.0 MB");
  await expect(page.getByTestId("pdf-open-default")).toBeVisible();
});
