//! Providers 配置/测试连接 IPC 命令。
//!
//! 三个命令：
//! - [`providers_get_config`]：返回 6 家 provider 的配置 + key 来源 + 模型列表
//! - [`providers_save_config`]：写盘 + 热重建 registry + emit `providers:changed`
//! - [`providers_test_connection`]：发一条最小 ping 请求验证 key/网络可用
//!
//! 设计要点：
//! - DTO 里 api_key 永远只回显 mask 后的字符串，不漏明文
//! - "留空 = 不变" 语义在 save 命令里实现
//! - test_connection **不**走 ai_chat_send 那条事件链（不 emit ai:* 事件）

use std::collections::HashMap;
use std::time::{Duration, Instant};

use futures::stream::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::ipc::ai::AiState;
use crate::ipc::settings::SettingsState;
use crate::providers::anthropic::{self as anthropic_mod, AnthropicConfig};
use crate::providers::env::{load_dotenv_map, mask_api_key};
use crate::providers::presets::Preset;
use crate::providers::types::{ChatRequest, ChatChunk, Message, MessageContent, ProviderError, Role};
use crate::providers::ModelInfo;
use crate::settings::{AppSettings, ProviderConfig};

/// API key 解析来源（优先级 env > dotenv > config > none）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum KeySource {
    /// `std::env::var` 命中
    Env,
    /// `~/.aitm/.env` 命中
    Dotenv,
    /// `~/.aitm/config.toml` `[providers.<id>]` 命中
    Config,
    /// 三源都为空
    None,
}

/// 单家 provider 给 UI 展示的全量配置。
#[derive(Debug, Clone, Serialize)]
pub struct ProviderConfigDto {
    pub id: String,
    pub display_name: String,
    pub enabled: bool,
    /// 已掩码的 API key；空字符串表示未配置。
    pub api_key_masked: String,
    pub key_source: KeySource,
    /// settings 里用户填的 base_url（空字符串 = 用默认）。
    pub base_url: String,
    /// 该 provider 内置默认 base_url（UI 用 placeholder 显示）。
    pub default_base_url: String,
    pub models: Vec<ModelInfo>,
}

/// providers_save_config 入参。
///
/// `api_key` 字段语义：空字符串 = 保留旧 key（不变），非空 = 覆盖。
/// 这样 UI 始终发 mask 后的占位空字符串，避免误清空。
#[derive(Debug, Clone, Deserialize)]
pub struct ProviderSavePayload {
    pub id: String,
    pub enabled: bool,
    pub api_key: String,
    pub base_url: String,
}

/// providers_test_connection 返回值。
#[derive(Debug, Clone, Serialize)]
pub struct ProviderTestResult {
    pub ok: bool,
    pub elapsed_ms: u64,
    pub message: String,
}

/// Provider 元数据抽象 —— OpenAI 兼容预设 + Anthropic 共用同一组生成 DTO 的代码。
///
/// 直接抽 `Preset` 不够 —— Anthropic 不在 `Preset` 枚举里且 env key 名拼法
/// 不规则（Anthropic 直接用全大写 id）。这里用一个内部小 enum 把两类 provider
/// 统一到同样的元数据接口下。
#[derive(Debug, Clone, Copy)]
enum ProviderKind {
    OpenAICompat(Preset),
    Anthropic,
}

impl ProviderKind {
    fn id(&self) -> &'static str {
        match self {
            Self::OpenAICompat(p) => p.id(),
            Self::Anthropic => "anthropic",
        }
    }

    fn display_name(&self) -> String {
        match self {
            Self::OpenAICompat(p) => p.display_name().to_string(),
            // 跟 AnthropicConfig::new 默认一致，避免 UI 显示与运行时不同名
            Self::Anthropic => "Claude (Anthropic)".to_string(),
        }
    }

    fn default_base_url(&self) -> String {
        match self {
            Self::OpenAICompat(p) => p.base_url().to_string(),
            Self::Anthropic => anthropic_mod::DEFAULT_BASE_URL.to_string(),
        }
    }

    fn models(&self) -> Vec<ModelInfo> {
        match self {
            Self::OpenAICompat(p) => p.models(),
            // 借 AnthropicConfig::new 默认 models，避免硬编码漂移
            Self::Anthropic => AnthropicConfig::new("anthropic", "").models,
        }
    }

    fn env_key_name(&self) -> String {
        // OpenAI 兼容：DEEPSEEK_API_KEY / QWEN_API_KEY / ZHIPU_API_KEY / ...
        // Anthropic：ANTHROPIC_API_KEY
        format!("{}_API_KEY", self.id().to_uppercase())
    }

    fn all() -> Vec<Self> {
        vec![
            Self::OpenAICompat(Preset::DeepSeek),
            Self::OpenAICompat(Preset::QwenDashScope),
            Self::OpenAICompat(Preset::Zhipu),
            Self::OpenAICompat(Preset::MoonshotKimi),
            Self::OpenAICompat(Preset::OpenAIOfficial),
            Self::Anthropic,
        ]
    }
}

