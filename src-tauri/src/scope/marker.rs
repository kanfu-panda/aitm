//! `.aitm/project.json` marker 文件读写（spec §7.3）。
//!
//! marker 是项目的"身份证"：UUID 唯一标识 + 名字 + 时间戳 + 路径足迹。
//! 与磁盘路径完全解耦——`mv ~/foo ~/bar/foo` 后 marker 仍跟着目录走，
//! 重新打开仍能识别同一项目（spec §7.4(2)）。
//!
//! 文件示例（spec §7.3）：
//! ```json
//! {
//!   "id": "0193abf1-7c2e-4d8a-9f0c-e1a3b5c7d9e2",
//!   "name": "aitm",
//!   "created_at": "2026-04-27T13:54:00+08:00",
//!   "binding": {
//!     "first_seen_path": "/Users/foo/work/aitm",
//!     "last_seen_path":  "/Users/foo/work/aitm"
//!   },
//!   "settings": {
//!     "default_provider": "anthropic",
//!     "default_model": "claude-opus-4-7"
//!   }
//! }
//! ```

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use uuid::Uuid;

/// `.aitm/project.json` 的内存表示。
///
/// 字段全部带 `#[serde(default)]` 兼容旧文件——后续新增字段不会让旧 marker
/// 解析失败。`id` / `name` / `created_at` 是必填，缺这三项视为损坏。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProjectMarker {
    /// UUID（v7 推荐，按时间排序友好）。
    pub id: Uuid,
    /// 项目展示名（init 时来自 dirname，可改）。
    pub name: String,
    /// ISO8601 / RFC3339 时间戳。
    pub created_at: String,
    /// 路径足迹（mv 项目时更新 last_seen_path）。
    #[serde(default)]
    pub binding: Binding,
    /// 项目级 provider/model 默认（可空字符串表示用全局默认）。
    #[serde(default)]
    pub settings: ProjectSettings,
}

/// 路径足迹：marker 在哪儿被首次创建 + 最近一次识别到。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct Binding {
    #[serde(default)]
    pub first_seen_path: String,
    #[serde(default)]
    pub last_seen_path: String,
}

/// 项目级 provider/model 默认。空字符串表示"用全局默认"。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ProjectSettings {
    #[serde(default)]
    pub default_provider: String,
    #[serde(default)]
    pub default_model: String,
}

/// 给 `root_path` 算 `.aitm/project.json` 的完整路径。
pub fn marker_path(root_path: &Path) -> PathBuf {
    root_path.join(".aitm").join("project.json")
}

/// 读 marker。
///
/// - 文件不存在 → `Ok(None)`
/// - JSON 格式错误（不可恢复） → `Err`，调用方决定降级策略
///   （`resolve_scope` 视为没找到继续向上查）
pub fn read(root_path: &Path) -> Result<Option<ProjectMarker>> {
    let path = marker_path(root_path);
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path)
        .with_context(|| format!("读 marker 失败: {}", path.display()))?;
    let marker: ProjectMarker = serde_json::from_str(&text)
        .with_context(|| format!("解析 marker JSON 失败: {}", path.display()))?;
    Ok(Some(marker))
}

/// 原子写 marker（tempfile + rename，参考 `settings/store.rs::save`）。
///
/// 自动创建 `<root>/.aitm/` 目录。`pretty` 序列化便于人类阅读 + git diff。
pub fn write(root_path: &Path, marker: &ProjectMarker) -> Result<()> {
    let dir = root_path.join(".aitm");
    fs::create_dir_all(&dir).with_context(|| format!("创建 .aitm/ 失败: {}", dir.display()))?;

    let path = dir.join("project.json");
    let tmp = dir.join(".project.json.tmp");

    let json = serde_json::to_string_pretty(marker).context("序列化 marker 失败")?;
    {
        let mut f = fs::File::create(&tmp)
            .with_context(|| format!("创建 marker tmp 失败: {}", tmp.display()))?;
        f.write_all(json.as_bytes())
            .with_context(|| format!("写 marker tmp 失败: {}", tmp.display()))?;
        f.sync_all().context("sync marker tmp 失败")?;
    }
    fs::rename(&tmp, &path)
        .with_context(|| format!("rename marker 失败: {}", path.display()))?;
    Ok(())
}

/// 写 `.aitm/.gitignore`，把 cache / 临时文件排除（spec §7.3）。
///
/// 内容固定且简短；存在则覆盖（重复 init 也是幂等的）。
pub fn write_gitignore(root_path: &Path) -> Result<()> {
    let dir = root_path.join(".aitm");
    fs::create_dir_all(&dir).with_context(|| format!("创建 .aitm/ 失败: {}", dir.display()))?;
    let path = dir.join(".gitignore");
    let content = "# aitm 自动生成：本机本地数据，不入 git\ncache/\n*.tmp\n*.log\n";
    fs::write(&path, content)
        .with_context(|| format!("写 .gitignore 失败: {}", path.display()))?;
    Ok(())
}

