//! 升级检查 IPC（v1.0 起切到 GitHub Releases API 端点）。
//!
//! 启动时调 `https://api.github.com/repos/<OWNER>/<REPO>/releases/latest`
//! 拿最新 release，跟当前 [`crate::version::current`] 比较；有新版本 → 返回
//! download URL + release notes 摘要；无 / 出错 → 返回 `available: false`，前端
//! 静默不打扰。
//!
//! **设计决策**（v1.0 切换）：
//! - 直接调 GitHub Releases API，**真相源就是 GitHub 仓库本身**——不需要中转 CDN
//! - GitHub API 未认证 rate limit 60 req/h/IP；单用户启动频率远低于此，足够用
//! - dmg 下载链接从 release assets 里按 `aitm_*_aarch64.dmg` 模式匹配
//! - 用户主动升级（点链接下 dmg 手动装）—— 不做 tauri-plugin-updater
//! - 网络 / rate limit / 解析失败一律返回 `available: false` + 简短 `error` 字段
//! - 比较算法：剥 `v` 前缀 + 简化 SemVer（pre-release 视为 < 同 major.minor.patch 正式版）

use serde::{Deserialize, Serialize};

/// GitHub Releases API 端点。仓库 owner/name 通过编译期常量配置。
const RELEASES_API_URL: &str =
    "https://api.github.com/repos/kanfu-panda/aitm/releases/latest";

/// HTTP 客户端 timeout（毫秒）—— 启动调用，不希望挂太久
const HTTP_TIMEOUT_MS: u64 = 5_000;

/// macOS aarch64 dmg 文件名模式（按约定 `aitm_<version>_aarch64.dmg` 匹配）
const DMG_ASSET_SUFFIX: &str = "_aarch64.dmg";

#[derive(Debug, Clone, Serialize)]
pub struct UpdateCheckResult {
    /// 是否有新版本（current < latest）
    pub available: bool,
    /// 当前 app 版本（CARGO_PKG_VERSION）
    pub current_version: String,
    /// 远端最新版本（剥 `v` 前缀），可空（拉失败时）
    pub latest_version: Option<String>,
    /// dmg 下载链接，可空
    pub release_url: Option<String>,
    /// release notes 摘要（前 N 字符），可空
    pub release_notes: Option<String>,
    /// 失败原因（available=false 时可能有；前端 console.warn 用）
    pub error: Option<String>,
}

/// GitHub Releases API 响应（只取我们需要的字段）。
///
/// 完整 schema：<https://docs.github.com/en/rest/releases/releases#get-the-latest-release>
#[derive(Debug, Deserialize)]
struct GitHubRelease {
    /// release tag，如 `v1.0.0` 或 `1.0.0`
    tag_name: String,
    /// release notes（markdown 原文）
    #[serde(default)]
    body: Option<String>,
    /// release 产物
    #[serde(default)]
    assets: Vec<GitHubAsset>,
}

#[derive(Debug, Deserialize)]
struct GitHubAsset {
    /// 资产文件名，如 `aitm_1.0.0_aarch64.dmg`
    name: String,
    /// 浏览器可直接下载的 URL
    browser_download_url: String,
}

#[tauri::command]
pub async fn update_check() -> Result<UpdateCheckResult, String> {
    let current = crate::version::current().to_string();
    let result = check_inner(&current).await;
    Ok(result)
}

