# Changelog

All notable changes to aitm will be documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.1] — 2026-08-10

### Added

- **In-app updates on macOS.** A new **About** page in Settings shows the current version and checks for updates on demand. When a newer version exists, aitm downloads it, verifies its signature, installs it and restarts — no more downloading a `.dmg` and dragging it over the old app. The macOS **About aitm** menu item and the status-bar update badge both open this page.
  - Windows is not covered yet and keeps the existing behaviour: you get a notice and a link to the installer.
  - The update itself only becomes available from the *next* release onward — 1.3.0 and earlier ship without the updater, so those need one manual install first.

### Fixed

- **The update notice offered the wrong installer.** It always linked the macOS `.dmg`, so Windows users were handed a package they could not install. The download link now matches the platform you are running, and falls back to the release page when no build exists for it.
- **Links in Settings did nothing when clicked.** External links now open in the system browser as intended.

## [1.3.0] — 2026-08-05

This release turns the built-in AI from a read-only assistant into one that can actually do the work — edit files, run commands it can verify, and drive the embedded browser — and adds Claude Code skills support.

### Added

- **File editing.** New `write_file` and `edit_file` tools let the AI create and modify files. Both are sandboxed to the working directory and require approval, and the approval dialog now shows a real **diff** of what will change instead of raw arguments
- **Claude Code skills compatibility.** Skills installed under `~/.claude/skills/`, a project's `.claude/skills/`, and Claude Code plugin marketplaces are all discovered automatically. The AI searches them on demand with `list_skills(query)` and loads the full instructions with `load_skill(name)` — only a short usage hint lives in the system prompt, so hundreds of skills cost almost no context
- **Stop and retry.** Streaming replies can be interrupted with a stop button (partial output is kept), and any finished, stopped, or failed reply can be regenerated
- **The AI can open the browser itself.** Previously it had to ask you to click the globe icon; `browser_open` now opens the panel and navigates in one step
- **Session-scoped approval.** High-risk tools offer "allow for this session" so a multi-file edit isn't interrupted by a dialog per file. Auto-approved calls are always labeled in the UI
- **Hallucination warning.** If a reply claims it completed something (navigated, wrote a file, ran a command) but no matching tool was actually called that turn, the message is flagged. Some models assert success without acting; this makes it visible instead of silent
- **Tool call history.** Tool calls, their results, and diffs now survive a restart instead of leaving only plain text behind
- Tool execution time is shown on each tool call

### Changed

- **`run_command` reports real completion and exit codes.** It used to wait a fixed 5 seconds and return whatever had arrived, so long commands looked finished when they weren't and the AI never knew whether they succeeded. It now detects actual command completion via shell integration hooks (zsh/bash) and reports `[exit code: N]`; commands still running after 120s are reported as such rather than as finished
- **Read-only tools run in parallel.** Reading several files at once no longer queues them one by one; tools with side effects stay strictly sequential and results are always returned in the original order
- **Context window budgeting.** Long conversations are trimmed automatically against the model's context window, keeping the system prompt, the first message, and recent turns — previously history grew without bound
- **Transient LLM failures retry with backoff.** A network blip or rate limit no longer ends the whole conversation
- **Prompt caching for Anthropic models**, cutting repeated input tokens on the stable prefix

### Fixed

- **Blank pages in the embedded browser** on sites that check the User-Agent (for example baidu.com). macOS child webviews had no explicit UA, so such sites served a downgrade redirect that then failed. A full Safari UA is now set
- **Terminal scrollback was lost when closing the file preview**, which also broke scrolling inside full-screen TUIs. Closing the preview no longer rebuilds the terminal
- **File tree collapsed on every filesystem change.** Refreshes are now incremental — only the affected directory reloads, and expansion state and scroll position are preserved
- **File preview could take over the entire area**, leaving no terminal
- **The AI could operate a browser tab other than the visible one.** When the active tab can't be determined the AI now gets an explicit error instead of a random tab, and stale tab references are rejected
- `browser_navigate` waits for the page to actually finish loading before reporting success
- Development logs are no longer flooded by third-party trace output

### Security

- **`run_command` is excluded from session-scoped approval.** Tool-level approval is too coarse for it — one tool name covers unlimited commands. Use the command allowlist in Settings for that
- **Destructive operations never offer "allow for this session"** and still require typing a confirmation
- `browser_eval` is now classified by script content: read-only expressions ask for ordinary approval, while anything touching storage, network, navigation, or the DOM still requires explicit confirmation
- `load_skill` rejects path traversal, keeping file reads inside the skill's own directory

## [1.1.1] — 2026-07-19

### Added

- Dock badge now lights up for every notification (bell / OSC / AI completion), tracked as per-tab unread plus a red Dock count — no longer suppressed by window-focus state, so completions in a background tab are still visible
- File tree auto-refreshes on external filesystem changes via a native watcher (macOS FSEvents, debounced); `.git`, `node_modules`, and `target` are filtered to avoid event storms
- Switching or activating a tab immediately focuses its terminal (or editor) — no extra click needed
- Markdown preview polish: systematic `.prose-md` styling (heading hierarchy, tables, code blocks, quotes, inline code) and syntax-highlighted code blocks that follow the dark/light theme
- Rounded corners unified across panels, tabs, buttons, inputs, and dialogs

### Changed

- Terminal tabs restyled to a VS Code–style per-group tab bar with a bottom active-tab indicator
- Clicking a file in the tree now auto-expands the preview pane when it was collapsed

### Fixed

- Dock badge rewritten to native AppKit (`NSApp.dockTile().setBadgeLabel()`), working around a macOS Tauri `setBadgeCount` bug so the badge reliably appears
- Notification events are now delivered to the main webview (`emit_to`), fixing bell/OSC notifications that never reached the frontend under Tauri 2's multi-webview model
- Restored the "close a running tab" confirmation dialog that was lost during the split-pane refactor
- Fixed dropped keystrokes — swallowed spaces after `cd` and during fast typing — with a data-driven re-injection timer that leaves IME / Chinese input untouched
- Terminal no longer snaps back to the bottom after the user scrolls up

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
