<div align="center">

# aitm

**An AI-native terminal for macOS.**

[Download](https://github.com/kanfu-panda/aitm/releases) ·
[Documentation](#documentation) ·
[中文](./README.zh-CN.md)

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS-lightgrey.svg)]()
[![Built with Tauri](https://img.shields.io/badge/Tauri-2.10-FFC131?logo=tauri&logoColor=white)](https://tauri.app)

</div>

---

## About

Most "AI terminals" bolt a chat panel onto an existing terminal. aitm is built the other direction: a tool-calling LLM is a first-class participant in the shell, with bounded access to your files, history, and processes — and every action passes through a 4-layer safety gate.

The terminal stays the workspace. The AI is a colleague in it, not a sidebar.

aitm is built with [Tauri 2](https://tauri.app), Rust, and React 19. The release binary is **5.3 MB** and starts in **3–5 ms**.

---

## Highlights

### Native by construction
No Electron. No web view stuffed with Node. The shell is real Rust talking to real PTYs through a 64 KB ring buffer. The UI is React rendered into a native WKWebView. Cold start is bound by macOS app launch, not by JavaScript.

### Tool-calling, not chat-pretending
The AI calls actual tools — `read_file`, `list_files`, `get_terminal_history`, `search_history`, `run_command` — and feeds the results back to itself in a bounded loop. Output is stripped of ANSI control sequences before the model sees it, so the model isn't reasoning about cursor escapes.

### Four-layer safety
HIGH-risk actions (anything mutating, anything reaching the network) require explicit user approval. LOW-risk reads happen silently. The four layers — blocklist regex, heuristic risk scoring, allowlist with metachar protection, and user confirmation — are independent: any one of them can stop a runaway agent.

### Multi-provider, BYO-key
Six providers out of the box: OpenAI, Anthropic, DeepSeek, Qwen (DashScope domestic + international), Zhipu, Moonshot. Bring your own API key. aitm holds nothing.

### Project scope
Run `aitm init` in a project directory to set a boundary. The AI's file tools stay inside it. A `MEMORY.md` at the root or `~/.aitm/MEMORY.md` globally is auto-injected into the system prompt.

---

## Installation

### Download

```bash
# Download the latest dmg
open https://github.com/kanfu-panda/aitm/releases/latest
```

aitm is signed and notarized by Apple. Drag `aitm.app` into `Applications` and launch.

### Homebrew

```bash
brew install --cask kanfu-panda/tap/aitm
```

### Build from source

```bash
git clone https://github.com/kanfu-panda/aitm.git
cd aitm
pnpm install
pnpm tauri dev
```

Requires Rust (pinned in `rust-toolchain.toml`), pnpm 10.x, and macOS.

---

## Roadmap

aitm 1.0 ships the core experience: terminal, AI loop, safety, project scope. Beyond 1.0:

- [ ] Keychain-backed API key storage
- [ ] First-class Windows support
- [ ] Plugin system for custom tools
- [ ] Linux build
- [ ] L2 risk scoring extensibility

Status updates land in [CHANGELOG.md](./CHANGELOG.md).

---

## Documentation

- [User guide](./docs/) — installation, configuration, AI providers
- [Architecture](./docs/ARCHITECTURE.md) — internals, IPC layer, tool loop
- [Contributing](./CONTRIBUTING.md) — development setup, conventions
- [Privacy](./docs/PRIVACY.md) — what aitm sends home (anonymous usage stats only, opt-out at any time)

---

## Contributing

Issues and pull requests are welcome. For non-trivial changes, open an issue first to discuss the direction — both because aitm has architectural opinions worth aligning on, and because bandwidth for review is finite.

```bash
# Run the full test suite
cd src-tauri && cargo test -p aitm
cargo clippy --all-targets -- -D warnings
cd .. && pnpm typecheck && pnpm lint && pnpm test
pnpm exec playwright test
```

All gates must pass before merging to `main`.

---

## License

[Apache 2.0](./LICENSE).

Copyright © 2026 [kanfu-panda](https://github.com/kanfu-panda).
