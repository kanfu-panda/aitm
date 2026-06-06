//! 应用设置（用户配置 TOML）。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub mod store;

/// 应用设置 —— 用户可以在设置 UI 改的所有字段。
///
/// 所有字段都有合理默认；toml 解析时缺字段自动用默认值（serde default）。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct AppSettings {
    pub terminal: TerminalSettings,
    pub shell: ShellSettings,
    pub providers: ProvidersSettings,
    pub safety: SafetySettings,
    pub browser: BrowserSettings,
    /// v0.4.1：UI 体系化设置（ActivityBar 位置 / 主题模式等）。
    pub ui: UiSettings,
    /// v0.5.0-A：通知系统设置（系统通知声音开关等）。
    pub notifications: NotificationSettings,
    /// v0.7.0-A：隐私 / 匿名使用统计相关设置。
    pub privacy: PrivacySettings,
    /// v0.9.0 T5b：文件编辑器 tab 状态持久化。
    pub editor: EditorSettings,
}

/// 终端外观与渲染。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct TerminalSettings {
    /// 字体族 CSS 列表。
    pub font_family: String,
    /// 字号（px）。
    pub font_size: u16,
    /// 行高倍数（1.0-2.0）。
    pub line_height: f32,
    /// 光标样式。
    pub cursor_style: CursorStyle,
    /// 主题 ID（前端 `src/lib/themes.ts` 的 `THEMES` 注册表里取）。
    /// 默认 `"default"` 即当前 zinc-950 黑底；其他预设：
    /// `"dracula"` / `"solarized-dark"` / `"solarized-light"` / `"one-dark"`。
    /// 后端不验证 ID 合法性，前端 `getTheme(id)` 找不到时 fallback 到默认。
    pub theme: String,
}

/// Shell 启动配置。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct ShellSettings {
    /// 默认 shell 路径覆盖。空字符串表示用 $SHELL。
    pub default_shell: String,
}

/// LLM provider 配置集合。
///
/// 用 `#[serde(transparent)]` 让 `[providers.<id>]` 直接映射到 `map`，
/// toml 落地形如：
///
/// ```toml
/// [providers.qwen]
/// enabled = true
/// api_key = "sk-..."
/// base_url = "..."
/// ```
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(transparent)]
pub struct ProvidersSettings {
    /// key 是 provider id（"anthropic" / "deepseek" / "qwen" / "zhipu" / "moonshot" / "openai"）。
    pub map: HashMap<String, ProviderConfig>,
}

/// 单个 provider 的可编辑字段。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct ProviderConfig {
    /// 是否启用该 provider。默认启用。
    pub enabled: bool,
    /// API 密钥（明文存 `~/.aitm/config.toml`，文件权限 0600）。
    pub api_key: String,
    /// 自定义 base_url，空字符串表示用 registry 默认值。
    pub base_url: String,
}

impl Default for ProviderConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            api_key: String::new(),
            base_url: String::new(),
        }
    }
}

/// 安全门相关设置（L3 白名单 + UI 显示开关）。
///
/// L1 黑名单和 L2 启发式风险评分都是后端硬编码逻辑，不暴露在配置里；
/// 这里只配可由用户主动信任 / 调整的部分：
///
/// - `whitelist`：glob 模式列表（如 `"git status *"` / `"ls *"`），命中的
///   `run_command` 会从 HIGH 降为 LOW（自动批准）。**不影响 DESTRUCTIVE**
///   ——哪怕白名单里写了 `git *`，`git push --force` 仍走 destructive 弹窗。
/// - `show_low_auto_approved`：LOW 风险工具自动批准时是否在 UI 气泡上
///   显示徽章（默认 false，避免噪音；老 维护者 可以打开看每条自动批是为啥）。
///
/// toml 形如：
///
/// ```toml
/// [safety]
/// whitelist = ["git status *", "ls *"]
/// show_low_auto_approved = true
/// ```
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct SafetySettings {
    /// glob 模式列表，匹配的 run_command 自动批准（HIGH→LOW）。
    /// 不影响 DESTRUCTIVE：哪怕 'git *' 命中 'git push --force' 仍弹 destructive 弹窗。
    pub whitelist: Vec<String>,
    /// LOW 风险工具自动批准时是否在 UI 气泡上显示徽章。
    pub show_low_auto_approved: bool,
}

/// Phase 4A T5：内嵌浏览器（embedded browser）相关配置。
///
/// 控制前端 [`browserSuspend`] 自动 suspend 策略的两个参数：
///
/// - `max_active_tabs`：同时可 active 的 webview 上限；超过 → LRU 起最旧的
///   非 pinned 非 active tab 起 suspend。默认 3，硬上限 10（防止内存爆炸）。
/// - `suspend_timer_minutes`：失焦超过该分钟数自动 suspend；默认 5；最小 1
///   最大 60（前端 BrowserSettingsSection input 的 min/max 一致）。
///
/// toml 形如：
///
/// ```toml
/// [browser]
/// max_active_tabs = 3
/// suspend_timer_minutes = 5
/// ```
///
/// 后端不验证字段范围，前端 UI 限制 input 范围；如果用户手改 toml 越界，
/// 前端 startBrowserSuspendTimer 直接按越界值跑（不致命，最多内存占用变化）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct BrowserSettings {
    /// 同时 active 的 webview 上限（超出 → LRU 自动 suspend）。默认 3。
    pub max_active_tabs: u32,
    /// 失焦多少分钟自动 suspend。默认 5。
    pub suspend_timer_minutes: u32,
}

impl Default for BrowserSettings {
    fn default() -> Self {
        Self {
            max_active_tabs: 3,
            suspend_timer_minutes: 5,
        }
    }
}

