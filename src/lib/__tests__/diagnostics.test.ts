import { describe, expect, it } from "vitest";

import {
  ISSUE_BODY_MAX,
  buildDiagnosticsText,
  buildIssueUrl,
} from "../diagnostics";
import type { DiagnosticsInfo } from "../tauri";

const INFO: DiagnosticsInfo = {
  version: "1.3.1",
  os: "macos",
  arch: "aarch64",
  log_dir: "/Users/x/Library/Logs/aitm",
  log_file: "/Users/x/Library/Logs/aitm/aitm.log",
  config_dir: "/Users/x/.aitm",
};

describe("buildDiagnosticsText", () => {
  it("包含版本 / 平台 / 两个目录", () => {
    const text = buildDiagnosticsText(INFO, "Mozilla/5.0 (Macintosh)");
    expect(text).toContain("1.3.1");
    expect(text).toContain("macos");
    expect(text).toContain("aarch64");
    expect(text).toContain("/Users/x/Library/Logs/aitm");
    expect(text).toContain("/Users/x/.aitm");
  });

  it("目录取不到时用占位符，不出现 null / undefined", () => {
    const text = buildDiagnosticsText(
      { ...INFO, log_dir: null, config_dir: null },
      "UA",
    );
    expect(text).not.toContain("null");
    expect(text).not.toContain("undefined");
  });

  it("带上 userAgent（里面有系统版本，报 bug 时有用）", () => {
    const text = buildDiagnosticsText(INFO, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    expect(text).toContain("Mac OS X 10_15_7");
  });
});

describe("buildIssueUrl", () => {
  it("指向本仓库的新建 issue 页", () => {
    const url = buildIssueUrl("诊断信息");
    expect(url.startsWith("https://github.com/kanfu-panda/aitm/issues/new")).toBe(
      true,
    );
  });

  it("诊断信息进 body 且做 URL 编码", () => {
    const url = buildIssueUrl("版本: 1.3.1\n平台: macos");
    expect(url).toContain(encodeURIComponent("版本: 1.3.1"));
    // 换行必须编码，否则 URL 被截断
    expect(url).not.toContain("\n");
  });

  it("body 过长时截断，避免超 URL 长度上限被服务端拒绝", () => {
    const huge = "行".repeat(ISSUE_BODY_MAX * 2);
    const url = buildIssueUrl(huge);
    // 编码后每个中文字符占 9 字节，这里只断言原文被截断到上限以内
    const body = decodeURIComponent(url.split("body=")[1] ?? "");
    expect(body.length).toBeLessThanOrEqual(ISSUE_BODY_MAX);
  });

  it("正常长度不截断", () => {
    const text = "版本: 1.3.1";
    const body = decodeURIComponent(buildIssueUrl(text).split("body=")[1] ?? "");
    expect(body).toBe(text);
  });
});

describe("buildIssueUrl 带日志尾部", () => {
  it("日志拼进正文，放在环境信息之后", () => {
    const url = buildIssueUrl("版本: 1.3.1", "panic at foo.rs:42");
    const body = decodeURIComponent(url.split("body=")[1] ?? "");
    expect(body.indexOf("版本: 1.3.1")).toBeLessThan(body.indexOf("panic at foo.rs:42"));
    expect(body).toContain("```");
  });

  it("日志为空 / 全空白时不拼空的日志段", () => {
    for (const empty of [null, undefined, "", "   \n  "]) {
      const body = decodeURIComponent(
        buildIssueUrl("版本: 1.3.1", empty).split("body=")[1] ?? "",
      );
      expect(body).toBe("版本: 1.3.1");
    }
  });

  it("整体超长时先砍日志，环境信息一个字都不能少", () => {
    const env = "版本: 1.3.1\n平台: macos aarch64";
    const body = decodeURIComponent(
      buildIssueUrl(env, "x".repeat(ISSUE_BODY_MAX * 3)).split("body=")[1] ?? "",
    );
    expect(body.startsWith(env)).toBe(true);
    expect(body.length).toBeLessThanOrEqual(ISSUE_BODY_MAX);
  });

  it("日志被截断时保留尾部（越靠后越接近现场）", () => {
    const env = "版本: 1.3.1";
    const log = "老日志".repeat(2000) + "PANIC_HERE";
    const body = decodeURIComponent(
      buildIssueUrl(env, log).split("body=")[1] ?? "",
    );
    expect(body).toContain("PANIC_HERE");
  });

  it("环境信息本身就超长时，退回只带环境信息且不超上限", () => {
    const env = "版本".repeat(ISSUE_BODY_MAX);
    const body = decodeURIComponent(
      buildIssueUrl(env, "some log").split("body=")[1] ?? "",
    );
    expect(body).not.toContain("最近日志");
    expect(body.length).toBeLessThanOrEqual(ISSUE_BODY_MAX);
  });
});
