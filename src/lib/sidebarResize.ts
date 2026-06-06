/**
 * v0.6.0-A T3：SplitDivider 集成到 sidebar 时的 store / IPC 桥接 helper。
 *
 * 设计：
 * - 拖动期间（mousemove 60fps）：只走 `useSettingsStore.setState` 本地内存，
 *   不触发 debounced IPC 写 TOML（避免每 frame 重启 timer + 拖完才落盘 1 次）。
 * - mouseup（SplitDivider onCommit）：主动调一次 `settingsUpdate`，把当前完整
 *   AppSettings 持久化到 TOML；IPC 层会 clamp 到 [180, 600]。
 *
 * 抽到 lib 而非 App.tsx 内部，是为了单测能 import + mock。
 */

import { useSettingsStore } from "../stores/settings";
import { settingsUpdate } from "./tauri";

export function updateFileTreeWidthLocal(next: number) {
  useSettingsStore.setState((s) => ({
    settings: {
      ...s.settings,
      ui: { ...s.settings.ui, file_tree_width: next },
    },
  }));
}

export function updateAiSidebarWidthLocal(next: number) {
  useSettingsStore.setState((s) => ({
    settings: {
      ...s.settings,
      ui: { ...s.settings.ui, ai_sidebar_width: next },
    },
  }));
}

export function commitSidebarSettings() {
  const current = useSettingsStore.getState().settings;
  return settingsUpdate(current).catch((e) =>
    console.error("settings_update 失败", e),
  );
}
