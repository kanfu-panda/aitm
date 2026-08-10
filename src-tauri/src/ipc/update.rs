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
//! - 下载链接按**当前运行平台**从 release assets 里挑（macOS dmg / Windows
//!   setup.exe / msi）；本平台无产物时回退到 release 页而非给错平台的包
//! - 网络 / rate limit / 解析失败一律返回 `available: false` + 简短 `error` 字段
//! - 比较算法：剥 `v` 前缀 + 简化 SemVer（pre-release 视为 < 同 major.minor.patch 正式版）

use serde::{Deserialize, Serialize};

/// GitHub Releases API 端点。仓库 owner/name 通过编译期常量配置。
const RELEASES_API_URL: &str =
    "https://api.github.com/repos/kanfu-panda/aitm/releases/latest";

/// HTTP 客户端 timeout（毫秒）—— 启动调用，不希望挂太久
const HTTP_TIMEOUT_MS: u64 = 5_000;

/// 当前运行平台对应的安装包文件名后缀，按优先级从高到低。
///
/// 文件名遵循 Tauri bundler 约定（对照 v1.3.0 实际产物）：
/// `aitm_1.3.0_aarch64.dmg` / `aitm_1.3.0_x64-setup.exe` / `aitm_1.3.0_arm64_en-US.msi` …
///
/// 用 `cfg!` 而非 `#[cfg]`：所有分支都参与编译，不会因为漏写某个
/// os×arch 组合而编不过；分支消解在优化期完成，无运行时开销。
///
/// Linux 暂无发布产物 → 空表，调用方回退到 release 页。
fn platform_asset_suffixes() -> &'static [&'static str] {
    if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") {
            &["_aarch64.dmg"]
        } else {
            &["_x64.dmg"]
        }
    } else if cfg!(target_os = "windows") {
        if cfg!(target_arch = "aarch64") {
            &["_arm64-setup.exe", "_arm64_en-US.msi"]
        } else {
            &["_x64-setup.exe", "_x64_en-US.msi"]
        }
    } else {
        &[]
    }
}

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
    /// release 页面地址；本平台没有直链产物时回退到它
    #[serde(default)]
    html_url: Option<String>,
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

    let release_url = resolve_download_url(&payload, platform_asset_suffixes());

    UpdateCheckResult {
        available,
        current_version: current.to_string(),
        latest_version: Some(latest),
        release_url,
        release_notes: payload.body.map(|b| truncate_notes(&b, 500)),
        error: None,
    }
}

/// 从 release assets 里挑本平台的安装包，按 `suffixes` 给的优先级依次尝试。
///
/// 一个后缀都匹配不上返 None（调用方负责回退）。
fn pick_asset(assets: &[GitHubAsset], suffixes: &[&str]) -> Option<String> {
    suffixes.iter().find_map(|suffix| {
        assets
            .iter()
            .find(|a| a.name.ends_with(suffix))
            .map(|a| a.browser_download_url.clone())
    })
}

