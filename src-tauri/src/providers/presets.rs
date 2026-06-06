//! 预设 OpenAI 兼容 provider 配置（base_url + 模型列表）。
//!
//! 用户用 `make_config` 加 API key 即可快速创建客户端。

use super::openai_compat::OpenAICompatConfig;
use super::ModelInfo;

/// 预设标识符。新增预设在这里加。
#[derive(Debug, Clone, Copy)]
pub enum Preset {
    DeepSeek,
    QwenDashScope,
    Zhipu,
    MoonshotKimi,
    OpenAIOfficial,
}

impl Preset {
    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            "deepseek" => Some(Self::DeepSeek),
            "qwen" => Some(Self::QwenDashScope),
            "zhipu" => Some(Self::Zhipu),
            "moonshot" => Some(Self::MoonshotKimi),
            "openai" => Some(Self::OpenAIOfficial),
            _ => None,
        }
    }

    pub fn id(&self) -> &'static str {
        match self {
            Self::DeepSeek => "deepseek",
            Self::QwenDashScope => "qwen",
            Self::Zhipu => "zhipu",
            Self::MoonshotKimi => "moonshot",
            Self::OpenAIOfficial => "openai",
        }
    }

    pub fn display_name(&self) -> &'static str {
        match self {
            Self::DeepSeek => "DeepSeek",
            Self::QwenDashScope => "Qwen (DashScope)",
            // v0.10.5：原 "智谱 GLM" 中文在英/日 UI 下显示突兀；统一英文公司名。
            // 前端 ProviderList 渲染 provider.name 字符串直接，不再 i18n 映射。
            Self::Zhipu => "Zhipu GLM",
            Self::MoonshotKimi => "Moonshot Kimi",
            Self::OpenAIOfficial => "OpenAI",
        }
    }

    pub fn base_url(&self) -> &'static str {
        match self {
            Self::DeepSeek => "https://api.deepseek.com/v1",
            Self::QwenDashScope => "https://dashscope.aliyuncs.com/compatible-mode/v1",
            Self::Zhipu => "https://open.bigmodel.cn/api/paas/v4",
            Self::MoonshotKimi => "https://api.moonshot.cn/v1",
            Self::OpenAIOfficial => "https://api.openai.com/v1",
        }
    }

    pub fn models(&self) -> Vec<ModelInfo> {
        match self {
            Self::DeepSeek => vec![
                ModelInfo { id: "deepseek-chat".into(), display_name: "DeepSeek Chat".into(), context_window: 128_000 },
                ModelInfo { id: "deepseek-coder".into(), display_name: "DeepSeek Coder".into(), context_window: 128_000 },
            ],
            Self::QwenDashScope => vec![
                ModelInfo { id: "qwen3-coder-plus".into(), display_name: "Qwen3 Coder Plus".into(), context_window: 128_000 },
                ModelInfo { id: "qwen-max".into(), display_name: "Qwen Max".into(), context_window: 128_000 },
                ModelInfo { id: "qwen-plus".into(), display_name: "Qwen Plus".into(), context_window: 128_000 },
            ],
            Self::Zhipu => vec![
                ModelInfo { id: "glm-4.6".into(), display_name: "GLM 4.6".into(), context_window: 128_000 },
                ModelInfo { id: "glm-4-air".into(), display_name: "GLM 4 Air".into(), context_window: 128_000 },
            ],
            Self::MoonshotKimi => vec![
                ModelInfo { id: "kimi-k2-0905-preview".into(), display_name: "Kimi K2".into(), context_window: 128_000 },
                ModelInfo { id: "moonshot-v1-32k".into(), display_name: "Moonshot V1 32K".into(), context_window: 32_000 },
            ],
            Self::OpenAIOfficial => vec![
                ModelInfo { id: "gpt-4o".into(), display_name: "GPT-4o".into(), context_window: 128_000 },
                ModelInfo { id: "gpt-4o-mini".into(), display_name: "GPT-4o Mini".into(), context_window: 128_000 },
            ],
        }
    }

    /// 创建一个 OpenAICompatConfig（待用户填 API key）。
    pub fn make_config(&self, api_key: impl Into<String>) -> OpenAICompatConfig {
        OpenAICompatConfig {
            id: self.id().to_string(),
            display_name: self.display_name().to_string(),
            base_url: self.base_url().to_string(),
            api_key: api_key.into(),
            models: self.models(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_id_全部预设可识别() {
        assert!(matches!(Preset::from_id("deepseek"), Some(Preset::DeepSeek)));
        assert!(matches!(Preset::from_id("qwen"), Some(Preset::QwenDashScope)));
        assert!(matches!(Preset::from_id("zhipu"), Some(Preset::Zhipu)));
        assert!(matches!(Preset::from_id("moonshot"), Some(Preset::MoonshotKimi)));
        assert!(matches!(Preset::from_id("openai"), Some(Preset::OpenAIOfficial)));
        assert!(Preset::from_id("xx").is_none());
    }

    #[test]
    fn 每家预设至少有一个模型() {
        for p in [
            Preset::DeepSeek,
            Preset::QwenDashScope,
            Preset::Zhipu,
            Preset::MoonshotKimi,
            Preset::OpenAIOfficial,
        ] {
            assert!(!p.models().is_empty(), "{} 缺模型", p.id());
        }
    }

    #[test]
    fn make_config_注入_api_key() {
        let cfg = Preset::DeepSeek.make_config("sk-test");
        assert_eq!(cfg.api_key, "sk-test");
        assert_eq!(cfg.id, "deepseek");
        assert_eq!(cfg.base_url, "https://api.deepseek.com/v1");
    }
}
