//! AI 聊天相关 IPC 命令 + 事件 forward。
//!
//! 1E 起：`ai_chat_send` 走 [`orchestrator::tool_loop::run_tool_loop`]，
//! 不再自己处理流式 chunk。事件类型直接从 orchestrator 模块 re-export，
//! 避免 ipc 这一层重复定义。
//!
//! 1F 起：增加项目作用域 + SQLite 持久化。
//! - 入口先调 [`scope::resolve_scope`]，[`Scope::NeedsInit`] 时暂存 args 到
//!   `AiState.pending_chats` 并 emit `ai:init_required`，前端弹 InitDialog 决议
//!   后调 [`ai_chat_resume`] 用确定的 scope 恢复。
//! - 用户每条 message + 每轮 assistant final text + token usage 都写 db。
//! - system prompt 由 [`scope::memory::compose_system_prompt`] 自动拼上全局 +
//!   项目两级 MEMORY.md（按 scope 决定）。
//!
//! 例外：`AiErrorEvent` 仍然在 ipc 这一层，因为 orchestrator emit 的 error
//! 没有 `kind` 字段（前端要据此区分 401/限流/网络等横幅样式）。
//! [`TauriSink::emit_error`] 把 orchestrator 端的简单 error 翻成带 kind 的
//! ipc 形态，默认填 `AiErrorKind::Protocol`。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{Mutex, RwLock};

use crate::ipc::scope::ScopeDto;
use crate::ipc::session::SessionState;
use crate::ipc::settings::SettingsState;
use crate::orchestrator::tool_loop::{
    self, AiDoneEvent as OrchDoneEvent, AiErrorEvent as OrchErrorEvent, AiTokenEvent,
    AiToolFinishedEvent, AiToolRequestEvent, AiToolStartedEvent, EventSink, ToolLoopHandle,
    run_tool_loop,
};
use crate::providers::registry::{auto_register, ProviderRegistry, RegistryEntry, SharedRegistry};
use crate::providers::types::*;
use crate::safety::whitelist::compile as compile_whitelist;
use crate::scope::Scope;
use crate::settings::AppSettings;
use crate::store::AitmDb;
use crate::store::repo_global;
use crate::store::repo_project;
use crate::tools::{ToolContext, registry::ToolRegistry};

// 让旧路径（如 settings、tests）继续 `use crate::ipc::ai::AiDoneEvent` / `UsageInfo` 不破。
pub use crate::orchestrator::tool_loop::{AiDoneEvent, UsageInfo};

/// 全局 AI 状态：持有 ProviderRegistry + ToolRegistry + tool loop 审批通道。
///
/// `registry` 用 `RwLock` 包：读路径（`list_providers` / `ai_chat_send`）
/// 拿读锁；写路径（用户保存 settings 后的 `rebuild_registry`）拿写锁。
/// 多读单写正好匹配实际访问模式。
pub struct AiState {
    pub registry: SharedRegistry,
    /// 工具注册表（启动时一次性装好默认工具，整个生命周期共享）。
    pub tools: Arc<ToolRegistry>,
    /// tool loop 用户审批通道。`ai_tool_approve` / `ai_tool_reject` 喂回结果。
    pub tool_loop_handle: Arc<ToolLoopHandle>,
    /// 当前活跃 chat task（用于 cancel）。
    pub active: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// 等待 init 决议的 chat 请求，按 conversation_id 暂存。
    /// 用户在 InitProjectDialog 决议后调 [`ai_chat_resume`] 取出 args + 用确定的
    /// scope 恢复执行。同 cid 的第二次 send 会覆盖前一条 pending（最后写赢）。
    pub pending_chats: Mutex<HashMap<String, ChatSendArgs>>,
}

impl AiState {
    /// 用启动时加载到的 settings 构造初始 registry。
    ///
    /// 不再保留 `Default` impl —— 调用方必须传 settings 引用，
    /// 避免出现"用空 settings 启动"的幽灵状态。
    pub fn new(settings: &AppSettings) -> Self {
        let mut reg = ProviderRegistry::new();
        // 启动期忽略 register 失败：单家 provider 配置错不应阻塞应用启动
        let _ = auto_register(&mut reg, settings);
        Self {
            registry: Arc::new(RwLock::new(reg)),
            tools: Arc::new(ToolRegistry::with_defaults()),
            tool_loop_handle: Arc::new(ToolLoopHandle::new()),
            active: Mutex::new(None),
            pending_chats: Mutex::new(HashMap::new()),
        }
    }
}

/// 带错误分类的 ai:error payload（前端横幅样式参考）。
///
/// orchestrator 自己的 [`OrchErrorEvent`] 没有 `kind` 字段，由 [`TauriSink::emit_error`]
/// 把它翻成本结构发出去。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiErrorEvent {
    pub conversation_id: String,
    pub message: String,
    pub kind: AiErrorKind,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiErrorKind {
    Unauthorized,
    RateLimited,
    Network,
    Protocol,
    Other,
}

/// 1F 新增：scope = NeedsInit 时 emit 给前端，触发 InitProjectDialog。
#[derive(Debug, Clone, Serialize)]
pub struct AiInitRequiredEvent {
    pub conversation_id: String,
    /// canonicalize 后的 cwd 绝对路径
    pub cwd: String,
    /// 项目名预填值（cwd 的 dirname）
    pub default_name: String,
}

