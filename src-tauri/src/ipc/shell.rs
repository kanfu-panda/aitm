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

/// 校验"在文件管理器中显示"的入参。
///
/// 比 [`validate_url`] 严得多：这里只接受**本机绝对路径**，且路径必须真实存在。
/// 不做 scheme / URL 那一套 —— 传进来的应该是 FileTree 里某个真实节点的 path。
///
/// 抽出独立函数是为了能单测（不真去 spawn 文件管理器）。
fn validate_reveal_path(path: &str) -> Result<std::path::PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("路径为空".to_string());
    }
    let p = std::path::Path::new(trimmed);
    if !p.is_absolute() {
        return Err(format!("只接受绝对路径：{trimmed}"));
    }
    if !p.exists() {
        return Err(format!("路径不存在：{trimmed}"));
    }
    Ok(p.to_path_buf())
}

/// 在系统文件管理器里定位并选中给定路径。
///
/// - macOS：`open -R <path>`（访达里选中该项，而不是打开它）
/// - Windows：`explorer /select,<path>`
/// - Linux：没有通用的"选中"协议，退而求其次用 `xdg-open` 打开**所在目录**
///
/// 与 [`shell_open`] 的区别：那个是"用默认应用打开这个文件"，这个是"在文件
/// 管理器里把它指给我看"。
#[tauri::command]
pub fn shell_reveal(path: String) -> Result<(), String> {
    let target = validate_reveal_path(&path)?;

    let spawned = if cfg!(target_os = "macos") {
        Command::new("open").arg("-R").arg(&target).spawn().is_ok()
    } else if cfg!(target_os = "windows") {
        // 注意：/select 与路径之间是逗号且**不能有空格**，所以拼成单个参数
        Command::new("explorer")
            .arg(format!("/select,{}", target.display()))
            .spawn()
            .is_ok()
    } else if cfg!(target_os = "linux") {
        // 文件本身交给 xdg-open 会用默认应用**打开**它，不是我们要的；开父目录
        let dir = if target.is_dir() {
            target.clone()
        } else {
            target.parent().map(|p| p.to_path_buf()).unwrap_or(target.clone())
        };
        Command::new("xdg-open").arg(dir).spawn().is_ok()
    } else {
        return Err(format!("不支持的平台：{}", std::env::consts::OS));
    };

    if !spawned {
        return Err("文件管理器 spawn 失败".to_string());
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

    // === shell_reveal 的入参校验 ===

    #[test]
    fn reveal_真实存在的文件_通过() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.txt");
        std::fs::write(&f, b"x").unwrap();
        assert!(validate_reveal_path(f.to_str().unwrap()).is_ok());
    }

    #[test]
    fn reveal_真实存在的目录_通过() {
        let dir = tempfile::tempdir().unwrap();
        assert!(validate_reveal_path(dir.path().to_str().unwrap()).is_ok());
    }

    #[test]
    fn reveal_不存在的路径_拒绝() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("没有这个文件.txt");
        let err = validate_reveal_path(missing.to_str().unwrap()).unwrap_err();
        assert!(err.contains("不存在"), "实际：{err}");
    }

    #[test]
    fn reveal_相对路径_拒绝() {
        // 相对路径的基准目录是应用的 cwd，跟用户看到的文件树无关，必须拒绝
        let err = validate_reveal_path("./foo.txt").unwrap_err();
        assert!(err.contains("绝对路径"), "实际：{err}");
    }

    #[test]
    fn reveal_空串_拒绝() {
        assert!(validate_reveal_path("").is_err());
        assert!(validate_reveal_path("   ").is_err());
    }

    #[test]
    fn reveal_两端空白_trim_后仍能命中() {
        let dir = tempfile::tempdir().unwrap();
        let padded = format!("  {}  ", dir.path().to_str().unwrap());
        assert!(validate_reveal_path(&padded).is_ok());
    }
}
