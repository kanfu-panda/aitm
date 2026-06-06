//! Provider Registry —— 跨多 tab/conversation 共享的 LLM provider 实例池。
//!
//! 启动时读 `~/.aitm/config.toml` 加 `~/.aitm/.env` 拼装出每家 provider，
//! 注册到 registry；运行时按 id 拿出来调 `stream_chat`。
//!
//! 运行期通过 [`rebuild_registry`] 在用户保存配置后**热替换**整个 registry，
//! 这样 IPC `ai_chat_send` 不需要重启即可看到新 key/base_url。

use std::collections::HashMap;
use std::sync::Arc;

use super::anthropic::{AnthropicClient, AnthropicConfig};
use super::openai_compat::{OpenAICompatClient, OpenAICompatConfig};
use super::presets::Preset;
use super::{LlmProvider, ModelInfo, ProviderError};
use crate::settings::AppSettings;

/// 跨 IPC 命令共享的 registry 句柄。
///
/// 用 `tokio::sync::RwLock`（不是 std）以便在 `async` 命令里 `.await`；
/// 用 `Arc` 让 `tauri::State` 能克隆而不重建数据。
pub type SharedRegistry = Arc<tokio::sync::RwLock<ProviderRegistry>>;

pub struct ProviderRegistry {
    providers: HashMap<String, Arc<dyn LlmProvider>>,
}

impl ProviderRegistry {
    pub fn new() -> Self {
        Self {
            providers: HashMap::new(),
        }
    }

    pub fn register(&mut self, p: Arc<dyn LlmProvider>) {
        self.providers.insert(p.id().to_string(), p);
    }

    pub fn get(&self, id: &str) -> Option<Arc<dyn LlmProvider>> {
        self.providers.get(id).cloned()
    }

    pub fn list_ids(&self) -> Vec<String> {
        self.providers.keys().cloned().collect()
    }

    /// 列出所有 provider 的 (id, display_name, models, capabilities)。
    pub fn describe_all(&self) -> Vec<RegistryEntry> {
        self.providers
            .values()
            .map(|p| RegistryEntry {
                id: p.id().to_string(),
                display_name: p.display_name().to_string(),
                models: p.list_models(),
                capabilities: p.capabilities(),
            })
            .collect()
    }
}

impl Default for ProviderRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RegistryEntry {
    pub id: String,
    pub display_name: String,
    pub models: Vec<ModelInfo>,
    pub capabilities: super::Capabilities,
}

/// 三源合并查找一个 key：
///
/// 优先级（从高到低）：
/// 1. `std::env::var(key)`（非空）
/// 2. `~/.aitm/.env` 中的同名 key（非空）
/// 3. `settings.providers.map.<provider_id>` 中对应字段（非空）
///
/// 三源都为空 → `None`。
fn lookup_with_config(
    dotenv: &HashMap<String, String>,
    key: &str,
    config_value: Option<&str>,
) -> Option<String> {
    if let Ok(v) = std::env::var(key) {
        if !v.is_empty() {
            return Some(v);
        }
    }
    if let Some(v) = dotenv.get(key) {
        if !v.is_empty() {
            return Some(v.clone());
        }
    }
    config_value
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
}

/// 该 provider 在 settings.providers.map 中是否启用。
///
/// **默认启用**：map 里没这条记录 → 视为 `enabled=true`（保持向后兼容，
/// 老 toml 没有 [providers.*] 段也能注册）。
fn is_enabled(settings: &AppSettings, provider_id: &str) -> bool {
    settings
        .providers
        .map
        .get(provider_id)
        .map(|c| c.enabled)
        .unwrap_or(true)
}

/// 解析 OpenAI 兼容 provider 的最终配置；返回 None 表示该 provider 不应注册
/// （没有可用 api_key 或被 disable）。
fn resolve_openai_compat_config(
    preset: Preset,
    settings: &AppSettings,
    dotenv: &HashMap<String, String>,
) -> Option<OpenAICompatConfig> {
    let id = preset.id();
    if !is_enabled(settings, id) {
        return None;
    }
    let upper = id.to_uppercase();
    let cfg_entry = settings.providers.map.get(id);

    let api_key = lookup_with_config(
        dotenv,
        &format!("{upper}_API_KEY"),
        cfg_entry.map(|c| c.api_key.as_str()),
    )?;

    let mut cfg = preset.make_config(api_key);
    if let Some(url) = lookup_with_config(
        dotenv,
        &format!("{upper}_BASE_URL"),
        cfg_entry.map(|c| c.base_url.as_str()),
    ) {
        cfg.base_url = url;
    }
    Some(cfg)
}

