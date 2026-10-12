/* docx 适配层单测：docx-preview 用假实现代替，只验证传参与错误透传。 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ renderAsync: vi.fn() }));

vi.mock("docx-preview", () => ({
  renderAsync: h.renderAsync,
}));

import { renderDocx } from "../docx";

beforeEach(() => {
  h.renderAsync.mockReset().mockResolvedValue(undefined);
});

describe("renderDocx", () => {
  it("应该_当渲染时_把原数据与_body_作为内容与样式容器传给_renderAsync", async () => {
    const body = document.createElement("div");
    const data = new ArrayBuffer(16);
    await renderDocx(body, data);
    expect(h.renderAsync).toHaveBeenCalledTimes(1);
    const [d, bodyContainer, styleContainer] = h.renderAsync.mock.calls[0];
    expect(d).toBe(data);
    expect(bodyContainer).toBe(body);
    expect(styleContainer).toBe(body);
  });

  it("应该_当渲染时_使用安全选项并关闭内嵌_HTML_与批注", async () => {
    await renderDocx(document.createElement("div"), new ArrayBuffer(4));
    const options = h.renderAsync.mock.calls[0][3];
    expect(options).toMatchObject({
      renderAltChunks: false,
      useBase64URL: true,
      renderComments: false,
      inWrapper: true,
      breakPages: true,
      experimental: false,
    });
  });

  it("应该_当_renderAsync_失败时_renderDocx_以同一个错误失败", async () => {
    const err = new Error("not a zip");
    h.renderAsync.mockRejectedValue(err);
    await expect(renderDocx(document.createElement("div"), new ArrayBuffer(4))).rejects.toBe(err);
  });
});