/// 合法 provider id 集合（save_config 校验用）。
fn is_known_id(id: &str) -> bool {
    ProviderKind::all().iter().any(|k| k.id() == id)
}

/// 三源解析一家 provider 的 (resolved_key, key_source)。
///
/// 提到模块级是为了让单测能直接调用，不必走 Tauri State。
fn resolve_key(
    kind: ProviderKind,
    settings: &AppSettings,
    dotenv: &HashMap<String, String>,
) -> (String, KeySource) {
    let env_key = kind.env_key_name();

    if let Ok(v) = std::env::var(&env_key) {
        if !v.is_empty() {
            return (v, KeySource::Env);
        }
    }
    if let Some(v) = dotenv.get(&env_key) {
        if !v.is_empty() {
            return (v.clone(), KeySource::Dotenv);
        }
    }
    if let Some(cfg) = settings.providers.map.get(kind.id()) {
        if !cfg.api_key.is_empty() {
            return (cfg.api_key.clone(), KeySource::Config);
        }
    }
    (String::new(), KeySource::None)
}

/// 把单家 provider 的 settings + 三源 → DTO（纯函数，便于测试）。
fn build_dto(
    kind: ProviderKind,
    settings: &AppSettings,
    dotenv: &HashMap<String, String>,
) -> ProviderConfigDto {
    let cfg = settings.providers.map.get(kind.id());
    let (resolved_key, key_source) = resolve_key(kind, settings, dotenv);

    ProviderConfigDto {
        id: kind.id().to_string(),
        display_name: kind.display_name(),
        enabled: cfg.map(|c| c.enabled).unwrap_or(true),
        api_key_masked: if resolved_key.is_empty() {
            String::new()
        } else {
            mask_api_key(&resolved_key)
        },
        key_source,
        base_url: cfg.map(|c| c.base_url.clone()).unwrap_or_default(),
        default_base_url: kind.default_base_url(),
        models: kind.models(),
    }
}

#[tauri::command]
pub async fn providers_get_config(
    settings_state: State<'_, SettingsState>,
) -> Result<Vec<ProviderConfigDto>, String> {
    // 拿一份 settings snapshot 立刻释放锁；后续遍历不持锁。
    let settings = settings_state.current.lock().await.clone();
    let dotenv = load_dotenv_map();

    Ok(ProviderKind::all()
        .into_iter()
        .map(|k| build_dto(k, &settings, &dotenv))
        .collect())
}

#[tauri::command]
pub async fn providers_save_config(
    payload: ProviderSavePayload,
    settings_state: State<'_, SettingsState>,
    ai_state: State<'_, AiState>,
    app: AppHandle,
) -> Result<(), String> {
    if !is_known_id(&payload.id) {
        return Err(format!("未知 provider id: {}", payload.id));
    }

    // 1. 在锁里 clone 一份当前 settings，立刻释放锁
    let mut new_settings = {
        let g = settings_state.current.lock().await;
        g.clone()
    };

    // 2. merge 改动到 map
    let entry = new_settings
        .providers
        .map
        .entry(payload.id.clone())
        .or_insert_with(ProviderConfig::default);
    entry.enabled = payload.enabled;
    if !payload.api_key.is_empty() {
        // "留空 = 不变" 语义：UI 不会发明文 key 除非用户主动改
        entry.api_key = payload.api_key;
    }
    entry.base_url = payload.base_url;

    // 3. 先落盘成功再更新内存 + 重建 registry。
    //    顺序很重要：磁盘是真理来源，rebuild 失败不应丢配置。
    crate::settings::store::save(&new_settings).map_err(|e| e.to_string())?;

    // 4. 把内存里的 SettingsState 也对齐
    *settings_state.current.lock().await = new_settings.clone();

    // 5. 热重建 registry（async 不阻塞）
    crate::providers::registry::rebuild_registry(&ai_state.registry, &new_settings)
        .await
        .map_err(|e| e.to_string())?;

    // 6. 通知前端刷新（其它窗口/sidebar 重新拉 list_providers）
    let _ = app.emit("providers:changed", ());

    Ok(())
}

