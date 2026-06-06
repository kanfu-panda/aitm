//! 工具调用编排：把 LLM 流式响应里的 tool_use 解析出来，
//! 经过安全门后调度 Tool 执行，结果喂回 LLM 进下一轮。

pub mod tool_loop;
