import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type SessionId = string;

export interface SessionConfig {
  shell?: string | null;
  cwd?: string | null;
  cols: number;
  rows: number;
}

export interface SessionDataEvent {
  session_id: SessionId;
  bytes_base64: string;
}

export interface SessionExitEvent {
  session_id: SessionId;
}

export async function sessionOpen(cfg: SessionConfig): Promise<SessionId> {
  return await invoke<SessionId>("session_open", { cfg });
}

export async function sessionWrite(id: SessionId, bytes: Uint8Array): Promise<void> {
  const bytesBase64 = btoa(String.fromCharCode(...bytes));
  await invoke("session_write", { id, bytesBase64 });
}

export async function sessionResize(
  id: SessionId,
  cols: number,
  rows: number,
): Promise<void> {
  await invoke("session_resize", { id, cols, rows });
}

export async function sessionClose(id: SessionId): Promise<void> {
  await invoke("session_close", { id });
}

/** 1F：实时查 session 的 shell cwd 字符串（用户在 PTY 里 cd 后会反映过来）。
 *  session 不存在 / 平台不支持时返回 null。前端 AiSidebar 启动 / 切 tab
 *  时调用，再用结果调 [`scopeResolve`] 决定 chat store 加载哪个 bucket。 */
export async function sessionCurrentCwd(
  id: SessionId,
): Promise<string | null> {
  return await invoke<string | null>("session_current_cwd", { id });
}

