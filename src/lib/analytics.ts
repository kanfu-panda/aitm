import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../stores/settings";

/**
 * v0.7.0-A：匿名使用统计 wrapper。
 *
 * - 读 `settings.privacy.analytics_opt_in`，关时静默 noop（不调 Aptabase）。
 * - Aptabase 调用失败永远不冒出（服务挂了 / Tauri 还没 ready 时调用都不致命）。
 *
 * **严禁**传 PII：终端命令 / 文件路径 / chat content / URL / API key / 任何用户数据。
 * 只传 categorical 值（如 provider id "deepseek"、tool name "read_file"、
 * settings section "ui"）或纯计数 number。
 *
 * v0.10.1：直接 invoke plugin 命令而非用 @aptabase/tauri SDK。后者 0.4.1
 * import 自 `@tauri-apps/api`（v1 默认入口），Tauri 2 这条路径走废弃的
 * `window.__TAURI_IPC__` global → 真机抛 "is not a function" Promise rejection。
 * Tauri 2 标准是 `@tauri-apps/api/core` 的 invoke，走 `__TAURI_INTERNALS__`。
 * SDK 内部就一行 `invoke("plugin:aptabase|track_event", { name, props })`，
 * 自己写比维护 fork 简单。
 *
 * @param name event 名（snake_case 习惯，如 `ai_chat_sent` / `tab_opened`）
 * @param props 可选 categorical props；Aptabase 只接受 string / number 值
 */
export function trackEvent(
  name: string,
  props?: Record<string, string | number>,
): void {
  try {
    const optIn =
      useSettingsStore.getState().settings.privacy.analytics_opt_in;
    if (!optIn) return;
    void invoke("plugin:aptabase|track_event", { name, props }).catch(() => {
      /* noop —— 上报失败不致命，应用照常跑 */
    });
  } catch {
    /* noop —— 上报失败不致命，应用照常跑 */
  }
}
