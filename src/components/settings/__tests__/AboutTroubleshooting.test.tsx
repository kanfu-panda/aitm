import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DiagnosticsInfo } from "../../../lib/tauri";

const mockDiagnostics: DiagnosticsInfo = {
  version: "1.3.1",
  os: "macos",
  arch: "aarch64",
  log_dir: "/Users/x/Library/Logs/aitm",
  log_file: "/Users/x/Library/Logs/aitm/aitm.log",
  config_dir: "/Users/x/.aitm",
};

const shellOpenMock = vi.fn(async (_url: string) => {});
const shellRevealMock = vi.fn(async (_path: string) => {});
const logTailMock = vi.fn(async (): Promise<string | null> => "panic at foo.rs:42");
const diagnosticsInfoMock = vi.fn(async (): Promise<DiagnosticsInfo> => mockDiagnostics);

vi.mock("../../../lib/tauri", async (orig) => {
  const real = await orig<typeof import("../../../lib/tauri")>();
  return {
    ...real,
    appVersion: vi.fn(async () => "1.3.1"),
    diagnosticsInfo: () => diagnosticsInfoMock(),
    shellOpen: (url: string) => shellOpenMock(url),
    shellReveal: (path: string) => shellRevealMock(path),
    diagnosticsLogTail: () => logTailMock(),
    updateCheck: vi.fn(async () => ({
      available: false,
      current_version: "1.3.1",
      latest_version: null,
      release_url: null,
      release_notes: null,
      error: null,
    })),
  };
});

import AboutSection from "../AboutSection";

describe("关于页 · 故障排查", () => {
  beforeEach(() => {
    shellOpenMock.mockClear();
    shellRevealMock.mockClear();
    logTailMock.mockClear();
    logTailMock.mockResolvedValue("panic at foo.rs:42");
    diagnosticsInfoMock.mockClear();
    diagnosticsInfoMock.mockResolvedValue(mockDiagnostics);
  });

  it("展示诊断文本：版本 / 平台 / 日志目录", async () => {
    render(<AboutSection />);
    const pre = await screen.findByTestId("about-diagnostics-text");
    expect(pre.textContent).toContain("1.3.1");
    expect(pre.textContent).toContain("macos aarch64");
    expect(pre.textContent).toContain("/Users/x/Library/Logs/aitm");
  });

  it("点「打开日志目录」走 reveal 而不是 open，且指向日志文件", async () => {
    // 日志目录叫 com.aitm.app，目录名以 .app 结尾——macOS `open` 会把它当应用
    // 程序包去启动并失败，而 shell_open 不等退出码，失败被整个吞掉。必须 reveal。
    render(<AboutSection />);
    const btn = await screen.findByTestId("about-open-log-dir");
    btn.click();
    await waitFor(() => {
      expect(shellRevealMock).toHaveBeenCalledWith(
        "/Users/x/Library/Logs/aitm/aitm.log",
      );
    });
    expect(shellOpenMock).not.toHaveBeenCalled();
  });

  it("日志文件不存在时退回 reveal 目录", async () => {
    diagnosticsInfoMock.mockResolvedValue({ ...mockDiagnostics, log_file: null });
    render(<AboutSection />);
    (await screen.findByTestId("about-open-log-dir")).click();
    await waitFor(() => {
      expect(shellRevealMock).toHaveBeenCalledWith("/Users/x/Library/Logs/aitm");
    });
  });

  it("reveal 失败时把错误显示出来，不再静默", async () => {
    shellRevealMock.mockRejectedValueOnce(new Error("路径不存在"));
    render(<AboutSection />);
    (await screen.findByTestId("about-open-log-dir")).click();
    expect(await screen.findByTestId("about-open-log-dir-failed")).toBeTruthy();
  });

  it("点「报告问题」开的是预填了诊断信息的新建 issue 页", async () => {
    render(<AboutSection />);
    const btn = await screen.findByTestId("about-report-issue");
    btn.click();
    await waitFor(() => expect(shellOpenMock).toHaveBeenCalled());
    const url = shellOpenMock.mock.calls[0]?.[0] ?? "";
    expect(url).toContain("github.com/kanfu-panda/aitm/issues/new");
    expect(decodeURIComponent(url)).toContain("1.3.1");
    // 只有环境信息的 issue 对排查没帮助，正文必须带上日志现场
    expect(decodeURIComponent(url)).toContain("panic at foo.rs:42");
  });

  it("读日志失败时照常开 issue，只是正文不带日志", async () => {
    logTailMock.mockRejectedValueOnce(new Error("权限不足"));
    render(<AboutSection />);
    (await screen.findByTestId("about-report-issue")).click();
    await waitFor(() => expect(shellOpenMock).toHaveBeenCalled());
    const url = decodeURIComponent(shellOpenMock.mock.calls[0]?.[0] ?? "");
    expect(url).toContain("1.3.1");
    expect(url).not.toContain("最近日志");
  });

  it("复制成功给出明确反馈", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<AboutSection />);
    (await screen.findByTestId("about-copy-diagnostics")).click();
    expect(await screen.findByTestId("about-copied")).toBeTruthy();
    expect(writeText).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("剪贴板被拒时提示手动选中，而不是静默失败", async () => {
    // webview 里剪贴板权限时灵时不灵，静默失败会让用户以为复制成功了
    const writeText = vi.fn(async () => {
      throw new Error("拒绝访问剪贴板");
    });
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<AboutSection />);
    (await screen.findByTestId("about-copy-diagnostics")).click();
    expect(await screen.findByTestId("about-copy-failed")).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("日志文件和目录都拿不到时按钮禁用，不给一个点了没反应的按钮", async () => {
    diagnosticsInfoMock.mockResolvedValue({
      ...mockDiagnostics,
      log_file: null,
      log_dir: null,
    });
    render(<AboutSection />);
    const btn = await screen.findByTestId("about-open-log-dir");
    expect(btn).toBeDisabled();
  });

  it("诊断文本里不出现 null / undefined", async () => {
    diagnosticsInfoMock.mockResolvedValue({
      ...mockDiagnostics,
      log_file: null,
      log_dir: null,
      config_dir: null,
    });
    render(<AboutSection />);
    const pre = await screen.findByTestId("about-diagnostics-text");
    expect(pre.textContent).not.toContain("null");
    expect(pre.textContent).not.toContain("undefined");
  });
});
