//! 工具注册表：跨整个 app 共享的 Tool 实例池。
//!
//! orchestrator 拿到 LLM 返回的 tool_use 后，按 name 找到 Arc<dyn Tool>
//! 调 execute；同时启动时把 to_tool_defs() 喂给 provider。

use std::collections::HashMap;
use std::sync::Arc;

use crate::providers::types::ToolDef;

use super::browser::{
    BrowserClickTool, BrowserEvalTool, BrowserFillTool, BrowserNavigateTool,
    BrowserSnapshotTool,
};
use super::list_files::ListFilesTool;
use super::read_file::ReadFileTool;
use super::run_command::RunCommandTool;
use super::terminal_history::{GetTerminalHistoryTool, SearchHistoryTool};
use super::Tool;

pub struct ToolRegistry {
    tools: HashMap<String, Arc<dyn Tool>>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self {
            tools: HashMap::new(),
        }
    }

    /// 注册默认工具集（5 文件 / 终端 + 5 浏览器 = 10 个）。
    pub fn with_defaults() -> Self {
        let mut r = Self::new();
        r.register(Arc::new(ReadFileTool));
        r.register(Arc::new(ListFilesTool));
        r.register(Arc::new(GetTerminalHistoryTool));
        r.register(Arc::new(SearchHistoryTool));
        r.register(Arc::new(RunCommandTool));
        // v0.5.0-E：Scriptable Browser API
        r.register(Arc::new(BrowserSnapshotTool));
        r.register(Arc::new(BrowserNavigateTool));
        r.register(Arc::new(BrowserClickTool));
        r.register(Arc::new(BrowserFillTool));
        r.register(Arc::new(BrowserEvalTool));
        r
    }

    pub fn register(&mut self, t: Arc<dyn Tool>) {
        self.tools.insert(t.name().to_string(), t);
    }

    pub fn get(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.tools.get(name).cloned()
    }

    pub fn list_names(&self) -> Vec<String> {
        self.tools.keys().cloned().collect()
    }

    /// 转成喂给 provider 的 ToolDef 列表。
    pub fn to_tool_defs(&self) -> Vec<ToolDef> {
        self.tools
            .values()
            .map(|t| ToolDef {
                name: t.name().to_string(),
                description: t.description().to_string(),
                input_schema: t.input_schema(),
            })
            .collect()
    }
}

impl Default for ToolRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn with_defaults_注册了_10_个工具() {
        let r = ToolRegistry::with_defaults();
        let mut names = r.list_names();
        names.sort();
        assert_eq!(
            names,
            vec![
                "browser_click",
                "browser_eval",
                "browser_fill",
                "browser_navigate",
                "browser_snapshot",
                "get_terminal_history",
                "list_files",
                "read_file",
                "run_command",
                "search_history",
            ]
        );
    }

    #[test]
    fn get_未注册的_工具_none() {
        let r = ToolRegistry::with_defaults();
        assert!(r.get("nonexistent").is_none());
        assert!(r.get("read_file").is_some());
    }

    #[test]
    fn to_tool_defs_含_10_条且字段非空() {
        // v0.5.0-E：5 文件/终端类 + 5 浏览器类 = 10
        let r = ToolRegistry::with_defaults();
        let defs = r.to_tool_defs();
        assert_eq!(defs.len(), 10);
        for d in &defs {
            assert!(!d.name.is_empty());
            assert!(!d.description.is_empty());
            assert_eq!(d.input_schema["type"], "object");
        }
    }

    #[test]
    fn to_tool_defs_serialize_含_openai_期望字段() {
        // OpenAI tool 格式：{type: function, function: {name, description, parameters}}
        // 但 provider 适配器自己包 type/function 那层；ToolDef 只需提供 name/description/input_schema
        let r = ToolRegistry::with_defaults();
        let read_file = r
            .to_tool_defs()
            .into_iter()
            .find(|d| d.name == "read_file")
            .unwrap();
        let json = serde_json::to_value(&read_file).unwrap();
        assert_eq!(json["name"], "read_file");
        assert!(json["description"].as_str().unwrap().contains("文件"));
        // input_schema.properties.path 存在
        assert!(json["input_schema"]["properties"]["path"].is_object());
        assert_eq!(json["input_schema"]["required"][0], "path");
    }

    #[test]
    fn to_tool_defs_anthropic_适配_input_schema_是_object() {
        // Anthropic 期望 { name, description, input_schema: {...} }
        // 我们的 ToolDef 字段命名跟 Anthropic 完全一致，零拷贝
        let r = ToolRegistry::with_defaults();
        for d in r.to_tool_defs() {
            assert_eq!(d.input_schema["type"], "object");
            // properties 字段存在（即使是空 object）
            assert!(d.input_schema.get("properties").is_some());
        }
    }
}