/** 订阅某 session 的输出 chunk。返回 unlisten。 */
export async function onSessionData(
  targetId: SessionId,
  cb: (bytes: Uint8Array) => void,
): Promise<UnlistenFn> {
  return await listen<SessionDataEvent>("session:data", (e) => {
    if (e.payload.session_id !== targetId) return;
    const bin = atob(e.payload.bytes_base64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    cb(arr);
  });
}

/** 订阅某 session 的退出。 */
export async function onSessionExit(
  targetId: SessionId,
  cb: () => void,
): Promise<UnlistenFn> {
  return await listen<SessionExitEvent>("session:exit", (e) => {
    if (e.payload.session_id === targetId) cb();
  });
}

// === v0.9.0 T4：关闭应用二次确认 ===

/** 用户在"确认退出"dialog 点"退出"后调；后端走 `app.exit(0)` 真退。
 *  关闭 dialog（点"取消"）走前端 `setOpen(false)` 即可，不需要 IPC。 */
export async function appQuitConfirmed(): Promise<void> {
  await invoke("app_quit_confirmed");
}

/** 订阅后端在 main webview CloseRequested 时 emit 的 `app:confirm-quit-requested` 事件。
 *  前端 `QuitConfirmDialog` 监听后弹 dialog；用户点"退出"→ `appQuitConfirmed()`。 */
export async function onAppConfirmQuitRequested(
  cb: () => void,
): Promise<UnlistenFn> {
  return await listen<null>("app:confirm-quit-requested", () => cb());
}

/** v0.10.0 HR9-8：订阅 macOS 自定义 menu "关闭标签 Cmd+W" 触发的 `app:close-active-tab` 事件。
 *  macOS NSMenu performKeyEquivalent 在 NSApp 层吃掉 Cmd+W，webview keyDown 收不到，
 *  必须走 menu event 路径。前端 App.tsx 收到后调跟 useShortcuts.closeTab 同一 handler。 */
export async function onAppCloseActiveTab(
  cb: () => void,
): Promise<UnlistenFn> {
  return await listen<null>("app:close-active-tab", () => cb());
}

/** v0.10.6 T4：订阅 NSMenu View > Increase/Decrease/Reset Font Size 触发的
 *  `menu:font-action` 事件。payload = "increase" / "decrease" / "reset"，
 *  前端 App.tsx 收到后调跟 Cmd++/Cmd+-/Cmd+0 同一 adjustFontSize handler。 */
export type FontAction = "increase" | "decrease" | "reset";

export async function onMenuFontAction(
  cb: (action: FontAction) => void,
): Promise<UnlistenFn> {
  return await listen<FontAction>("menu:font-action", (e) => cb(e.payload));
}

// === settings ===

export type CursorStyle = "block" | "underline" | "bar";

export interface AppSettings {
  terminal: {
    font_family: string;
    font_size: number;
    line_height: number;
    cursor_style: CursorStyle;
    /** 主题 ID：default / dracula / solarized-dark / solarized-light / one-dark
     *  完整 ITheme 由 src/lib/themes.ts 的 THEMES 注册表按 ID 查表 */
    theme: string;
  };
  shell: {
    default_shell: string;
  };
  safety: {
    /** L3 白名单 glob 模式列表（命中即降级到 LOW 自动批）。 */
    whitelist: string[];
    /** 自动批准（LOW / 白名单命中）时是否在工具气泡上显示徽章。 */
    show_low_auto_approved: boolean;
  };
  /** Phase 4A T5：内嵌浏览器（embedded browser）配置。 */
  browser: BrowserSettings;
  /** v0.4.1：UI 体系化设置。 */
  ui: UiSettings;
  /** v0.5.0-A：通知系统设置。 */
  notifications: NotificationSettings;
  /** v0.7.0-A：隐私 / 匿名使用统计设置。 */
  privacy: PrivacySettings;
  /** v0.9.0 T5b：文件编辑器 tab 状态持久化。 */
  editor: EditorSettings;
}

/** v0.9.0 T5b：文件编辑器 tab 状态（mirror 后端 `crate::settings::EditorSettings`）。
 *
 * - `open_files`：当前打开 tab 的文件**绝对路径**列表；顺序与 UI tab 顺序一致；
 *   重启时按列表顺序逐个 `openFile` 恢复。
 * - `active_file`：上次激活的文件路径；不在 `open_files` 内时前端回退首项；
 *   列表为空时为 null。 */
export interface EditorSettings {
  open_files: string[];
  active_file: string | null;
  /** v0.10.6 T4：CodeMirror 字号（px，整数）。默认 13；前端 `clampFontSize`
   *  限制 10..24。后端只存原始 u16，不做范围校验。 */
  font_size: number;
}

/** v0.7.0-A：隐私设置（mirror 后端 `crate::settings::PrivacySettings`）。 */
export interface PrivacySettings {
  /** 是否参与 Aptabase 匿名使用统计；默认 true。关掉之后 `analytics.ts`
   *  wrapper 静默丢弃事件，Rust 侧 `app_started/app_exited` 不受影响。 */
  analytics_opt_in: boolean;
}

/** v0.5.0-A：通知系统设置（mirror 后端 `crate::settings::NotificationSettings`）。 */
export interface NotificationSettings {
  /** 系统通知触发时是否带 macOS 默认提示音。默认 true。 */
  sound: boolean;
}

/** v0.4.1：UI 体系化设置（mirror 后端 `crate::settings::UiSettings`）。 */
export interface UiSettings {
  /** ActivityBar 摆放位置；默认 `right`。 */
  activity_bar_position: ActivityBarPosition;
  /** v0.4.1 T5：主题模式（auto / dark / light）；默认 `dark`。 */
  theme_mode: ThemeMode;
  /** v0.5.0-B：AI 侧栏位置；默认 `right`。 */
  ai_sidebar_position: SidePanelPosition;
  /** v0.5.0-B：文件树位置；默认 `left`。 */
  file_tree_position: SidePanelPosition;
  /** v0.6.0-A：FileTree 宽度（px）；默认 240。
   *  IPC 层 `settings_update` 会 clamp 到 [180, 600]。 */
  file_tree_width: number;
  /** v0.6.0-A：AiSidebar 宽度（px）；默认 360。
   *  IPC 层 `settings_update` 会 clamp 到 [180, 600]。 */
  ai_sidebar_width: number;
  /** v0.6.0-A：FilePreviewDialog 上次位置 + 尺寸。
   *  `null` 表示首次打开（前端居中 + 默认尺寸 800×600）；
   *  off-screen detect 由前端逻辑处理（后端不 clamp）。 */
  file_preview_dialog: DialogRect | null;
  /** v0.9.0 T4：关闭应用时是否弹"确认退出"对话框；默认 true。
   *  关掉之后红叉 / Cmd+Q 直接退出，跟 v0.8.x 之前行为一致。 */
  confirm_quit: boolean;
  /** v0.10.0 HR6-3e：分屏 layout tree 跨重启持久化的 JSON 字符串。
   *
   *  - `null` / 缺省 → 首次启动，前端用 `makeDefaultRoot()` 单 leaf 兜底。
   *  - 否则前端 `JSON.parse` + `sanitizeLayout` 过滤失效 tab id 后
   *    `resetLayout` 灌进 `usePaneLayoutStore`。
   *
   *  之所以传 string 而不是嵌套对象：后端 `UiSettings.pane_layout` 是
   *  `Option<String>`，把整棵 LayoutNode tree 当不透明 blob 存进 TOML
   *  （递归 tagged enum 在 TOML 里表达笨拙）。 */
  pane_layout: string | null;
  /** v0.10.0 HR7-7：用户自定义快捷键覆盖。
   *
   *  - **key** = action 名（前端 [`ActionName`] 字符串字面量，如 `"newTab"` /
   *    `"closePane"`）；缺失走 [`DEFAULT_KEYBINDINGS`]。
   *  - **value** = 快捷键描述字符串（如 `"Cmd+T"` / `"Cmd+Shift+W"` / `"Cmd+\\"` /
   *    `"Cmd+,"`），由 [`parseKeybinding`] 解析。
   *
   *  只存"用户改过"的覆盖项，默认 binding 不入盘（避免老 toml 升级写一堆
   *  冗余）。冲突检测在前端 [`findConflicts`] 完成；后端不解析仅当 blob 转发。 */
  keybindings: Record<string, string>;
  /** v0.10.4 i18n：UI 显示语言。值是 BCP 47 locale 代码：
   *  当前支持 `"en"` / `"zh-CN"` / `"ja"`；默认 `"en"`。
   *  老 toml 缺字段时后端 `#[serde(default = "default_language")]` → "en"。 */
  language: string;
}

/** v0.6.0-A：浮动 Dialog 的位置 + 尺寸（CSS px，左上角原点）。 */
export interface DialogRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** ActivityBar 4 向位置；与后端 enum kebab-case 对齐。 */
export type ActivityBarPosition = "right" | "left" | "top" | "bottom";

/** v0.5.0-B：AI 侧栏 / 文件树左右位置；与后端 enum kebab-case 对齐。 */
export type SidePanelPosition = "left" | "right";

/** v0.4.1 T5：主题模式三态；与后端 `ThemeMode` enum lowercase 对齐。
 * - `auto`：跟随系统 `prefers-color-scheme`
 * - `dark`：强制暗色（默认）
 * - `light`：强制亮色
 */
export type ThemeMode = "auto" | "dark" | "light";

/** Phase 4A T5：内嵌浏览器自动 suspend 策略参数。 */
export interface BrowserSettings {
  /** 同时 active 的 webview 上限（超出 → LRU 自动 suspend）。默认 3，硬上限 10。 */
  max_active_tabs: number;
  /** 失焦多少分钟自动 suspend。默认 5；最小 1，最大 60。 */
  suspend_timer_minutes: number;
}

export async function settingsGet(): Promise<AppSettings> {
  return await invoke<AppSettings>("settings_get");
}

export async function settingsUpdate(s: AppSettings): Promise<void> {
  await invoke("settings_update", { settings: s });
}

export async function settingsReset(): Promise<AppSettings> {
  return await invoke<AppSettings>("settings_reset");
}

// === AI ===

export type Role = "user" | "assistant" | "tool";

export interface AiMessage {
  role: Role;
  content: string;
}

export interface ProviderModel {
  id: string;
  display_name: string;
  context_window: number;
}

export interface AiCapabilities {
  supports_tools: boolean;
  supports_streaming_tools: boolean;
  needs_args_concat: boolean;
}

export interface ProviderEntry {
  id: string;
  display_name: string;
  models: ProviderModel[];
  capabilities: AiCapabilities;
}

export interface AiTokenEvent {
  conversation_id: string;
  text: string;
}

export interface AiDoneEvent {
  conversation_id: string;
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number } | null;
}