#[tauri::command]
pub async fn list_providers(state: State<'_, AiState>) -> Result<Vec<RegistryEntry>, String> {
    Ok(state.registry.read().await.describe_all())
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChatSendArgs {
    pub conversation_id: String,
    pub provider_id: String,
    pub model: String,
    pub messages: Vec<Message>,
    #[serde(default)]
    pub system: Option<String>,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
    #[serde(default = "default_temperature")]
    pub temperature: f32,
    /// 当前活跃 tab 的 session id；run_command / terminal_history 在 LLM
    /// 没传 session_id 时用这个兜底。前端从 useTabsStore.activeId 取。
    #[serde(default)]
    pub active_session_id: Option<String>,
    /// 1F：当前活跃 tab 的 shell cwd 绝对路径（用于 scope 解析）。
    /// 前端从 active session 的 current_cwd 拿；缺失时后端用 active_session_id 兜底查；
    /// 都没有用 HOME。
    #[serde(default)]
    pub cwd: Option<String>,
    /// v0.9.2 HR5-1+2：前端 collectRuntimeContext 收集的 active terminal /
    /// browser / editor 实时状态。每轮请求注入 system prompt 末尾，让 AI
    /// 不再瞎猜"用户当前在哪 / 看啥 / 编辑啥"。老客户端不传 → None。
    #[serde(default)]
    pub runtime_context: Option<RuntimeContext>,
}

/// v0.9.2 HR5-1+2：前端 collectRuntimeContext 序列化结构。
///
/// 三个 active 子结构都是 Option：用户可能没开终端 / 没开浏览器 / 没开编辑器。
/// 全 None + os 空 → render_runtime_context 返 None（不污染 prompt）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct RuntimeContext {
    pub active_terminal: Option<ActiveTerminal>,
    pub active_browser: Option<ActiveBrowser>,
    pub active_editor: Option<ActiveEditor>,
    pub os: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct ActiveTerminal {
    pub session_id: String,
    pub cwd: Option<String>,
    pub shell: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct ActiveBrowser {
    pub tab_id: String,
    pub url: String,
    pub title: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct ActiveEditor {
    pub path: String,
    pub language: Option<String>,
    pub dirty: bool,
}

/// v0.9.2 HR5-2 / v0.10.0 HR6-1：渲染 runtime context 为 markdown 文本块，append 到 system prompt。
///
/// **HR6-1 修复**（v0.10.0）：
/// - 旧版当 `active_terminal` 为 None 或 cwd 缺失时，仍然输出"行为指引：用户问'我在哪'
///   → 直接答 active_terminal.cwd"——但实际数据缺失，模型只好凭空猜，出现真机
///   遇到的 `/Users/someuser` 一类合理但虚构的路径幻觉。
/// - 新版：缺字段统一输出 `(未知)`，缺整段统一输出"(未打开 / 用户没开 X)"，并附"铁律
///   v3：禁止编造"段落，明确告诉模型"信息缺失时调工具拿真值或直接说不知道，绝不要
///   编合理路径"。
///
/// 渲染规则：
/// - 全 None + os 空 → 返 None（不污染 prompt）
/// - 至少有一个 active 或 os 非空 → 返 Some(markdown 块)
/// - 字段为 Some("") 或 None → 输出 `(未知)` 占位（不再静默吞掉）
/// - 整个 active_* 为 None → 输出"(未打开 ...)"，让模型清楚看到"该模块没开"
pub fn render_runtime_context(ctx: &RuntimeContext) -> Option<String> {
    let has_terminal = ctx.active_terminal.is_some();
    let has_browser = ctx.active_browser.is_some();
    let has_editor = ctx.active_editor.is_some();
    let has_os = !ctx.os.is_empty();
    if !has_terminal && !has_browser && !has_editor && !has_os {
        return None;
    }

    /// 小工具：Option<String> 为空 / None 视为 "(未知)"，否则原值
    fn show_opt(v: &Option<String>) -> &str {
        match v {
            Some(s) if !s.is_empty() => s.as_str(),
            _ => "(未知)",
        }
    }
    /// 同上，String 版本（空串 → "(未知)"）
    fn show_str(s: &str) -> &str {
        if s.is_empty() {
            "(未知)"
        } else {
            s
        }
    }

    let mut out = String::from("# 当前运行时状态（v0.9.2 实时注入，每轮请求刷新）\n\n");

    if let Some(t) = &ctx.active_terminal {
        out.push_str("active 终端：\n");
        out.push_str(&format!("- session_id: {}\n", show_str(&t.session_id)));
        out.push_str(&format!("- cwd: {}\n", show_opt(&t.cwd)));
        out.push_str(&format!("- shell: {}\n", show_opt(&t.shell)));
        out.push('\n');
    } else {
        out.push_str("active 终端：(未打开 / 用户没开终端 tab)\n\n");
    }

    if let Some(b) = &ctx.active_browser {
        out.push_str("active 浏览器 tab：\n");
        out.push_str(&format!("- tab_id: {}\n", show_str(&b.tab_id)));
        out.push_str(&format!("- url: {}\n", show_str(&b.url)));
        out.push_str(&format!("- title: {}\n", show_opt(&b.title)));
        out.push('\n');
    } else {
        out.push_str("active 浏览器 tab：(未打开 / 用户没开浏览器面板)\n\n");
    }

    if let Some(e) = &ctx.active_editor {
        out.push_str("active 编辑器文件：\n");
        out.push_str(&format!("- path: {}\n", show_str(&e.path)));
        out.push_str(&format!("- language: {}\n", show_opt(&e.language)));
        out.push_str(&format!("- dirty: {}\n\n", e.dirty));
    } else {
        out.push_str("active 编辑器文件：(未打开 / 用户没在文件树点开任何文件)\n\n");
    }

    if has_os {
        out.push_str(&format!("操作系统：{}\n\n", ctx.os));
    }

    out.push_str(
        "## 行为指引\n\
        - 用户说\"当前/这个/此\"指上面 active 状态，**不要**自己猜或反问\n\
        - 用户说\"列当前目录\" → 直接调 list_files（cwd 用 active 终端的 cwd，相对路径用 `.`）\n\
        - 用户说\"看当前页面\" → **不要**回答前先调 browser_snapshot 拿即时数据\n\
        - 用户问\"我现在在哪\" → 直接答 active_terminal.cwd，**不要**调工具\n\n",
    );

    out.push_str(
        "## ⚠️ 铁律 v3：禁止编造\n\n\
        **禁止编造**任何不在上面 active 状态中的数据：\n\
        - 用户名 / 用户路径名（如 `/Users/xxx`，xxx 必须是上面 active_terminal.cwd 真实路径段，\
        不能是看似合理的中文名）\n\
        - 终端 session / browser tab / 编辑器文件\n\
        - 任何\"看似合理\"的猜测路径都是错的\n\n\
        如果信息缺失：\n\
        - 终端 cwd 显示 `(未知)` → 调 `run_command(active_terminal.session_id, \"pwd\")` 拿真值\n\
        - **active 终端整段是\"未打开\"** → 直接告诉用户\"未打开终端，请先打开一个 tab\"\n\
        - 浏览器 URL 缺失 → 调 `browser_snapshot`\n\
        - **active 浏览器整段是\"未打开\"** → 告诉用户\"浏览器面板没开\"\n\
        - 文件 / 编辑器缺失 → 告诉用户\"请先在文件树点开一个文件\"\n\n\
        **永远说真话**：宁可\"我不知道\"，**绝不**捏造合理路径。\n",
    );

    Some(out)
}

fn default_max_tokens() -> u32 {
    4096
}

fn default_temperature() -> f32 {
    1.0
}

/// 默认 system prompt：明确引导 LLM 在合适时**主动调用工具**而不是给文字指南。
///
/// 1E-1 阶段实测：Qwen / DeepSeek / 部分模型即使收到 tools 列表，
/// 默认行为也是反问/给"打开终端 ls /"这种文字指南，不会主动调工具。
/// 这里给一个明确引导。
fn default_system_prompt() -> String {
    r#"你是一个集成在终端应用中的 AI 助手。用户工作在一台 macOS / Linux 电脑上，已经配置了多个工具供你直接使用，**请主动调用工具**完成用户请求，不要给"打开终端 ls /"这种文字指南。

# ⚠️ 最高优先级铁律（违反即视为故障）

**不许撒谎说做了某件事**。如果你的回复里出现下列字眼之一：
"已跳转" / "已打开" / "已导航" / "已搜索" / "已点击" / "已填写" / "已经跳转到" / "已经导航到" / "已经打开" / "成功跳转" / "成功打开" / "好的，已..." / "好的，我已..."

那么**这条回复里同一轮必须含有对应的工具调用**（`browser_navigate` / `browser_click` / `browser_fill` 等真实 tool_use block）。**未调工具就声称已做 = 严重错误**。

### 反例（错误，绝对禁止）

用户："跳转到 google"
AI（错）："好的，已经跳转到 Google 首页了。"  ← **没调 browser_navigate 就说"已跳转" = 撒谎**

### 正例（正确）

用户："跳转到 google"
AI 操作：调用 `browser_navigate(url="https://www.google.com")` 工具
AI 回复："已跳转到 Google。"  ← **调了工具才说"已跳转"**

### 例外（可以不调工具）

如果你**不打算**调工具（如能力不够 / 不确定 URL / 用户上下文不清楚）：
- 改用："我准备调用 browser_navigate 跳转到 X，需要确认 URL 是 https://xxx 吗？"
- 或：反问澄清，**绝对不要**写"已经..."

---

# ⚠️ 铁律 v2（v0.9.2 加强）

如果你的回复声称完成了任何 browser_* 操作（"已跳转 / 已点击 / 已填 / 已搜索"等），
**当前 assistant 消息**里**必须**有对应的 tool_use block，且**后续轮 tool_result 的内容 `ok` 字段为 `true`**。

如果上一轮 tool_result 内容 `ok === false`（操作失败）：
- **禁止**说"已跳转 / 已打开"等已完成式表述
- 必须改说："跳转失败，原因：X"（X 来自 tool_result.reason）
- 然后由用户决定要不要重试 / 改 URL

注：browser_navigate 现在的 tool_result 总是结构化对象（v0.9.2 起）：
  - 成功：`{ ok: true, url, title }`
  - 失败：`{ ok: false, attempted_url, reason }`

读 tool_result 字符串里的 `"ok": false` 判失败，不要看 reason 文本自己推断。

---

# 可用工具

文件 / 终端类：
- `read_file(path)`：读文件内容（限用户家目录及子目录）
- `list_files(dir, max_depth?)`：列目录文件（自动跳过 .git/node_modules 等）
- `get_terminal_history(session_id, lines?)`：拉指定终端 tab 的最近输出
- `search_history(query, max_results?)`：跨所有终端 tab 搜关键字
- `run_command(session_id, cmd)`：在指定终端 tab 执行命令（每次会问用户确认）

浏览器类（v0.5.5，aitm 内嵌浏览器；用户在 ActivityBar 点地球图标打开）：
- `browser_snapshot(tab_id?)`：抓内嵌浏览器当前页面的可交互元素（a11y 树）。返回 url/title/elements 数组（每个 element 有 ref/tag/text）。**用户提到"看页面 / 看网页 / 看 xx 网站有什么"时主动调这个**
- `browser_navigate(url, tab_id?)`：让内嵌浏览器导航到 URL。**用户说"跳/到/去/打开/导航 X"无条件调本工具，不要根据会话历史判断"已经在 X"**
- `browser_click(ref, tab_id?)`：点击 snapshot 抓到的元素（按 ref 引用）。**先 snapshot 拿 ref**
- `browser_fill(ref, value, tab_id?)`：填写输入框
- `browser_eval(script, tab_id?)`：任意 JS eval（仅必要时用）
- 这些工具的 `tab_id` 不传时自动用 active 浏览器 tab

# 其他行为约定

1. 用户问"看 / 读 / 列 / 查 / 搜 / 跑 / 执行"类问题时，**直接调对应工具**
2. 用户提到"页面 / 网页 / 浏览器 / 网站"时，**用 browser_* 工具操作内嵌浏览器**（不要建议用户自己打开浏览器）
3. **区分两种"搜索"**：
   - 用户在 **浏览器上下文**中说"搜索 / 在搜索框填 X / 点搜索按钮"：先 `browser_snapshot` 找搜索框 ref → `browser_fill(ref=搜索框, value="X")` → `browser_snapshot` 找搜索按钮 → `browser_click`
   - 用户在 **终端上下文**中说"搜历史输出 X" / "查终端日志里有没有 X"：用 `search_history(query="X")`
   - 默认：如果用户最近一句提了浏览器/页面/网址，"搜索"意指浏览器搜索
4. **浏览器状态是会变的**：用户可能在两条消息之间手动改 URL / 关 tab；不要根据历史 snapshot / 历史 tool result 判断"当前在哪个页面"。如果想确认当前 URL，先调 `browser_snapshot`（snapshot 返回的 url 字段是即时真值）
5. `path` / `dir` 用相对路径（基于用户家目录），如 `.`、`Desktop`、`code/proj`
6. `session_id` 用户没指定时，可以省略或问用户
7. 工具结果是真实数据，请基于结果回答；不要捏造文件名 / 命令输出
8. 用户家目录下任何文件都可以读，无需额外授权（沙盒已生效）
9. 用中文简洁回答，不要复述工具调用过程
"#.into()
}

/// 1F 持久化版本的 EventSink：包装 [`TauriSink`]，在 emit_token 累积 assistant
/// 文本，emit_done 时一次性把 assistant message + token usage 写 SQLite。
///
/// 设计取舍（plan §2.5）：
/// - **token delta 不写盘**：流式 50+ chunks/s 同步写 sqlite 会拖慢 LLM 响应；
///   累积到内存的 String，emit_done 时一次写
/// - **tool_call 暂不持久化**：完整持久化要在 sink 里维护 call_id → 元信息
///   的 map（emit_tool_request 时存 args_preview/risk，emit_tool_finished
///   时合并成完整 payload）。T8 简化只持久化 user + assistant + token usage；
///   工具调用气泡仍是 in-memory，重启后丢失（接受 — 用户极少在工具执行中重启）
struct PersistenceSink {
    inner: TauriSink,
    db: Arc<AitmDb>,
    bucket: String,
    /// 同一 conversation 流式累积 assistant text；done 时 drain 写 db
    assistant_buffer: StdMutex<String>,
    /// 该 sink 服务的 conversation id（与 emit 事件里的 cid 比对一致）
    cid: String,
    /// provider id 用于 token usage 累加
    provider_id: String,
}

impl PersistenceSink {
    fn drain_assistant_text(&self) -> String {
        self.assistant_buffer
            .lock()
            .map(|mut b| std::mem::take(&mut *b))
            .unwrap_or_default()
    }
}

impl EventSink for PersistenceSink {
    fn emit_token(&self, e: &AiTokenEvent) {
        if e.conversation_id == self.cid {
            if let Ok(mut b) = self.assistant_buffer.lock() {
                b.push_str(&e.text);
            }
        }
        self.inner.emit_token(e);
    }

    fn emit_tool_request(&self, e: &AiToolRequestEvent) {
        self.inner.emit_tool_request(e);
    }

    fn emit_tool_started(&self, e: &AiToolStartedEvent) {
        self.inner.emit_tool_started(e);
    }

    fn emit_tool_finished(&self, e: &AiToolFinishedEvent) {
        // 工具开始下一轮 LLM 之前，assistant 已经有累积的 text → 也要写一次（
        // 否则跨工具调用的中间文本会丢）。这种 case：assistant 说"我先看一下"
        // → tool_call → assistant 继续。如果不在 tool_finished 时 flush，
        // "我先看一下" 会和最后一段文本被合并到一条 assistant 消息里。
        // 简化：暂不在这里 flush（这两段文本本来在 LLM 视角就是同一回合）。
        self.inner.emit_tool_finished(e);
    }

    fn emit_notification(&self, e: &crate::notifications::NotificationEvent) {
        // PersistenceSink 只 wrap，直接转发到内层 sink；通知不入库（v0.5.0-A
        // 范围内，留 v0.5.0-C Session 持久化时考虑）
        self.inner.emit_notification(e);
    }

    fn emit_done(&self, e: &OrchDoneEvent) {
        if e.conversation_id == self.cid {
            // 1. assistant final text → db
            let text = self.drain_assistant_text();
            if !text.is_empty() {
                let payload = serde_json::json!({
                    "content": text,
                    "usage": e.usage,
                })
                .to_string();
                if let Err(err) = persist_message(
                    &self.db,
                    &self.bucket,
                    &self.cid,
                    "assistant",
                    &payload,
                ) {
                    tracing::warn!("persist assistant message failed: {err}");
                }
            }

            // 2. token usage → db
            if let Some(u) = &e.usage {
                if let Err(err) = persist_token_usage(
                    &self.db,
                    &self.bucket,
                    &self.provider_id,
                    u.input_tokens as i64,
                    u.output_tokens as i64,
                ) {
                    tracing::warn!("persist token usage failed: {err}");
                }
            }
        }
        self.inner.emit_done(e);
    }

    fn emit_error(&self, e: &OrchErrorEvent) {
        self.inner.emit_error(e);
    }
}

/// 把一条消息持久化到项目 db。
fn persist_message(
    db: &AitmDb,
    bucket: &str,
    cid: &str,
    kind: &str,
    payload_json: &str,
) -> anyhow::Result<()> {
    db.with_project(bucket, |c| {
        let _ = repo_project::messages::append(c, cid, kind, payload_json)?;
        Ok(())
    })
}

/// 累加 token usage 到全局 db。
fn persist_token_usage(
    db: &AitmDb,
    bucket: &str,
    provider_id: &str,
    delta_in: i64,
    delta_out: i64,
) -> anyhow::Result<()> {
    let yyyymm = repo_global::token_usage::current_yyyymm();
    db.with_global(|c| {
        repo_global::token_usage::accumulate(
            c,
            bucket,
            provider_id,
            &yyyymm,
            delta_in,
            delta_out,
        )?;
        Ok(())
    })
}

/// 生产环境 EventSink：把 orchestrator 事件 emit 给 Tauri 前端。
///
/// 不直接复用 `orchestrator::tool_loop::TauriSink`，因为 ipc 这层要把简单的
/// `OrchErrorEvent` 翻成带 `kind` 的 [`AiErrorEvent`]。
struct TauriSink {
    app: AppHandle,
}

impl EventSink for TauriSink {
    fn emit_token(&self, e: &AiTokenEvent) {
        let _ = self.app.emit("ai:token", e);
    }
    fn emit_tool_request(&self, e: &AiToolRequestEvent) {
        let _ = self.app.emit("ai:tool_request", e);
    }
    fn emit_tool_started(&self, e: &AiToolStartedEvent) {
        let _ = self.app.emit("ai:tool_started", e);
    }
    fn emit_tool_finished(&self, e: &AiToolFinishedEvent) {
        let _ = self.app.emit("ai:tool_finished", e);
    }
    fn emit_done(&self, e: &OrchDoneEvent) {
        let _ = self.app.emit("ai:done", e);
    }
    fn emit_error(&self, e: &OrchErrorEvent) {
        // orchestrator 的 error 不带 kind；这里默认 Protocol。
        // provider 启动失败那次 error 由 ai_chat_send 直接 emit 准确分类的版本。
        let ipc_e = AiErrorEvent {
            conversation_id: e.conversation_id.clone(),
            message: e.message.clone(),
            kind: AiErrorKind::Protocol,
        };
        let _ = self.app.emit("ai:error", &ipc_e);
    }
    fn emit_notification(&self, e: &crate::notifications::NotificationEvent) {
        let _ = self.app.emit("notification:received", e);
    }
}

/// 解析 args.cwd → 绝对路径；优先用前端传的 args.cwd，缺失或空时用
/// active_session 的 shell 实时 cwd 兜底，再不行用 HOME。
async fn resolve_args_cwd(
    args: &ChatSendArgs,
    session_state: &Arc<SessionState>,
) -> PathBuf {
    if let Some(c) = args.cwd.as_deref() {
        if !c.is_empty() {
            return PathBuf::from(c);
        }
    }
    if let Some(sid) = args.active_session_id.as_deref() {
        if !sid.is_empty() {
            if let Some(p) = session_state.current_cwd(sid).await {
                return p;
            }
        }
    }
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

/// HR5-3：解析 ToolContext.cwd（即 AI 工具沙盒锚点 + 工作目录）。
///
/// 优先级：
/// 1. 项目 scope → 用 `Scope::Project.root_path`（项目沙盒）
/// 2. 其他 scope（Global / NeedsInit）→ 用 active 终端 session 的实时 shell cwd
/// 3. 兜底：HOME（再不行 "/"，理论上几乎不会到这一步）
///
/// 抽成纯函数方便单测：`session_cwd` 由调用方提前查好
/// （`session_state.current_cwd(sid).await`），None 表示"无 active session
/// 或查不到"。空字符串路径 / 根目录 "/" 视为不可信，回退到 HOME。
pub(crate) fn resolve_tool_cwd(scope: &Scope, session_cwd: Option<PathBuf>) -> PathBuf {
    if let Scope::Project { root_path, .. } = scope {
        return PathBuf::from(root_path);
    }
    if let Some(p) = session_cwd {
        // 边界：空字符串 / 根目录 → 视为不可信，走 HOME 兜底
        let s = p.as_os_str();
        if !s.is_empty() && p != std::path::Path::new("/") {
            return p;
        }
    }
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

#[tauri::command]
pub async fn ai_chat_send(
    args: ChatSendArgs,
    state: State<'_, AiState>,
    session_state: State<'_, Arc<SessionState>>,
    settings_state: State<'_, SettingsState>,
    db: State<'_, Arc<AitmDb>>,
    browser_state: State<'_, Arc<crate::ipc::browser::BrowserState>>,
    app: AppHandle,
) -> Result<(), String> {
    // 1. 解析 cwd 并查 scope（scope 是 db 调用，丢 spawn_blocking）
    let cwd_path = resolve_args_cwd(&args, session_state.inner()).await;
    let db_arc: Arc<AitmDb> = db.inner().clone();
    let cwd_for_scope = cwd_path.clone();
    let scope = tokio::task::spawn_blocking(move || {
        crate::scope::resolve_scope(&cwd_for_scope, &db_arc)
    })
    .await
    .map_err(|e| format!("scope resolve spawn 失败: {e}"))?
    .map_err(|e| e.to_string())?;

    // 2. NeedsInit → 暂存 + emit + 返回（不起 stream task，等用户决议）
    if let Scope::NeedsInit { cwd } = &scope {
        let cid = args.conversation_id.clone();
        let default_name = std::path::Path::new(cwd)
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "项目".to_string());

        // 暂停前先取消 active task（如果有的话，避免老 task 还在跑）
        {
            let mut g = state.active.lock().await;
            if let Some(h) = g.take() {
                h.abort();
            }
        }

        state.pending_chats.lock().await.insert(cid.clone(), args);

        let _ = app.emit(
            "ai:init_required",
            AiInitRequiredEvent {
                conversation_id: cid,
                cwd: cwd.clone(),
                default_name,
            },
        );
        return Ok(());
    }

    // 3. Project / Global → 起 stream task
    spawn_chat_with_scope(
        args,
        scope,
        state,
        session_state.inner().clone(),
        settings_state,
        db.inner().clone(),
        browser_state.inner().clone(),
        app,
    )
    .await
}

/// 1F：用户在 InitProjectDialog 决议后恢复一条暂停的 chat。
///
/// `cid` 是 [`ai_chat_send`] 暂停时的 conversation_id；`scope` 是用户决议后
/// 的最终作用域：
/// - 用户选"是，初始化为项目" → 前端先调 `project_init` 落 marker，再调
///   `ai_chat_resume(cid, Project { uuid, root_path })`
/// - 用户选"不用，临时全局" → 直接 `ai_chat_resume(cid, Global)`
/// - 用户选"别再问我" → 前端先调 `mark_ignored`，再 `ai_chat_resume(cid, Global)`
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ai_chat_resume(
    cid: String,
    scope: ScopeDto,
    state: State<'_, AiState>,
    session_state: State<'_, Arc<SessionState>>,
    settings_state: State<'_, SettingsState>,
    db: State<'_, Arc<AitmDb>>,
    browser_state: State<'_, Arc<crate::ipc::browser::BrowserState>>,
    app: AppHandle,
) -> Result<(), String> {
    let args = state
        .pending_chats
        .lock()
        .await
        .remove(&cid)
        .ok_or_else(|| format!("无暂停的 chat: {cid}"))?;

    let scope_internal: Scope = scope.into();
    spawn_chat_with_scope(
        args,
        scope_internal,
        state,
        session_state.inner().clone(),
        settings_state,
        db.inner().clone(),
        browser_state.inner().clone(),
        app,
    )
    .await
}

/// 实际起 stream task 跑一次 chat。
///
/// 共用 [`ai_chat_send`] 与 [`ai_chat_resume`] 的尾段：
/// 1. 把最新一条 user 消息持久化到项目 db
/// 2. 用 [`scope::memory::compose_system_prompt`] 给 system prompt 拼上 MEMORY
/// 3. 编译白名单 + 构造 ToolContext
/// 4. 包 [`PersistenceSink`] 让 done 时把 assistant + token usage 写盘
/// 5. spawn run_tool_loop
#[allow(clippy::too_many_arguments)]
async fn spawn_chat_with_scope(
    args: ChatSendArgs,
    scope: Scope,
    state: State<'_, AiState>,
    session_arc: Arc<SessionState>,
    settings_state: State<'_, SettingsState>,
    db: Arc<AitmDb>,
    browser_state: Arc<crate::ipc::browser::BrowserState>,
    app: AppHandle,
) -> Result<(), String> {
    // 拿 provider — 小作用域释放读锁
    let provider = {
        let g = state.registry.read().await;
        g.get(&args.provider_id)
            .ok_or_else(|| format!("provider 不存在: {}", args.provider_id))?
    };

    let cid = args.conversation_id.clone();
    let bucket = scope.bucket_id().to_string();
    let provider_id = args.provider_id.clone();

    // 1. 持久化最新一条 user 消息（取 messages 中最后一个 role==User）
    if let Some(last_user_text) = extract_last_user_text(&args.messages) {
        let payload = serde_json::json!({ "content": last_user_text }).to_string();
        let db_for_user = db.clone();
        let bucket_for_user = bucket.clone();
        let cid_for_user = cid.clone();
        let _ = tokio::task::spawn_blocking(move || {
            persist_message(&db_for_user, &bucket_for_user, &cid_for_user, "user", &payload)
        })
        .await;
    }

    // 2. compose system prompt（base + 全局 MEMORY + 项目 MEMORY）
    let base_system = args
        .system
        .clone()
        .unwrap_or_else(default_system_prompt);
    let scope_for_compose = scope.clone();
    let composed = tokio::task::spawn_blocking(move || {
        crate::scope::memory::compose_system_prompt(&base_system, &scope_for_compose)
    })
    .await
    .unwrap_or_else(|_| default_system_prompt());

    // v0.9.2 HR5-1+2：append runtime context（active terminal/browser/editor + os）
    // 让 AI 不再瞎猜"当前在哪"。runtime_context=None → 跟 v0.9.1 行为一致
    let final_system = match args
        .runtime_context
        .as_ref()
        .and_then(render_runtime_context)
    {
        Some(block) => format!("{composed}\n\n{block}"),
        None => composed,
    };

    let req = ChatRequest {
        model: args.model.clone(),
        messages: args.messages.clone(),
        // tools 由 run_tool_loop 内部从 ToolRegistry 注入，这里留空避免重复
        tools: vec![],
        system: Some(final_system),
        max_tokens: args.max_tokens,
        temperature: args.temperature,
    };

    // 取消之前的 active task（若有）
    {
        let mut g = state.active.lock().await;
        if let Some(h) = g.take() {
            h.abort();
        }
    }

    let tools = state.tools.clone();
    let handle = state.tool_loop_handle.clone();

    // 编译白名单
    let whitelist = {
        let s = settings_state.current.lock().await;
        let (wl, _failed) = compile_whitelist(&s.safety.whitelist);
        Arc::new(wl)
    };

    // HR5-3 沙盒根：项目 scope 用项目根；其他 scope 先查 active session cwd 再 HOME 兜底
    let session_cwd = match args.active_session_id.as_deref() {
        Some(sid) if !sid.is_empty() => session_arc.current_cwd(sid).await,
        _ => None,
    };
    let cwd = resolve_tool_cwd(&scope, session_cwd);

    let ctx = ToolContext {
        session_state: session_arc,
        cwd,
        active_session_id: args.active_session_id.clone(),
        whitelist,
        browser_state: browser_state.clone(),
    };

    let sink: Arc<dyn EventSink> = Arc::new(PersistenceSink {
        inner: TauriSink { app },
        db,
        bucket,
        assistant_buffer: StdMutex::new(String::new()),
        cid: cid.clone(),
        provider_id,
    });

    let task = tokio::spawn(async move {
        run_tool_loop(req, provider, tools, ctx, sink, cid, handle).await;
    });

    *state.active.lock().await = Some(task);
    Ok(())
}

/// 从 messages 列表里抽取最后一条 user 消息的纯文本。
/// 找不到 / 内容是 Blocks（含工具结果） → None。
fn extract_last_user_text(messages: &[Message]) -> Option<String> {
    messages.iter().rev().find_map(|m| {
        if !matches!(m.role, Role::User) {
            return None;
        }
        match &m.content {
            MessageContent::Text(t) => Some(t.clone()),
            MessageContent::Blocks(blocks) => {
                // 取所有 Text block 拼起来
                let text: String = blocks
                    .iter()
                    .filter_map(|b| match b {
                        ContentBlock::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                if text.is_empty() { None } else { Some(text) }
            }
        }
    })
}

#[tauri::command]
pub async fn ai_chat_cancel(state: State<'_, AiState>) -> Result<(), String> {
    let mut g = state.active.lock().await;
    if let Some(h) = g.take() {
        h.abort();
    }
    Ok(())
}

/// 用户在前端 ConfirmDialog 点了"批准" → 喂回 tool loop。
#[tauri::command]
pub async fn ai_tool_approve(
    call_id: String,
    state: State<'_, AiState>,
) -> Result<(), String> {
    tool_loop::resolve_approval(&state.tool_loop_handle, &call_id, true).await;
    Ok(())
}

/// 用户在前端 ConfirmDialog 点了"拒绝" → 喂回 tool loop。
#[tauri::command]
pub async fn ai_tool_reject(
    call_id: String,
    state: State<'_, AiState>,
) -> Result<(), String> {
    tool_loop::resolve_approval(&state.tool_loop_handle, &call_id, false).await;
    Ok(())
}

/// 把 ProviderError 分类成前端横幅类型。
///
/// 当前 ai_chat_send 已经把流式处理交给 run_tool_loop，provider 自身的
/// 启动错误也走 sink.emit_error 路径，因此本函数暂时无调用方但保留作 API
/// 兜底（前端 e2e 测试 / 后续 hook 可能用）。
#[allow(dead_code)]
fn classify_error(e: &ProviderError) -> AiErrorKind {
    match e {
        ProviderError::Unauthorized => AiErrorKind::Unauthorized,
        ProviderError::RateLimited => AiErrorKind::RateLimited,
        ProviderError::Http(_) | ProviderError::Timeout => AiErrorKind::Network,
        ProviderError::Protocol(_) => AiErrorKind::Protocol,
        _ => AiErrorKind::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_last_user_text_text_变体() {
        let msgs = vec![
            Message {
                role: Role::User,
                content: MessageContent::Text("第一条".into()),
            },
            Message {
                role: Role::Assistant,
                content: MessageContent::Text("响应".into()),
            },
            Message {
                role: Role::User,
                content: MessageContent::Text("第二条".into()),
            },
        ];
        assert_eq!(extract_last_user_text(&msgs), Some("第二条".into()));
    }

    #[test]
    fn extract_last_user_text_blocks_变体_只取_text_block() {
        let msgs = vec![Message {
            role: Role::User,
            content: MessageContent::Blocks(vec![
                ContentBlock::Text {
                    text: "你好".into(),
                },
                ContentBlock::ToolResult {
                    tool_use_id: "x".into(),
                    content: "结果".into(),
                    is_error: false,
                },
            ]),
        }];
        assert_eq!(extract_last_user_text(&msgs), Some("你好".into()));
    }

    #[test]
    fn extract_last_user_text_无_user_返回_none() {
        let msgs = vec![Message {
            role: Role::Assistant,
            content: MessageContent::Text("响应".into()),
        }];
        assert_eq!(extract_last_user_text(&msgs), None);
    }

    #[test]
    fn extract_last_user_text_全是_tool_result_blocks_返回_none() {
        let msgs = vec![Message {
            role: Role::User,
            content: MessageContent::Blocks(vec![ContentBlock::ToolResult {
                tool_use_id: "x".into(),
                content: "结果".into(),
                is_error: false,
            }]),
        }];
        assert_eq!(extract_last_user_text(&msgs), None);
    }

    #[test]
    fn default_system_prompt_含铁律_v2_段() {
        // v0.9.2 HR5-4：system prompt 必须含"铁律 v2"段，引导 LLM
        // 看 tool_result.ok 判断 browser_navigate 是否真成功。
        let prompt = default_system_prompt();
        assert!(
            prompt.contains("铁律 v2"),
            "default_system_prompt 缺铁律 v2 段"
        );
        // 必须提到 tool_result 内容里的 ok 字段
        assert!(
            prompt.contains("ok ===")
                || prompt.contains("\"ok\": false")
                || prompt.contains("ok 字段"),
            "铁律 v2 应引导 LLM 看 tool_result.ok 字段"
        );
        // 必须给出失败时的应对模板
        assert!(
            prompt.contains("跳转失败") || prompt.contains("失败"),
            "铁律 v2 应给出失败应对模板"
        );
        // 必须说明 navigate 失败时也是结构化 JSON
        assert!(
            prompt.contains("attempted_url") || prompt.contains("ok: false"),
            "铁律 v2 应说明 tool_result 是结构化对象"
        );
    }

    // ============================================================
    // HR5-3：resolve_tool_cwd helper（ToolContext.cwd 选取策略）
    // ============================================================

    #[test]
    fn resolve_tool_cwd_项目_scope_永远用项目根_忽略_session_cwd() {
        // 项目 scope 优先级最高：哪怕 active session cd 到别处，沙盒仍锚定项目根
        let scope = Scope::Project {
            uuid: "abc".into(),
            root_path: "/tmp/aitm".into(),
        };
        let got = resolve_tool_cwd(&scope, Some(PathBuf::from("/tmp")));
        assert_eq!(got, PathBuf::from("/tmp/aitm"));
    }

    #[test]
    fn resolve_tool_cwd_global_scope_有_session_cwd_用_session() {
        // 非项目 scope + 拿到 active session 的 shell cwd → 用 session cwd
        let scope = Scope::Global;
        let got = resolve_tool_cwd(&scope, Some(PathBuf::from("/tmp/foo")));
        assert_eq!(got, PathBuf::from("/tmp/foo"));
    }

    #[test]
    fn resolve_tool_cwd_无_session_cwd_回退_home() {
        // 没传 active_session_id / session 已关 / cwd 查不到 → HOME 兜底
        let scope = Scope::Global;
        let got = resolve_tool_cwd(&scope, None);
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
        assert_eq!(got, home);
    }

    #[test]
    fn resolve_tool_cwd_needs_init_scope_有_session_cwd_用_session() {
        // NeedsInit 还在等用户决议；run_tool_loop 一般不会跑到这分支，
        // 但为防御性测，确保 enum 全覆盖
        let scope = Scope::NeedsInit {
            cwd: "/some/path".into(),
        };
        let got = resolve_tool_cwd(&scope, Some(PathBuf::from("/tmp/bar")));
        assert_eq!(got, PathBuf::from("/tmp/bar"));
    }

    #[test]
    fn resolve_tool_cwd_session_cwd_是空路径_回退_home() {
        // 边界：sysinfo 查 cwd 返了空 PathBuf（理论几乎不会发生但防御）→ HOME 兜底
        let scope = Scope::Global;
        let got = resolve_tool_cwd(&scope, Some(PathBuf::new()));
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
        assert_eq!(got, home);
    }

    #[test]
    fn resolve_tool_cwd_session_cwd_是根目录_回退_home() {
        // 边界：cwd 解析到 "/"（很可能是 sysinfo 短路或 shell init 阶段）→ 视为不可信 → HOME
        let scope = Scope::Global;
        let got = resolve_tool_cwd(&scope, Some(PathBuf::from("/")));
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
        assert_eq!(got, home);
    }

    // ============================================================
    // HR5-2：render_runtime_context（运行时 active 块渲染）
    // ============================================================

    #[test]
    fn render_runtime_context_全_none_返回_none() {
        // 完全空 ctx：active_* 全 None + os 空 → 跳过 append
        let ctx = RuntimeContext::default();
        assert_eq!(render_runtime_context(&ctx), None);
    }

    #[test]
    fn render_runtime_context_仅_os_也会渲染() {
        // 只有 os（前端永远会传）→ render 仍输出 block（含 os 行 + 行为指引段）
        let ctx = RuntimeContext {
            os: "macos".into(),
            ..Default::default()
        };
        let out = render_runtime_context(&ctx).expect("非空 → Some");
        assert!(out.contains("操作系统：macos"));
        assert!(out.contains("行为指引"));
    }

    #[test]
    fn render_runtime_context_全字段_渲染包含三块_active() {
        let ctx = RuntimeContext {
            active_terminal: Some(ActiveTerminal {
                session_id: "sess-uuid-1".into(),
                cwd: Some("/tmp/aitm".into()),
                shell: Some("/bin/zsh".into()),
            }),
            active_browser: Some(ActiveBrowser {
                tab_id: "wv-1".into(),
                url: "https://github.com".into(),
                title: Some("GitHub".into()),
            }),
            active_editor: Some(ActiveEditor {
                path: "/tmp/aitm/src/lib.rs".into(),
                language: Some("rs".into()),
                dirty: true,
            }),
            os: "macos".into(),
        };
        let out = render_runtime_context(&ctx).expect("非空 → Some");

        // 三个块都在
        assert!(out.contains("active 终端"), "缺 active 终端块");
        assert!(out.contains("session_id: sess-uuid-1"));
        assert!(out.contains("cwd: /tmp/aitm"));
        assert!(out.contains("shell: /bin/zsh"));

        assert!(out.contains("active 浏览器 tab"));
        assert!(out.contains("tab_id: wv-1"));
        assert!(out.contains("url: https://github.com"));
        assert!(out.contains("title: GitHub"));

        assert!(out.contains("active 编辑器文件"));
        assert!(out.contains("path: /tmp/aitm/src/lib.rs"));
        assert!(out.contains("language: rs"));
        assert!(out.contains("dirty: true"));

        assert!(out.contains("操作系统：macos"));
        assert!(out.contains("行为指引"));
    }

    #[test]
    fn render_runtime_context_部分字段_缺字段输出未知占位() {
        // HR6-1：active_terminal 存在但 cwd / shell 缺失 → 输出 `(未知)` 占位
        // （而非旧版的静默吞掉——会让 LLM 看不见数据缺失，凭空猜出 `/Users/someuser`）
        let ctx = RuntimeContext {
            active_terminal: Some(ActiveTerminal {
                session_id: "sess-2".into(),
                cwd: None,
                shell: None,
            }),
            os: "linux".into(),
            ..Default::default()
        };
        let out = render_runtime_context(&ctx).expect("非空 → Some");
        assert!(out.contains("session_id: sess-2"));
        assert!(out.contains("cwd: (未知)"), "cwd 缺失应输出 `(未知)` 占位");
        assert!(out.contains("shell: (未知)"), "shell 缺失应输出 `(未知)` 占位");
        // 浏览器 / 编辑器整段未打开
        assert!(out.contains("active 浏览器 tab：(未打开"));
        assert!(out.contains("active 编辑器文件：(未打开"));
        assert!(out.contains("操作系统：linux"));
    }

    #[test]
    fn render_runtime_context_cwd_空字符串_视为未知() {
        // HR6-1：serde default 给到 Some("") 也归为"未知"，输出 `(未知)` 占位
        let ctx = RuntimeContext {
            active_terminal: Some(ActiveTerminal {
                session_id: "s".into(),
                cwd: Some("".into()),
                shell: Some("".into()),
            }),
            os: "macos".into(),
            ..Default::default()
        };
        let out = render_runtime_context(&ctx).expect("Some");
        assert!(out.contains("cwd: (未知)"));
        assert!(out.contains("shell: (未知)"));
    }

    // ============================================================
    // HR6-1：AI 幻觉 hotfix —— 缺失数据必须显式标 (未知) / (未打开)
    // ============================================================

    #[test]
    fn render_runtime_context_active_terminal_无_cwd_输出_未知占位() {
        // 真机复现：terminal 有 session_id 但 cwd=None → 输出含 `cwd: (未知)`
        // 这样模型清晰看到"cwd 数据缺失"，按铁律 v3 应调 run_command(pwd) 或说不知道
        let ctx = RuntimeContext {
            active_terminal: Some(ActiveTerminal {
                session_id: "sess-real".into(),
                cwd: None,
                shell: Some("/bin/zsh".into()),
            }),
            os: "macos".into(),
            ..Default::default()
        };
        let out = render_runtime_context(&ctx).expect("Some");
        assert!(out.contains("cwd: (未知)"), "cwd=None 应输出 `(未知)`");
        assert!(out.contains("shell: /bin/zsh"));
        assert!(out.contains("session_id: sess-real"));
    }

    #[test]
    fn render_runtime_context_无_active_terminal_输出_未打开() {
        // active_terminal=None（用户没开任何终端 tab）→ 输出明确"未打开"
        // 旧版只是不渲染终端段，模型看不到"没开"信号，会凭空猜路径
        let ctx = RuntimeContext {
            os: "macos".into(),
            ..Default::default()
        };
        let out = render_runtime_context(&ctx).expect("Some");
        assert!(
            out.contains("active 终端：(未打开"),
            "active_terminal=None 应输出 `(未打开 ...)`，实得：\n{out}"
        );
    }

    #[test]
    fn render_runtime_context_无_active_browser_输出_未打开() {
        let ctx = RuntimeContext {
            os: "macos".into(),
            ..Default::default()
        };
        let out = render_runtime_context(&ctx).expect("Some");
        assert!(
            out.contains("active 浏览器 tab：(未打开"),
            "active_browser=None 应输出 `(未打开 ...)`，实得：\n{out}"
        );
    }

    #[test]
    fn render_runtime_context_无_active_editor_输出_未打开() {
        let ctx = RuntimeContext {
            os: "macos".into(),
            ..Default::default()
        };
        let out = render_runtime_context(&ctx).expect("Some");
        assert!(
            out.contains("active 编辑器文件：(未打开"),
            "active_editor=None 应输出 `(未打开 ...)`，实得：\n{out}"
        );
    }

    #[test]
    fn render_runtime_context_含铁律_v3_关键词() {
        // 任何非空 ctx 渲染都应附"铁律 v3：禁止编造"段
        let ctx = RuntimeContext {
            os: "macos".into(),
            ..Default::default()
        };
        let out = render_runtime_context(&ctx).expect("Some");
        assert!(out.contains("铁律 v3"), "缺铁律 v3 段");
        assert!(out.contains("禁止编造"), "缺‘禁止编造’关键词");
        assert!(out.contains("永远说真话"), "缺‘永远说真话’关键词");
        assert!(
            out.contains("捏造") || out.contains("绝不"),
            "应含强调性禁止用语"
        );
    }

    #[test]
    fn runtime_context_序列化_缺字段_全部走_default() {
        // 模拟前端老客户端：只传 os 字段，其它都没有。
        // 走 serde(default) 兜底，反序列化不应失败。
        let json = r#"{"os":"macos"}"#;
        let ctx: RuntimeContext = serde_json::from_str(json).expect("deserialize");
        assert!(ctx.active_terminal.is_none());
        assert!(ctx.active_browser.is_none());
        assert!(ctx.active_editor.is_none());
        assert_eq!(ctx.os, "macos");
    }

    #[test]
    fn runtime_context_序列化_active_terminal_缺_optional_字段() {
        // active_terminal 只传 session_id，cwd / shell 缺失走 default(None)
        let json = r#"{
            "active_terminal": {"session_id": "abc"},
            "os": "macos"
        }"#;
        let ctx: RuntimeContext = serde_json::from_str(json).expect("deserialize");
        let term = ctx.active_terminal.expect("present");
        assert_eq!(term.session_id, "abc");
        assert!(term.cwd.is_none());
        assert!(term.shell.is_none());
    }

    #[test]
    fn chat_send_args_无_runtime_context_字段_反序列化_正常() {
        // 老客户端不传 runtime_context 字段 → ChatSendArgs::runtime_context = None
        let json = r#"{
            "conversation_id": "cid-1",
            "provider_id": "anthropic",
            "model": "claude-3-5-sonnet",
            "messages": []
        }"#;
        let args: ChatSendArgs = serde_json::from_str(json).expect("deserialize");
        assert!(args.runtime_context.is_none());
    }

    #[test]
    fn chat_send_args_有_runtime_context_字段_反序列化_正常() {
        // 新客户端传 runtime_context → 解析为 Some(RuntimeContext)，子字段对得上
        let json = r#"{
            "conversation_id": "cid-1",
            "provider_id": "anthropic",
            "model": "claude-3-5-sonnet",
            "messages": [],
            "runtime_context": {
                "active_terminal": {
                    "session_id": "sess-uuid-1",
                    "cwd": "/tmp"
                },
                "os": "macos"
            }
        }"#;
        let args: ChatSendArgs = serde_json::from_str(json).expect("deserialize");
        let rc = args.runtime_context.expect("present");
        let term = rc.active_terminal.expect("active_terminal present");
        assert_eq!(term.session_id, "sess-uuid-1");
        assert_eq!(term.cwd.as_deref(), Some("/tmp"));
        assert_eq!(rc.os, "macos");
    }
}
