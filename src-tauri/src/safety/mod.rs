//! AI 命令安全门（spec §9）。
//!
//! 4 层防线：
//! - **L1 黑名单**（本 phase 实现）：硬正则拦截已知危险命令
//! - **L2 风险评分**：1E-2 引入（DESTRUCTIVE / HIGH / LOW 启发式）
//! - **L3 白名单**：1E-2 引入（用户配置 glob 匹配 → 自动批准）
//! - **L4 用户确认**：本 phase 实现（按 risk 弹不同确认 UI）

pub mod blacklist;
pub mod risk;
pub mod whitelist;