export interface AiErrorEvent {
  conversation_id: string;
  message: string;
  kind: "unauthorized" | "rate_limited" | "network" | "protocol" | "other";
}

export interface ChatSendArgs {
  conversation_id: string;
  provider_id: string;
  model: string;
  messages: AiMessage[];
  system?: string | null;
  max_tokens?: number;
  temperature?: number;
  /** 当前活跃 tab 的 session id；run_command / terminal_history 工具兜底用 */
  active_session_id?: string | null;
  /** 1F：当前活跃 tab 的 shell cwd 绝对路径，用于后端 scope 解析。
   *  缺失时后端用 active_session_id 兜底查；都没有用 HOME。 */
  cwd?: string | null;
  /** v0.9.2 HR5-1+2：每轮运行时 active 状态快照（终端 cwd / 浏览器 URL /
   *  编辑器文件 / OS）。后端 append 到 system prompt 末尾，让 AI 不再瞎猜
   *  / 谎报"已跳转"。前端用 [`collectRuntimeContext`] 在发送前一刻拼。 */
  runtime_context?: RuntimeContext;
}

/** v0.9.2 HR5：运行时 active 状态。完整定义见 [`src/lib/aiContext.ts`]。
 *  这里只在 tauri.ts IPC 协议层引用一次，单测覆盖各组合在 aiContext.test.ts。 */
export type RuntimeContext = import("./aiContext").RuntimeContext;

export async function listProviders(): Promise<ProviderEntry[]> {
  return await invoke<ProviderEntry[]>("list_providers");
}

export async function aiChatSend(args: ChatSendArgs): Promise<void> {
  await invoke("ai_chat_send", { args });
}

export async function aiChatCancel(): Promise<void> {
  await invoke("ai_chat_cancel");
}

export async function onAiToken(
  cid: string,
  cb: (text: string) => void,
): Promise<UnlistenFn> {
  return await listen<AiTokenEvent>("ai:token", (e) => {
    if (e.payload.conversation_id === cid) cb(e.payload.text);
  });
}

export async function onAiDone(
  cid: string,
  cb: (e: AiDoneEvent) => void,
): Promise<UnlistenFn> {
  return await listen<AiDoneEvent>("ai:done", (e) => {
    if (e.payload.conversation_id === cid) cb(e.payload);
  });
}

export async function onAiError(
  cid: string,
  cb: (e: AiErrorEvent) => void,
): Promise<UnlistenFn> {
  return await listen<AiErrorEvent>("ai:error", (e) => {
    if (e.payload.conversation_id === cid) cb(e.payload);
  });
}

// === AI 工具调用事件 ===

/** 风险等级，跟 src-tauri/src/tools/mod.rs 的 RiskClass 一一对应。 */
export type RiskClass = "low" | "high" | "destructive";

/** 工具调用申请（仅 High / Destructive 触发，Low 自动批准跳过）。 */
export interface AiToolRequestEvent {
  conversation_id: string;
  call_id: string;
  name: string;
  /** 已 pretty-print 的入参 JSON 字符串，给 ConfirmDialog 显示。 */
  args_preview: string;
  risk: RiskClass;
  /** L2 启发式给出的归类原因（仅 run_command 走 L2 时有值；如 "L2：sudo 提权"）。 */
  risk_reason?: string | null;
}