/// v0.4.1：UI 体系化相关设置。
///
/// 当前字段：
///
/// - `activity_bar_position`：4 向（`right` / `left` / `top` / `bottom`），默认 `right`。
/// - `theme_mode`：主题模式（`auto` / `dark` / `light`），默认 `dark`。T5 加。
/// - `file_tree_width` / `ai_sidebar_width`：v0.6.0-A 两侧栏宽度（px），默认 240 / 360，
///   IPC 层 clamp 到 `[180, 600]`。
/// - `file_preview_dialog`：v0.6.0-A FilePreviewDialog 上次位置 + 尺寸；
///   `None` 表示首次打开（前端居中 + 默认尺寸）。
///
/// toml 形如：
///
/// ```toml
/// [ui]
/// activity_bar_position = "right"
/// theme_mode = "dark"
/// file_tree_width = 240
/// ai_sidebar_width = 360
///
/// [ui.file_preview_dialog]
/// x = 100.0
/// y = 100.0
/// w = 800.0
/// h = 600.0
/// ```
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct UiSettings {
    /// ActivityBar 摆放位置；默认 `right`。
    pub activity_bar_position: ActivityBarPosition,
    /// v0.4.1 T5：主题模式（auto 跟随系统 / dark 强制暗色 / light 强制亮色）；默认 `dark`。
    pub theme_mode: ThemeMode,
    /// v0.5.0-B：AI 侧栏位置；默认 `right`（保持 v0.5.0-A 行为）。
    pub ai_sidebar_position: SidePanelPosition,
    /// v0.5.0-B：文件树位置；默认 `left`（保持 v0.5.0-A 行为）。
    pub file_tree_position: SidePanelPosition,
    /// v0.6.0-A：FileTree 宽度（px）；默认 240。
    /// IPC 层 `settings_update` clamp 到 `[180, 600]`；settings 自身存裸值。
    pub file_tree_width: u32,
    /// v0.6.0-A：AiSidebar 宽度（px）；默认 360。
    /// IPC 层 `settings_update` clamp 到 `[180, 600]`；settings 自身存裸值。
    pub ai_sidebar_width: u32,
    /// v0.6.0-A：FilePreviewDialog 上次位置 + 尺寸。
    /// `None` 表示首次打开（前端居中 + 默认尺寸 800×600）；
    /// `Some(rect)` 表示用户拖/缩放过，保留上次状态。
    /// `#[serde(skip_serializing_if = "Option::is_none")]` 让 None 时 toml 不写该字段。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_preview_dialog: Option<DialogRect>,
    /// v0.9.0 T4：关闭应用时是否弹"确认退出"对话框；默认 `true`。
    ///
    /// 关掉之后红叉 / Cmd+Q 直接退出，跟 v0.8.x 之前行为一致；
    /// 老 toml 缺该字段时 `#[serde(default = "default_true_confirm_quit")]`
    /// 兜底回 true（升级用户默认开启二次确认，避免误关丢工作）。
    #[serde(default = "default_true_confirm_quit")]
    pub confirm_quit: bool,
    /// v0.10.0 HR6-3e：分屏 layout tree 跨重启持久化（整棵 LayoutNode 树的
    /// JSON 字符串）。
    ///
    /// **为什么序列化成字符串塞 TOML 而不是嵌套结构？**
    ///
    /// LayoutNode 是嵌套二叉树（leaf | split{left, right}）+ tagged enum
    /// （`kind: "leaf" | "split"`），TOML 表达递归 enum 非常笨拙（每层都要
    /// 显式表名）。前端 zustand store 也是用 JSON.stringify/JSON.parse 维护，
    /// 直接传 JSON 字符串最稳定 —— 后端只当不透明 blob 存盘，不解析。
    ///
    /// - `None` / 空字符串 → 启动时前端 fallback 到默认单 leaf
    ///   （`makeDefaultRoot()`）；HR6-3c 现有"灌 tabs 进 INITIAL_GROUP"逻辑
    ///   接管。
    /// - `Some(json)` → 前端 JSON.parse 后跑 `sanitizeLayout` 过滤已关 tab
    ///   的失效 id，再 `resetLayout` 灌进 store。
    ///
    /// 老 toml 缺该字段时 `#[serde(default)]` → `None`，行为等同首次启动。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_layout: Option<String>,
    /// v0.10.0 HR7-7：用户自定义快捷键覆盖。
    ///
    /// - **key** = action 名（前端 `ActionName`，如 `"newTab"` / `"closePane"`）
    /// - **value** = 快捷键描述字符串（如 `"Cmd+T"` / `"Ctrl+Shift+W"` / `"Cmd+\\"` / `"Cmd+,"`）
    ///
    /// 缺失的 action 走前端 `DEFAULT_KEYBINDINGS`；只存"用户改过"的覆盖项，
    /// 默认值不入盘以避免老 toml 升级写一堆冗余。
    ///
    /// 后端不解析快捷键字符串，仅当不透明 blob 存盘 + 转发；前端
    /// `parseKeybinding` 负责解析 + 校验。
    ///
    /// 老 toml 缺该字段时 `#[serde(default)]` → 空 map，行为等同未覆盖。
    pub keybindings: HashMap<String, String>,
    /// v0.10.4：UI 显示语言（i18n）。值是 BCP 47 / IETF locale 代码：
    /// 当前支持 `"en"` / `"zh-CN"` / `"ja"`；默认 `"en"`。
    /// 老 toml 缺字段时 `#[serde(default = "default_language")]` → "en"。
    /// 前端 i18next 启动时读这个，运行时切换会通过 settings_update 同步回来。
    #[serde(default = "default_language")]
    pub language: String,
}

/// v0.10.4：language 字段默认 "en"。
fn default_language() -> String {
    "en".to_string()
}

/// v0.9.0 T4：`UiSettings.confirm_quit` 的字段级 serde default。
///
/// 为啥要单独一个函数：bool 的 serde default 默认是 `false`，
/// 直接 `#[serde(default)]` 无法表达"老 toml 缺字段时回 true"——必须
/// 用 `default = "fn_name"` 走自定义函数返 true。
fn default_true_confirm_quit() -> bool {
    true
}

impl Default for UiSettings {
    fn default() -> Self {
        Self {
            activity_bar_position: ActivityBarPosition::Right,
            theme_mode: ThemeMode::Dark,
            ai_sidebar_position: SidePanelPosition::Right,
            file_tree_position: SidePanelPosition::Left,
            file_tree_width: 240,
            ai_sidebar_width: 360,
            file_preview_dialog: None,
            confirm_quit: true,
            pane_layout: None,
            keybindings: HashMap::new(),
            language: default_language(),
        }
    }
}

/// v0.6.0-A：浮动 Dialog 的位置 + 尺寸（CSS px，左上角原点）。
///
/// 用 `f32` 而非 `u32`：浏览器 `window.innerWidth/Height` 可能返回小数（高 DPI / 缩放），
/// `getBoundingClientRect` 也返回小数，避免 round-trip 损失精度。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct DialogRect {
    /// 左上角 X 坐标（px）。
    pub x: f32,
    /// 左上角 Y 坐标（px）。
    pub y: f32,
    /// 宽度（px）。
    pub w: f32,
    /// 高度（px）。
    pub h: f32,
}

/// v0.5.0-B：AI 侧栏 / 文件树左右位置。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SidePanelPosition {
    Left,
    Right,
}

/// v0.5.0-A：通知系统设置。
///
/// - `sound`：系统通知触发时是否带 macOS 默认提示音（NSUserNotification sound）。
///   默认 `true`（维护者 决策，能通知到但不打扰）。
///
/// toml 形如：
///
/// ```toml
/// [notifications]
/// sound = true
/// ```
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct NotificationSettings {
    /// 系统通知是否带声音。默认开。
    pub sound: bool,
}

impl Default for NotificationSettings {
    fn default() -> Self {
        Self { sound: true }
    }
}

/// v0.7.0-A：隐私 / 匿名使用统计设置。
///
/// - `analytics_opt_in`：是否参与 Aptabase 匿名使用统计；默认 `true`（启动即上报）。
///   关掉之后前端 wrapper `src/lib/analytics.ts::trackEvent` 会静默丢弃事件。
///   注意：Rust 侧 `app_started` / `app_exited` 不走前端 wrapper，不受该字段影响
///   （这两条没有 PII，且 Aptabase 推荐至少上报 startup/exit）。
///
/// 老 toml 缺 `[privacy]` 时 `#[serde(default)]` 兜底到默认 `true`：意味着升级
/// 老用户默认参与上报。若用户介意可去 Settings 关掉。
///
/// toml 形如：
///
/// ```toml
/// [privacy]
/// analytics_opt_in = true
/// ```
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct PrivacySettings {
    /// 是否参与匿名使用统计；默认开。
    pub analytics_opt_in: bool,
}

impl Default for PrivacySettings {
    fn default() -> Self {
        Self {
            analytics_opt_in: true,
        }
    }
}

/// v0.9.0 T5b：文件编辑器 tab 状态持久化。
///
/// CodeMirror 文件编辑器（T5a-T5e）的跨重启状态：
///
/// - `open_files`：当前打开 tab 的文件**绝对路径**列表，顺序与 UI tab 顺序一致。
///   重启时按列表顺序逐个 `openFile()` 恢复 tab。文件已被删除时单文件 reopen
///   失败，前端 store 静默跳过（不阻塞其他 tab 恢复）。
/// - `active_file`：上次会话最后激活的文件路径；不在 `open_files` 内时回退到
///   列表首项；列表为空时为 None。
///
/// **不存** dirty buffer（未保存的修改）—— 编辑器关闭即弃，避免持久化打开任意
/// 文件时把未提交内容静默写盘。Cmd+W 关 tab 时 dirty 文件由 UI 弹保存确认。
///
/// 老 toml 缺 `[editor]` 段时 `#[serde(default)]` 让整段降级到 `EditorSettings::default()`，
/// 即 open_files 空列表 + active_file None；旧用户升级后首次启动右侧编辑器
/// 工作区不展开（默认 0 高度，跟 v0.8.x 行为一致）。
///
/// toml 形如：
///
/// ```toml
/// [editor]
/// open_files = ["/Users/leo/proj/foo.ts", "/Users/leo/proj/README.md"]
/// active_file = "/Users/leo/proj/README.md"
/// ```
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct EditorSettings {
    /// 当前打开 tab 的文件绝对路径列表（顺序 = UI tab 顺序）。
    pub open_files: Vec<String>,
    /// 上次激活的文件路径；不在 `open_files` 内时前端回退到首项。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_file: Option<String>,
    /// v0.10.6 T4：CodeMirror 字号（px，整数）。
    ///
    /// 默认 13，与 `TerminalSettings.font_size` 对齐。前端 `clampFontSize` 限制 10..24；
    /// 后端只存原始 u16 数值，不做范围校验（用户手改 TOML 写 999 也能反序列化成功，
    /// 由前端渲染时 clamp 兜底，避免反序列化失败导致整份配置丢失）。
    #[serde(default = "default_editor_font_size")]
    pub font_size: u16,
}

