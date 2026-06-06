# aitm 项目 Claude Code 指引

本文件给 Claude Code（或其他 AI 协作工具）和人类 contributor 提供项目快速理解。

---

## 工程约定

### 1. 提交规范

- 中文 commit message 内容（标题简洁，正文必要时展开）
- 用 Conventional Commits 前缀：`feat:` / `fix:` / `chore:` / `docs:` / `refactor:` / `test:` 等
- 提交前确保所有质量门通过（见下）

### 2. 质量门（合并前必过）

```bash
# Rust 后端
cd src-tauri
cargo test -p aitm
cargo clippy --all-targets -- -D warnings   # 0 warning
cd ..

# 前端
pnpm typecheck   # 0 error
pnpm lint        # 0 error
pnpm test        # vitest 全绿
pnpm exec playwright test   # E2E 全绿
```

### 3. 性能宪章（不可退）

- 冷启动 < 200ms
- 5 PTY 同时运行内存 < 80MB
- 二进制包 < 25MB

### 4. 真机 smoke 是必须的

**自动化测试 ≠ 功能正确**。早期开发暴露过 4 个真机才能发现的 bug（OpenAI 协议序列化、Qwen 流式 id 空串、cwd 错位、ANSI 噪音），单测全绿照样炸。

合并前请：

1. 启 `pnpm tauri dev`
2. 用真实 LLM 跑核心场景（至少 OpenAI + Anthropic 两家）
3. 检查 dev log 无异常

### 5. 调试期日志

加 `eprintln!` / `tracing::info!` 临时调试时，**必须**在合并前删掉或降级到 trace。永远不要把调试日志合到 main。

---

## 配色 / UI 约定

- **Tailwind 4** + zinc 灰阶（zinc-900 容器，zinc-700 边框，zinc-100 主文字，zinc-400/500 次要）
- 强调色：
  - emerald（成功 / 批准）
  - rose（错误 / 危险）
  - amber（警告）
  - sky（运行中）
- **不用 emoji** 除非明确需要；UI 上少量功能性 emoji 如 ✦（AI 标识）、🔧（工具调用）可以保留
- Dialog 用 Radix UI（已装），不引入别的 modal 库

---

## LLM Provider 协议层踩坑备忘

写 provider 适配器或 orchestrator 时**先看这条**，避免重复踩前人的坑：

### OpenAI 兼容（DeepSeek / Qwen / 智谱 / Moonshot / OpenAI）

- 流式请求要加 `stream_options: {include_usage: true}`，否则 usage chunks 不返回
- 请求 messages 序列化：
  - `assistant` 含 ToolUse → `tool_calls: [{id, type: "function", function: {name, arguments: <JSON 字符串>}}]`，**arguments 是字符串不是对象**
  - `tool` 角色每个 ToolResult 拆一条 `{role: "tool", tool_call_id, content}` 消息
  - 不要原样 JSON 化 `MessageContent::Blocks`，OpenAI 不认 `type: "tool_use"` / `"tool_result"`
- 流式响应里 `tool_calls[*].id` 第一个 chunk 给真值，后续 chunks 是空字符串 `""` 而非 null。判空再覆盖 tool_index → id 映射
- DashScope 海外：`https://dashscope-intl.aliyuncs.com/compatible-mode/v1`
- DashScope 国内：`https://dashscope.aliyuncs.com/compatible-mode/v1`

### Anthropic 协议

- 原生支持 `ContentBlock::ToolUse` / `ToolResult`，**不需要**像 OpenAI 那样转格式
- usage 在 `message_delta` event 自带，不需要 `stream_options`

### Tool 调用循环

- LLM 不知真实 session UUID，会编 `session_id: "default"` / `"current"`
- 工具的 schema 把 `session_id` 改成 optional，runtime 兜底到 `ctx.active_session_id`
- 兜底覆盖：`""` / `"current"` / `"default"` / `"active"` / `"main"` 都视为「用 active」
- system prompt 引导 LLM 主动调工具（不写默认 prompt 的话 Qwen 倾向给文字指南）

### PTY 输出处理

- ring buffer 存原始 bytes（前端 xterm.js 要 ANSI 渲染）
- AI 工具读取时调 `tools::ansi::strip_for_llm` 剥 CSI / OSC / DCS + 删低位控制 + 折叠空行
- 不剥的话 LLM 看不懂会反复重试别的命令 → 用户被 N 次确认弹窗轰炸

---

## 测试基础设施

- **后端单测**：`cargo test -p aitm <module>`，用 `tempfile::TempDir` + 共享 `lib::test_env_lock::ENV_LOCK` 串行 env 改动
- **后端集成（wiremock）**：`src-tauri/tests/*.rs`，独立 binary 不受 unit test ENV 污染
- **前端单测**：vitest + jsdom，mock `@tauri-apps/api/core` 的 invoke
- **E2E**：Playwright + `tests/e2e/_mock-ipc.ts` 注入 `window.__TAURI_INTERNALS__`，含事件机制（`__emitMockEvent` + `transformCallback` 回调注册）+ 可断言的 `__lastSavedPayload` / `__lastApprovalDecision` 钩子
- **chat store 暴露 cid 给 E2E**：`window.__getChatCid()` 仅在 dev / test 模式挂 zustand store conversationId

---

## 文件结构关键索引

```
src-tauri/src/
├── ipc/                   IPC 命令入口（Tauri commands）
│   ├── ai.rs              ai_chat_send / ai_tool_approve / ai_tool_reject + AiState 含 ToolRegistry + ToolLoopHandle
│   ├── providers.rs       providers_get_config / save_config / test_connection
│   ├── settings.rs        settings_get / update / reset
│   └── session.rs         session_open / write / resize / close
├── orchestrator/
│   └── tool_loop.rs       工具调用循环 + EventSink trait（关键扩展点）
├── tools/
│   ├── mod.rs             Tool trait + ToolContext + RiskClass + ToolError
│   ├── ansi.rs            strip_for_llm（剥 ANSI 给 LLM 看）
│   ├── registry.rs        ToolRegistry::with_defaults() 注册默认工具
│   ├── read_file.rs / list_files.rs / terminal_history.rs / run_command.rs
├── safety/
│   └── blacklist.rs       L1 黑名单 regex
├── providers/
│   ├── types.rs           LlmProvider trait + ChatChunk / ContentBlock / ToolDef 协议层
│   ├── openai_compat.rs   OpenAI 兼容适配（含协议转换 helper）
│   ├── anthropic.rs       Anthropic 适配
│   ├── presets.rs         多家预设 base_url + models
│   ├── registry.rs        ProviderRegistry + Arc<RwLock<>> + auto_register 三源合并 + rebuild_registry
│   └── env.rs             load_dotenv_map / mask_api_key
├── settings/              AppSettings + TOML 持久化
└── session/               PTY 抽象 + 64KB ring buffer

src/ (前端)
├── components/
│   ├── AiSidebar.tsx      侧栏总入口；订阅 ai:* 事件 + 调 aiChatSend
│   ├── ConfirmDialog.tsx  HIGH / DESTRUCTIVE 工具批准弹窗
│   ├── ToolCallBubble.tsx 工具调用气泡（参数 + 结果折叠）
│   ├── MessageBubble.tsx  user / assistant 文本气泡
│   ├── SettingsModal.tsx  设置面板（字体 / 光标 / Shell / AI Provider）
│   └── ProviderList.tsx   AI Provider 配置 section
├── stores/                zustand：chat / tabs / sidebar / settings
└── lib/tauri.ts           IPC 类型 + invoke 包装
```