export interface AiToolStartedEvent {
  conversation_id: string;
  call_id: string;
  name: string;
}

export interface AiToolFinishedEvent {
  conversation_id: string;
  call_id: string;
  /** 工具回执给 LLM 的内容（成功输出或错误描述）。 */
  content: string;
  is_error: boolean;
  /** 自动批准的原因（"L2：只读命令 ls" / "白名单：git status \*"）；
   * 走过 ask_user 弹窗的留 None。前端在 ToolCallBubble 上展示徽章。 */
  auto_approved_reason?: string | null;
}

/** 用户批准某个工具调用，喂回后端 tool loop。 */
export async function aiToolApprove(callId: string): Promise<void> {
  await invoke("ai_tool_approve", { callId });
}

/** 用户拒绝某个工具调用。 */
export async function aiToolReject(callId: string): Promise<void> {
  await invoke("ai_tool_reject", { callId });
}

export async function onAiToolRequest(
  cid: string,
  cb: (e: AiToolRequestEvent) => void,
): Promise<UnlistenFn> {
  return await listen<AiToolRequestEvent>("ai:tool_request", (e) => {
    if (e.payload.conversation_id === cid) cb(e.payload);
  });
}

export async function onAiToolStarted(
  cid: string,
  cb: (e: AiToolStartedEvent) => void,
): Promise<UnlistenFn> {
  return await listen<AiToolStartedEvent>("ai:tool_started", (e) => {
    if (e.payload.conversation_id === cid) cb(e.payload);
  });
}

export async function onAiToolFinished(
  cid: string,
  cb: (e: AiToolFinishedEvent) => void,
): Promise<UnlistenFn> {
  return await listen<AiToolFinishedEvent>("ai:tool_finished", (e) => {
    if (e.payload.conversation_id === cid) cb(e.payload);
  });
}

// === Provider config ===

export type KeySource = "env" | "dotenv" | "config" | "none";

export interface ProviderConfigDto {
  id: string;
  display_name: string;
  enabled: boolean;
  api_key_masked: string;
  key_source: KeySource;
  base_url: string;
  default_base_url: string;
  models: ProviderModel[];
}

export interface ProviderSavePayload {
  id: string;
  enabled: boolean;
  /** 空字符串 = 保留原 key（"留空 = 不变"语义） */
  api_key: string;
  base_url: string;
}

export interface ProviderTestResult {
  ok: boolean;
  elapsed_ms: number;
  message: string;
}

export async function providersGetConfig(): Promise<ProviderConfigDto[]> {
  return await invoke<ProviderConfigDto[]>("providers_get_config");
}

export async function providersSaveConfig(payload: ProviderSavePayload): Promise<void> {
  await invoke("providers_save_config", { payload });
}

export async function providersTestConnection(id: string): Promise<ProviderTestResult> {
  return await invoke<ProviderTestResult>("providers_test_connection", { id });
}

export async function onProvidersChanged(cb: () => void): Promise<UnlistenFn> {
  return await listen<unknown>("providers:changed", () => cb());
}

// === v0.5.0-A 通知系统 ===

export interface NotificationReceivedPayload {
  session_id: string;
  level: "running" | "waiting" | "done" | "error";
  message: string;
  source: "ai_tool_loop" | "osc_9" | "osc_99" | "osc_777";
  timestamp_ms: number;
}

/** 后端 notification:received 事件订阅（OSC 解析 + AI 工具循环触发的统一通道）。 */
export async function onNotificationReceived(
  cb: (payload: NotificationReceivedPayload) => void,
): Promise<UnlistenFn> {
  return await listen<NotificationReceivedPayload>(
    "notification:received",
    (e) => cb(e.payload),
  );
}

// === v0.5.0-B Tab 元信息 ===

export interface TabMetadata {
  git_branch: string | null;
  git_dirty: boolean;
  git_unpushed_count: number | null;
  cwd: string | null;
  listening_ports: number[];
}

/** 拉某 session 的 Tab 元信息（前端 5s poll active tab）；cache 未刷过 → null */
export async function tabGetMetadata(id: SessionId): Promise<TabMetadata | null> {
  return await invoke<TabMetadata | null>("tab_get_metadata", { id });
}

// === v0.5.0-D Session 持久化（跨重启 tab 列表 + cwd + title + unread） ===

export interface TabSnapshot {
  tab_id: string;
  title: string;
  cwd: string | null;
  unread: number;
  /**
   * v0.10.0 HR9-5：tab 所属 PaneGroup 的 id。
   *
   * 关键：snapshot 跟 settings.ui.pane_layout 是两份独立持久化。重启时
   * useTabsStore.addTab() 给每个 tab 生成新 uuid，旧 layout 里的 tab_ids 全部
   * 失效。snapshot 记下 tab 当时的 group 归属，restore 时按 group_id 把新 tab id
   * 加进对应 group，恢复分屏视图。
   *
   * 缺省（null / 旧 snapshot 没该字段） → restore 时 fallback INITIAL_GROUP_ID。
   */
  group_id: string | null;
}