/// 决定"点了徽标去哪"：优先本平台安装包直链，没有则退到 release 页。
///
/// 回退这一步是必须的——Linux 无产物、或某次发布漏传某平台包时，
/// 给 release 页也好过给一个别的平台的安装包（v1.3.0 之前的行为）。
fn resolve_download_url(release: &GitHubRelease, suffixes: &[&str]) -> Option<String> {
    pick_asset(&release.assets, suffixes).or_else(|| release.html_url.clone())
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

    /// 造一组真实 release 的资产（照抄 v1.3.0 的实际文件名）
    fn 全平台资产() -> Vec<GitHubAsset> {
        ["aarch64.dmg", "arm64-setup.exe", "arm64_en-US.msi", "x64-setup.exe", "x64_en-US.msi"]
            .iter()
            .map(|tail| GitHubAsset {
                name: format!("aitm_1.3.0_{tail}"),
                browser_download_url: format!("https://x/y/aitm_1.3.0_{tail}"),
            })
            .collect()
    }

    #[test]
    fn pick_asset_macos_arm_取_dmg() {
        let url = pick_asset(&全平台资产(), &["_aarch64.dmg"]);
        assert_eq!(url.as_deref(), Some("https://x/y/aitm_1.3.0_aarch64.dmg"));
    }

    #[test]
    fn pick_asset_windows_x64_取_setup_exe_不取_dmg() {
        let url = pick_asset(&全平台资产(), &["_x64-setup.exe", "_x64_en-US.msi"]);
        assert_eq!(url.as_deref(), Some("https://x/y/aitm_1.3.0_x64-setup.exe"));
    }

    #[test]
    fn pick_asset_windows_arm_取_arm64_不取_x64() {
        let url = pick_asset(&全平台资产(), &["_arm64-setup.exe", "_arm64_en-US.msi"]);
        assert_eq!(url.as_deref(), Some("https://x/y/aitm_1.3.0_arm64-setup.exe"));
    }

    #[test]
    fn pick_asset_按后缀优先级回退到次选() {
        // setup.exe 缺失时应退到 msi，而不是直接放弃
        let assets: Vec<GitHubAsset> = 全平台资产()
            .into_iter()
            .filter(|a| !a.name.ends_with("-setup.exe"))
            .collect();
        let url = pick_asset(&assets, &["_x64-setup.exe", "_x64_en-US.msi"]);
        assert_eq!(url.as_deref(), Some("https://x/y/aitm_1.3.0_x64_en-US.msi"));
    }

    #[test]
    fn pick_asset_匹配不上返_none() {
        // Linux（无候选后缀）与"资产里没有本平台包"两种情况都应为 None
        assert!(pick_asset(&全平台资产(), &[]).is_none());
        assert!(pick_asset(&全平台资产(), &["_riscv64.deb"]).is_none());
    }

    #[test]
    fn pick_asset_空_assets() {
        assert!(pick_asset(&[], &["_aarch64.dmg"]).is_none());
    }

    #[test]
    fn 本平台后缀非空_且不跨平台() {
        // 回归：v1.3.0 之前只认 _aarch64.dmg，Windows 用户会拿到 macOS dmg
        let s = platform_asset_suffixes();
        if cfg!(any(target_os = "macos", target_os = "windows")) {
            assert!(!s.is_empty(), "macOS/Windows 必须有候选后缀");
        }
        if cfg!(target_os = "windows") {
            assert!(s.iter().all(|x| !x.ends_with(".dmg")), "Windows 不该匹配 dmg：{s:?}");
        }
        if cfg!(target_os = "macos") {
            assert!(s.iter().all(|x| x.ends_with(".dmg")), "macOS 只该匹配 dmg：{s:?}");
        }
    }

    #[test]
    fn 无本平台资产时回退到_release_页() {
        let payload = GitHubRelease {
            tag_name: "v9.9.9".to_string(),
            body: None,
            html_url: Some("https://github.com/kanfu-panda/aitm/releases/tag/v9.9.9".to_string()),
            assets: vec![],
        };
        assert_eq!(
            resolve_download_url(&payload, &["_aarch64.dmg"]).as_deref(),
            Some("https://github.com/kanfu-panda/aitm/releases/tag/v9.9.9")
        );
    }

    #[test]
    fn 有本平台资产时优先直链而非_release_页() {
        let payload = GitHubRelease {
            tag_name: "v9.9.9".to_string(),
            body: None,
            html_url: Some("https://github.com/kanfu-panda/aitm/releases/tag/v9.9.9".to_string()),
            assets: 全平台资产(),
        };
        assert_eq!(
            resolve_download_url(&payload, &["_aarch64.dmg"]).as_deref(),
            Some("https://x/y/aitm_1.3.0_aarch64.dmg")
        );
    }

    #[test]
    fn github_release_缺_html_url_不炸() {
        let body = r#"{"tag_name": "v1.0.0", "assets": []}"#;
        let p: GitHubRelease = serde_json::from_str(body).unwrap();
        assert!(p.html_url.is_none());
        assert!(resolve_download_url(&p, &["_aarch64.dmg"]).is_none());
    }
}
