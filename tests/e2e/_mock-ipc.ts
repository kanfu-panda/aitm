import type { Page } from "@playwright/test";
import type { AppSettings } from "../../src/lib/tauri";
import { DEFAULT_E2E_SETTINGS } from "./fixtures/default-settings";

export interface MockOptions {
  noProviders?: boolean;
}

/** 在浏览器上下文里安装一个最小 Tauri IPC mock，避免组件挂载时 invoke 报错。
 *
 * 事件机制：
 * 1. transformCallback(cb) 把 cb 存到 window[`_${id}`]，返回 id（仿 Tauri 真实实现）
 * 2. invoke("plugin:event|listen", { event, handler }) 把 event→handler 注册到 listenerMap，
 *    返回 eventId 让 unlisten 用
 * 3. 暴露 window.__emitMockEvent(event, payload) 让 spec 主动触发事件回调
 * 4. providers_save_config 内部自动 emit "providers:changed"，模拟后端真实行为
 *
 * Settings 一致性（v0.7.1-A T1 加）：
 * - `settings_get` 返回值来自 `fixtures/default-settings.ts::DEFAULT_E2E_SETTINGS`，跟
 *   `src/lib/tauri.ts::AppSettings` 完整对齐；每次后端加字段同步改 fixture 即可。
 * - mutable 字段（terminal.theme / safety / browser / ui.activity_bar_position / ui.theme_mode）
 *   走运行时 settingsState，spec 改完立即被 settings_get 读到（"立即生效"语义）。
 *
 * Aptabase + unknownInvoke（v0.7.1-A T1 加）：
 * - `plugin:aptabase|*` 命令静默返 undefined（v0.7.0 引入 `@aptabase/tauri` 调用）
 * - 末尾 fallback：未识别命令打 console.warn 而不是 throw，方便 spec 失败时 trace
 */