#[tauri::command]
pub async fn providers_test_connection(
    id: String,
    ai_state: State<'_, AiState>,
) -> Result<ProviderTestResult, String> {
    // 小作用域释放读锁，防止跨 await 持锁阻塞 rebuild_registry 的写锁
    let provider = {
        let g = ai_state.registry.read().await;
        g.get(&id)
    };

    let Some(provider) = provider else {
        return Ok(ProviderTestResult {
            ok: false,
            elapsed_ms: 0,
            message: "provider 未配置或已禁用".into(),
        });
    };

    let model = match provider.list_models().first() {
        Some(m) => m.id.clone(),
        None => {
            return Ok(ProviderTestResult {
                ok: false,
                elapsed_ms: 0,
                message: "provider 无可用模型".into(),
            });
        }
    };

    let req = ChatRequest {
        model,
        messages: vec![Message {
            role: Role::User,
            content: MessageContent::Text("ping".into()),
        }],
        tools: vec![],
        system: None,
        max_tokens: 1,
        temperature: 0.0,
    };

    let start = Instant::now();
    let timeout = Duration::from_secs(10);
    let result: Result<Result<(), ProviderError>, _> = tokio::time::timeout(timeout, async move {
        let mut stream = provider.stream_chat(req).await?;
        // 拿到第一个有效 chunk 就算通；如果是 Error chunk 转成 Err 走分类
        if let Some(ChatChunk::Error { message }) = stream.next().await {
            return Err(ProviderError::Other(message));
        }
        Ok(())
    })
    .await;

    let elapsed_ms = start.elapsed().as_millis() as u64;
    Ok(match result {
        Ok(Ok(())) => ProviderTestResult {
            ok: true,
            elapsed_ms,
            message: format!("OK ({elapsed_ms} ms)"),
        },
        Ok(Err(e)) => ProviderTestResult {
            ok: false,
            elapsed_ms,
            message: classify_for_user(&e),
        },
        Err(_) => ProviderTestResult {
            ok: false,
            elapsed_ms,
            message: "超时（10s）".into(),
        },
    })
}

