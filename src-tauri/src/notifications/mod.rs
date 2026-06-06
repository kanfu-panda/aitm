//! v0.5.0-A 通知子系统：PTY OSC 协议解析 + AI 工具循环触发 + 系统通知。
//!
//! 入口：`OscParser`（流式 OSC 解析器，喂入 bytes 出 NotificationEvent）+
//! `NotificationEvent` 数据模型（前后端共用，emit 给前端 zustand store）。

pub mod osc_parser;
pub mod types;

pub use osc_parser::OscParser;
pub use types::{NotificationEvent, NotificationLevel, NotificationSource};
