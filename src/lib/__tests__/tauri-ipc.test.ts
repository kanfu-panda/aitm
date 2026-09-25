/**
 * src/lib/tauri.ts 的契约测试。
 *
 * tauri.ts 是前端调后端 IPC 的薄包装层：绝大多数函数形如
 * `invoke("cmd_name", { a, b })`，事件订阅函数形如 `listen("evt:name", cb)`。
 * 这层薄包装唯一容易出 bug 的地方是**命令名 / 参数名写错**——Tauri 会把 Rust
 * 端 snake_case 参数自动映射成前端 camelCase，参数名一旦手滑打错，运行时不
 * 会报类型错误，只会静默失败（后端收不到该字段，往往用默认值兜底）。
 *
 * 所以这里的测试全部围绕"调用后立刻断言 invoke / listen 收到的命令名与参数
 * 对象"，而不是验证业务逻辑（业务逻辑在后端 / 调用方）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UnlistenFn } from "@tauri-apps/api/event";

const { mockInvoke, mockListen } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockListen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mockListen,
}));

import * as Tauri from "../tauri";

// === 通用 fixture（结构必须与各接口定义精确匹配，编译期就能钉住字段名） ===

const sampleSessionConfig: Tauri.SessionConfig = { cols: 80, rows: 24 };

const sampleSettings: Tauri.AppSettings = {
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
    restore_session: true,
    pane_layout: null,
    keybindings: {},
    language: "zh-CN",
  },
  notifications: { sound: true },
  privacy: { analytics_opt_in: true },
  editor: { open_files: [], active_file: null, font_size: 13 },
};

const sampleChatArgs: Tauri.ChatSendArgs = {
  conversation_id: "c1",
  provider_id: "deepseek",
  model: "deepseek-chat",
  messages: [{ role: "user", content: "你好" }],
};

const sampleScope: Tauri.ScopeDto = { kind: "global" };

const sampleSnapshot: Tauri.SessionSnapshot = {
  schema_version: 1,
  saved_at_ms: 0,
  tabs: [],
  active_tab_id: null,
  browser_tabs: [],
  active_browser_index: null,
};

const sampleProviderPayload: Tauri.ProviderSavePayload = {
  id: "deepseek",
  enabled: true,
  api_key: "",
  base_url: "https://api.deepseek.com",
};

const sampleBounds: Tauri.BrowserBounds = { x: 0, y: 0, w: 100, h: 100 };

const mockUnlisten: UnlistenFn = vi.fn();

beforeEach(() => {
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(undefined);
  mockListen.mockReset();
});

// =============================================================================
// 一、简单 invoke 契约：每条只断言"调用后端命令名 + 参数对象"
// =============================================================================

interface InvokeCase {
  desc: string;
  cmd: string;
  /** undefined 表示该函数不带第二个参数调用 invoke（如 `invoke("app_quit_confirmed")`）。 */
  args?: Record<string, unknown>;
  call: () => Promise<unknown>;
}