/// 解析 Anthropic provider 的最终配置；返回 None 表示不应注册。
fn resolve_anthropic_config(
    settings: &AppSettings,
    dotenv: &HashMap<String, String>,
) -> Option<AnthropicConfig> {
    if !is_enabled(settings, "anthropic") {
        return None;
    }
    let cfg_entry = settings.providers.map.get("anthropic");

    let api_key = lookup_with_config(
        dotenv,
        "ANTHROPIC_API_KEY",
        cfg_entry.map(|c| c.api_key.as_str()),
    )?;

    let mut cfg = AnthropicConfig::new("anthropic", api_key);
    if let Some(url) = lookup_with_config(
        dotenv,
        "ANTHROPIC_BASE_URL",
        cfg_entry.map(|c| c.base_url.as_str()),
    ) {
        cfg.base_url = url;
    }
    Some(cfg)
}

/// 根据 `settings`（含 providers 段）+ env + `.env` 三源合并构造 provider 实例
/// 注册到 `reg`。
///
/// 三源优先级（高 → 低）：`std::env::var` > `~/.aitm/.env` > `settings.providers.map`。
///
/// 注册策略：
/// - 没有可用 api_key → 跳过该 provider
/// - `enabled = false` → 跳过该 provider（map 里不存在视为 `enabled = true`，向后兼容）
/// - base_url 三源都空 → 用 preset 默认 base_url（不影响是否注册）
pub fn auto_register(
    reg: &mut ProviderRegistry,
    settings: &AppSettings,
) -> Result<(), ProviderError> {
    let dotenv = super::env::load_dotenv_map();

    if let Some(cfg) = resolve_anthropic_config(settings, &dotenv) {
        reg.register(Arc::new(AnthropicClient::new(cfg)));
    }

    for preset in [
        Preset::DeepSeek,
        Preset::QwenDashScope,
        Preset::Zhipu,
        Preset::MoonshotKimi,
        Preset::OpenAIOfficial,
    ] {
        if let Some(cfg) = resolve_openai_compat_config(preset, settings, &dotenv) {
            reg.register(Arc::new(OpenAICompatClient::new(cfg)));
        }
    }
    Ok(())
}