export interface SessionSnapshot {
  schema_version: number;
  saved_at_ms: number;
  tabs: TabSnapshot[];
  active_tab_id: string | null;
}

/** 启动时调；无 / 坏 snapshot → null，前端走默认路径。 */
export async function sessionSnapshotLoad(): Promise<SessionSnapshot | null> {
  return await invoke<SessionSnapshot | null>("session_snapshot_load");
}

/** debounced 1s 触发；写失败静默 log warn（不阻塞主路径）。 */
export async function sessionSnapshotSave(
  snapshot: SessionSnapshot,
): Promise<void> {
  await invoke("session_snapshot_save", { snapshot });
}

/** 用户选"全新启动"时调。 */
export async function sessionSnapshotClear(): Promise<void> {
  await invoke("session_snapshot_clear");
}

// === Safety 白名单 ===

/** 校验单条 glob 模式语法是否合法。SettingsModal 输入框 blur 时调。
 *  合法 → resolve；非法 → reject，错误消息可直接展给用户。 */
export async function safetyValidatePattern(pattern: string): Promise<void> {
  await invoke("safety_validate_pattern", { pattern });
}

/** 测试 cmd 是否会被 patterns 命中。命中返回原 pattern；不命中返回 null。
 *  含 shell 元字符的 cmd（;|&\`\$( 等）即使 glob 命中也算不命中（防注入）。 */
export async function safetyTestMatch(
  cmd: string,
  patterns: string[],
): Promise<string | null> {
  return await invoke<string | null>("safety_test_match", { cmd, patterns });
}

// === 项目作用域 + SQLite 持久化 ===

/** 项目作用域 DTO，与后端 [`crate::ipc::scope::ScopeDto`] 对齐。
 *
 * - `project`：在已 init 的项目里（cwd 向上找到 .aitm/project.json）
 * - `global`：用户选过"临时全局" / "永久忽略"，对话写全局桶
 * - `needs_init`：既无 marker 也不在 ignored_paths，需弹 InitProjectDialog */
export type ScopeDto =
  | { kind: "project"; uuid: string; root_path: string }
  | { kind: "global" }
  | { kind: "needs_init"; cwd: string };

/** project_init 成功返回。 */
export interface ProjectInitResult {
  uuid: string;
  root_path: string;
  name: string;
}

/** 解析 cwd → ScopeDto。AiSidebar 启动 / 切 tab 时调，决定 load 哪个 bucket。 */
export async function scopeResolve(cwd: string): Promise<ScopeDto> {
  return await invoke<ScopeDto>("scope_resolve", { cwd });
}

/** 用户在 InitProjectDialog 选"是，初始化为项目"时调。
 *  写 .aitm/project.json + .gitignore + 注册全局 + 懒创建项目 db。 */
export async function projectInit(
  cwd: string,
  name: string,
): Promise<ProjectInitResult> {
  return await invoke<ProjectInitResult>("project_init", { cwd, name });
}

/** 用户选"别再问我这个目录"时调。下次同 cwd 解析直接走 Global。 */
export async function markIgnored(cwd: string): Promise<void> {
  await invoke("mark_ignored", { cwd });
}

/** ai:init_required 事件 payload — scope = NeedsInit 时由后端 emit，
 *  AiSidebar 应弹 InitProjectDialog。 */
export interface AiInitRequiredEvent {
  conversation_id: string;
  cwd: string;
  default_name: string;
}

/** 监听 ai:init_required 事件。 */
export async function onAiInitRequired(
  cb: (e: AiInitRequiredEvent) => void,
): Promise<UnlistenFn> {
  return await listen<AiInitRequiredEvent>("ai:init_required", (e) => {
    cb(e.payload);
  });
}

/** 用户在 InitProjectDialog 决议后恢复一条暂停的 chat。
 *  scope 是决议结果（Project 或 Global）。 */
export async function aiChatResume(
  cid: string,
  scope: ScopeDto,
): Promise<void> {
  await invoke("ai_chat_resume", { cid, scope });
}

/** 单个对话元信息 DTO（与后端 ConversationRow 对齐）。 */
export interface ConversationDto {
  id: string;
  title: string;
  title_auto: boolean;
  provider_id: string;
  model_id: string;
  created_at: number;
  updated_at: number;
}

/** 单条消息 DTO（payload_json 是后端流式表里 kind 对应的 JSON 串）。 */
export interface MessageDto {
  id: number;
  seq: number;
  kind: string; // 'user' | 'assistant' | 'tool_call'
  payload_json: string;
  created_at: number;
}

export async function convList(scope: ScopeDto): Promise<ConversationDto[]> {
  return await invoke<ConversationDto[]>("conv_list", { scope });
}

export async function convCreate(
  scope: ScopeDto,
  title: string,
): Promise<ConversationDto> {
  return await invoke<ConversationDto>("conv_create", { scope, title });
}

export async function convDelete(scope: ScopeDto, cid: string): Promise<void> {
  await invoke("conv_delete", { scope, cid });
}

export async function convRename(
  scope: ScopeDto,
  cid: string,
  title: string,
): Promise<void> {
  await invoke("conv_rename", { scope, cid, title });
}