async fn check_inner(current: &str) -> UpdateCheckResult {
    let make_err = |err: String| UpdateCheckResult {
        available: false,
        current_version: current.to_string(),
        latest_version: None,
        release_url: None,
        release_notes: None,
        error: Some(err),
    };

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(HTTP_TIMEOUT_MS))
        .user_agent(format!("aitm/{}", current))
        .build()
    {
        Ok(c) => c,
        Err(e) => return make_err(format!("HTTP client 构建失败: {e}")),
    };

    let resp = match client
        .get(RELEASES_API_URL)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return make_err(format!("请求 GitHub Releases 失败: {e}")),
    };

    if !resp.status().is_success() {
        return make_err(format!("GitHub Releases API 返 {}", resp.status()));
    }

    let payload: GitHubRelease = match resp.json().await {
        Ok(r) => r,
        Err(e) => return make_err(format!("解析 GitHub Releases 失败: {e}")),
    };

    let latest = strip_v_prefix(&payload.tag_name);
    let available = is_newer(&latest, current);

    let release_url = pick_dmg_asset(&payload.assets);

    UpdateCheckResult {
        available,
        current_version: current.to_string(),
        latest_version: Some(latest),
        release_url,
        release_notes: payload.body.map(|b| truncate_notes(&b, 500)),
        error: None,
    }
}

/// 从 release assets 里挑 macOS aarch64 dmg。
///
/// 按约定文件名 `aitm_<version>_aarch64.dmg` 匹配；找不到返 None。
fn pick_dmg_asset(assets: &[GitHubAsset]) -> Option<String> {
    assets
        .iter()
        .find(|a| a.name.ends_with(DMG_ASSET_SUFFIX))
        .map(|a| a.browser_download_url.clone())
}

/// 剥 `v` 前缀；`v0.2.0` → `0.2.0`，`0.2.0` 原样
fn strip_v_prefix(tag: &str) -> String {
    tag.strip_prefix('v').unwrap_or(tag).to_string()
}

/// SemVer 字符串比较：`latest > current`？
///
/// 简化算法（v0.2.1 范围）：按 `.` 拆，逐段比较；每段以 `-` 切前后，前段（数字）
/// 转 u32 比较，相等则有 pre-release 后缀的视为更小（SemVer 11 规则简化版）。
///
/// 不引 semver crate（依赖收紧）。够用：aitm 版本号始终 `<u32>.<u32>.<u32>` 或加
/// `-mvp` / `-rc1` 之类后缀。
fn is_newer(latest: &str, current: &str) -> bool {
    let l = parse_version(latest);
    let c = parse_version(current);
    l > c
}

/// 把版本字符串拆成可比较的 (major, minor, patch, pre)。
fn parse_version(s: &str) -> (u32, u32, u32, std::cmp::Reverse<Option<String>>) {
    let mut major = 0;
    let mut minor = 0;
    let mut patch = 0;
    let mut pre: Option<String> = None;

    let parts: Vec<&str> = s.split('.').collect();
    if let Some(p) = parts.first() {
        major = parse_segment_num(p, &mut pre);
    }
    if let Some(p) = parts.get(1) {
        minor = parse_segment_num(p, &mut pre);
    }
    if let Some(p) = parts.get(2) {
        patch = parse_segment_num(p, &mut pre);
    }
    (major, minor, patch, std::cmp::Reverse(pre))
}

fn parse_segment_num(seg: &str, pre_out: &mut Option<String>) -> u32 {
    if let Some((num_str, pre)) = seg.split_once('-') {
        if pre_out.is_none() {
            *pre_out = Some(pre.to_string());
        }
        num_str.parse().unwrap_or(0)
    } else {
        seg.parse().unwrap_or(0)
    }
}

