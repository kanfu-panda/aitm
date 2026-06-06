//! 系统级 URL 打开 IPC（Phase 3A T1）。
//!
//! 给前端"Ctrl+点击 URL 用系统浏览器打开"用。**只允许** http / https /
//! mailto 三种 scheme，防 file:// / javascript: / 任意 shell URI 滥用。
//!
//! ## 平台 dispatch
//!
//! - macOS：`open <url>`（LaunchServices）
//! - Linux：先试 `xdg-open`；spawn 失败回退 `open`（极少数 distro 没装 xdg-utils）
//! - Windows：`rundll32 url.dll,FileProtocolHandler <url>`
//!
//! 不等子进程退出（`spawn().is_ok()` 即返回），避免 IPC 卡阻塞。

use std::process::Command;

/// URL 白名单 prefix。比较前对 url 整体 trim + 转小写。
const ALLOWED_SCHEMES: &[&str] = &["http://", "https://", "mailto:"];

/// 校验 URL scheme 是否在白名单。`Ok(trimmed)` 通过；`Err(reason)` 拒绝。
///
/// 抽出独立函数方便单测（不真 spawn 子进程）。
///
/// v0.5.0-C T4：扩展支持本地绝对路径（`/...` / `file://...`），让
/// FilePreviewDialog 的 "用默认应用打开" 按钮调它打开本地文件（如 binary /
/// 不支持预览的 .dmg / .pdf 等）。
fn validate_url(url: &str) -> Result<&str, String> {
    let trimmed = url.trim();
    let lower = trimmed.to_lowercase();
    for prefix in ALLOWED_SCHEMES {
        if lower.starts_with(prefix) {
            return Ok(trimmed);
        }
    }
    // v0.5.0-C：本地绝对路径或 file:// scheme 允许（用户在 FileTree 主动点的文件）
    if trimmed.starts_with('/') || lower.starts_with("file://") {
        return Ok(trimmed);
    }
    // 提取 scheme 给错误信息更友好；冒号前的部分；没冒号就报全 url
    let scheme_end = trimmed.find(':').unwrap_or(trimmed.len());
    let scheme = &trimmed[..scheme_end];
    Err(format!("不支持的 URL scheme: {scheme}"))
}

/// 用系统默认应用打开 URL（http/https/mailto 白名单）。
#[tauri::command]
pub fn shell_open(url: String) -> Result<(), String> {
    let url = validate_url(&url)?;

    // 各平台分发；不等子进程退出。
    let spawned = if cfg!(target_os = "macos") {
        Command::new("open").arg(url).spawn().is_ok()
    } else if cfg!(target_os = "linux") {
        // 先 xdg-open；spawn 失败 fallback 到 open（少数 distro 没装 xdg-utils）
        Command::new("xdg-open").arg(url).spawn().is_ok()
            || Command::new("open").arg(url).spawn().is_ok()
    } else if cfg!(target_os = "windows") {
        Command::new("rundll32")
            .arg("url.dll,FileProtocolHandler")
            .arg(url)
            .spawn()
            .is_ok()
    } else {
        return Err(format!("不支持的平台：{}", std::env::consts::OS));
    };

    if !spawned {
        return Err("系统打开命令 spawn 失败".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_通过() {
        assert!(validate_url("http://example.com").is_ok());
    }

    #[test]
    fn https_通过() {
        assert!(validate_url("https://example.com/path?q=1").is_ok());
    }

    #[test]
    fn mailto_通过() {
        assert!(validate_url("mailto:foo@bar.com").is_ok());
    }

    // v0.5.0-C T4：原 file_拒绝 测试已废弃——file:// 现在通过（FilePreviewDialog 用）

    #[test]
    fn javascript_拒绝() {
        let err = validate_url("javascript:alert(1)").unwrap_err();
        assert!(err.contains("javascript"), "实际：{err}");
    }

    #[test]
    fn 大写_https_通过_小写比较() {
        assert!(validate_url("HTTPS://example.com").is_ok());
    }

    #[test]
    fn 混合大小写_通过() {
        assert!(validate_url("HtTp://Example.Com").is_ok());
    }

    #[test]
    fn 前后空白_trim_后判断() {
        assert!(validate_url("  https://example.com  ").is_ok());
    }

    #[test]
    fn 空字符串_拒绝() {
        assert!(validate_url("").is_err());
    }

    #[test]
    fn 没冒号_拒绝() {
        assert!(validate_url("just-a-string").is_err());
    }

    #[test]
    fn ssh_scheme_拒绝() {
        let err = validate_url("ssh://user@host").unwrap_err();
        assert!(err.contains("ssh"));
    }

    // v0.5.0-C T4：本地绝对路径 + file:// 通过（FilePreviewDialog "用默认应用打开"）
    #[test]
    fn 绝对路径_通过() {
        assert!(validate_url("/Users/x/foo.pdf").is_ok());
        assert!(validate_url("/tmp/binary.dmg").is_ok());
    }

    #[test]
    fn file_scheme_通过_v0_5_0_c() {
        // v0.5.0-C 之前是拒绝的；现在允许
        assert!(validate_url("file:///Users/x/foo.dmg").is_ok());
        assert!(validate_url("FILE:///some/path").is_ok());
    }

    #[test]
    fn 相对路径_拒绝() {
        // 只支持绝对路径，相对路径不行（避免歧义）
        assert!(validate_url("./relative.txt").is_err());
        assert!(validate_url("relative.txt").is_err());
    }
}