export async function installTauriMock(
  page: Page,
  opts: MockOptions = {},
): Promise<void> {
  // 把 default settings 序列化后传入 init script（跨 node↔browser context 边界）
  const defaultSettings: AppSettings = DEFAULT_E2E_SETTINGS;
  await page.addInitScript(
    ({ options, defaultSettings: DEFAULTS }) => {
    const noProv = options.noProviders;

    // === Provider config mock 状态（每个 page 隔离）===
    const providerStore = new Map<string, ProviderConfigDto>();

    interface ProviderModel {
      id: string;
      display_name: string;
      context_window: number;
    }

    interface ProviderConfigDto {
      id: string;
      display_name: string;
      enabled: boolean;
      api_key_masked: string;
      key_source: "env" | "dotenv" | "config" | "none";
      base_url: string;
      default_base_url: string;
      models: ProviderModel[];
    }

    interface SavePayload {
      id: string;
      enabled: boolean;
      api_key: string;
      base_url: string;
    }

    const empty = (
      id: string,
      name: string,
      defaultUrl: string,
    ): ProviderConfigDto => ({
      id,
      display_name: name,
      enabled: true,
      api_key_masked: "",
      key_source: "none",
      base_url: "",
      default_base_url: defaultUrl,
      models: [
        {
          id: `${id}-default`,
          display_name: `${name} default`,
          context_window: 128000,
        },
      ],
    });

    // 默认 qwen 已配置，其他 5 家未配置（key_source: "none"）
    providerStore.set("qwen", {
      id: "qwen",
      display_name: "Qwen (DashScope)",
      enabled: true,
      api_key_masked: "sk-•••••••••••••••••1234",
      key_source: "config",
      base_url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      default_base_url:
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
      models: [
        { id: "qwen-max", display_name: "Qwen Max", context_window: 128000 },
      ],
    });
    providerStore.set(
      "anthropic",
      empty("anthropic", "Claude", "https://api.anthropic.com/v1"),
    );
    providerStore.set(
      "deepseek",
      empty("deepseek", "DeepSeek", "https://api.deepseek.com/v1"),
    );
    providerStore.set(
      "zhipu",
      empty("zhipu", "智谱 GLM", "https://open.bigmodel.cn/api/paas/v4"),
    );
    providerStore.set(
      "moonshot",
      empty("moonshot", "Moonshot Kimi", "https://api.moonshot.cn/v1"),
    );
    providerStore.set(
      "openai",
      empty("openai", "OpenAI", "https://api.openai.com/v1"),
    );

    // === 事件机制 mock ===
    // event name → Set<callbackId>
    const listenerMap = new Map<string, Set<number>>();
    let nextCallbackId = 1;

    // 真实 Tauri 是 plugin 内部状态，mock 里把回调挂到 window[`_${id}`]
    const transformCallback = <T>(cb: (v: T) => void): number => {
      const id = nextCallbackId++;
      const prop = `_${id}`;
      Object.defineProperty(window, prop, {
        value: (payload: T) => cb(payload),
        writable: false,
        configurable: true,
      });
      return id;
    };

    // 由 spec 调用（或 invoke 内部调用）触发事件
    const emitMockEvent = (event: string, payload: unknown) => {
      const ids = listenerMap.get(event);
      if (!ids) return;
      for (const id of ids) {
        // Tauri Event 对象格式：{ event, id, payload }
        const fn = (window as unknown as Record<string, (v: unknown) => void>)[
          `_${id}`
        ];
        if (typeof fn === "function") {
          fn({ event, id, payload });
        }
      }
    };
    (window as unknown as { __emitMockEvent: typeof emitMockEvent }).__emitMockEvent =
      emitMockEvent;

    // 工具审批 mock 状态预初始化（避免 spec 读到 undefined）
    (
      window as unknown as {
        __lastApprovalDecision: { call_id?: string; approved?: boolean };
      }
    ).__lastApprovalDecision = {};

    // settings.safety / terminal.theme / browser / ui mock 状态：spec 通过
    // settings_update 路径改它，后续 settings_get 读它（"修改 → 立即生效"语义）。
    // 初值从 fixture 拷贝（fixture 跟 AppSettings interface 完整对齐）。
    const settingsState = {
      whitelist: [...DEFAULTS.safety.whitelist] as string[],
      showLowAutoApproved: DEFAULTS.safety.show_low_auto_approved,
      terminalTheme: DEFAULTS.terminal.theme,
      browserMaxActiveTabs: DEFAULTS.browser.max_active_tabs,
      browserSuspendTimerMinutes: DEFAULTS.browser.suspend_timer_minutes,
      // v0.4.1 T2：ActivityBar 4 向位置；默认 right。
      activityBarPosition: DEFAULTS.ui.activity_bar_position,
      // v0.4.1 T5：主题模式三态；默认 dark。
      themeMode: DEFAULTS.ui.theme_mode,
    };

    // === scope + conversations 状态（每个 page 隔离）===
    // 简化模型：只有一个 global 桶，spec 不关心持久化，关心的是 chat store
    // 拿到一份非空的 conversation list（或 createConversation 拿到 db id）
    interface ConversationDtoMock {
      id: string;
      title: string;
      title_auto: boolean;
      provider_id: string;
      model_id: string;
      created_at: number;
      updated_at: number;
    }
    interface MessageDtoMock {
      id: number;
      seq: number;
      kind: string;
      payload_json: string;
      created_at: number;
    }
    const conversationsStore: ConversationDtoMock[] = [];
    // cid → 该对话已持久化的 messages（spec 通过 __seedConversations 预填）
    const messagesStore = new Map<string, MessageDtoMock[]>();
    let convCounter = 0;
    const newConvId = () => {
      convCounter += 1;
      return `mock-conv-${convCounter}`;
    };

    // === scope_resolve / init / persistence 钩子 ===
    // spec 通过这几个钩子改 mock 行为 + 断言副作用。
    // 1. __setScopeResolveResult(scope)：spec 在 page.goto 前改 scope_resolve 默认返回值
    let scopeResolveResult: unknown = { kind: "global" };
    (
      window as unknown as {
        __setScopeResolveResult: (s: unknown) => void;
      }
    ).__setScopeResolveResult = (s: unknown) => {
      scopeResolveResult = s;
    };

    // 2. __triggerInitRequired(payload)：spec 调来模拟后端 emit ai:init_required
    (
      window as unknown as {
        __triggerInitRequired: (p: unknown) => void;
      }
    ).__triggerInitRequired = (payload: unknown) => {
      emitMockEvent("ai:init_required", payload);
    };

    // 3. __seedConversations：spec 调来预填 conversationsStore + messagesStore
    //    覆盖现有 store 全部内容，让 conv_list / conv_get_messages 返回非空
    interface SeedMessage {
      id?: number;
      seq?: number;
      kind?: string;
      payload_json?: string;
      created_at?: number;
    }
    (
      window as unknown as {
        __seedConversations: (
          convs: ConversationDtoMock[],
          messagesByCid?: Record<string, SeedMessage[]>,
        ) => void;
      }
    ).__seedConversations = (convs, messagesByCid) => {
      conversationsStore.length = 0;
      for (const c of convs) conversationsStore.push(c);
      messagesStore.clear();
      if (messagesByCid) {
        for (const [cid, rows] of Object.entries(messagesByCid)) {
          messagesStore.set(
            cid,
            rows.map((r, i) => ({
              id: r.id ?? i + 1,
              seq: r.seq ?? i + 1,
              kind: r.kind ?? "user",
              payload_json: r.payload_json ?? "{}",
              created_at: r.created_at ?? Math.floor(Date.now() / 1000),
            })),
          );
        }
      }
    };

    // 4. __last*Args：每次对应 IPC 调用记录最后参数；spec 用来断言。
    //    用 getter 是为了 spec 在 page.evaluate 里读到的是当前值（mock invoke
    //    handler 内部更新 lastArgs 闭包后立即生效）。
    const lastArgs: {
      projectInit?: unknown;
      markIgnored?: unknown;
      resume?: unknown;
      convCreate?: unknown;
      sessionSnapshotSave?: unknown;
    } = {};

    // v0.7.1-A T5：fs_read_preview / session_snapshot 钩子（spec 控制返回值 +
    // 断言副作用）。
    //
    // - __setFsReadPreviewResult(result)：spec 在 page.goto 前设置 fs_read_preview
    //   返回的 PreviewResult；默认是简单的 text kind。
    // - __setSessionSnapshot(snap)：spec 设置 session_snapshot_load 返回值（null=无）。
    // - __snapshotCalls：记录 session_snapshot_save / clear 调用次数 + 最后 payload。
    interface PreviewKindMock {
      kind: string;
      content?: string;
      truncated?: boolean;
      language?: string;
      mime?: string;
      base64?: string;
      reason?: string;
      size?: number;
      max_size?: number;
    }
    let fsReadPreviewResult: PreviewKindMock = {
      kind: "text",
      content: "hello world",
      truncated: false,
    };
    (
      window as unknown as {
        __setFsReadPreviewResult: (r: PreviewKindMock) => void;
      }
    ).__setFsReadPreviewResult = (r) => {
      fsReadPreviewResult = r;
    };

    // v0.7.1-A T5：file-preview spec 需要 FileTree 渲染出可点击文件。
    // FileTree 用 sessionCurrentCwd 拿 cwd + fsTree 拉目录；默认 mock 返
    // cwd=null（FileTree 显示"无 cwd"），无文件可点。
    // spec 调 __setMockCwd("/path") 启用：sessionCurrentCwd 返该 cwd，
    // fs_tree 返一个含 __mockFiles 文件的根目录节点。
    let mockCwd: string | null = null;
    let mockFiles: Array<{ name: string; path: string }> = [];
    (
      window as unknown as {
        __setMockCwd: (
          cwd: string | null,
          files?: Array<{ name: string; path: string }>,
        ) => void;
      }
    ).__setMockCwd = (cwd, files) => {
      mockCwd = cwd;
      mockFiles = files ?? [];
    };

    interface SnapshotTabMock {
      tab_id: string;
      title: string;
      cwd: string | null;
      unread: number;
      /** v0.10.0 HR9-5：tab 当时所属 PaneGroup 的 id（旧 snapshot 可缺）。 */
      group_id?: string | null;
    }
    interface SnapshotMock {
      schema_version: number;
      saved_at_ms: number;
      tabs: SnapshotTabMock[];
      active_tab_id: string | null;
    }
    let sessionSnapshot: SnapshotMock | null = null;
    (
      window as unknown as {
        __setSessionSnapshot: (s: SnapshotMock | null) => void;
      }
    ).__setSessionSnapshot = (s) => {
      sessionSnapshot = s;
    };

    const snapshotCalls = {
      saveCount: 0,
      clearCount: 0,
    };
    Object.defineProperty(window, "__snapshotCalls", {
      get: () => ({ ...snapshotCalls }),
      configurable: true,
    });
    Object.defineProperty(window, "__lastProjectInitArgs", {
      get: () => lastArgs.projectInit,
      configurable: true,
    });
    Object.defineProperty(window, "__lastMarkIgnoredArgs", {
      get: () => lastArgs.markIgnored,
      configurable: true,
    });
    Object.defineProperty(window, "__lastResumeArgs", {
      get: () => lastArgs.resume,
      configurable: true,
    });
    Object.defineProperty(window, "__lastConvCreateArgs", {
      get: () => lastArgs.convCreate,
      configurable: true,
    });

    // @ts-expect-error: 注入到 window
    window.__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
        // === 事件命令 ===
        if (cmd === "plugin:event|listen") {
          const event = args.event as string;
          const handler = args.handler as number; // transformCallback 返回值
          if (!listenerMap.has(event)) listenerMap.set(event, new Set());
          listenerMap.get(event)!.add(handler);
          return handler; // 用 callbackId 当 eventId
        }
        if (cmd === "plugin:event|unlisten") {
          const event = args.event as string;
          const eventId = args.eventId as number;
          listenerMap.get(event)?.delete(eventId);
          return null;
        }

        // === 已有命令 ===
        if (cmd === "session_open")
          return "00000000-0000-0000-0000-000000000001";
        if (cmd === "settings_get") {
          // 从 fixture 取所有字段（保证跟 AppSettings interface 完整对齐），
          // 用 settingsState 覆盖那些 spec 可改的 mutable 字段。
          return {
            ...DEFAULTS,
            terminal: {
              ...DEFAULTS.terminal,
              theme: settingsState.terminalTheme,
            },
            safety: {
              ...DEFAULTS.safety,
              whitelist: settingsState.whitelist,
              show_low_auto_approved: settingsState.showLowAutoApproved,
            },
            browser: {
              ...DEFAULTS.browser,
              max_active_tabs: settingsState.browserMaxActiveTabs,
              suspend_timer_minutes: settingsState.browserSuspendTimerMinutes,
            },
            ui: {
              ...DEFAULTS.ui,
              activity_bar_position: settingsState.activityBarPosition,
              theme_mode: settingsState.themeMode,
            },
          };
        }
        if (cmd === "settings_update") {
          const s = args.settings as {
            terminal?: { theme?: string };
            safety?: { whitelist: string[]; show_low_auto_approved: boolean };
            browser?: { max_active_tabs: number; suspend_timer_minutes: number };
            ui?: {
              activity_bar_position?: "right" | "left" | "top" | "bottom";
              theme_mode?: "auto" | "dark" | "light";
            };
          };
          if (s?.safety) {
            settingsState.whitelist = s.safety.whitelist;
            settingsState.showLowAutoApproved = s.safety.show_low_auto_approved;
          }
          if (s?.terminal?.theme) {
            settingsState.terminalTheme = s.terminal.theme;
          }
          if (s?.browser) {
            settingsState.browserMaxActiveTabs = s.browser.max_active_tabs;
            settingsState.browserSuspendTimerMinutes =
              s.browser.suspend_timer_minutes;
          }
          if (s?.ui) {
            if (s.ui.activity_bar_position) {
              settingsState.activityBarPosition = s.ui.activity_bar_position;
            }
            if (s.ui.theme_mode) {
              settingsState.themeMode = s.ui.theme_mode;
            }
          }
          // 暴露给 spec：__lastSavedSettings 让验证 settings_update payload
          (window as unknown as { __lastSavedSettings: typeof s }).__lastSavedSettings = s;
          return null;
        }
        if (cmd === "settings_reset") return null;

        // === Safety 白名单 ===
        if (cmd === "safety_validate_pattern") {
          const pattern = (args.pattern ?? "") as string;
          // 简化：只拦显式非法语法（中括号未闭合）。真后端用 globset 校验。
          if (pattern.includes("[") && !pattern.includes("]")) {
            throw new Error(`pattern 非法: 中括号未闭合 (${pattern})`);
          }
          return null;
        }
        if (cmd === "safety_test_match") {
          const cmdStr = (args.cmd ?? "") as string;
          const patterns = (args.patterns ?? []) as string[];
          // 元字符防御
          for (const m of [";", "&&", "||", "|", "`", "$(", ">", "<"]) {
            if (cmdStr.includes(m)) return null;
          }
          // 简化的 glob 匹配：'foo *' 命中以 'foo ' 开头或等于 'foo' 的 cmd
          for (const p of patterns) {
            if (p === cmdStr) return p;
            if (p.endsWith(" *")) {
              const prefix = p.slice(0, -2);
              if (cmdStr === prefix || cmdStr.startsWith(prefix + " ")) {
                return p;
              }
            }
          }
          return null;
        }

        if (cmd === "list_providers") {
          if (noProv) return [];
          // 动态：根据 providerStore 返回所有 enabled 且有 key 的 provider
          const out: Array<{
            id: string;
            display_name: string;
            models: ProviderModel[];
            capabilities: {
              supports_tools: boolean;
              supports_streaming_tools: boolean;
              needs_args_concat: boolean;
            };
          }> = [];
          for (const p of providerStore.values()) {
            if (!p.enabled || p.key_source === "none") continue;
            out.push({
              id: p.id,
              display_name: p.display_name,
              models: p.models,
              capabilities: {
                supports_tools: true,
                supports_streaming_tools: true,
                needs_args_concat: true,
              },
            });
          }
          return out;
        }

        if (cmd === "ai_chat_send") return null;
        if (cmd === "ai_chat_cancel") return null;
        if (cmd === "ai_chat_resume") {
          lastArgs.resume = {
            cid: args.cid as string,
            scope: args.scope,
          };
          return null;
        }

        // === scope + conversations ===
        if (cmd === "session_current_cwd") {
          // v0.7.1-A T5：spec 调 __setMockCwd 可让 FileTree 渲染目录
          return mockCwd;
        }
        if (cmd === "scope_resolve") {
          // E2E 默认走 global 桶，跳过 InitProjectDialog 流程；
          // spec 可调 __setScopeResolveResult 覆盖
          return scopeResolveResult;
        }
        if (cmd === "project_init") {
          lastArgs.projectInit = {
            cwd: args.cwd as string,
            name: args.name as string,
          };
          return {
            uuid: "00000000-0000-0000-0000-000000000abc",
            root_path: (args.cwd ?? "/tmp/mock-project") as string,
            name: (args.name ?? "mock") as string,
          };
        }
        if (cmd === "mark_ignored") {
          lastArgs.markIgnored = { cwd: args.cwd as string };
          return null;
        }

        if (cmd === "conv_list") {
          return [...conversationsStore];
        }
        if (cmd === "conv_create") {
          lastArgs.convCreate = {
            scope: args.scope,
            title: args.title as string,
          };
          const now = Math.floor(Date.now() / 1000);
          const dto: ConversationDtoMock = {
            id: newConvId(),
            title: (args.title ?? "新对话") as string,
            title_auto: true,
            provider_id: "",
            model_id: "",
            created_at: now,
            updated_at: now,
          };
          conversationsStore.unshift(dto);
          return dto;
        }
        if (cmd === "conv_delete") {
          const cid = args.cid as string;
          const idx = conversationsStore.findIndex((c) => c.id === cid);
          if (idx >= 0) conversationsStore.splice(idx, 1);
          return null;
        }
        if (cmd === "conv_rename") {
          const cid = args.cid as string;
          const c = conversationsStore.find((x) => x.id === cid);
          if (c) {
            c.title = (args.title ?? c.title) as string;
            c.title_auto = false;
            c.updated_at = Math.floor(Date.now() / 1000);
          }
          return null;
        }
        if (cmd === "conv_set_model") {
          const cid = args.cid as string;
          const c = conversationsStore.find((x) => x.id === cid);
          if (c) {
            c.provider_id = (args.providerId ?? c.provider_id) as string;
            c.model_id = (args.modelId ?? c.model_id) as string;
            c.updated_at = Math.floor(Date.now() / 1000);
          }
          return null;
        }
        if (cmd === "conv_append_message") {
          // 返回一个最小可用 MessageDto（chat store 不会读 seq/payload，只 fire-and-forget）
          return {
            id: 1,
            seq: 1,
            kind: (args.kind ?? "user") as string,
            payload_json: (args.payloadJson ?? "{}") as string,
            created_at: Math.floor(Date.now() / 1000),
          };
        }
        if (cmd === "conv_replace_message_payload") return null;
        if (cmd === "conv_get_messages") {
          const cid = args.cid as string;
          return messagesStore.get(cid) ?? [];
        }

        // === 工具调用审批 ===
        if (cmd === "ai_tool_approve") {
          (
            window as unknown as {
              __lastApprovalDecision: { call_id?: string; approved?: boolean };
            }
          ).__lastApprovalDecision = {
            call_id: (args.callId ?? args.call_id) as string,
            approved: true,
          };
          return null;
        }
        if (cmd === "ai_tool_reject") {
          (
            window as unknown as {
              __lastApprovalDecision: { call_id?: string; approved?: boolean };
            }
          ).__lastApprovalDecision = {
            call_id: (args.callId ?? args.call_id) as string,
            approved: false,
          };
          return null;
        }

        // === Provider config 命令（T9 新增）===
        if (cmd === "providers_get_config") {
          return Array.from(providerStore.values());
        }
        if (cmd === "providers_save_config") {
          const p = args.payload as SavePayload;
          const cur = providerStore.get(p.id);
          if (!cur) return null;
          const merged: ProviderConfigDto = {
            ...cur,
            enabled: p.enabled,
            base_url: p.base_url,
            api_key_masked: p.api_key
              ? "sk-•••••••••••••••••" + p.api_key.slice(-4)
              : cur.api_key_masked,
            key_source: p.api_key ? "config" : cur.key_source,
          };
          providerStore.set(p.id, merged);
          // 暴露给 spec 验证 mock 接收到的 payload
          (window as unknown as { __lastSavedPayload: SavePayload }).__lastSavedPayload =
            p;
          // 模拟后端：保存成功后 emit providers:changed
          emitMockEvent("providers:changed", null);
          return null;
        }
        // === Phase 2A T5：系统资源监控（前端订阅事件即可，调命令也兜底返 null） ===
        if (cmd === "system_metrics_start") return null;

        // === Phase 3A T4：终端 Cmd+点击 URL（e2e 不走真打开，stub 返 null） ===
        if (cmd === "shell_open") return null;

        // === Phase 3A T5：关闭 tab 二次确认（默认 stub 返 false 不弹 dialog） ===
        if (cmd === "session_has_running_command") return false;

        // === v0.2.1：升级检查 ===
        // 默认 stub 返"无更新"，避免 e2e 启动时弹真 GitHub API 调用
        if (cmd === "update_check") {
          return {
            available: false,
            current_version: "0.2.1",
            latest_version: null,
            release_url: null,
            release_notes: null,
            error: null,
          };
        }

        if (cmd === "providers_test_connection") {
          const id = args.id as string;
          const cfg = providerStore.get(id);
          if (!cfg || cfg.key_source === "none") {
            return {
              ok: false,
              elapsed_ms: 0,
              message: "provider 未配置或已禁用",
            };
          }
          return { ok: true, elapsed_ms: 42, message: "OK (42 ms)" };
        }

        // === Phase 3A T3：文件读取 stub（给 MarkdownPreviewDialog 测） ===
        if (cmd === "fs_read_text") {
          return "# Mock\n";
        }

        // === v0.5.0-C T1：FilePreviewDialog fs_read_preview（v0.7.1-A T5 加 mock）===
        // PreviewResult enum：spec 用 __setFsReadPreviewResult 控制 kind/content
        if (cmd === "fs_read_preview") {
          return fsReadPreviewResult;
        }

        // === v0.5.0-D：Session snapshot 启动恢复（v0.7.1-A T5 加 mock）===
        // 默认 load 返 null（无 snapshot，走默认空白启动）；
        // spec 用 __setSessionSnapshot 控制返回值。
        if (cmd === "session_snapshot_load") {
          return sessionSnapshot;
        }
        if (cmd === "session_snapshot_save") {
          snapshotCalls.saveCount += 1;
          lastArgs.sessionSnapshotSave = args.snapshot;
          return null;
        }
        if (cmd === "session_snapshot_clear") {
          snapshotCalls.clearCount += 1;
          return null;
        }

        // === Phase 3A T1 / T2：文件树 stub ===
        // FileTree 默认隐藏（fileTreeOpen=false），现有 e2e 不主动触发；
        // 为防早期初始化或后续 spec 调用 invoke 落到这里炸 console，
        // 兜底返一个最小可用的空目录 dir 节点。
        if (cmd === "fs_tree") {
          const reqPath = (args.path ?? "/mock") as string;
          // v0.7.1-A T5：根目录请求时把 mockFiles 暴露出来
          if (mockCwd && reqPath === mockCwd) {
            return {
              name: mockCwd.split("/").pop() ?? "mock",
              path: mockCwd,
              kind: "dir",
              children: mockFiles.map((f) => ({
                name: f.name,
                path: f.path,
                kind: "file",
                children: null,
              })),
            };
          }
          return {
            name: "mock",
            path: reqPath,
            kind: "dir",
            children: [],
          };
        }

        // === v1.1.0 F5：目录树 fs 自动刷新（notify watcher）stub ===
        // e2e 环境没有真实后端 watcher；no-op 即可。真实触发靠 spec 调
        // `window.__emitMockEvent("fs:changed", { paths: [...] })`（事件机制通用，
        // 见文件顶部说明，无需额外 mock）。
        if (cmd === "fs_watch_start" || cmd === "fs_watch_stop") {
          return null;
        }

        // === Phase 4A T1：内嵌浏览器 IPC stub（最小） ===
        // T2/T3/T4/T5 各自加自己的语义；这里仅让默认 e2e 不破。
        if (cmd === "browser_open_tab") {
          return { tab_id: `mock-browser-${Date.now()}` };
        }
        if (
          cmd === "browser_close_tab" ||
          cmd === "browser_navigate" ||
          cmd === "browser_set_active" ||
          cmd === "browser_set_bounds" ||
          cmd === "browser_suspend_tab" ||
          cmd === "browser_set_scroll_y" ||
          cmd === "browser_panel_close_all" ||
          cmd === "browser_hide_all_active" ||
          cmd === "browser_show_all_active" ||
          cmd === "browser_forward_hotkey"
        ) {
          return null;
        }

        // === v0.7.0：Aptabase 遥测插件 IPC noop（v0.7.1-A T1 加）===
        // `@aptabase/tauri` 内部调 `plugin:aptabase|track_event`；e2e 跑 dev 时这些
        // 调用会打到 mock，未匹配时被 fallback warn 误伤。这里宽松一些：
        // 凡 `plugin:` 前缀（Tauri 2 plugin 命名约定）的命令一律 noop。
        if (cmd.startsWith("plugin:")) {
          return undefined;
        }

        // === unknownInvoke 兜底（v0.7.1-A T1 加）===
        // 之前是直接 return null —— spec 失败时根本不知道哪个 invoke 没 mock。
        // 改成 console.warn 留 trace + return undefined（不 throw 避免误杀场景：
        // 后端真后续新加了命令，前端调进来时 mock 还没补）。
        console.warn(`[mock-ipc] 未识别的 invoke 命令: ${cmd}`, args);
        return undefined;
      },
      transformCallback,
    };
    },
    { options: opts, defaultSettings },
  );
}