/// 创建一个全新 marker。
///
/// - `id` 用 `Uuid::now_v7()`（按时间排序友好，spec §7.3 推荐）
/// - `created_at` 用当前 UTC 时间的 RFC3339 字符串
/// - `binding.first_seen_path` 与 `last_seen_path` 都填 `root_path`
/// - `settings` 取默认（空字符串 = 用全局默认）
pub fn create_new(root_path: &Path, name: &str) -> ProjectMarker {
    let now = OffsetDateTime::now_utc();
    let created_at = now
        .format(&Rfc3339)
        .unwrap_or_else(|_| String::from("1970-01-01T00:00:00Z"));
    let path_str = root_path.to_string_lossy().into_owned();
    ProjectMarker {
        id: Uuid::now_v7(),
        name: name.to_string(),
        created_at,
        binding: Binding {
            first_seen_path: path_str.clone(),
            last_seen_path: path_str,
        },
        settings: ProjectSettings::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn read_不存在文件_返回_none() {
        let tmp = TempDir::new().unwrap();
        let r = read(tmp.path()).unwrap();
        assert!(r.is_none());
    }

    #[test]
    fn write_后_read_往返一致() {
        let tmp = TempDir::new().unwrap();
        let m = create_new(tmp.path(), "demo");
        write(tmp.path(), &m).unwrap();
        let back = read(tmp.path()).unwrap().expect("应能读到");
        assert_eq!(m, back);
        // 落盘文件确实存在
        assert!(tmp.path().join(".aitm").join("project.json").exists());
    }

    #[test]
    fn create_new_生成_uuid_v7() {
        let tmp = TempDir::new().unwrap();
        let m = create_new(tmp.path(), "demo");
        // UUID v7 的 version nibble 是 7
        assert_eq!(m.id.get_version_num(), 7);
        // name / 路径足迹正确
        assert_eq!(m.name, "demo");
        assert_eq!(m.binding.first_seen_path, m.binding.last_seen_path);
        assert_eq!(
            m.binding.first_seen_path,
            tmp.path().to_string_lossy().into_owned(),
        );
    }

    #[test]
    fn create_new_created_at_是_rfc3339() {
        let tmp = TempDir::new().unwrap();
        let m = create_new(tmp.path(), "demo");
        // 应能往返解析回 OffsetDateTime
        assert!(
            OffsetDateTime::parse(&m.created_at, &Rfc3339).is_ok(),
            "created_at 不是合法 RFC3339: {}",
            m.created_at,
        );
    }

    #[test]
    fn write_是原子写_临时文件被清理() {
        let tmp = TempDir::new().unwrap();
        let m = create_new(tmp.path(), "demo");
        write(tmp.path(), &m).unwrap();
        let dir = tmp.path().join(".aitm");
        assert!(dir.join("project.json").exists());
        assert!(
            !dir.join(".project.json.tmp").exists(),
            "tmp 文件应在 rename 后被清理"
        );
    }

    #[test]
    fn read_损坏_json_返回_err() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join(".aitm");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("project.json"), "{ this is not json").unwrap();
        let r = read(tmp.path());
        assert!(r.is_err(), "损坏 JSON 应返回 Err");
    }

    #[test]
    fn write_gitignore_落盘正确() {
        let tmp = TempDir::new().unwrap();
        write_gitignore(tmp.path()).unwrap();
        let path = tmp.path().join(".aitm").join(".gitignore");
        assert!(path.exists());
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("cache/"));
        assert!(content.contains("*.tmp"));
    }

    #[test]
    fn marker_path_拼接正确() {
        let p = Path::new("/Users/foo/proj");
        assert_eq!(
            marker_path(p),
            PathBuf::from("/Users/foo/proj/.aitm/project.json"),
        );
    }

    #[test]
    fn 默认字段缺失也能反序列化() {
        // 测试 #[serde(default)] 兼容性：仅有必填字段也能 parse
        let json = r#"{
            "id": "0193abf1-7c2e-4d8a-9f0c-e1a3b5c7d9e2",
            "name": "demo",
            "created_at": "2026-04-27T13:54:00+08:00"
        }"#;
        let m: ProjectMarker = serde_json::from_str(json).unwrap();
        assert_eq!(m.name, "demo");
        assert_eq!(m.binding.first_seen_path, "");
        assert_eq!(m.settings.default_provider, "");
    }
}