const invokeCases: InvokeCase[] = [
  // --- session ---
  {
    desc: "sessionOpen",
    cmd: "session_open",
    args: { cfg: sampleSessionConfig },
    call: () => Tauri.sessionOpen(sampleSessionConfig),
  },
  {
    desc: "sessionResize",
    cmd: "session_resize",
    args: { id: "s1", cols: 80, rows: 24 },
    call: () => Tauri.sessionResize("s1", 80, 24),
  },
  {
    desc: "sessionClose",
    cmd: "session_close",
    args: { id: "s1" },
    call: () => Tauri.sessionClose("s1"),
  },
  {
    desc: "sessionCurrentCwd",
    cmd: "session_current_cwd",
    args: { id: "s1" },
    call: () => Tauri.sessionCurrentCwd("s1"),
  },
  {
    desc: "sessionHasRunningCommand",
    cmd: "session_has_running_command",
    args: { id: "s1" },
    call: () => Tauri.sessionHasRunningCommand("s1"),
  },
  // --- app 生命周期 ---
  {
    desc: "appQuitConfirmed",
    cmd: "app_quit_confirmed",
    call: () => Tauri.appQuitConfirmed(),
  },
  // --- settings ---
  {
    desc: "settingsGet",
    cmd: "settings_get",
    call: () => Tauri.settingsGet(),
  },
  {
    desc: "settingsUpdate",
    cmd: "settings_update",
    args: { settings: sampleSettings },
    call: () => Tauri.settingsUpdate(sampleSettings),
  },
  {
    desc: "settingsReset",
    cmd: "settings_reset",
    call: () => Tauri.settingsReset(),
  },
  // --- AI ---
  {
    desc: "listProviders",
    cmd: "list_providers",
    call: () => Tauri.listProviders(),
  },
  {
    desc: "aiChatSend",
    cmd: "ai_chat_send",
    args: { args: sampleChatArgs },
    call: () => Tauri.aiChatSend(sampleChatArgs),
  },
  {
    desc: "aiChatCancel",
    cmd: "ai_chat_cancel",
    call: () => Tauri.aiChatCancel(),
  },
  {
    desc: "aiToolReject",
    cmd: "ai_tool_reject",
    args: { callId: "call-1" },
    call: () => Tauri.aiToolReject("call-1"),
  },
  {
    desc: "aiToolApprove（remember 缺省 = false）",
    cmd: "ai_tool_approve",
    args: { callId: "call-1", remember: false },
    call: () => Tauri.aiToolApprove("call-1"),
  },
  {
    desc: "aiToolApprove（remember 显式 = true）",
    cmd: "ai_tool_approve",
    args: { callId: "call-2", remember: true },
    call: () => Tauri.aiToolApprove("call-2", true),
  },
  // --- provider 配置 ---
  {
    desc: "providersGetConfig",
    cmd: "providers_get_config",
    call: () => Tauri.providersGetConfig(),
  },
  {
    desc: "providersSaveConfig",
    cmd: "providers_save_config",
    args: { payload: sampleProviderPayload },
    call: () => Tauri.providersSaveConfig(sampleProviderPayload),
  },
  {
    desc: "providersTestConnection",
    cmd: "providers_test_connection",
    args: { id: "deepseek" },
    call: () => Tauri.providersTestConnection("deepseek"),
  },
  // --- tab 元信息 / 快照 ---
  {
    desc: "tabGetMetadata",
    cmd: "tab_get_metadata",
    args: { id: "s1" },
    call: () => Tauri.tabGetMetadata("s1"),
  },
  {
    desc: "sessionSnapshotLoad",
    cmd: "session_snapshot_load",
    call: () => Tauri.sessionSnapshotLoad(),
  },
  {
    desc: "sessionSnapshotSave",
    cmd: "session_snapshot_save",
    args: { snapshot: sampleSnapshot },
    call: () => Tauri.sessionSnapshotSave(sampleSnapshot),
  },
  {
    desc: "sessionSnapshotClear",
    cmd: "session_snapshot_clear",
    call: () => Tauri.sessionSnapshotClear(),
  },
  // --- safety 白名单 ---
  {
    desc: "safetyValidatePattern",
    cmd: "safety_validate_pattern",
    args: { pattern: "git *" },
    call: () => Tauri.safetyValidatePattern("git *"),
  },
  {
    desc: "safetyTestMatch",
    cmd: "safety_test_match",
    args: { cmd: "git status", patterns: ["git *"] },
    call: () => Tauri.safetyTestMatch("git status", ["git *"]),
  },
  // --- 项目作用域 ---
  {
    desc: "scopeResolve",
    cmd: "scope_resolve",
    args: { cwd: "/tmp/proj" },
    call: () => Tauri.scopeResolve("/tmp/proj"),
  },
  {
    desc: "projectInit",
    cmd: "project_init",
    args: { cwd: "/tmp/proj", name: "我的项目" },
    call: () => Tauri.projectInit("/tmp/proj", "我的项目"),
  },
  {
    desc: "markIgnored",
    cmd: "mark_ignored",
    args: { cwd: "/tmp/proj" },
    call: () => Tauri.markIgnored("/tmp/proj"),
  },
  {
    desc: "aiChatResume",
    cmd: "ai_chat_resume",
    args: { cid: "c1", scope: sampleScope },
    call: () => Tauri.aiChatResume("c1", sampleScope),
  },
  // --- 对话 / 消息持久化 ---
  {
    desc: "convList",
    cmd: "conv_list",
    args: { scope: sampleScope },
    call: () => Tauri.convList(sampleScope),
  },
  {
    desc: "convCreate",
    cmd: "conv_create",
    args: { scope: sampleScope, title: "新对话" },
    call: () => Tauri.convCreate(sampleScope, "新对话"),
  },
  {
    desc: "convDelete",
    cmd: "conv_delete",
    args: { scope: sampleScope, cid: "c1" },
    call: () => Tauri.convDelete(sampleScope, "c1"),
  },
  {
    desc: "convRename",
    cmd: "conv_rename",
    args: { scope: sampleScope, cid: "c1", title: "改名" },
    call: () => Tauri.convRename(sampleScope, "c1", "改名"),
  },
  {
    desc: "convSetModel",
    cmd: "conv_set_model",
    args: {
      scope: sampleScope,
      cid: "c1",
      providerId: "deepseek",
      modelId: "deepseek-chat",
    },
    call: () => Tauri.convSetModel(sampleScope, "c1", "deepseek", "deepseek-chat"),
  },
  {
    desc: "convAppendMessage",
    cmd: "conv_append_message",
    args: { scope: sampleScope, cid: "c1", kind: "user", payloadJson: "{}" },
    call: () => Tauri.convAppendMessage(sampleScope, "c1", "user", "{}"),
  },
  {
    desc: "convReplaceMessagePayload",
    cmd: "conv_replace_message_payload",
    args: { scope: sampleScope, cid: "c1", seq: 1, payloadJson: "{}" },
    call: () => Tauri.convReplaceMessagePayload(sampleScope, "c1", 1, "{}"),
  },
  {
    desc: "convGetMessages",
    cmd: "conv_get_messages",
    args: { scope: sampleScope, cid: "c1" },
    call: () => Tauri.convGetMessages(sampleScope, "c1"),
  },
  // --- 升级检查 / 版本 / 诊断 ---
  {
    desc: "updateCheck",
    cmd: "update_check",
    call: () => Tauri.updateCheck(),
  },
  {
    desc: "appVersion",
    cmd: "app_version",
    call: () => Tauri.appVersion(),
  },
  {
    desc: "diagnosticsInfo",
    cmd: "diagnostics_info",
    call: () => Tauri.diagnosticsInfo(),
  },
  {
    desc: "diagnosticsLogTail",
    cmd: "diagnostics_log_tail",
    call: () => Tauri.diagnosticsLogTail(),
  },
  // --- 浏览器：历史导航 ---
  {
    desc: "browserGoBack",
    cmd: "browser_go_back",
    args: { tabId: "t1" },
    call: () => Tauri.browserGoBack("t1"),
  },
  {
    desc: "browserGoForward",
    cmd: "browser_go_forward",
    args: { tabId: "t1" },
    call: () => Tauri.browserGoForward("t1"),
  },
  {
    desc: "browserReload",
    cmd: "browser_reload",
    args: { tabId: "t1" },
    call: () => Tauri.browserReload("t1"),
  },
  // --- 文件系统 ---
  {
    desc: "fsReadText（maxBytes 缺省 = 2_000_000）",
    cmd: "fs_read_text",
    args: { path: "/tmp/a.md", maxBytes: 2_000_000 },
    call: () => Tauri.fsReadText("/tmp/a.md"),
  },
  {
    desc: "fsReadText（maxBytes 显式指定）",
    cmd: "fs_read_text",
    args: { path: "/tmp/big.md", maxBytes: 500 },
    call: () => Tauri.fsReadText("/tmp/big.md", 500),
  },
  {
    desc: "fsReadPreview",
    cmd: "fs_read_preview",
    args: { path: "/tmp/a.md" },
    call: () => Tauri.fsReadPreview("/tmp/a.md"),
  },
  {
    desc: "fsDiskUsage",
    cmd: "fs_disk_usage",
    args: { path: "/tmp" },
    call: () => Tauri.fsDiskUsage("/tmp"),
  },
  {
    desc: "gitCurrentBranch",
    cmd: "git_current_branch",
    args: { cwd: "/tmp/repo" },
    call: () => Tauri.gitCurrentBranch("/tmp/repo"),
  },
  {
    desc: "fileWrite",
    cmd: "file_write",
    args: { path: "/tmp/a.txt", content: "hi" },
    call: () => Tauri.fileWrite("/tmp/a.txt", "hi"),
  },
  {
    desc: "fsCreateFile",
    cmd: "fs_create_file",
    args: { path: "/tmp/new.txt" },
    call: () => Tauri.fsCreateFile("/tmp/new.txt"),
  },
  {
    desc: "fsCreateDir",
    cmd: "fs_create_dir",
    args: { path: "/tmp/newdir" },
    call: () => Tauri.fsCreateDir("/tmp/newdir"),
  },
  {
    desc: "fsRename",
    cmd: "fs_rename",
    args: { from: "/tmp/a", to: "/tmp/b" },
    call: () => Tauri.fsRename("/tmp/a", "/tmp/b"),
  },
  {
    desc: "fsDelete",
    cmd: "fs_delete",
    args: { path: "/tmp/a" },
    call: () => Tauri.fsDelete("/tmp/a"),
  },
  {
    desc: "fsStat",
    cmd: "fs_stat",
    args: { path: "/tmp/a" },
    call: () => Tauri.fsStat("/tmp/a"),
  },
  {
    desc: "fsTree",
    cmd: "fs_tree",
    args: { path: "/tmp", maxDepth: 1 },
    call: () => Tauri.fsTree("/tmp", 1),
  },
  {
    desc: "fsWatchStart",
    cmd: "fs_watch_start",
    args: { path: "/tmp" },
    call: () => Tauri.fsWatchStart("/tmp"),
  },
  {
    desc: "fsWatchStop",
    cmd: "fs_watch_stop",
    call: () => Tauri.fsWatchStop(),
  },
  {
    desc: "gitStatus",
    cmd: "git_status",
    args: { cwd: "/tmp/repo" },
    call: () => Tauri.gitStatus("/tmp/repo"),
  },
  // --- shell ---
  {
    desc: "shellOpen",
    cmd: "shell_open",
    args: { url: "https://example.com" },
    call: () => Tauri.shellOpen("https://example.com"),
  },
  {
    desc: "shellReveal",
    cmd: "shell_reveal",
    args: { path: "/tmp/a" },
    call: () => Tauri.shellReveal("/tmp/a"),
  },
  // --- 浏览器：tab 生命周期 / 可见性 ---
  {
    desc: "browserOpenTab（mobile 缺省 = false）",
    cmd: "browser_open_tab",
    args: { url: "https://a.com", x: 0, y: 0, w: 100, h: 100, mobile: false },
    call: () => Tauri.browserOpenTab("https://a.com", sampleBounds),
  },
  {
    desc: "browserOpenTab（mobile 显式 = true）",
    cmd: "browser_open_tab",
    args: { url: "https://a.com", x: 0, y: 0, w: 100, h: 100, mobile: true },
    call: () => Tauri.browserOpenTab("https://a.com", sampleBounds, true),
  },
  {
    desc: "browserCloseTab",
    cmd: "browser_close_tab",
    args: { tabId: "t1" },
    call: () => Tauri.browserCloseTab("t1"),
  },
  {
    desc: "browserNavigate",
    cmd: "browser_navigate",
    args: { tabId: "t1", url: "https://a.com" },
    call: () => Tauri.browserNavigate("t1", "https://a.com"),
  },
  {
    desc: "browserSetActive",
    cmd: "browser_set_active",
    args: { tabId: "t1" },
    call: () => Tauri.browserSetActive("t1"),
  },
  {
    desc: "browserClearActive",
    cmd: "browser_clear_active",
    call: () => Tauri.browserClearActive(),
  },
  {
    desc: "browserSetBounds",
    cmd: "browser_set_bounds",
    args: { tabId: "t1", x: 0, y: 0, w: 100, h: 100 },
    call: () => Tauri.browserSetBounds("t1", sampleBounds),
  },
  {
    desc: "browserSetZoom",
    cmd: "browser_set_zoom",
    args: { tabId: "t1", factor: 1.5 },
    call: () => Tauri.browserSetZoom("t1", 1.5),
  },
  {
    desc: "browserSuspendTab",
    cmd: "browser_suspend_tab",
    args: { tabId: "t1" },
    call: () => Tauri.browserSuspendTab("t1"),
  },
  {
    desc: "browserSetScrollY",
    cmd: "browser_set_scroll_y",
    args: { tabId: "t1", y: 200 },
    call: () => Tauri.browserSetScrollY("t1", 200),
  },
  {
    desc: "browserPanelCloseAll",
    cmd: "browser_panel_close_all",
    call: () => Tauri.browserPanelCloseAll(),
  },
  {
    desc: "browserHideAllActive",
    cmd: "browser_hide_all_active",
    call: () => Tauri.browserHideAllActive(),
  },
  {
    desc: "browserShowAllActive",
    cmd: "browser_show_all_active",
    call: () => Tauri.browserShowAllActive(),
  },
  {
    desc: "browserOpenResult",
    cmd: "browser_open_result",
    args: { requestId: "r1", ok: true, tabId: "t1", error: null },
    call: () => Tauri.browserOpenResult("r1", true, "t1", null),
  },
  // --- tmux ---
  {
    desc: "tmuxAvailable",
    cmd: "tmux_available",
    call: () => Tauri.tmuxAvailable(),
  },
  {
    desc: "tmuxListSessions",
    cmd: "tmux_list_sessions",
    call: () => Tauri.tmuxListSessions(),
  },
  {
    desc: "tmuxAttachCommand",
    cmd: "tmux_attach_command",
    args: { id: "$1", takeover: false },
    call: () => Tauri.tmuxAttachCommand("$1", false),
  },
  {
    desc: "tmuxInterruptSession",
    cmd: "tmux_interrupt_session",
    args: { id: "$1" },
    call: () => Tauri.tmuxInterruptSession("$1"),
  },
  {
    desc: "tmuxKillSession",
    cmd: "tmux_kill_session",
    args: { id: "$1" },
    call: () => Tauri.tmuxKillSession("$1"),
  },
  {
    desc: "tmuxNewSession",
    cmd: "tmux_new_session",
    args: { name: "dev", cwd: "/tmp" },
    call: () => Tauri.tmuxNewSession("dev", "/tmp"),
  },
  {
    desc: "tmuxRenameSession",
    cmd: "tmux_rename_session",
    args: { id: "$1", name: "dev2" },
    call: () => Tauri.tmuxRenameSession("$1", "dev2"),
  },
  {
    desc: "tmuxCapturePane",
    cmd: "tmux_capture_pane",
    args: { id: "$1" },
    call: () => Tauri.tmuxCapturePane("$1"),
  },
  {
    desc: "tmuxSessionOfTab（sessionId 映射为参数名 id）",
    cmd: "tmux_session_of_tab",
    args: { id: "s1" },
    call: () => Tauri.tmuxSessionOfTab("s1"),
  },
];