/// 用最新 settings 重新构造 registry 内容并原子替换。
///
/// 用 `async + .await` 而不是 `blocking_write`：IPC 命令 handler 是 async，在
/// async 上下文 blocking_write 会阻塞整个 tokio worker 线程。
///
/// 调用时机：用户保存 settings 后，由 settings_update 命令链式调用。
pub async fn rebuild_registry(
    shared: &SharedRegistry,
    settings: &AppSettings,
) -> Result<(), ProviderError> {
    let mut new_reg = ProviderRegistry::new();
    auto_register(&mut new_reg, settings)?;
    *shared.write().await = new_reg;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::types::*;
    use crate::settings::ProviderConfig;
    use async_trait::async_trait;
    use futures::stream::BoxStream;
    use tempfile::TempDir;

    /// 把 HOME 切到临时目录 + 清空相关 env vars，运行 f 后还原。
    /// 串行锁用 lib 根的共享 ENV_LOCK，避免与 settings::store 测试争 HOME。
    fn with_clean_env<F: FnOnce(&AppSettings)>(settings: AppSettings, f: F) {
        let _guard = crate::test_env_lock::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let tmp = TempDir::new().unwrap();
        let original_home = std::env::var("HOME").ok();
        let env_keys = [
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_BASE_URL",
            "DEEPSEEK_API_KEY",
            "DEEPSEEK_BASE_URL",
            "QWEN_API_KEY",
            "QWEN_BASE_URL",
            "ZHIPU_API_KEY",
            "ZHIPU_BASE_URL",
            "MOONSHOT_API_KEY",
            "MOONSHOT_BASE_URL",
            "OPENAI_API_KEY",
            "OPENAI_BASE_URL",
        ];
        let originals: Vec<(&str, Option<String>)> = env_keys
            .iter()
            .map(|k| (*k, std::env::var(k).ok()))
            .collect();

        // SAFETY: ENV_LOCK 串行 + 单线程修改 env，符合 set_var 安全前提。
        unsafe {
            std::env::set_var("HOME", tmp.path());
            for k in &env_keys {
                std::env::remove_var(k);
            }
        }

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(&settings)));

        unsafe {
            if let Some(h) = original_home {
                std::env::set_var("HOME", h);
            } else {
                std::env::remove_var("HOME");
            }
            for (k, v) in originals {
                if let Some(val) = v {
                    std::env::set_var(k, val);
                } else {
                    std::env::remove_var(k);
                }
            }
        }

        if let Err(e) = result {
            std::panic::resume_unwind(e);
        }
    }

    /// 测试用假 provider。
    struct FakeProvider;

    #[async_trait]
    impl LlmProvider for FakeProvider {
        fn id(&self) -> &str {
            "fake"
        }
        fn display_name(&self) -> &str {
            "Fake"
        }
        fn list_models(&self) -> Vec<ModelInfo> {
            vec![]
        }
        fn capabilities(&self) -> super::super::Capabilities {
            Default::default()
        }
        async fn stream_chat(
            &self,
            _: ChatRequest,
        ) -> Result<BoxStream<'static, ChatChunk>, ProviderError> {
            Ok(Box::pin(futures::stream::empty()))
        }
    }

    #[test]
    fn register_then_get() {
        let mut r = ProviderRegistry::new();
        r.register(Arc::new(FakeProvider));
        assert!(r.get("fake").is_some());
        assert!(r.get("nonexistent").is_none());
    }

    #[test]
    fn list_ids_包含所有() {
        let mut r = ProviderRegistry::new();
        r.register(Arc::new(FakeProvider));
        let ids = r.list_ids();
        assert_eq!(ids, vec!["fake"]);
    }

    #[test]
    fn describe_all_含基础信息() {
        let mut r = ProviderRegistry::new();
        r.register(Arc::new(FakeProvider));
        let desc = r.describe_all();
        assert_eq!(desc.len(), 1);
        assert_eq!(desc[0].id, "fake");
        assert_eq!(desc[0].display_name, "Fake");
    }

    #[test]
    fn auto_register_无_settings_无_env_啥都不注册() {
        with_clean_env(AppSettings::default(), |settings| {
            let mut reg = ProviderRegistry::new();
            auto_register(&mut reg, settings).unwrap();
            assert!(
                reg.list_ids().is_empty(),
                "三源都空时不应注册任何 provider，实际：{:?}",
                reg.list_ids()
            );
        });
    }

    #[test]
    fn auto_register_settings_里_有_key_注册成功() {
        let mut s = AppSettings::default();
        s.providers.map.insert(
            "qwen".into(),
            ProviderConfig {
                enabled: true,
                api_key: "sk-from-config".into(),
                base_url: String::new(),
            },
        );
        with_clean_env(s, |settings| {
            let mut reg = ProviderRegistry::new();
            auto_register(&mut reg, settings).unwrap();
            assert!(
                reg.list_ids().iter().any(|id| id == "qwen"),
                "settings 里有 qwen key 应注册，实际：{:?}",
                reg.list_ids()
            );
        });
    }

    #[test]
    fn auto_register_disabled_即使有_key_也不注册() {
        let mut s = AppSettings::default();
        s.providers.map.insert(
            "qwen".into(),
            ProviderConfig {
                enabled: false,
                api_key: "sk-from-config".into(),
                base_url: String::new(),
            },
        );
        with_clean_env(s, |settings| {
            let mut reg = ProviderRegistry::new();
            auto_register(&mut reg, settings).unwrap();
            assert!(
                !reg.list_ids().iter().any(|id| id == "qwen"),
                "enabled=false 不应注册，实际：{:?}",
                reg.list_ids()
            );
        });
    }

    #[test]
    fn auto_register_env_优先级高于_config() {
        let mut s = AppSettings::default();
        s.providers.map.insert(
            "qwen".into(),
            ProviderConfig {
                enabled: true,
                api_key: "sk-from-config".into(),
                base_url: String::new(),
            },
        );

        // 这里不能用 with_clean_env（它会清掉 QWEN_API_KEY），手动管理 env
        let _guard = crate::test_env_lock::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let tmp = TempDir::new().unwrap();
        let original_home = std::env::var("HOME").ok();
        let original_qwen = std::env::var("QWEN_API_KEY").ok();

        // SAFETY: ENV_LOCK 串行 + 单线程修改 env
        unsafe {
            std::env::set_var("HOME", tmp.path());
            std::env::set_var("QWEN_API_KEY", "sk-from-env");
        }

        // 直接验 helper：env 应胜出
        let dotenv = HashMap::new();
        let resolved =
            resolve_openai_compat_config(Preset::QwenDashScope, &s, &dotenv);

        unsafe {
            if let Some(h) = original_home {
                std::env::set_var("HOME", h);
            } else {
                std::env::remove_var("HOME");
            }
            if let Some(v) = original_qwen {
                std::env::set_var("QWEN_API_KEY", v);
            } else {
                std::env::remove_var("QWEN_API_KEY");
            }
        }

        let cfg = resolved.expect("应解析出配置");
        assert_eq!(
            cfg.api_key, "sk-from-env",
            "env 应优先于 settings；实际 api_key={}",
            cfg.api_key
        );
    }

    // 此测试故意跨 await 持 std::sync::Mutex —— 因为这是 cfg(test) 串行锁，
    // 整段测试需要原子地占住 env，rebuild_registry 内部不会回头来抢这把锁，
    // 不存在 deadlock 风险。current_thread runtime 也保证 guard 不跨线程。
    #[allow(clippy::await_holding_lock)]
    #[tokio::test(flavor = "current_thread")]
    async fn rebuild_registry_替换内容() {
        let _guard = crate::test_env_lock::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let tmp = TempDir::new().unwrap();
        let original_home = std::env::var("HOME").ok();
        let env_keys = [
            "ANTHROPIC_API_KEY",
            "DEEPSEEK_API_KEY",
            "QWEN_API_KEY",
            "ZHIPU_API_KEY",
            "MOONSHOT_API_KEY",
            "OPENAI_API_KEY",
        ];
        let originals: Vec<(&str, Option<String>)> = env_keys
            .iter()
            .map(|k| (*k, std::env::var(k).ok()))
            .collect();

        unsafe {
            std::env::set_var("HOME", tmp.path());
            for k in &env_keys {
                std::env::remove_var(k);
            }
        }

        let shared: SharedRegistry = Arc::new(tokio::sync::RwLock::new(ProviderRegistry::new()));

        // 第一次 rebuild：settings 含 qwen
        let mut s1 = AppSettings::default();
        s1.providers.map.insert(
            "qwen".into(),
            ProviderConfig {
                enabled: true,
                api_key: "sk-1".into(),
                base_url: String::new(),
            },
        );
        rebuild_registry(&shared, &s1).await.unwrap();
        assert!(
            shared.read().await.list_ids().iter().any(|id| id == "qwen"),
            "rebuild 后应含 qwen"
        );

        // 第二次 rebuild：disable qwen
        let mut s2 = s1.clone();
        s2.providers.map.get_mut("qwen").unwrap().enabled = false;
        rebuild_registry(&shared, &s2).await.unwrap();
        assert!(
            !shared.read().await.list_ids().iter().any(|id| id == "qwen"),
            "disable + rebuild 后应不含 qwen"
        );

        // 还原 env
        unsafe {
            if let Some(h) = original_home {
                std::env::set_var("HOME", h);
            } else {
                std::env::remove_var("HOME");
            }
            for (k, v) in originals {
                if let Some(val) = v {
                    std::env::set_var(k, val);
                } else {
                    std::env::remove_var(k);
                }
            }
        }
    }
}
