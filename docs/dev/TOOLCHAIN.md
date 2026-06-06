# 工具链版本

Phase 0 脚手架时记录。每次大版本升级后更新。

## 当前已安装（开发机，2026-04-27）

| 工具 | 版本 | 最低要求 |
|------|------|---------|
| rustc | rustc 1.95.0 (59807616e 2026-04-14) | 1.85+ stable |
| cargo | cargo 1.95.0 (f2d3ce0bd 2026-03-21) | 随 rustc 自带 |
| node | v22.16.0 | 22 LTS 或 24 LTS |
| pnpm | 10.33.0 | 10.x |
| cargo-tauri | tauri-cli 2.10.1 | 2.9.5+ |

## 固定策略

- Rust → `rust-toolchain.toml`（`stable`）
- Node → `.nvmrc`（22）+ Homebrew `node@22`
- pnpm → `package.json` 的 `packageManager` 字段
- Cargo 依赖 → `Cargo.toml` 中精确小版本（不用 `^`，不用 `*`）
- npm 依赖 → `package.json` 中用 `~`（仅允许 patch 升级）

升级节奏见 spec §3.2（patch 自动 / minor 月审 / major 单独 issue）。

## 历史升级

- 2026-04-27：初始记录。Rust 从无到 stable；Node 20.19.2 → 22.x（避开 v20 EOL）。