/// 把 release notes 截到 max_chars 字符（按 char 不按 byte，避免 UTF-8 截半）
fn truncate_notes(s: &str, max_chars: usize) -> String {
    let trimmed = s.trim();
    let count = trimmed.chars().count();
    if count <= max_chars {
        trimmed.to_string()
    } else {
        let cut: String = trimmed.chars().take(max_chars).collect();
        format!("{cut}…")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 剥_v_前缀() {
        assert_eq!(strip_v_prefix("v0.2.0"), "0.2.0");
        assert_eq!(strip_v_prefix("0.2.0"), "0.2.0");
        assert_eq!(strip_v_prefix("v0.1.0-mvp"), "0.1.0-mvp");
    }

    #[test]
    fn 版本比较_主版本号大() {
        assert!(is_newer("1.0.0", "0.2.0"));
        assert!(is_newer("0.3.0", "0.2.5"));
        assert!(is_newer("0.2.1", "0.2.0"));
    }

    #[test]
    fn 版本比较_等于不更新() {
        assert!(!is_newer("0.2.0", "0.2.0"));
        assert!(!is_newer("v0.2.0", "0.2.0"));
    }

    #[test]
    fn 版本比较_pre_release_小于_release() {
        assert!(is_newer("0.1.0", "0.1.0-mvp"));
        assert!(!is_newer("0.1.0-mvp", "0.1.0"));
    }

    #[test]
    fn 版本比较_老版本不更新() {
        assert!(!is_newer("0.1.0", "0.2.0"));
        assert!(!is_newer("0.0.1", "0.2.0"));
    }

    #[test]
    fn release_notes_截断_保留_utf8() {
        let zh = "这是一段测试文本".repeat(100);
        let truncated = truncate_notes(&zh, 50);
        assert_eq!(truncated.chars().count(), 51); // 50 + 省略号
        assert!(truncated.ends_with('…'));
    }

    #[test]
    fn release_notes_短于上限不截断() {
        let s = "短文本";
        assert_eq!(truncate_notes(s, 100), "短文本");
    }

    #[test]
    fn release_notes_去首尾空白() {
        assert_eq!(truncate_notes("  hi  \n", 10), "hi");
    }

    // === v1.0 GitHub Releases API schema 解析测试 ===

    #[test]
    fn github_release_完整解析() {
        let body = r##"{
            "tag_name": "v1.0.0",
            "body": "release notes here",
            "assets": [
                {"name": "aitm_1.0.0_aarch64.dmg", "browser_download_url": "https://github.com/x/y/releases/download/v1.0.0/aitm_1.0.0_aarch64.dmg"}
            ]
        }"##;
        let p: GitHubRelease = serde_json::from_str(body).unwrap();
        assert_eq!(p.tag_name, "v1.0.0");
        assert_eq!(p.body.as_deref(), Some("release notes here"));
        assert_eq!(p.assets.len(), 1);
        assert_eq!(p.assets[0].name, "aitm_1.0.0_aarch64.dmg");
    }

    #[test]
    fn github_release_缺_body_字段_可空() {
        let body = r#"{"tag_name": "v1.0.0", "assets": []}"#;
        let p: GitHubRelease = serde_json::from_str(body).unwrap();
        assert!(p.body.is_none());
        assert_eq!(p.assets.len(), 0);
    }

    #[test]
    fn github_release_含_v_前缀_仍能_strip() {
        let body = r#"{"tag_name": "v1.0.0", "assets": []}"#;
        let p: GitHubRelease = serde_json::from_str(body).unwrap();
        assert_eq!(strip_v_prefix(&p.tag_name), "1.0.0");
    }

    #[test]
    fn pick_dmg_asset_找到_aarch64() {
        let assets = vec![
            GitHubAsset {
                name: "install-aitm.sh".to_string(),
                browser_download_url: "https://x/y/install-aitm.sh".to_string(),
            },
            GitHubAsset {
                name: "aitm_1.0.0_aarch64.dmg".to_string(),
                browser_download_url: "https://x/y/aitm_1.0.0_aarch64.dmg".to_string(),
            },
        ];
        let url = pick_dmg_asset(&assets);
        assert_eq!(url.as_deref(), Some("https://x/y/aitm_1.0.0_aarch64.dmg"));
    }

    #[test]
    fn pick_dmg_asset_无_aarch64_返_none() {
        let assets = vec![GitHubAsset {
            name: "install-aitm.sh".to_string(),
            browser_download_url: "https://x/y/install-aitm.sh".to_string(),
        }];
        assert!(pick_dmg_asset(&assets).is_none());
    }

    #[test]
    fn pick_dmg_asset_空_assets() {
        assert!(pick_dmg_asset(&[]).is_none());
    }
}