export async function convSetModel(
  scope: ScopeDto,
  cid: string,
  providerId: string,
  modelId: string,
): Promise<void> {
  await invoke("conv_set_model", {
    scope,
    cid,
    providerId,
    modelId,
  });
}

export async function convAppendMessage(
  scope: ScopeDto,
  cid: string,
  kind: string,
  payloadJson: string,
): Promise<MessageDto> {
  return await invoke<MessageDto>("conv_append_message", {
    scope,
    cid,
    kind,
    payloadJson,
  });
}

export async function convReplaceMessagePayload(
  scope: ScopeDto,
  cid: string,
  seq: number,
  payloadJson: string,
): Promise<void> {
  await invoke("conv_replace_message_payload", {
    scope,
    cid,
    seq,
    payloadJson,
  });
}

export async function convGetMessages(
  scope: ScopeDto,
  cid: string,
): Promise<MessageDto[]> {
  return await invoke<MessageDto[]>("conv_get_messages", { scope, cid });
}

// === Phase 2A T5：系统资源监控 ===

/** `system:metrics` 事件 payload。后端 1.5s emit 一次，反映 aitm 主进程资源占用。
 *  - `rss_mb`: 进程 Resident Set Size（MB，向下取整）
 *  - `cpu_pct`: 进程 CPU 占用百分比（0-100*核数，单核满负荷 = 100）
 *  - `active_sessions`: 当前活跃 PTY session 数 */
export interface SystemMetricsEvent {
  rss_mb: number;
  cpu_pct: number;
  active_sessions: number;
}

/** 订阅 `system:metrics` 事件。后端在 setup 阶段已自启动定时器，前端只需订阅。 */
export async function onSystemMetrics(
  cb: (e: SystemMetricsEvent) => void,
): Promise<UnlistenFn> {
  return await listen<SystemMetricsEvent>("system:metrics", (e) => cb(e.payload));
}

// === v0.2.1：升级检查 ===

/** `update_check` IPC 命令返回值。
 *  - `available`: 是否有新版本（current < latest）
 *  - `current_version`: 当前 app 版本（CARGO_PKG_VERSION）
 *  - `latest_version`: 远端最新 tag（剥 `v` 前缀），可空（API 失败时）
 *  - `release_url`: GitHub release 页面 URL，可空
 *  - `release_notes`: release notes 摘要（前 500 字符），可空
 *  - `error`: 失败原因（available=false 时可能有；前端 console.warn 用） */
export interface UpdateCheckResult {
  available: boolean;
  current_version: string;
  latest_version: string | null;
  release_url: string | null;
  release_notes: string | null;
  error: string | null;
}

/** 调用后端 GitHub Releases API 检查是否有新版本。
 *  网络 / API 失败一律返回 `available: false`，前端不应弹错误对话框。 */
export async function updateCheck(): Promise<UpdateCheckResult> {
  return await invoke<UpdateCheckResult>("update_check");
}

// === Phase 3A T3：文件读取（给 MD 预览） ===

/** 读文本文件；max_bytes 默认 2MB；二进制 / 大文件 / 不存在都 → reject。
 *  T3 MarkdownPreviewDialog 调它读 .md 文件内容渲染。
 *  T1 提供后端 `fs_read_text` IPC 命令。 */
export async function fsReadText(
  path: string,
  maxBytes: number = 2_000_000,
): Promise<string> {
  return await invoke<string>("fs_read_text", { path, maxBytes });
}

// === v0.5.0-C T1：多种文件预览（5 kind 分类） ===

/** mirror 后端 PreviewResult enum（rename_all="snake_case"）。 */
export type PreviewResult =
  | { kind: "markdown"; content: string; truncated: boolean }
  | {
      kind: "code";
      content: string;
      language: string;
      truncated: boolean;
    }
  | { kind: "text"; content: string; truncated: boolean }
  | { kind: "image"; mime: string; base64: string }
  | { kind: "binary"; reason: string }
  | { kind: "too_large"; size: number; max_size: number };

/** 按扩展名 + UTF-8 嗅探返结构化预览。Markdown/Code/Text 1MB 上限；图片 5MB 上限。
 *  v0.5.0-C T1：FilePreviewDialog 调它。 */
export async function fsReadPreview(path: string): Promise<PreviewResult> {
  return await invoke<PreviewResult>("fs_read_preview", { path });
}

// === v0.9.1 HR3-3：StatusBar 重排（磁盘 / git 分支）===

/** 磁盘使用情况（mirror 后端 `crate::ipc::fs::DiskUsage`）。 */
export interface DiskUsage {
  free_bytes: number;
  total_bytes: number;
  used_pct: number;
}

/** 查 `path` 所在分区的容量信息。StatusBar 10s 轮询。
 *  path 不存在 / 找不到分区 → reject。 */
export async function fsDiskUsage(path: string): Promise<DiskUsage> {
  return await invoke<DiskUsage>("fs_disk_usage", { path });
}

/** 查 `cwd` 所在 git 仓库的当前分支；不在 repo 内返 null。
 *  path 不存在 / 其它 IO 错误 → reject（前端 catch 后隐藏）。 */
export async function gitCurrentBranch(cwd: string): Promise<string | null> {
  return await invoke<string | null>("git_current_branch", { cwd });
}