describe("invoke 包装函数：命令名与参数契约", () => {
  it.each(invokeCases)("$desc 调用后端命令 $cmd 并传对参数", async ({ cmd, args, call }) => {
    await call();
    if (args === undefined) {
      expect(mockInvoke).toHaveBeenCalledWith(cmd);
    } else {
      expect(mockInvoke).toHaveBeenCalledWith(cmd, args);
    }
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// 二、sessionWrite：Uint8Array → base64 编码
// =============================================================================

describe("sessionWrite（bytes 编码为 base64 再调用 session_write）", () => {
  it("把 Uint8Array 编码为 base64 字符串，附带原始 id 一起传给后端", async () => {
    const bytes = new Uint8Array([104, 101, 108, 108, 111]); // "hello"
    await Tauri.sessionWrite("s1", bytes);
    expect(mockInvoke).toHaveBeenCalledWith("session_write", {
      id: "s1",
      bytesBase64: btoa("hello"),
    });
  });
});

// =============================================================================
// 三、setAppBadgeCount：label 计算分支 + 失败静默 console.warn
// =============================================================================

describe("setAppBadgeCount（label 计算分支 + 失败兜底 console.warn）", () => {
  it("count > 0 时 label 是该数字的字符串形式", async () => {
    await Tauri.setAppBadgeCount(3);
    expect(mockInvoke).toHaveBeenCalledWith("set_dock_badge", { label: "3" });
  });

  it("count = 0 时 label 为 null（清空角标）", async () => {
    await Tauri.setAppBadgeCount(0);
    expect(mockInvoke).toHaveBeenCalledWith("set_dock_badge", { label: null });
  });

  it("count 缺省时 label 为 null", async () => {
    await Tauri.setAppBadgeCount();
    expect(mockInvoke).toHaveBeenCalledWith("set_dock_badge", { label: null });
  });

  it("invoke 失败时不向上抛错，改为 console.warn 兜底", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockInvoke.mockRejectedValueOnce(new Error("no window"));
    await expect(Tauri.setAppBadgeCount(1)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      "[badge] set_dock_badge 失败",
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });
});

// =============================================================================
// 四、事件订阅：不带参数回调（listen 的 handler 忽略 payload，cb() 无参调用）
// =============================================================================

interface NoArgEventCase {
  desc: string;
  event: string;
  register: (cb: () => void) => Promise<UnlistenFn>;
}

const noArgEventCases: NoArgEventCase[] = [
  {
    desc: "onAppConfirmQuitRequested",
    event: "app:confirm-quit-requested",
    register: Tauri.onAppConfirmQuitRequested,
  },
  {
    desc: "onAppCloseActiveTab",
    event: "app:close-active-tab",
    register: Tauri.onAppCloseActiveTab,
  },
  {
    desc: "onProvidersChanged",
    event: "providers:changed",
    register: Tauri.onProvidersChanged,
  },
  {
    desc: "onMenuOpenAbout",
    event: "menu:open-about",
    register: Tauri.onMenuOpenAbout,
  },
];

describe("事件订阅：不带参数回调", () => {
  it.each(noArgEventCases)(
    "$desc 订阅 $event 事件，触发时不带参数调用回调",
    async ({ event, register }) => {
      let handler: (e: { payload: unknown }) => void = () => {};
      mockListen.mockImplementationOnce((_event: string, h: typeof handler) => {
        handler = h;
        return Promise.resolve(mockUnlisten);
      });

      const cb = vi.fn();
      const unlisten = await register(cb);

      expect(mockListen).toHaveBeenCalledWith(event, expect.any(Function));
      expect(unlisten).toBe(mockUnlisten);

      handler({ payload: null });
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith();
    },
  );
});

// =============================================================================
// 五、事件订阅：payload 原样转交给回调
// =============================================================================

interface PayloadEventCase {
  desc: string;
  event: string;
  register: (cb: (p: unknown) => void) => Promise<UnlistenFn>;
  payload: unknown;
}

const payloadEventCases: PayloadEventCase[] = [
  {
    desc: "onMenuFontAction",
    event: "menu:font-action",
    register: Tauri.onMenuFontAction,
    payload: "increase" satisfies Tauri.FontAction,
  },
  {
    desc: "onNotificationReceived",
    event: "notification:received",
    register: Tauri.onNotificationReceived,
    payload: {
      session_id: "s1",
      level: "waiting",
      message: "等待批准",
      source: "ai_tool_loop",
      timestamp_ms: 123,
    },
  },
  {
    desc: "onFsChanged",
    event: "fs:changed",
    register: Tauri.onFsChanged,
    payload: { paths: ["/tmp/a"] },
  },
  {
    desc: "onWindowFocusChanged",
    event: "window:focus-changed",
    register: Tauri.onWindowFocusChanged,
    payload: true,
  },
  {
    desc: "onBrowserHotkey",
    event: "browser:hotkey",
    register: Tauri.onBrowserHotkey,
    payload: { key: "b", meta: true, ctrl: false, shift: false, alt: false },
  },
  {
    desc: "onBrowserUrlChanged",
    event: "browser:url_changed",
    register: Tauri.onBrowserUrlChanged,
    payload: { tab_id: "t1", url: "https://a.com" },
  },
  {
    desc: "onBrowserTitleChanged",
    event: "browser:title_changed",
    register: Tauri.onBrowserTitleChanged,
    payload: { tab_id: "t1", title: "标题" },
  },
  {
    desc: "onBrowserOpenRequested",
    event: "browser:open_requested",
    register: Tauri.onBrowserOpenRequested,
    payload: { request_id: "r1", url: "https://a.com" },
  },
  {
    desc: "onPtyCwdChanged",
    event: "pty:cwd-changed",
    register: Tauri.onPtyCwdChanged,
    payload: { session_id: "s1", cwd: "/tmp" },
  },
  {
    desc: "onAiInitRequired",
    event: "ai:init_required",
    register: Tauri.onAiInitRequired,
    payload: { conversation_id: "c1", cwd: "/tmp", default_name: "proj" },
  },
  {
    desc: "onSystemMetrics",
    event: "system:metrics",
    register: Tauri.onSystemMetrics,
    payload: { rss_mb: 100, cpu_pct: 5, active_sessions: 2 },
  },
];

describe("事件订阅：payload 原样转交给回调", () => {
  it.each(payloadEventCases)(
    "$desc 订阅 $event 事件并把 payload 转交给回调",
    async ({ event, register, payload }) => {
      let handler: (e: { payload: unknown }) => void = () => {};
      mockListen.mockImplementationOnce((_event: string, h: typeof handler) => {
        handler = h;
        return Promise.resolve(mockUnlisten);
      });

      const cb = vi.fn();
      await register(cb);

      expect(mockListen).toHaveBeenCalledWith(event, expect.any(Function));

      handler({ payload });
      expect(cb).toHaveBeenCalledWith(payload);
    },
  );
});

// =============================================================================
// 六、事件订阅：按 conversation_id 过滤（匹配才回调，不匹配静默丢弃）
// =============================================================================

interface CidEventCase {
  desc: string;
  event: string;
  register: (cid: string, cb: (p: unknown) => void) => Promise<UnlistenFn>;
  payloadFor: (cid: string) => Record<string, unknown>;
}

const cidEventCases: CidEventCase[] = [
  {
    desc: "onAiDone",
    event: "ai:done",
    register: Tauri.onAiDone,
    payloadFor: (cid) => ({ conversation_id: cid, stop_reason: "end_turn", usage: null }),
  },
  {
    desc: "onAiError",
    event: "ai:error",
    register: Tauri.onAiError,
    payloadFor: (cid) => ({ conversation_id: cid, message: "网络错误", kind: "network" }),
  },
  {
    desc: "onAiToolRequest",
    event: "ai:tool_request",
    register: Tauri.onAiToolRequest,
    payloadFor: (cid) => ({
      conversation_id: cid,
      call_id: "call-1",
      name: "read_file",
      args_preview: "{}",
      risk: "low",
    }),
  },
  {
    desc: "onAiToolStarted",
    event: "ai:tool_started",
    register: Tauri.onAiToolStarted,
    payloadFor: (cid) => ({ conversation_id: cid, call_id: "call-1", name: "read_file" }),
  },
  {
    desc: "onAiToolFinished",
    event: "ai:tool_finished",
    register: Tauri.onAiToolFinished,
    payloadFor: (cid) => ({
      conversation_id: cid,
      call_id: "call-1",
      content: "ok",
      is_error: false,
      elapsed_ms: 10,
    }),
  },
];

describe("事件订阅：按 conversation_id 过滤", () => {
  it.each(cidEventCases)(
    "$desc：conversation_id 匹配时转发 payload，不匹配时不回调",
    async ({ event, register, payloadFor }) => {
      let handler: (e: { payload: Record<string, unknown> }) => void = () => {};
      mockListen.mockImplementationOnce((_event: string, h: typeof handler) => {
        handler = h;
        return Promise.resolve(mockUnlisten);
      });

      const cb = vi.fn();
      await register("target-cid", cb);
      expect(mockListen).toHaveBeenCalledWith(event, expect.any(Function));

      const matched = payloadFor("target-cid");
      handler({ payload: matched });
      expect(cb).toHaveBeenCalledWith(matched);

      cb.mockClear();
      const unmatched = payloadFor("other-cid");
      handler({ payload: unmatched });
      expect(cb).not.toHaveBeenCalled();
    },
  );
});

// =============================================================================
// 七、onAiToken：按 conversation_id 过滤 + 只转发 payload.text（不是整个 payload）
// =============================================================================

describe("onAiToken（cid 过滤 + 只转发 text 字段）", () => {
  it("conversation_id 匹配时把 payload.text 转交回调；不匹配时不回调", async () => {
    let handler: (e: { payload: Tauri.AiTokenEvent }) => void = () => {};
    mockListen.mockImplementationOnce((_event: string, h: typeof handler) => {
      handler = h;
      return Promise.resolve(mockUnlisten);
    });

    const cb = vi.fn();
    await Tauri.onAiToken("target-cid", cb);
    expect(mockListen).toHaveBeenCalledWith("ai:token", expect.any(Function));

    handler({ payload: { conversation_id: "target-cid", text: "你好" } });
    expect(cb).toHaveBeenCalledWith("你好");

    cb.mockClear();
    handler({ payload: { conversation_id: "other-cid", text: "不该收到" } });
    expect(cb).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 八、onSessionExit：按 session_id 过滤，回调不带参数
// =============================================================================

describe("onSessionExit（session_id 过滤，回调无参数）", () => {
  it("session_id 匹配时无参调用回调；不匹配时不回调", async () => {
    let handler: (e: { payload: Tauri.SessionExitEvent }) => void = () => {};
    mockListen.mockImplementationOnce((_event: string, h: typeof handler) => {
      handler = h;
      return Promise.resolve(mockUnlisten);
    });

    const cb = vi.fn();
    await Tauri.onSessionExit("s1", cb);
    expect(mockListen).toHaveBeenCalledWith("session:exit", expect.any(Function));

    handler({ payload: { session_id: "s1" } });
    expect(cb).toHaveBeenCalledWith();

    cb.mockClear();
    handler({ payload: { session_id: "s2" } });
    expect(cb).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 九、onAnySessionData / onSessionData：base64 解码为 Uint8Array + session 过滤
// =============================================================================

describe("onAnySessionData / onSessionData（base64 解码 + session 过滤）", () => {
  it("onAnySessionData 把 base64 payload 解码为 Uint8Array，并带 sessionId 一起转发", async () => {
    let handler: (e: { payload: Tauri.SessionDataEvent }) => void = () => {};
    mockListen.mockImplementationOnce((_event: string, h: typeof handler) => {
      handler = h;
      return Promise.resolve(mockUnlisten);
    });

    const cb = vi.fn();
    await Tauri.onAnySessionData(cb);
    expect(mockListen).toHaveBeenCalledWith("session:data", expect.any(Function));

    handler({ payload: { session_id: "s1", bytes_base64: btoa("hi") } });
    expect(cb).toHaveBeenCalledTimes(1);
    const [sid, bytes] = cb.mock.calls[0] as [string, Uint8Array];
    expect(sid).toBe("s1");
    expect(Array.from(bytes)).toEqual([104, 105]); // "hi" 的字节码
  });

  it("onSessionData 只在 sessionId 匹配 targetId 时把 bytes 转发出去", async () => {
    let handler: (e: { payload: Tauri.SessionDataEvent }) => void = () => {};
    mockListen.mockImplementationOnce((_event: string, h: typeof handler) => {
      handler = h;
      return Promise.resolve(mockUnlisten);
    });

    const cb = vi.fn();
    await Tauri.onSessionData("s1", cb);
    // onSessionData 内部转调 onAnySessionData，只会注册一次 session:data 监听
    expect(mockListen).toHaveBeenCalledWith("session:data", expect.any(Function));
    expect(mockListen).toHaveBeenCalledTimes(1);

    handler({ payload: { session_id: "s2", bytes_base64: btoa("no") } });
    expect(cb).not.toHaveBeenCalled();

    handler({ payload: { session_id: "s1", bytes_base64: btoa("ok") } });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(Array.from(cb.mock.calls[0][0] as Uint8Array)).toEqual([111, 107]); // "ok"
  });
});
