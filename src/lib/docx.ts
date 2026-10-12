/* docx 适配层：按需加载 docx-preview，把 Word 文档渲染进容器。 */

export async function renderDocx(body: HTMLElement, data: ArrayBuffer): Promise<void> {
  const { renderAsync } = await import("docx-preview");
  await renderAsync(data, body, body, {
    inWrapper: true,
    breakPages: true,
    ignoreLastRenderedPageBreak: true,
    renderHeaders: true,
    renderFooters: true,
    renderFootnotes: true,
    renderEndnotes: true,
    renderComments: false,
    // 关闭内嵌 HTML 片段（altChunk）：默认走与应用同源的 iframe srcdoc，不安全
    renderAltChunks: false,
    // 图片与字体以 data: URL 输出，落在现有 CSP 允许范围内
    useBase64URL: true,
    experimental: false,
  });
}
