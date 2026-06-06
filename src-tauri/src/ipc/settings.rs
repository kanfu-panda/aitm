//! settings 相关 IPC 命令。

use tauri::State;
use tokio::sync::Mutex;

use crate::settings::{store, AppSettings};

/// 全局 settings 状态（注册到 Tauri Builder.manage）。
pub struct SettingsState {
    pub current: Mutex<AppSettings>,
}

impl SettingsState {
    /// 启动时从磁盘加载；不存在或损坏 → 默认值。
    pub fn new() -> Self {
        Self {
            current: Mutex::new(store::load()),
        }
    }
}

impl Default for SettingsState {
    fn default() -> Self {
        Self::new()
    }
}

#[tauri::command]
pub async fn settings_get(state: State<'_, SettingsState>) -> Result<AppSettings, String> {
    Ok(state.current.lock().await.clone())
}

/// v0.6.0-A：UiSettings.{file_tree_width, ai_sidebar_width} 的 IPC 层 clamp 范围。
/// 跟前端 SplitDivider 的 min/max 一致；用户在 dev console 或手改 toml 越界时兜底。
const PANEL_WIDTH_MIN: u32 = 180;
const PANEL_WIDTH_MAX: u32 = 600;

#[tauri::command]
pub async fn settings_update(
    settings: AppSettings,
    state: State<'_, SettingsState>,
) -> Result<(), String> {
    // 关键：前端 TS 的 AppSettings 类型只含 terminal/shell/safety，没有 providers，
    // 直接 save 会让 serde default 把 providers.map 设为空 → 覆盖磁盘上的 provider 配置
    // 用户在 UI 配的 Qwen API key 改主题/字号后被静默清空。
    //
    // 修复：服务端 merge —— 保留当前 providers，只接受 terminal/shell/safety。
    // providers 改动必须走专用 providers_save_config IPC。
    let mut guard = state.current.lock().await;
    let mut merged = settings;
    merged.providers = guard.providers.clone();

    // v0.6.0-A：sidebar 宽度 clamp 到 [180, 600]。
    // file_preview_dialog 不 clamp（前端逻辑处理 off-screen reset）。
    merged.ui.file_tree_width = merged.ui.file_tree_width.clamp(PANEL_WIDTH_MIN, PANEL_WIDTH_MAX);
    merged.ui.ai_sidebar_width = merged.ui.ai_sidebar_width.clamp(PANEL_WIDTH_MIN, PANEL_WIDTH_MAX);

    *guard = merged.clone();
    store::save(&merged).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn settings_reset(state: State<'_, SettingsState>) -> Result<AppSettings, String> {
    let defaults = AppSettings::default();
    *state.current.lock().await = defaults.clone();
    store::save(&defaults).map_err(|e| e.to_string())?;
    Ok(defaults)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{ProviderConfig, ProvidersSettings};
    use std::collections::HashMap;

    /// 复用 settings_update 内部的 clamp 逻辑做单测；与正式 IPC handler 必须保持同步。
    /// 单测无法直接构造 Tauri `State<SettingsState>`，所以这里用纯函数 mirror。
    fn clamp_panel_widths(s: &mut AppSettings) {
        s.ui.file_tree_width = s.ui.file_tree_width.clamp(PANEL_WIDTH_MIN, PANEL_WIDTH_MAX);
        s.ui.ai_sidebar_width = s.ui.ai_sidebar_width.clamp(PANEL_WIDTH_MIN, PANEL_WIDTH_MAX);
    }

    /// 回归测：前端 TS `AppSettings` 没 providers 字段，settings_update 直接 save 会让 serde default 把 providers.map 清空，覆盖磁盘上的 Qwen 等用户配置。修复后必须保留 providers。
    #[test]
    fn settings_update_merge_保留_providers() {
        // 模拟磁盘上的当前 settings：含 Qwen 配置
        let mut current = AppSettings::default();
        let mut map = HashMap::new();
        map.insert(
            "qwen".into(),
            ProviderConfig {
                enabled: true,
                api_key: "sk-existing".into(),
                base_url: "".into(),
            },
        );
        current.providers = ProvidersSettings { map };

        // 模拟前端发来的 settings（providers 为空，符合前端 TS 类型）
        let from_frontend = AppSettings {
            terminal: current.terminal.clone(),
            shell: current.shell.clone(),
            providers: ProvidersSettings::default(), // 前端不含 providers → 默认空
            safety: current.safety.clone(),
            browser: current.browser.clone(),
            ui: current.ui,
            notifications: current.notifications.clone(),
            privacy: current.privacy.clone(),
            editor: current.editor.clone(),
        };

        // 复用 merge 逻辑（与 settings_update 一致）
        let mut merged = from_frontend;
        merged.providers = current.providers.clone();

        // 验证：Qwen 配置必须保留
        assert_eq!(merged.providers.map.len(), 1);
        let qwen = merged.providers.map.get("qwen").unwrap();
        assert_eq!(qwen.api_key, "sk-existing");
        assert!(qwen.enabled);
    }

    // ===== v0.6.0-A T1：settings_update 对 sidebar 宽度的 clamp =====

    #[test]
    fn settings_update_clamp_file_tree_width_下限_180() {
        // 越界（小）值 → clamp 到下限 180。
        let mut s = AppSettings::default();
        s.ui.file_tree_width = 100;
        clamp_panel_widths(&mut s);
        assert_eq!(s.ui.file_tree_width, 180, "100 < 180 应 clamp 到 180");
    }

    #[test]
    fn settings_update_clamp_file_tree_width_上限_600() {
        // 越界（大）值 → clamp 到上限 600。
        let mut s = AppSettings::default();
        s.ui.file_tree_width = 700;
        clamp_panel_widths(&mut s);
        assert_eq!(s.ui.file_tree_width, 600, "700 > 600 应 clamp 到 600");
    }

    #[test]
    fn settings_update_clamp_file_tree_width_正常值不变() {
        // 范围内的值原样保留。
        let mut s = AppSettings::default();
        s.ui.file_tree_width = 240;
        clamp_panel_widths(&mut s);
        assert_eq!(s.ui.file_tree_width, 240, "240 在 [180, 600] 内应保持");
    }

    #[test]
    fn settings_update_clamp_ai_sidebar_width_下限_180() {
        let mut s = AppSettings::default();
        s.ui.ai_sidebar_width = 50;
        clamp_panel_widths(&mut s);
        assert_eq!(s.ui.ai_sidebar_width, 180);
    }

    #[test]
    fn settings_update_clamp_ai_sidebar_width_上限_600() {
        let mut s = AppSettings::default();
        s.ui.ai_sidebar_width = 999;
        clamp_panel_widths(&mut s);
        assert_eq!(s.ui.ai_sidebar_width, 600);
    }

    #[test]
    fn settings_update_clamp_ai_sidebar_width_正常值不变() {
        let mut s = AppSettings::default();
        s.ui.ai_sidebar_width = 420;
        clamp_panel_widths(&mut s);
        assert_eq!(s.ui.ai_sidebar_width, 420);
    }

    #[test]
    fn settings_update_clamp_边界值_180_和_600_保持() {
        // clamp 的 inclusive 边界：180 / 600 自身应保留。
        let mut s = AppSettings::default();
        s.ui.file_tree_width = 180;
        s.ui.ai_sidebar_width = 600;
        clamp_panel_widths(&mut s);
        assert_eq!(s.ui.file_tree_width, 180);
        assert_eq!(s.ui.ai_sidebar_width, 600);
    }

    #[test]
    fn settings_update_不_clamp_file_preview_dialog() {
        // file_preview_dialog 不做边界 clamp（off-screen reset 前端处理）。
        use crate::settings::DialogRect;
        let mut s = AppSettings::default();
        // 故意给一个 off-screen 的 rect
        s.ui.file_preview_dialog = Some(DialogRect {
            x: -1000.0,
            y: -1000.0,
            w: 9999.0,
            h: 9999.0,
        });
        clamp_panel_widths(&mut s);
        let rect = s.ui.file_preview_dialog.expect("dialog 应保留");
        // 不被改动
        assert_eq!(rect.x, -1000.0);
        assert_eq!(rect.y, -1000.0);
        assert_eq!(rect.w, 9999.0);
        assert_eq!(rect.h, 9999.0);
    }
}