// === v0.9.0 T5c：文件写入（编辑器 Cmd+S 保存） ===

/** 写入文件内容到磁盘（编辑器保存）。
 *  - path 必须是绝对路径
 *  - 写入系统黑名单目录（/etc /System /usr /Library/System、
 *    C:\Windows\、C:\Program Files\）会被后端 reject
 *  失败抛出（含具体原因）；UI 应 catch 并提示 read-only 降级。 */
export async function fileWrite(path: string, content: string): Promise<void> {
  await invoke("file_write", { path, content });
}

// === v0.10.2 #6：文件树右键菜单 CRUD ===

/** 新建空文件。path 必须绝对路径 + 不在系统黑名单 + 不已存在。失败抛错。 */
export async function fsCreateFile(path: string): Promise<void> {
  await invoke("fs_create_file", { path });
}

/** 新建目录（不递归创建父）。同样 path 校验 + 不已存在。 */
export async function fsCreateDir(path: string): Promise<void> {
  await invoke("fs_create_dir", { path });
}

/** 重命名 / 移动 from 到 to。目标已存在 → 失败（UI 应先弹覆盖确认）。 */
export async function fsRename(from: string, to: string): Promise<void> {
  await invoke("fs_rename", { from, to });
}

/** 删除文件或目录（目录递归）。**危险操作**，UI 必须二次确认后调。 */
export async function fsDelete(path: string): Promise<void> {
  await invoke("fs_delete", { path });
}

// === v0.10.3 #10：文件元信息（外部改动检测）===

export interface FileMeta {
  exists: boolean;
  mtime_ms: number;
  size: number;
  is_dir: boolean;
}

/** 读 path 的 mtime / size / exists。轻量轮询用。失败 path 返 exists=false 不抛错。 */
export async function fsStat(path: string): Promise<FileMeta> {
  return await invoke<FileMeta>("fs_stat", { path });
}

// === v0.10.3 HR9-2 扩展：macOS Dock icon 红色数字角标 ===

/**
 * 设置 app 全局 dock badge count（macOS）。
 * count=0 / undefined → 清掉角标。Windows 不支持（Tauri 文档明示）。
 * Linux 行为依赖桌面环境（Unity / KDE 有些支持）。
 *
 * 失败静默 console.warn —— badge 是辅助 UX，不该让上游崩。
 */
export async function setAppBadgeCount(count?: number): Promise<void> {
  try {
    await getCurrentWindow().setBadgeCount(count && count > 0 ? count : undefined);
  } catch (e) {
    console.warn("[badge] setBadgeCount 失败", e);
  }
}

// === Phase 3A T4：xterm Cmd+点击 URL → 系统浏览器 ===

/** 用系统默认浏览器打开 URL。后端白名单只允许 http/https/mailto schemes。
 *  非法 scheme → reject。终端 webLinksAddon 检测到的 URL 走这里。 */
export async function shellOpen(url: string): Promise<void> {
  await invoke("shell_open", { url });
}

// === Phase 3A T5：关闭 tab 二次确认 ===

/** 检测 PTY 子进程是否有运行中的子命令（fork 出的进程数 > 0）。
 *  用 sysinfo 查 shell pid 的 children；mac/linux 准；windows 可能不准（v0.3.x 修）。
 *  失败（找不到 pid 等）一律返 false 不阻塞 close。 */
export async function sessionHasRunningCommand(id: SessionId): Promise<boolean> {
  return await invoke<boolean>("session_has_running_command", { id });
}

// === Phase 3A T1 / T2：文件树 ===

/** 文件树节点；与后端 `crate::ipc::fs::TreeNode` 对齐。
 *
 * - `path` 是 canonicalize 后的绝对路径
 * - `children`：
 *   - `file` 节点恒为 `null`
 *   - `dir` 节点：当 `max_depth` 还没递归完时为子项数组；
 *     已达递归深度上限时为 `null`，作为前端"懒加载占位"信号 */
export interface TreeNode {
  name: string;
  path: string;
  kind: "file" | "dir";
  /** dir 类型 + 当前 max_depth 没继续递归时 = null（前端懒加载信号） */
  children: TreeNode[] | null;
}

/** 后端遍历 path 下的文件树。
 *
 * - `max_depth=0` → 顶层 dir 自身的 children=null（仅 metadata）
 * - `max_depth=1` → 含一级子项；二级 dir 的 children=null
 * - hidden 文件不显示；后端硬编码跳过 .git / node_modules / target / dist 等 */
export async function fsTree(path: string, maxDepth: number): Promise<TreeNode> {
  return await invoke<TreeNode>("fs_tree", { path, maxDepth });
}

// === v0.9.1 HR3-6：Git 状态（FileTree 文件名按 git status 染色）===

/** 与后端 `crate::ipc::git::GitStatus` 对齐。 */
export type GitStatus =
  | "modified"
  | "added"
  | "deleted"
  | "untracked"
  | "renamed"
  | "conflict"
  | "ignored";

/** 单文件 git 状态条目；`path` 为绝对路径，直接和 TreeNode.path 等值比对。 */
export interface GitFileStatus {
  path: string;
  status: GitStatus;
}

