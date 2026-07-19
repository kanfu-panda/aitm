//! 通知数据模型，前后端共用（前端通过 IPC event payload 反序列化）。
//!
//! 设计要点（plan §2.5）：
//! - **优先级**：waiting > error > done > running。前端 store 按此决定状态环颜色覆盖
//! - **source** 标识便于调试 + 未来"通知历史"面板
//! - **timestamp_ms**：epoch milliseconds，前端 Cmd+Shift+U 排序用

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NotificationLevel {
    /// AI streaming / 命令运行中。tab ring sky。**不**发系统通知（避免打扰用户当下操作）
    Running,
    /// AI 等审批 / OSC 99 level=warning。tab ring amber + pulse 动画。发系统通知
    Waiting,
    /// AI 完成 / OSC 9 generic / OSC 777 notify。tab ring emerald。发系统通知（可配置）
    Done,
    /// AI 工具失败 / OSC 99 level=error。tab ring rose。发系统通知
    Error,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NotificationSource {
    /// aitm AI 工具循环主动发（差异化核心 — cmux 没有这个源）
    AiToolLoop,
    /// PTY 输出解析到 OSC 9（iTerm2/cmux 流派）
    Osc9,
    /// PTY 输出解析到 OSC 99（cmux 自定义，带 level metadata）
    Osc99,
    /// PTY 输出解析到 OSC 777（urxvt notify 流派）
    Osc777,
    /// PTY 输出中的孤立 BEL (0x07) — 终端响铃。Claude Code 等 CLI 完成时响铃；
    /// macOS Terminal 以响铃点亮 Dock 角标，aitm 对齐该语义。
    /// 前端只点未读 + Dock 角标，**不**发系统通知横幅（响铃可能高频，如补全提示音）
    Bell,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NotificationEvent {
    /// 关联的后端 session id；前端通过 sessionId → tabId 路由到对应 tab
    pub session_id: String,
    pub level: NotificationLevel,
    /// 通知文案；空时前端用默认值（"AI 完成" / "AI 等审批" 等）
    pub message: String,
    pub source: NotificationSource,
    pub timestamp_ms: u64,
}
