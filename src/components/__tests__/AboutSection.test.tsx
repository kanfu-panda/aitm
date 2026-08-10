import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateCheckResult } from "../../lib/tauri";
import type { PendingUpdate } from "../../lib/updater";

const shellOpenSpy = vi.fn(async (_url: string) => {});

/** 每个用例可覆盖：GitHub Releases API 兜底返回值 */
let mockResult: UpdateCheckResult;
/** 每个用例可覆盖：兜底 IPC 是否直接 reject */
let mockReject: Error | null = null;
/** 每个用例可覆盖：应用内更新器 check 的结果；抛错用 mockCheckError */
let mockPending: PendingUpdate | null = null;
let mockCheckError: Error | null = null;

vi.mock("../../lib/tauri", async (orig) => {
  const real = await orig<typeof import("../../lib/tauri")>();
  return {
    ...real,
    appVersion: vi.fn(async () => "1.3.0"),
    shellOpen: (url: string) => shellOpenSpy(url),
    updateCheck: vi.fn(async () => {
      if (mockReject) throw mockReject;
      return mockResult;
    }),
  };
});

vi.mock("../../lib/updater", () => ({
  checkForUpdate: vi.fn(async () => {
    if (mockCheckError) throw mockCheckError;
    return mockPending;
  }),
}));

import AboutSection from "../settings/AboutSection";

describe("AboutSection（关于页）", () => {
  beforeEach(() => {
    shellOpenSpy.mockClear();
    mockReject = null;
    mockPending = null;
    // 默认：应用内更新器不可用（对应老 release 无 latest.json），走兜底路径
    mockCheckError = new Error("could not fetch a valid release JSON");
    mockResult = {
      available: false,
      current_version: "1.3.0",
      latest_version: "1.3.0",
      release_url: null,
      release_notes: null,
      error: null,
    };
  });

  it("进入时显示当前版本号（不需要点检查）", async () => {
    render(<AboutSection />);
    await waitFor(() => {
      expect(screen.getByText(/1\.3\.0/)).toBeTruthy();
    });
  });

  it("更新器说无更新时提示已是最新", async () => {
    mockCheckError = null;
    mockPending = null;
    render(<AboutSection />);
    fireEvent.click(screen.getByTestId("about-check-update"));
    await waitFor(() => {
      expect(screen.getByTestId("about-up-to-date")).toBeTruthy();
    });
  });

  it("有更新时可应用内安装，点安装后显示下载进度", async () => {
    mockCheckError = null;
    const install = vi.fn(async (onProgress?: (r: number | null) => void) => {
      onProgress?.(0.5);
      // 真实实现装完会重启，这里挂起不返回，模拟"停在安装中"
      await new Promise(() => {});
    });
    mockPending = { version: "1.4.0", notes: "修了一堆 bug", install };

    render(<AboutSection />);
    fireEvent.click(screen.getByTestId("about-check-update"));
    await waitFor(() => {
      expect(screen.getByTestId("about-update-available")).toBeTruthy();
    });
    expect(screen.getByText(/1\.4\.0/)).toBeTruthy();

    fireEvent.click(screen.getByTestId("about-install"));
    await waitFor(() => {
      expect(screen.getByTestId("about-installing").textContent).toContain("50");
    });
    expect(install).toHaveBeenCalledTimes(1);
  });

  it("安装失败时显示原因，不停在进度条上", async () => {
    mockCheckError = null;
    mockPending = {
      version: "1.4.0",
      install: vi.fn(async () => {
        throw new Error("签名校验失败");
      }),
    };
    render(<AboutSection />);
    fireEvent.click(screen.getByTestId("about-check-update"));
    await waitFor(() => screen.getByTestId("about-install"));
    fireEvent.click(screen.getByTestId("about-install"));
    await waitFor(() => {
      expect(screen.getByTestId("about-check-failed").textContent).toContain("签名校验失败");
    });
    expect(screen.queryByTestId("about-installing")).toBeNull();
  });

  it("更新器不可用但 GitHub 上有新版本时，退回手动下载链接", async () => {
    mockResult = {
      available: true,
      current_version: "1.3.0",
      latest_version: "1.4.0",
      release_url: "https://x/y/aitm_1.4.0_aarch64.dmg",
      release_notes: null,
      error: null,
    };
    render(<AboutSection />);
    fireEvent.click(screen.getByTestId("about-check-update"));
    await waitFor(() => {
      expect(screen.getByTestId("about-update-manual")).toBeTruthy();
    });
    // 走的是手动路径，不该出现应用内安装按钮
    expect(screen.queryByTestId("about-install")).toBeNull();

    // 必须走 shell_open IPC —— Tauri webview 里 window.open 打不开系统浏览器
    fireEvent.click(screen.getByRole("button", { name: /下载|Download/ }));
    expect(shellOpenSpy).toHaveBeenCalledWith("https://x/y/aitm_1.4.0_aarch64.dmg");
  });

  it("两条路都失败时如实显示失败原因（不假装已是最新）", async () => {
    mockResult = {
      available: false,
      current_version: "1.3.0",
      latest_version: null,
      release_url: null,
      release_notes: null,
      error: "请求 GitHub Releases 失败: timeout",
    };
    render(<AboutSection />);
    fireEvent.click(screen.getByTestId("about-check-update"));
    await waitFor(() => {
      expect(screen.getByTestId("about-check-failed").textContent).toContain("timeout");
    });
    expect(screen.queryByTestId("about-up-to-date")).toBeNull();
  });

  it("项目主页也走 shell_open（webview 里 window.open 打不开）", async () => {
    render(<AboutSection />);
    fireEvent.click(screen.getByRole("button", { name: /项目主页|Project homepage|プロジェクトページ/ }));
    expect(shellOpenSpy).toHaveBeenCalledWith("https://github.com/kanfu-panda/aitm");
  });

  it("兜底 IPC 直接 reject 也走失败态，按钮恢复可点", async () => {
    mockReject = new Error("invoke 挂了");
    render(<AboutSection />);
    fireEvent.click(screen.getByTestId("about-check-update"));
    await waitFor(() => {
      expect(screen.getByTestId("about-check-failed")).toBeTruthy();
    });
    expect(screen.getByTestId("about-check-update").hasAttribute("disabled")).toBe(false);
  });
});