/** 查 `cwd` 所在 git 仓库的脏文件清单。
 *
 * - 不在 git 仓库 → 返空数组（fail-soft，不抛错）。
 * - 大 repo 可能慢；前端调用方应做节流（FileTree 现走 5s 轮询）。 */
export async function gitStatus(cwd: string): Promise<GitFileStatus[]> {
  return await invoke<GitFileStatus[]>("git_status", { cwd });
}

// === Phase 4A T1：内嵌浏览器 ===

/** 后端 [`browser_open_tab`] 返回值。 */
export interface BrowserOpenResult {
  tab_id: string;
}

/** 浏览器 webview bounds（logical 坐标，已 DPI scale）。 */
export interface BrowserBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 在主 window 内 spawn 一个子 webview 加载 URL，返回 tab_id（即 webview label）。 */
export async function browserOpenTab(
  url: string,
  bounds: BrowserBounds,
): Promise<BrowserOpenResult> {
  return await invoke<BrowserOpenResult>("browser_open_tab", {
    url,
    x: bounds.x,
    y: bounds.y,
    w: bounds.w,
    h: bounds.h,
  });
}

/** destroy 指定 tab 的 webview。tabId 不存在不报错。 */
export async function browserCloseTab(tabId: string): Promise<void> {
  await invoke("browser_close_tab", { tabId });
}

/** 切 URL；走 Tauri 真 navigate API（不 eval 注入）。 */
export async function browserNavigate(tabId: string, url: string): Promise<void> {
  await invoke("browser_navigate", { tabId, url });
}

/** 把指定 tab show，其余 hide（多 webview 没有 z-index）。 */
export async function browserSetActive(tabId: string): Promise<void> {
  await invoke("browser_set_active", { tabId });
}

/** 重设 webview 的 position + size；ResizeObserver 60fps 节流上报。 */
export async function browserSetBounds(
  tabId: string,
  bounds: BrowserBounds,
): Promise<void> {
  await invoke("browser_set_bounds", {
    tabId,
    x: bounds.x,
    y: bounds.y,
    w: bounds.w,
    h: bounds.h,
  });
}

/** 等价 close（释放 WKWebView 进程）；前端保留 url/title/scrollY 由 zustand 管。 */
export async function browserSuspendTab(tabId: string): Promise<void> {
  await invoke("browser_suspend_tab", { tabId });
}

/** 在 webview 加载完后 eval `scrollTo(0, y)` 恢复滚动位置。 */
export async function browserSetScrollY(tabId: string, y: number): Promise<void> {
  await invoke("browser_set_scroll_y", { tabId, y });
}

/** 收起浏览器面板：destroy 全部 active webview。 */
export async function browserPanelCloseAll(): Promise<void> {
  await invoke("browser_panel_close_all");
}

/** 弹 dialog 时让所有 webview 让位（dialog 在 DOM 层，会被 native overlay 遮挡）。 */
export async function browserHideAllActive(): Promise<void> {
  await invoke("browser_hide_all_active");
}

/** dialog 关闭后恢复所有 webview 显示。**注意**：之后应紧跟 [`browserSetActive`]
 *  把非 active 的 hide 回去，避免多 webview 同时可见。 */
export async function browserShowAllActive(): Promise<void> {
  await invoke("browser_show_all_active");
}

/** 子 webview 注入脚本捕获到 Cmd+B/T/W/P/, 时调；后端转发为 `browser:hotkey` 事件。 */
export interface BrowserHotkeyEvent {
  key: string;
  meta: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

/** 监听后端转发上来的浏览器 webview 内捕获到的快捷键。
 *  在 useShortcuts / 主 webview 全局 keydown handler 旁挂一份即可。 */
export async function onBrowserHotkey(
  cb: (e: BrowserHotkeyEvent) => void,
): Promise<UnlistenFn> {
  return await listen<BrowserHotkeyEvent>("browser:hotkey", (e) => cb(e.payload));
}

/** v0.5.8：浏览器 tab URL 变化事件。AI 工具 / IPC navigate 完成后 emit，
 *  前端订阅同步 zustand `tabs[].url`，避免 URL 栏跟实际不一致。 */
export interface BrowserUrlChangedEvent {
  tab_id: string;
  url: string;
}

export async function onBrowserUrlChanged(
  cb: (e: BrowserUrlChangedEvent) => void,
): Promise<UnlistenFn> {
  return await listen<BrowserUrlChangedEvent>("browser:url_changed", (e) =>
    cb(e.payload),
  );
}

/** v0.9.0 T3：后端 OSC 7 解析出 shell 新 cwd 时发的事件。 */
export interface PtyCwdChangedEvent {
  /** 字符串化的 session UUID。 */
  session_id: string;
  /** shell 汇报的绝对路径（已 URL 解码 / `~` 展开）。 */
  cwd: string;
}

/** 监听后端 OSC 7 cwd 变化事件。前端在 App.tsx 顶层订阅一次即可。 */
export async function onPtyCwdChanged(
  cb: (e: PtyCwdChangedEvent) => void,
): Promise<UnlistenFn> {
  return await listen<PtyCwdChangedEvent>("pty:cwd-changed", (e) =>
    cb(e.payload),
  );
}
