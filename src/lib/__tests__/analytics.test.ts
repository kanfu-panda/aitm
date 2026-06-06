import { beforeEach, describe, expect, it, vi } from "vitest";

// v0.10.1：mock `@tauri-apps/api/core` 的 invoke —— analytics.ts 不再走
// @aptabase/tauri SDK，直接 invoke("plugin:aptabase|track_event")。
// 用 vi.hoisted 让 mockInvoke 在 vi.mock factory hoist 时已 ready。
const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

import { trackEvent } from "../analytics";
import { useSettingsStore } from "../../stores/settings";

/** 把 store 重置成可控的最小 settings；analytics_opt_in 由各 test 自行覆盖。 */
function resetStoreWithOptIn(optIn: boolean): void {
  useSettingsStore.setState({
    settings: {
      terminal: {
        font_family: "Menlo, monospace",
        font_size: 13,
        line_height: 1.2,
        cursor_style: "block",
        theme: "default",
      },
      shell: { default_shell: "" },
      safety: { whitelist: [], show_low_auto_approved: false },
      browser: { max_active_tabs: 3, suspend_timer_minutes: 5 },
      ui: {
        activity_bar_position: "right",
        theme_mode: "dark",
        ai_sidebar_position: "right",
        file_tree_position: "left",
        file_tree_width: 240,
        ai_sidebar_width: 360,
        file_preview_dialog: null,
        confirm_quit: true,
        pane_layout: null,
        keybindings: {},
        language: "en",
      },
      notifications: { sound: true },
      privacy: { analytics_opt_in: optIn },
      editor: { open_files: [], active_file: null, font_size: 13 },
    },
    loaded: true,
  });
}

describe("trackEvent（analytics wrapper）", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(() => Promise.resolve());
  });

  it("opt_in=true 时调用 plugin:aptabase|track_event", () => {
    resetStoreWithOptIn(true);
    trackEvent("tab_opened");
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("plugin:aptabase|track_event", {
      name: "tab_opened",
      props: undefined,
    });
  });

  it("opt_in=true 时透传 props 给底层 invoke", () => {
    resetStoreWithOptIn(true);
    trackEvent("ai_chat_sent", { provider: "deepseek" });
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("plugin:aptabase|track_event", {
      name: "ai_chat_sent",
      props: { provider: "deepseek" },
    });
  });

  it("opt_in=false 时不调底层 invoke（静默 noop）", () => {
    resetStoreWithOptIn(false);
    trackEvent("tab_opened");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("opt_in=false 时即使带 props 也不上报", () => {
    resetStoreWithOptIn(false);
    trackEvent("ai_tool_invoked", { name: "read_file" });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("invoke 同步抛错时 trackEvent 不向上抛（catch 兜底）", () => {
    resetStoreWithOptIn(true);
    mockInvoke.mockImplementationOnce(() => {
      throw new Error("Tauri not ready");
    });
    // 关键断言：调用方不需要 try/catch 也不会崩。
    expect(() => trackEvent("app_started")).not.toThrow();
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it("invoke 返回 rejected Promise 时不致命（unhandled rejection 也不抛）", async () => {
    resetStoreWithOptIn(true);
    mockInvoke.mockReturnValueOnce(Promise.reject(new Error("network down")));
    // void invoke().catch(noop) 内部已经吞掉 rejection，不会触发
    // unhandledrejection。同步 caller 也不抛。
    expect(() => trackEvent("file_previewed", { kind: "markdown" })).not.toThrow();
    // 给 microtask 一个 tick 跑完 reject 处理，避免污染后续 test
    await Promise.resolve();
    await Promise.resolve();
  });
});