fn default_editor_font_size() -> u16 {
    13
}

impl Default for EditorSettings {
    fn default() -> Self {
        Self {
            open_files: Vec::new(),
            active_file: None,
            font_size: default_editor_font_size(),
        }
    }
}

/// ActivityBar 4 向位置。
///
/// 与前端 `src/components/ActivityBar/constants.ts` 的 `ActivityBarPosition`
/// 类型 mirror。`#[serde(rename_all = "kebab-case")]` 让 toml/JSON 落地为
/// 小写字符串（`"right"` 而不是 `"Right"`）。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ActivityBarPosition {
    Right,
    Left,
    Top,
    Bottom,
}

/// v0.4.1 T5：主题模式三态。
///
/// - `Auto`：跟随系统 `prefers-color-scheme`（浏览器 / OS 切换 dark/light 时自动跟切）
/// - `Dark`：强制暗色（v0.4.0 既有体验）
/// - `Light`：强制亮色（v0.4.1 新增）
///
/// 默认值 `Dark`：aitm 终端用户偏好暗色，避免老用户升级后第一眼"我的色调怎么变了"。
///
/// 与前端 `src/lib/theme.ts` 的 `ThemeMode` 类型 mirror。`#[serde(rename_all =
/// "lowercase")]` 让 toml/JSON 落地为 `"dark"` / `"light"` / `"auto"`。
///
/// `#[default]` 标 `Dark`：aitm 终端用户偏好暗色，避免老用户升级后第一眼"我的色调怎么变了"。
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ThemeMode {
    Auto,
    #[default]
    Dark,
    Light,
}

/// xterm 支持的光标样式。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CursorStyle {
    Block,
    Underline,
    Bar,
}

