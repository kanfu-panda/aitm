# Changelog

All notable changes to aitm will be documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-05-28

First public release.

### Terminal

- Multi-tab PTY with WebGL rendering (xterm.js 5.5)
- Split panes — horizontal and vertical, drag tabs across groups
- 8 themes — Dracula, Solarized Dark/Light, One Dark, Homebrew, Warp, Catppuccin Mocha, Default
- Font size scaling (`Cmd++` / `Cmd+-` / `Cmd+0`)
- Per-tab working directory restoration across restarts
- macOS-native notifications and tab badges
- 64 KB ring buffer for terminal output history

### File workspace

- File tree with git status coloring (modified, added, deleted, untracked, ignored)
- Right-click CRUD on files and folders
- Built-in CodeMirror editor with VS Code Dark+/Light+ themes
- External file change detection with conflict-resolution dialog
- Click URLs in terminal output to open in built-in browser

### AI

- Six providers — OpenAI, Anthropic, DeepSeek, Qwen (DashScope domestic + international), Zhipu, Moonshot
- Bring-your-own API key, stored locally
- Tool-calling loop with five built-in tools: `read_file`, `list_files`, `get_terminal_history`, `search_history`, `run_command`
- ANSI control sequences stripped from tool output before feeding to the model
- 10-step loop cap per session
- Multi-conversation history persisted to SQLite
- Active context auto-injection — current terminal cwd, browser URL, editor file
- VS Code-style collapsible tool-call cards in chat

### Safety

- Four-layer safety gate, each independently blocking:
  - **L1** — Blocklist regex (`rm -rf /`, `dd of=/dev/...`, `mkfs.*`, fork bomb)
  - **L2** — Heuristic risk scoring (DESTRUCTIVE / HIGH / LOW)
  - **L3** — Allowlist with globset patterns and metachar injection prevention
  - **L4** — User confirmation dialog for HIGH-risk actions

### Project scope

- `aitm init` to mark a directory as a project boundary
- AI file tools constrained to project boundary
- `MEMORY.md` auto-injection (global `~/.aitm/MEMORY.md` and per-project)
- Project-scoped conversation buckets

### Configuration

- Three-source merge — `std::env > ~/.aitm/.env > ~/.aitm/config.toml`
- TOML-persisted settings, no restart on key changes
- Provider configuration UI

### Internationalization

- English (default), 中文, 日本語
- Switch language without restart
- Includes macOS NSMenu

### Performance

- 5.3 MB binary
- 3–5 ms cold start
- 8–9 MB RSS for 5 concurrent PTY sessions

---

Earlier development history (v0.1.0 through v0.10.6) is preserved in the internal repository and not included in the public release.