/// 把 ProviderError 翻成 UI 友好的中文提示。
///
/// 公开为 `pub` 以便集成测试（`tests/providers_config_integration.rs`）
/// 能直接验证错误分类映射，而无需起 Tauri State / AppHandle。
pub fn classify_for_user(e: &ProviderError) -> String {
    match e {
        ProviderError::Unauthorized => "API key 无效（401/403）".into(),
        ProviderError::RateLimited => "触发限流（429）".into(),
        ProviderError::Http(_) | ProviderError::Timeout => format!("网络错误：{e}"),
        ProviderError::Protocol(s) => format!("协议错误：{s}"),
        _ => format!("{e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::ProviderConfig;

    /// 串行锁：本模块测试要改 std::env，跟 registry / settings::store 共用 ENV_LOCK。
    fn with_clean_env<F: FnOnce()>(f: F) {
        let _guard = crate::test_env_lock::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        // 保存现场
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
        // SAFETY: ENV_LOCK 串行 + 单线程修改 env
        unsafe {
            for k in &env_keys {
                std::env::remove_var(k);
            }
        }

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));

        unsafe {
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

    #[test]
    fn dto_未配置时_api_key_masked_为空() {
        with_clean_env(|| {
            let settings = AppSettings::default();
            let dotenv = HashMap::new();
            let dto = build_dto(
                ProviderKind::OpenAICompat(Preset::QwenDashScope),
                &settings,
                &dotenv,
            );
            assert_eq!(dto.id, "qwen");
            assert_eq!(dto.api_key_masked, "");
            assert_eq!(dto.key_source, KeySource::None);
            // 未配置默认启用
            assert!(dto.enabled);
            // 用户没填 base_url
            assert_eq!(dto.base_url, "");
            // 默认 base_url 来自 preset
            assert_eq!(
                dto.default_base_url,
                "https://dashscope.aliyuncs.com/compatible-mode/v1"
            );
        });
    }

    #[test]
    fn dto_settings_有_key_时_显示_masked_且_source_为_config() {
        with_clean_env(|| {
            let mut s = AppSettings::default();
            s.providers.map.insert(
                "deepseek".into(),
                ProviderConfig {
                    enabled: true,
                    api_key: "sk-deepseek-abcdefghijk1234".into(),
                    base_url: "https://example.com/v1".into(),
                },
            );
            let dotenv = HashMap::new();
            let dto = build_dto(
                ProviderKind::OpenAICompat(Preset::DeepSeek),
                &s,
                &dotenv,
            );
            assert_eq!(dto.id, "deepseek");
            assert_eq!(dto.key_source, KeySource::Config);
            // mask_api_key 保留前 3 / 后 4
            assert!(dto.api_key_masked.starts_with("sk-"));
            assert!(dto.api_key_masked.ends_with("1234"));
            assert!(dto.api_key_masked.contains('•'));
            assert_eq!(dto.base_url, "https://example.com/v1");
        });
    }

    #[test]
    fn dto_env_优先级高于_config() {
        let _guard = crate::test_env_lock::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let original = std::env::var("ZHIPU_API_KEY").ok();
        // SAFETY: ENV_LOCK 串行
        unsafe {
            std::env::set_var("ZHIPU_API_KEY", "sk-from-env-1234abcd");
        }

        let mut s = AppSettings::default();
        s.providers.map.insert(
            "zhipu".into(),
            ProviderConfig {
                enabled: true,
                api_key: "sk-from-config-9999".into(),
                base_url: String::new(),
            },
        );
        let dotenv = HashMap::new();
        let (resolved, src) = resolve_key(ProviderKind::OpenAICompat(Preset::Zhipu), &s, &dotenv);

        unsafe {
            if let Some(v) = original {
                std::env::set_var("ZHIPU_API_KEY", v);
            } else {
                std::env::remove_var("ZHIPU_API_KEY");
            }
        }

        assert_eq!(resolved, "sk-from-env-1234abcd");
        assert_eq!(src, KeySource::Env);
    }

    #[test]
    fn dto_anthropic_默认_base_url_正确() {
        with_clean_env(|| {
            let s = AppSettings::default();
            let dotenv = HashMap::new();
            let dto = build_dto(ProviderKind::Anthropic, &s, &dotenv);
            assert_eq!(dto.id, "anthropic");
            assert_eq!(dto.default_base_url, "https://api.anthropic.com/v1");
            assert!(!dto.models.is_empty());
        });
    }

    #[test]
    fn provider_kind_all_含_6_家() {
        let all = ProviderKind::all();
        assert_eq!(all.len(), 6);
        let ids: Vec<_> = all.iter().map(|k| k.id()).collect();
        assert!(ids.contains(&"deepseek"));
        assert!(ids.contains(&"qwen"));
        assert!(ids.contains(&"zhipu"));
        assert!(ids.contains(&"moonshot"));
        assert!(ids.contains(&"openai"));
        assert!(ids.contains(&"anthropic"));
    }

    #[test]
    fn is_known_id_拒绝未知() {
        assert!(is_known_id("qwen"));
        assert!(is_known_id("anthropic"));
        assert!(!is_known_id("not-real"));
        assert!(!is_known_id(""));
    }

    #[test]
    fn classify_for_user_映射() {
        assert_eq!(
            classify_for_user(&ProviderError::Unauthorized),
            "API key 无效（401/403）"
        );
        assert_eq!(
            classify_for_user(&ProviderError::RateLimited),
            "触发限流（429）"
        );
        assert!(classify_for_user(&ProviderError::Timeout).contains("网络错误"));
        assert!(classify_for_user(&ProviderError::Protocol("xx".into())).contains("协议错误"));
    }
}