impl Default for TerminalSettings {
    fn default() -> Self {
        Self {
            // v0.9.0 T1：字体链改为 JetBrains Mono 优先（字面高度大、对比度好；
            // 对照 Terax 终端视觉提升）。
            // 跨平台 fallback 链（浏览器按顺序找第一个可用字体）：
            // - 首选：JetBrains Mono（开发者主流字体，开源；用户自装或前端嵌入版可命中）
            // - macOS：SF Mono（系统自带）→ Menlo（系统自带）
            // - Windows：Consolas（系统自带）→ Cascadia Code（Win11 自带；Win10 装了 Terminal/VSCode 也有）
            // - 终极兜底：Courier New（几乎所有 OS 都有）→ monospace（CSS 关键字）
            font_family: "'JetBrains Mono', 'SF Mono', Menlo, Consolas, 'Cascadia Code', 'Courier New', monospace".to_string(),
            font_size: 13,
            // v0.9.0 T1：行高 1.2 → 1.5，更松、对照 Terax 视觉。
            line_height: 1.5,
            cursor_style: CursorStyle::Block,
            theme: "default".to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 默认设置往返序列化() {
        let s = AppSettings::default();
        let toml_str = toml::to_string(&s).unwrap();
        let back: AppSettings = toml::from_str(&toml_str).unwrap();
        assert_eq!(s, back);
    }

    #[test]
    fn 默认字号为_13() {
        assert_eq!(AppSettings::default().terminal.font_size, 13);
    }

    #[test]
    fn 默认光标为_block() {
        assert_eq!(AppSettings::default().terminal.cursor_style, CursorStyle::Block);
    }

    #[test]
    fn 缺字段_toml_用默认值填充() {
        // 只指定 font_size，其他字段应该用默认值
        let toml_str = r#"
[terminal]
font_size = 16
"#;
        let s: AppSettings = toml::from_str(toml_str).unwrap();
        assert_eq!(s.terminal.font_size, 16);
        assert!((s.terminal.line_height - 1.5).abs() < 1e-6); // 默认（v0.9.0 T1：1.2 → 1.5）
        assert_eq!(s.terminal.cursor_style, CursorStyle::Block); // 默认
        assert_eq!(s.terminal.theme, "default"); // 1G：默认主题
    }

    #[test]
    fn 默认主题为_default() {
        assert_eq!(AppSettings::default().terminal.theme, "default");
    }

    #[test]
    fn theme_字段往返序列化() {
        let mut s = AppSettings::default();
        s.terminal.theme = "dracula".to_string();
        let toml_str = toml::to_string(&s).unwrap();
        assert!(toml_str.contains("theme = \"dracula\""));
        let back: AppSettings = toml::from_str(&toml_str).unwrap();
        assert_eq!(back.terminal.theme, "dracula");
    }

    #[test]
    fn 老_toml_无_theme_字段_仍能解析() {
        // 1G 之前的 config.toml 没有 theme 字段
        let toml_str = r#"
[terminal]
font_family = "Menlo"
font_size = 14
line_height = 1.3
cursor_style = "underline"
"#;
        let s: AppSettings = toml::from_str(toml_str).unwrap();
        assert_eq!(s.terminal.theme, "default", "缺字段应用默认 'default'");
        assert_eq!(s.terminal.font_size, 14);
    }

    #[test]
    fn cursor_style_序列化为_kebab_case() {
        let json = serde_json::to_string(&CursorStyle::Underline).unwrap();
        assert_eq!(json, "\"underline\"");
        let bar: CursorStyle = serde_json::from_str("\"bar\"").unwrap();
        assert_eq!(bar, CursorStyle::Bar);
    }

    #[test]
    fn providers_默认空() {
        assert!(AppSettings::default().providers.map.is_empty());
    }

    #[test]
    fn provider_config_默认_enabled_true() {
        let pc = ProviderConfig::default();
        assert!(pc.enabled);
        assert_eq!(pc.api_key, "");
        assert_eq!(pc.base_url, "");
    }

    #[test]
    fn 往返序列化_含_providers_section() {
        let mut s = AppSettings::default();
        s.providers.map.insert(
            "qwen".into(),
            ProviderConfig {
                enabled: true,
                api_key: "sk-test".into(),
                base_url: "https://example.com/v1".into(),
            },
        );
        let toml_str = toml::to_string(&s).unwrap();
        // 关键断言：必须落地为嵌套表 [providers.qwen]，
        // 而不是 [providers.map.qwen] 或 inline 形式。
        assert!(
            toml_str.contains("[providers.qwen]"),
            "实际 toml:\n{}",
            toml_str
        );
        let back: AppSettings = toml::from_str(&toml_str).unwrap();
        assert_eq!(s, back);
    }

    #[test]
    fn 老_toml_无_providers_section_兼容() {
        // 模拟早期 config.toml（只有 [terminal]），应能解析且 providers.map 为空。
        let toml_str = r#"
[terminal]
font_size = 14
"#;
        let s: AppSettings = toml::from_str(toml_str).unwrap();
        assert_eq!(s.terminal.font_size, 14);
        assert!(s.providers.map.is_empty());
    }

    #[test]
    fn safety_settings_默认值() {
        let s = SafetySettings::default();
        assert!(s.whitelist.is_empty());
        assert!(!s.show_low_auto_approved);
    }

    #[test]
    fn appsettings_默认含空_safety() {
        let s = AppSettings::default();
        assert!(s.safety.whitelist.is_empty());
        assert!(!s.safety.show_low_auto_approved);
    }

    #[test]
    fn 老_toml_无_safety_section_兼容() {
        // 模拟早期 config.toml（只有 [terminal]），
        // 应能解析且 safety 全是默认值（whitelist 空 / show_low false）。
        // serde(default) 在 AppSettings 上的关键作用：缺整段 section 也不报错。
        let toml_str = r#"
[terminal]
font_size = 14
"#;
        let s: AppSettings = toml::from_str(toml_str).unwrap();
        assert_eq!(s.terminal.font_size, 14);
        assert!(s.safety.whitelist.is_empty());
        assert!(!s.safety.show_low_auto_approved);
    }

    #[test]
    fn 往返序列化_含_safety_section() {
        let mut s = AppSettings::default();
        s.safety.whitelist.push("git status *".to_string());
        s.safety.whitelist.push("ls *".to_string());
        s.safety.show_low_auto_approved = true;

        let toml_str = toml::to_string(&s).unwrap();
        // 关键断言：必须落地为顶层 [safety] 段，不是 [safety.map] 或 inline。
        assert!(
            toml_str.contains("[safety]"),
            "实际 toml:\n{}",
            toml_str
        );
        // whitelist 应该是数组形式
        assert!(
            toml_str.contains("whitelist"),
            "实际 toml:\n{}",
            toml_str
        );
        assert!(
            toml_str.contains("show_low_auto_approved"),
            "实际 toml:\n{}",
            toml_str
        );

        let back: AppSettings = toml::from_str(&toml_str).unwrap();
        assert_eq!(s, back);
    }

    #[test]
    fn 默认_safety_序列化能反序列化回来() {
        // 默认值（whitelist 空 / show_low false）落 toml 后再读回来不应崩；
        // 即使 [safety] 段里 whitelist 是空数组也要兼容。
        let s = AppSettings::default();
        let toml_str = toml::to_string(&s).unwrap();
        let back: AppSettings = toml::from_str(&toml_str).unwrap();
        assert_eq!(s, back);
        assert!(back.safety.whitelist.is_empty());
        assert!(!back.safety.show_low_auto_approved);
    }

    #[test]
    fn safety_whitelist_多条_pattern_顺序保持() {
        let mut s = AppSettings::default();
        s.safety.whitelist = vec![
            "git status *".to_string(),
            "ls *".to_string(),
            "pnpm test *".to_string(),
            "cargo --version".to_string(),
        ];

        let toml_str = toml::to_string(&s).unwrap();
        let back: AppSettings = toml::from_str(&toml_str).unwrap();
        // Vec<String> 必须保持顺序（不像 HashMap）
        assert_eq!(
            back.safety.whitelist,
            vec![
                "git status *".to_string(),
                "ls *".to_string(),
                "pnpm test *".to_string(),
                "cargo --version".to_string(),
            ]
        );
    }

    #[test]
    fn 老_toml_只有_safety_缺_whitelist_字段_兼容() {
        // 用户手改 config.toml 可能只写了 show_low_auto_approved = true 一项；
        // SafetySettings 上的 #[serde(default)] 必须让缺字段降级到默认值（空 vec）。
        let toml_str = r#"
[safety]
show_low_auto_approved = true
"#;
        let s: AppSettings = toml::from_str(toml_str).unwrap();
        assert!(s.safety.whitelist.is_empty());
        assert!(s.safety.show_low_auto_approved);
    }

    // ===== Phase 4A T5：BrowserSettings =====

    #[test]
    fn browser_settings_默认值() {
        let s = BrowserSettings::default();
        assert_eq!(s.max_active_tabs, 3);
        assert_eq!(s.suspend_timer_minutes, 5);
    }

    #[test]
    fn appsettings_默认含_browser_默认值() {
        let s = AppSettings::default();
        assert_eq!(s.browser.max_active_tabs, 3);
        assert_eq!(s.browser.suspend_timer_minutes, 5);
    }

    #[test]
    fn 老_toml_无_browser_section_兼容() {
        // 模拟 v0.3.x 之前的 config.toml（无 [browser] 段）；
        // serde(default) 在 AppSettings 上让缺整段也能解析。
        let toml_str = r#"
[terminal]
font_size = 14
"#;
        let s: AppSettings = toml::from_str(toml_str).unwrap();
        assert_eq!(s.terminal.font_size, 14);
        assert_eq!(s.browser.max_active_tabs, 3);
        assert_eq!(s.browser.suspend_timer_minutes, 5);
    }

    #[test]
    fn 老_toml_只有_browser_缺_max_active_字段_兼容() {
        // 用户只写了 suspend_timer_minutes 一项；
        // BrowserSettings 上的 #[serde(default)] 必须让缺字段降级到默认值。
        let toml_str = r#"
[browser]
suspend_timer_minutes = 10
"#;
        let s: AppSettings = toml::from_str(toml_str).unwrap();
        assert_eq!(s.browser.max_active_tabs, 3); // 默认
        assert_eq!(s.browser.suspend_timer_minutes, 10);
    }

    #[test]
    fn 往返序列化_含_browser_section() {
        let mut s = AppSettings::default();
        s.browser.max_active_tabs = 5;
        s.browser.suspend_timer_minutes = 10;

        let toml_str = toml::to_string(&s).unwrap();
        assert!(
            toml_str.contains("[browser]"),
            "实际 toml:\n{}",
            toml_str
        );
        assert!(toml_str.contains("max_active_tabs = 5"));
        assert!(toml_str.contains("suspend_timer_minutes = 10"));

        let back: AppSettings = toml::from_str(&toml_str).unwrap();
        assert_eq!(s, back);
    }

    #[test]
    fn 默认_browser_序列化能反序列化回来() {
        let s = AppSettings::default();
        let toml_str = toml::to_string(&s).unwrap();
        let back: AppSettings = toml::from_str(&toml_str).unwrap();
        assert_eq!(s, back);
        assert_eq!(back.browser.max_active_tabs, 3);
        assert_eq!(back.browser.suspend_timer_minutes, 5);
    }

    // ===== v0.4.1 T2：UiSettings.activity_bar_position =====

    #[test]
    fn ui_settings_默认值() {
        let s = UiSettings::default();
        assert_eq!(s.activity_bar_position, ActivityBarPosition::Right);
    }

    #[test]
    fn appsettings_默认含_ui_默认值() {
        let s = AppSettings::default();
        assert_eq!(s.ui.activity_bar_position, ActivityBarPosition::Right);
    }

    #[test]
    fn 老_toml_无_ui_section_兼容() {
        // v0.4.0 之前 config.toml 没有 [ui]；serde(default) 必须兜底。
        let toml_str = r#"
[terminal]
font_size = 14
"#;
        let s: AppSettings = toml::from_str(toml_str).unwrap();
        assert_eq!(s.terminal.font_size, 14);
        assert_eq!(s.ui.activity_bar_position, ActivityBarPosition::Right);
    }

    #[test]
    fn activity_bar_position_序列化为_kebab_case() {
        let json = serde_json::to_string(&ActivityBarPosition::Right).unwrap();
        assert_eq!(json, "\"right\"");
        let bottom: ActivityBarPosition = serde_json::from_str("\"bottom\"").unwrap();
        assert_eq!(bottom, ActivityBarPosition::Bottom);
    }

    #[test]
    fn 往返序列化_含_ui_section() {
        let mut s = AppSettings::default();
        s.ui.activity_bar_position = ActivityBarPosition::Bottom;

        let toml_str = toml::to_string(&s).unwrap();
        assert!(
            toml_str.contains("[ui]"),
            "实际 toml:\n{}",
            toml_str
        );
        assert!(
            toml_str.contains("activity_bar_position = \"bottom\""),
            "实际 toml:\n{}",
            toml_str
        );

        let back: AppSettings = toml::from_str(&toml_str).unwrap();
        assert_eq!(s, back);
    }

    #[test]
    fn 老_toml_只有_ui_缺_activity_bar_position_字段_兼容() {
        // 用户在 [ui] 里只写了别的字段（未来 T5 会加 theme_mode）；
        // UiSettings 上的 #[serde(default)] 必须让缺字段降级到默认值。
        let toml_str = r#"
[ui]
"#;
        let s: AppSettings = toml::from_str(toml_str).unwrap();
        assert_eq!(s.ui.activity_bar_position, ActivityBarPosition::Right);
    }

    #[test]
    fn 默认_ui_序列化能反序列化回来() {
        let s = AppSettings::default();
        let toml_str = toml::to_string(&s).unwrap();
        let back: AppSettings = toml::from_str(&toml_str).unwrap();
        assert_eq!(s, back);
        assert_eq!(back.ui.activity_bar_position, ActivityBarPosition::Right);
    }

    #[test]
    fn 全部_4_向_position_往返一致() {
        for pos in [
            ActivityBarPosition::Right,
            ActivityBarPosition::Left,
            ActivityBarPosition::Top,
            ActivityBarPosition::Bottom,
        ] {
            let mut s = AppSettings::default();
            s.ui.activity_bar_position = pos;
            let toml_str = toml::to_string(&s).unwrap();
            let back: AppSettings = toml::from_str(&toml_str).unwrap();
            assert_eq!(back.ui.activity_bar_position, pos);
        }
    }

    // ===== v0.4.1 T5：UiSettings.theme_mode =====

    #[test]
    fn theme_mode_默认为_dark() {
        let s = ThemeMode::default();
        assert_eq!(s, ThemeMode::Dark);
    }

    #[test]
    fn ui_settings_默认_theme_mode_为_dark() {
        let s = UiSettings::default();
        assert_eq!(s.theme_mode, ThemeMode::Dark);
    }

    #[test]
    fn appsettings_默认含_ui_theme_mode_dark() {
        let s = AppSettings::default();
        assert_eq!(s.ui.theme_mode, ThemeMode::Dark);
    }

    #[test]
    fn theme_mode_序列化为_lowercase() {
        // serde rename_all = "lowercase" 应让三个变体落地为小写字符串
        assert_eq!(serde_json::to_string(&ThemeMode::Auto).unwrap(), "\"auto\"");
        assert_eq!(serde_json::to_string(&ThemeMode::Dark).unwrap(), "\"dark\"");
        assert_eq!(serde_json::to_string(&ThemeMode::Light).unwrap(), "\"light\"");

        let auto: ThemeMode = serde_json::from_str("\"auto\"").unwrap();
        assert_eq!(auto, ThemeMode::Auto);
        let light: ThemeMode = serde_json::from_str("\"light\"").unwrap();
        assert_eq!(light, ThemeMode::Light);
    }

    #[test]
    fn theme_mode_自定义_light_往返序列化() {
        let mut s = AppSettings::default();
        s.ui.theme_mode = ThemeMode::Light;

        let toml_str = toml::to_string(&s).unwrap();
        assert!(
            toml_str.contains("theme_mode = \"light\""),
            "实际 toml:\n{}",
            toml_str
        );

        let back: AppSettings = toml::from_str(&toml_str).unwrap();
        assert_eq!(back.ui.theme_mode, ThemeMode::Light);
    }

    #[test]
    fn theme_mode_自定义_auto_往返序列化() {
        let mut s = AppSettings::default();
        s.ui.theme_mode = ThemeMode::Auto;

        let toml_str = toml::to_string(&s).unwrap();
        assert!(toml_str.contains("theme_mode = \"auto\""));

        let back: AppSettings = toml::from_str(&toml_str).unwrap();
        assert_eq!(back.ui.theme_mode, ThemeMode::Auto);
    }

    #[test]
    fn 老_toml_无_theme_mode_字段_兼容() {
        // T2 时代 [ui] 段只有 activity_bar_position；T5 加 theme_mode 后老 toml 必须仍能解析。
        // UiSettings 上的 #[serde(default)] 让缺字段降级到默认 Dark。
        let toml_str = r#"
[ui]
activity_bar_position = "left"
"#;
        let s: AppSettings = toml::from_str(toml_str).unwrap();
        assert_eq!(s.ui.activity_bar_position, ActivityBarPosition::Left);
        assert_eq!(s.ui.theme_mode, ThemeMode::Dark, "缺 theme_mode 应默认 dark");
    }

    #[test]
    fn 老_toml_完全无_ui_section_含_theme_mode_默认() {
        // 更老的 v0.4.0 之前 toml，连 [ui] 段都没；
        // 顶层 AppSettings 上的 #[serde(default)] 让整段降级到 UiSettings::default()。
        let toml_str = r#"
[terminal]
font_size = 14
"#;
        let s: AppSettings = toml::from_str(toml_str).unwrap();
        assert_eq!(s.ui.theme_mode, ThemeMode::Dark);
        assert_eq!(s.ui.activity_bar_position, ActivityBarPosition::Right);
    }

    #[test]
    fn 全部_3_态_theme_mode_往返一致() {
        for mode in [ThemeMode::Auto, ThemeMode::Dark, ThemeMode::Light] {
            let mut s = AppSettings::default();
            s.ui.theme_mode = mode;
            let toml_str = toml::to_string(&s).unwrap();
            let back: AppSettings = toml::from_str(&toml_str).unwrap();
            assert_eq!(back.ui.theme_mode, mode);
        }
    }

    #[test]
    fn 默认_ui_含_theme_mode_序列化能反序列化回来() {
        // 跟既有 默认_ui_序列化能反序列化回来 测试一组：保 default 等价。
        let s = AppSettings::default();
        let toml_str = toml::to_string(&s).unwrap();
        let back: AppSettings = toml::from_str(&toml_str).unwrap();
        assert_eq!(s, back);
        assert_eq!(back.ui.theme_mode, ThemeMode::Dark);
    }

    // ===== v0.6.0-A T1：UiSettings.{file_tree_width, ai_sidebar_width, file_preview_dialog} =====

    #[test]
    fn ui_settings_默认含_v0_6_0_a_新字段() {
        // 默认值断言：T1 新增的 3 个字段值正确。
        let s = UiSettings::default();
        assert_eq!(s.file_tree_width, 240, "FileTree 默认宽度 240");
        assert_eq!(s.ai_sidebar_width, 360, "AiSidebar 默认宽度 360");
        assert_eq!(
            s.file_preview_dialog, None,
            "FilePreviewDialog 默认 None（首次打开居中）"
        );
    }

    #[test]
    fn appsettings_默认含_v0_6_0_a_新字段() {
        let s = AppSettings::default();
        assert_eq!(s.ui.file_tree_width, 240);
        assert_eq!(s.ui.ai_sidebar_width, 360);
        assert_eq!(s.ui.file_preview_dialog, None);
    }

    #[test]
    fn 默认_v0_6_0_a_字段_往返序列化不丢() {
        // 默认值经 toml ser/de 后应该完全相等。
        let s = AppSettings::default();
        let toml_str = toml::to_string(&s).unwrap();
        let back: AppSettings = toml::from_str(&toml_str).unwrap();
        assert_eq!(s, back);
        assert_eq!(back.ui.file_tree_width, 240);
        assert_eq!(back.ui.ai_sidebar_width, 360);
        assert_eq!(back.ui.file_preview_dialog, None);
    }

    #[test]
    fn 老_toml_无_v0_6_0_a_字段_用默认值兼容() {
        // 模拟 v0.5.x 时代的 [ui] 段（只有 activity_bar_position / theme_mode /
        // ai_sidebar_position / file_tree_position）；
        // serde(default) 必须让 v0.6.0-A 新加的 3 个字段降级到默认值。
        let toml_str = r#"
[ui]
activity_bar_position = "right"
theme_mode = "dark"
ai_sidebar_position = "right"
file_tree_position = "left"
"#;
        let s: AppSettings = toml::from_str(toml_str).unwrap();
        assert_eq!(s.ui.file_tree_width, 240, "缺字段应默认 240");
        assert_eq!(s.ui.ai_sidebar_width, 360, "缺字段应默认 360");
        assert_eq!(s.ui.file_preview_dialog, None, "缺字段应默认 None");
        // 老字段不受影响
        assert_eq!(s.ui.activity_bar_position, ActivityBarPosition::Right);
        assert_eq!(s.ui.theme_mode, ThemeMode::Dark);
    }

    #[test]
    fn 老_toml_完全无_ui_段_含_v0_6_0_a_字段_默认值() {
        // 更老的 v0.4.0 之前 toml，连 [ui] 段都没；
        // 顶层 AppSettings 上的 #[serde(default)] 让整段降级到 UiSettings::default()。
        let toml_str = r#"
[terminal]
font_size = 14
"#;
        let s: AppSettings = toml::from_str(toml_str).unwrap();
        assert_eq!(s.ui.file_tree_width, 240);
        assert_eq!(s.ui.ai_sidebar_width, 360);
        assert_eq!(s.ui.file_preview_dialog, None);
    }

    #[test]
    fn file_preview_dialog_为_none_时_toml_不写字段() {
        // 关键约束：None 时 toml 输出不应含 `file_preview_dialog =` 行，
        // 避免出现 `file_preview_dialog = ""` 这种容易引起反序列化歧义的写法。
        // serde 的 `skip_serializing_if = "Option::is_none"` 保证这点。
        let s = AppSettings::default();
        let toml_str = toml::to_string(&s).unwrap();
        assert!(
            !toml_str.contains("file_preview_dialog"),
            "None 时 toml 不应含 file_preview_dialog 字段；实际:\n{}",
            toml_str
        );
    }

    #[test]
    fn file_preview_dialog_some_往返保留_xywh() {
        // Some(rect) 时 round-trip 必须保留 x/y/w/h 4 个 f32。
        let mut s = AppSettings::default();
        s.ui.file_preview_dialog = Some(DialogRect {
            x: 120.5,
            y: 80.0,
            w: 900.25,
            h: 640.0,
        });

        let toml_str = toml::to_string(&s).unwrap();
        assert!(
            toml_str.contains("file_preview_dialog"),
            "Some 时 toml 应含 file_preview_dialog 字段；实际:\n{}",
            toml_str
        );

        let back: AppSettings = toml::from_str(&toml_str).unwrap();
        let rect = back.ui.file_preview_dialog.expect("应反序列化为 Some");
        // f32 浮点等值比较（用了固定可表示的小数 0.5 / 0.25，所以可以直接 ==）
        assert!((rect.x - 120.5).abs() < f32::EPSILON);
        assert!((rect.y - 80.0).abs() < f32::EPSILON);
        assert!((rect.w - 900.25).abs() < f32::EPSILON);
        assert!((rect.h - 640.0).abs() < f32::EPSILON);
    }

    // ===== v0.7.0-A T1：PrivacySettings =====

    #[test]
    fn privacy_settings_默认_opt_in_为_true() {
        let s = PrivacySettings::default();
        assert!(s.analytics_opt_in, "默认应启用匿名使用统计（用户可在 UI 关）");
    }

    #[test]
    fn appsettings_默认含_privacy_opt_in_true() {
        let s = AppSettings::default();
        assert!(s.privacy.analytics_opt_in);
    }

    #[test]
    fn 老_toml_无_privacy_section_用默认_true_兼容() {
        // 升级用户的 config.toml 不会有 [privacy] 段；
        // serde(default) 必须让缺整段降级到 PrivacySettings::default()，
        // analytics_opt_in 默认 true（升级用户默认参与，但可主动关）。
        let toml_str = r#"
[terminal]
font_size = 14
"#;
        let s: AppSettings = toml::from_str(toml_str).unwrap();
        assert_eq!(s.terminal.font_size, 14);
        assert!(s.privacy.analytics_opt_in, "缺 [privacy] 段应默认 opt_in=true");
    }

    #[test]
    fn 老_toml_有_privacy_缺_opt_in_字段_默认_true_兼容() {
        // 用户在 [privacy] 段没写 analytics_opt_in；
        // PrivacySettings 上的 #[serde(default)] 必须让缺字段降级到默认 true。
        let toml_str = r#"
[privacy]
"#;
        let s: AppSettings = toml::from_str(toml_str).unwrap();
        assert!(s.privacy.analytics_opt_in, "缺 analytics_opt_in 字段应默认 true");
    }

    #[test]
    fn 往返序列化_含_privacy_section() {
        // 默认值经 toml ser/de 后应该完全相等。
        let s = AppSettings::default();
        let toml_str = toml::to_string(&s).unwrap();
        assert!(
            toml_str.contains("[privacy]"),
            "实际 toml:\n{}",
            toml_str
        );
        assert!(
            toml_str.contains("analytics_opt_in = true"),
            "实际 toml:\n{}",
            toml_str
        );

        let back: AppSettings = toml::from_str(&toml_str).unwrap();
        assert_eq!(s, back);
    }

    #[test]
    fn privacy_opt_out_往返序列化保留_false() {
        // 用户关 toggle 后落 toml 再读回来应保留 false。
        let mut s = AppSettings::default();
        s.privacy.analytics_opt_in = false;

        let toml_str = toml::to_string(&s).unwrap();
        assert!(
            toml_str.contains("analytics_opt_in = false"),
            "实际 toml:\n{}",
            toml_str
        );

        let back: AppSettings = toml::from_str(&toml_str).unwrap();
        assert!(!back.privacy.analytics_opt_in);
    }

    // ===== v0.9.0 T4：UiSettings.confirm_quit =====

    #[test]
    fn ui_settings_默认_confirm_quit_为_true() {
        // 默认开启二次确认，避免误关 aitm 丢工作。
        let s = UiSettings::default();
        assert!(s.confirm_quit, "默认应开启关闭二次确认");
    }

    #[test]
    fn appsettings_默认含_confirm_quit_true() {
        let s = AppSettings::default();
        assert!(s.ui.confirm_quit);
    }

    #[test]
    fn 老_toml_无_confirm_quit_字段_默认_true_兼容() {
        // v0.8.x 之前 [ui] 段没有 confirm_quit 字段；
        // 升级用户读取老 toml 时必须降级到默认 true（保持新版默认体验）。
        let toml_str = r#"
[ui]
activity_bar_position = "right"
theme_mode = "dark"
ai_sidebar_position = "right"
file_tree_position = "left"
file_tree_width = 240
ai_sidebar_width = 360
"#;
        let s: AppSettings = toml::from_str(toml_str).unwrap();
        assert!(
            s.ui.confirm_quit,
            "缺 confirm_quit 字段应默认 true（v0.9.0 T4 升级兼容）"
        );
        // 其他字段不受影响
        assert_eq!(s.ui.file_tree_width, 240);
    }

    #[test]
    fn 老_toml_完全无_ui_段_含_confirm_quit_默认_true() {
        // 更老的 v0.4.0 之前 toml，连 [ui] 段都没；走 UiSettings::default()。
        let toml_str = r#"
[terminal]
font_size = 14
"#;
        let s: AppSettings = toml::from_str(toml_str).unwrap();
        assert!(s.ui.confirm_quit);
    }

    #[test]
    fn confirm_quit_关掉后往返序列化保留_false() {
        // 用户关 toggle → settings.toml 应落 confirm_quit = false，且 round-trip 保留。
        let mut s = AppSettings::default();
        s.ui.confirm_quit = false;

        let toml_str = toml::to_string(&s).unwrap();
        assert!(
            toml_str.contains("confirm_quit = false"),
            "实际 toml:\n{}",
            toml_str
        );

        let back: AppSettings = toml::from_str(&toml_str).unwrap();
        assert!(!back.ui.confirm_quit);
    }

    #[test]
    fn confirm_quit_默认值_往返一致() {
        let s = AppSettings::default();
        let toml_str = toml::to_string(&s).unwrap();
        let back: AppSettings = toml::from_str(&toml_str).unwrap();
        assert_eq!(s, back);
        assert!(back.ui.confirm_quit);
    }

    #[test]
    fn v0_6_0_a_自定义_width_往返一致() {
        // 用户改过宽度后落 toml 再读回来不应丢。
        let mut s = AppSettings::default();
        s.ui.file_tree_width = 320;
        s.ui.ai_sidebar_width = 420;

        let toml_str = toml::to_string(&s).unwrap();
        assert!(toml_str.contains("file_tree_width = 320"));
        assert!(toml_str.contains("ai_sidebar_width = 420"));

        let back: AppSettings = toml::from_str(&toml_str).unwrap();
        assert_eq!(back.ui.file_tree_width, 320);
        assert_eq!(back.ui.ai_sidebar_width, 420);
    }

    // ===== v0.9.0 T1：TerminalSettings 默认字体 / 行高调整 =====

    #[test]
    fn 默认字体链_首位为_jetbrains_mono() {
        // v0.9.0 T1：对照 Terax 视觉，字体链首位改为 JetBrains Mono；
        // 字面高度大、对比度好；用户实际命中需自装或前端嵌入版。
        let s = TerminalSettings::default();
        assert!(
            s.font_family.starts_with("'JetBrains Mono'"),
            "font_family 首位应是 'JetBrains Mono'，实际：{}",
            s.font_family,
        );
    }

    #[test]
    fn 默认字体链_含跨平台_fallback() {
        // 保留三大 OS 兜底：SF Mono / Menlo（macOS）、Consolas / Cascadia Code（Windows）、
        // Courier New + monospace（终极兜底）。改默认时若误删某一项应被这个测试拦下。
        let s = TerminalSettings::default();
        for expected in [
            "'JetBrains Mono'",
            "'SF Mono'",
            "Menlo",
            "Consolas",
            "'Cascadia Code'",
            "'Courier New'",
            "monospace",
        ] {
            assert!(
                s.font_family.contains(expected),
                "font_family 应含 {}，实际：{}",
                expected,
                s.font_family,
            );
        }
    }

    #[test]
    fn 默认行高_为_1_5() {
        // v0.9.0 T1：line_height 1.2 → 1.5，更松、对照 Terax 视觉。
        let s = TerminalSettings::default();
        assert!(
            (s.line_height - 1.5).abs() < 1e-6,
            "line_height 应为 1.5，实际：{}",
            s.line_height,
        );
    }

    // ===== v0.9.0 T5b：EditorSettings =====

    #[test]
    fn editor_settings_默认值_空列表_无_active() {
        let s = EditorSettings::default();
        assert!(s.open_files.is_empty(), "默认 open_files 应为空");
        assert!(s.active_file.is_none(), "默认 active_file 应为 None");
        assert_eq!(s.font_size, 13, "默认 font_size 应为 13");
    }

    // ===== v0.10.6 T4：EditorSettings.font_size =====

    #[test]
    fn editor_font_size_默认_13() {
        assert_eq!(AppSettings::default().editor.font_size, 13);
    }

    #[test]
    fn editor_缺_font_size_字段_用默认_13_兼容老_toml() {
        // v0.10.5 之前 [editor] 段只有 open_files / active_file，没有 font_size。
        // serde(default = "...") 必须让缺字段降级到 13，老用户升级后字号不变。
        let toml_str = r#"
[editor]
open_files = ["/proj/foo.ts"]
"#;
        let s: AppSettings = toml::from_str(toml_str).unwrap();
        assert_eq!(s.editor.font_size, 13);
        assert_eq!(s.editor.open_files, vec!["/proj/foo.ts".to_string()]);
    }

    #[test]
    fn editor_font_size_持久化_往返() {
        let mut s = AppSettings::default();
        s.editor.font_size = 18;
        let toml_str = toml::to_string(&s).unwrap();
        assert!(toml_str.contains("font_size = 18"), "toml 应含 font_size = 18\n{toml_str}");
        let back: AppSettings = toml::from_str(&toml_str).unwrap();
        assert_eq!(back.editor.font_size, 18);
    }

    #[test]
    fn editor_font_size_超界值_反序列化不报错_由前端_clamp_兜底() {
        // 用户手改 TOML 写 999 也能反序列化成功，避免整份配置丢失；
        // 前端 clampFontSize 渲染时兜底到 [10, 24]。
        let toml_str = r#"
[editor]
font_size = 999
"#;
        let s: AppSettings = toml::from_str(toml_str).unwrap();
        assert_eq!(s.editor.font_size, 999);
    }

    #[test]
    fn appsettings_默认含_editor_默认值() {
        let s = AppSettings::default();
        assert!(s.editor.open_files.is_empty());
        assert!(s.editor.active_file.is_none());
    }

    #[test]
    fn 老_toml_无_editor_section_用默认值兼容() {
        // v0.8.x 之前 config.toml 没有 [editor] 段；
        // serde(default) 必须让缺整段降级到 EditorSettings::default()，
        // open_files 空 / active_file None（升级用户首次启动右侧编辑器工作区不展开）。
        let toml_str = r#"
[terminal]
font_size = 14
"#;
        let s: AppSettings = toml::from_str(toml_str).unwrap();
        assert_eq!(s.terminal.font_size, 14);
        assert!(s.editor.open_files.is_empty());
        assert!(s.editor.active_file.is_none());
    }

    #[test]
    fn 老_toml_有_editor_缺_active_file_字段_默认_none_兼容() {
        // 用户在 [editor] 段只写了 open_files；
        // EditorSettings 上的 #[serde(default)] 必须让缺字段降级到默认 None。
        let toml_str = r#"
[editor]
open_files = ["/a/foo.ts"]
"#;
        let s: AppSettings = toml::from_str(toml_str).unwrap();
        assert_eq!(s.editor.open_files, vec!["/a/foo.ts".to_string()]);
        assert!(s.editor.active_file.is_none());
    }

    #[test]
    fn editor_active_file_为_none_时_toml_不写字段() {
        // skip_serializing_if = "Option::is_none" 保证 None 时 toml 输出不含 active_file 行。
        let s = AppSettings::default();
        let toml_str = toml::to_string(&s).unwrap();
        assert!(
            !toml_str.contains("active_file"),
            "None 时 toml 不应含 active_file 字段；实际:\n{}",
            toml_str
        );
    }

    #[test]
    fn editor_open_files_顺序保持() {
        // Vec<String> 必须保持顺序（不像 HashMap）。
        let mut s = AppSettings::default();
        s.editor.open_files = vec![
            "/proj/a.ts".to_string(),
            "/proj/b.rs".to_string(),
            "/proj/README.md".to_string(),
        ];

        let toml_str = toml::to_string(&s).unwrap();
        let back: AppSettings = toml::from_str(&toml_str).unwrap();
        assert_eq!(
            back.editor.open_files,
            vec![
                "/proj/a.ts".to_string(),
                "/proj/b.rs".to_string(),
                "/proj/README.md".to_string(),
            ],
        );
    }

    #[test]
    fn 往返序列化_含_editor_section() {
        let mut s = AppSettings::default();
        s.editor.open_files = vec!["/proj/a.ts".to_string()];
        s.editor.active_file = Some("/proj/a.ts".to_string());

        let toml_str = toml::to_string(&s).unwrap();
        assert!(
            toml_str.contains("[editor]"),
            "实际 toml:\n{}",
            toml_str,
        );
        assert!(toml_str.contains("open_files"));
        assert!(toml_str.contains("active_file = \"/proj/a.ts\""));

        let back: AppSettings = toml::from_str(&toml_str).unwrap();
        assert_eq!(s, back);
    }

    #[test]
    fn editor_active_file_往返保留() {
        let mut s = AppSettings::default();
        s.editor.open_files = vec![
            "/x/foo.ts".to_string(),
            "/x/bar.rs".to_string(),
        ];
        s.editor.active_file = Some("/x/bar.rs".to_string());

        let toml_str = toml::to_string(&s).unwrap();
        let back: AppSettings = toml::from_str(&toml_str).unwrap();
        assert_eq!(back.editor.active_file, Some("/x/bar.rs".to_string()));
        assert_eq!(back.editor.open_files.len(), 2);
    }

    #[test]
    fn 默认_editor_序列化能反序列化回来() {
        let s = AppSettings::default();
        let toml_str = toml::to_string(&s).unwrap();
        let back: AppSettings = toml::from_str(&toml_str).unwrap();
        assert_eq!(s, back);
        assert!(back.editor.open_files.is_empty());
        assert!(back.editor.active_file.is_none());
    }

    // ===== v0.10.0 HR6-3e：UiSettings.pane_layout =====

    #[test]
    fn ui_settings_默认_pane_layout_为_none() {
        // 默认 None：首次启动 / 老用户升级 → 前端走 makeDefaultRoot 单 leaf。
        let s = UiSettings::default();
        assert!(s.pane_layout.is_none());
    }

    #[test]
    fn appsettings_默认含_pane_layout_none() {
        let s = AppSettings::default();
        assert!(s.ui.pane_layout.is_none());
    }

    #[test]
    fn pane_layout_为_none_时_toml_不写字段() {
        // skip_serializing_if = "Option::is_none" 保证 None 时 toml 输出不含
        // pane_layout 行，避免出现 `pane_layout = ""` 这种容易引起反序列化歧义的写法。
        let s = AppSettings::default();
        let toml_str = toml::to_string(&s).unwrap();
        assert!(
            !toml_str.contains("pane_layout"),
            "None 时 toml 不应含 pane_layout 字段；实际:\n{}",
            toml_str
        );
    }

    #[test]
    fn pane_layout_some_往返保留_json_字符串() {
        // 前端 JSON.stringify(LayoutNode) 后塞过来；后端只当不透明 blob 存。
        let json = r#"{"kind":"leaf","group":{"id":"g-initial","type":"terminal","tab_ids":["t-1","t-2"],"active_tab_id":"t-1"}}"#;
        let mut s = AppSettings::default();
        s.ui.pane_layout = Some(json.to_string());

        let toml_str = toml::to_string(&s).unwrap();
        assert!(
            toml_str.contains("pane_layout"),
            "Some 时 toml 应含 pane_layout 字段；实际:\n{}",
            toml_str
        );

        let back: AppSettings = toml::from_str(&toml_str).unwrap();
        assert_eq!(back.ui.pane_layout.as_deref(), Some(json));
    }

    #[test]
    fn 老_toml_无_pane_layout_字段_默认_none_兼容() {
        // v0.9.x 之前 [ui] 段没有 pane_layout 字段；
        // 升级用户读取老 toml 时必须降级到默认 None（前端走默认单 leaf）。
        let toml_str = r#"
[ui]
activity_bar_position = "right"
theme_mode = "dark"
ai_sidebar_position = "right"
file_tree_position = "left"
file_tree_width = 240
ai_sidebar_width = 360
confirm_quit = true
"#;
        let s: AppSettings = toml::from_str(toml_str).unwrap();
        assert!(
            s.ui.pane_layout.is_none(),
            "缺 pane_layout 字段应默认 None（v0.10.0 HR6-3e 升级兼容）"
        );
        // 其他字段不受影响
        assert_eq!(s.ui.file_tree_width, 240);
        assert!(s.ui.confirm_quit);
    }

    #[test]
    fn 老_toml_完全无_ui_段_含_pane_layout_默认_none() {
        // 更老的 v0.4.0 之前 toml，连 [ui] 段都没；走 UiSettings::default()。
        let toml_str = r#"
[terminal]
font_size = 14
"#;
        let s: AppSettings = toml::from_str(toml_str).unwrap();
        assert!(s.ui.pane_layout.is_none());
    }

    // ===== v0.10.0 HR7-7：UiSettings.keybindings =====

    #[test]
    fn ui_settings_默认_keybindings_为空_map() {
        // 默认空 map：所有 action 走前端 DEFAULT_KEYBINDINGS，TOML 不带冗余覆盖项。
        let s = UiSettings::default();
        assert!(s.keybindings.is_empty(), "默认 keybindings 应为空 map");
    }

    #[test]
    fn appsettings_默认含_keybindings_空_map() {
        let s = AppSettings::default();
        assert!(s.ui.keybindings.is_empty());
    }

    #[test]
    fn keybindings_往返保留_单条覆盖() {
        // 用户改 Cmd+T → Cmd+Shift+T 后落 TOML 再读回应保留。
        let mut s = AppSettings::default();
        s.ui.keybindings.insert("newTab".into(), "Cmd+Shift+T".into());

        let toml_str = toml::to_string(&s).unwrap();
        assert!(
            toml_str.contains("[ui.keybindings]"),
            "应落地为子表 [ui.keybindings]；实际：\n{}",
            toml_str
        );
        assert!(toml_str.contains("newTab"));

        let back: AppSettings = toml::from_str(&toml_str).unwrap();
        assert_eq!(back.ui.keybindings.get("newTab"), Some(&"Cmd+Shift+T".to_string()));
    }

    #[test]
    fn keybindings_往返保留_多条覆盖() {
        // 多条覆盖（含特殊字符 \\ 和 ,）round-trip 必须全保留。
        let mut s = AppSettings::default();
        s.ui.keybindings.insert("newTab".into(), "Cmd+Shift+T".into());
        s.ui.keybindings.insert("splitVertical".into(), "Cmd+\\".into());
        s.ui.keybindings.insert("openSettings".into(), "Cmd+,".into());

        let toml_str = toml::to_string(&s).unwrap();
        let back: AppSettings = toml::from_str(&toml_str).unwrap();
        assert_eq!(back.ui.keybindings.len(), 3);
        assert_eq!(back.ui.keybindings.get("newTab"), Some(&"Cmd+Shift+T".to_string()));
        assert_eq!(back.ui.keybindings.get("splitVertical"), Some(&"Cmd+\\".to_string()));
        assert_eq!(back.ui.keybindings.get("openSettings"), Some(&"Cmd+,".to_string()));
    }

    #[test]
    fn 老_toml_无_keybindings_字段_默认空_map_兼容() {
        // v0.9.x 之前 [ui] 段没有 keybindings 字段；
        // 升级用户读取老 toml 时必须降级到默认空 map（前端走默认 binding）。
        let toml_str = r#"
[ui]
activity_bar_position = "right"
theme_mode = "dark"
ai_sidebar_position = "right"
file_tree_position = "left"
file_tree_width = 240
ai_sidebar_width = 360
confirm_quit = true
"#;
        let s: AppSettings = toml::from_str(toml_str).unwrap();
        assert!(
            s.ui.keybindings.is_empty(),
            "缺 keybindings 字段应默认空 map（v0.10.0 HR7-7 升级兼容）"
        );
        // 其他字段不受影响
        assert_eq!(s.ui.file_tree_width, 240);
        assert!(s.ui.confirm_quit);
    }

    #[test]
    fn 老_toml_完全无_ui_段_含_keybindings_默认空() {
        // 更老的 v0.4.0 之前 toml，连 [ui] 段都没；走 UiSettings::default()。
        let toml_str = r#"
[terminal]
font_size = 14
"#;
        let s: AppSettings = toml::from_str(toml_str).unwrap();
        assert!(s.ui.keybindings.is_empty());
    }

    #[test]
    fn 默认_keybindings_序列化能反序列化回来() {
        let s = AppSettings::default();
        let toml_str = toml::to_string(&s).unwrap();
        let back: AppSettings = toml::from_str(&toml_str).unwrap();
        assert_eq!(s, back);
        assert!(back.ui.keybindings.is_empty());
    }

    #[test]
    fn pane_layout_嵌套_split_json_往返保留() {
        // 真实嵌套 split tree 的 JSON：layout tree 任意深度都应能存。
        let json = r#"{"kind":"split","direction":"horizontal","ratio":0.5,"left":{"kind":"leaf","group":{"id":"g-a","type":"terminal","tab_ids":["t1"],"active_tab_id":"t1"}},"right":{"kind":"split","direction":"vertical","ratio":0.7,"left":{"kind":"leaf","group":{"id":"g-b","type":"terminal","tab_ids":[],"active_tab_id":null}},"right":{"kind":"leaf","group":{"id":"g-c","type":"terminal","tab_ids":["t2"],"active_tab_id":"t2"}}}}"#;
        let mut s = AppSettings::default();
        s.ui.pane_layout = Some(json.to_string());

        let toml_str = toml::to_string(&s).unwrap();
        let back: AppSettings = toml::from_str(&toml_str).unwrap();
        assert_eq!(back.ui.pane_layout.as_deref(), Some(json));
    }
}
