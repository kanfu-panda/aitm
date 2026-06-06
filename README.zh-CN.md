<div align="center">

# aitm

**面向 macOS 的 AI 原生终端。**

[下载](https://github.com/kanfu-panda/aitm/releases) ·
[文档](#文档) ·
[English](./README.md)

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS-lightgrey.svg)]()
[![Built with Tauri](https://img.shields.io/badge/Tauri-2.10-FFC131?logo=tauri&logoColor=white)](https://tauri.app)

</div>

---

## 关于

大多数「AI 终端」只是在已有终端上贴一块对话面板。aitm 反过来设计：一个有工具调用能力的 LLM 是 shell 中的一等参与者，对你的文件、历史和进程拥有**有边界的**访问能力——并且每个动作都要通过 4 层安全门。

终端依然是工作区。AI 是其中的同事，不是侧边栏。

aitm 由 [Tauri 2](https://tauri.app)、Rust 和 React 19 构建。Release 二进制 **5.3 MB**，冷启动 **3-5 毫秒**。

---

## 核心特点

### 原生构造
不是 Electron。也不是塞着 Node 的 webview。Shell 是真实的 Rust 通过 64 KB 环形缓冲与真实 PTY 通信。UI 是 React 渲染到原生 WKWebView。冷启动受限于 macOS 应用启动本身，而非 JavaScript。

### 工具调用，不是假装聊天
AI 调用真实的工具——`read_file`、`list_files`、`get_terminal_history`、`search_history`、`run_command`——并在有界循环中把结果喂回自己。输出在喂给模型之前会剥离 ANSI 控制序列，模型不会被光标转义码绊住。

### 四层安全门
HIGH 风险动作（任何修改、任何外网请求）需要用户显式批准。LOW 风险的读取静默执行。四层——黑名单正则、启发式风险评分、带元字符防护的白名单、用户确认弹窗——彼此独立：任何一层都能拦下失控的 agent。

### 多 Provider，自带密钥
开箱即用六家 Provider：OpenAI、Anthropic、DeepSeek、Qwen（DashScope 国内 + 海外）、智谱、Moonshot。自带 API Key，aitm 本身不持有任何凭证。

### 项目作用域
在项目目录下运行 `aitm init` 设定边界。AI 的文件工具会留在边界内。项目根的 `MEMORY.md` 或全局 `~/.aitm/MEMORY.md` 会自动注入到 system prompt。

---

## 安装

### 下载

```bash
# 下载最新 dmg
open https://github.com/kanfu-panda/aitm/releases/latest
```

aitm 已通过 Apple 签名和公证。把 `aitm.app` 拖到 `Applications` 启动即可。

### Homebrew

```bash
brew install --cask kanfu-panda/tap/aitm
```

### 从源码构建

```bash
git clone https://github.com/kanfu-panda/aitm.git
cd aitm
pnpm install
pnpm tauri dev
```

需要 Rust（在 `rust-toolchain.toml` 中锁定版本）、pnpm 10.x，以及 macOS。

---

## 路线图

aitm 1.0 交付核心体验：终端、AI 循环、安全门、项目作用域。1.0 之后：

- [ ] Keychain 后端的 API Key 存储
- [ ] 一等 Windows 支持
- [ ] 自定义工具的插件系统
- [ ] Linux 构建
- [ ] L2 风险评分可扩展性

进展更新见 [CHANGELOG.md](./CHANGELOG.md)。

---

## 文档

- [用户手册](./docs/) — 安装、配置、AI Provider
- [架构](./docs/ARCHITECTURE.md) — 内部结构、IPC 层、工具循环
- [贡献指南](./CONTRIBUTING.md) — 开发环境、约定
- [隐私](./docs/PRIVACY.md) — aitm 上报什么（仅匿名使用统计，可随时关闭）

---

## 贡献

欢迎提 Issue 和 PR。对于非小型改动，请先开 Issue 讨论方向——一方面 aitm 在架构上有明确取向值得对齐，另一方面 review 带宽有限。

```bash
# 跑完整测试
cd src-tauri && cargo test -p aitm
cargo clippy --all-targets -- -D warnings
cd .. && pnpm typecheck && pnpm lint && pnpm test
pnpm exec playwright test
```

合并到 `main` 之前所有质量门必须全绿。

---

## 协议

[Apache 2.0](./LICENSE)。

Copyright © 2026 [kanfu-panda](https://github.com/kanfu-panda)。
