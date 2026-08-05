//! load_skill 工具：按名加载 CC skill 的正文 / 辅助文件（v1.3.0 B2+B3）。
//!
//! system prompt 里只有一段几百字节的导航说明（见 [`crate::skills::render_hint`]），
//! 名字靠 [`crate::tools::list_skills`] 按需搜，正文靠本工具按需加载 —— 118 个 skill
//! 的正文（甚至光是清单）全塞 system prompt 都会挤爆上下文，且每轮重发。
//!
//! # 🔴 沙盒（红线）
//!
//! `read_file` 的沙盒根是 **cwd**，而 skill 通常装在 `~/.claude/skills/` —— 在
//! cwd 之外，`read_file` 一律 `Blocked`。所以 skill 的 `references/` 辅助文件
//! **只能**经本工具读。**绝不放宽 `read_file` 的 cwd 沙盒**，而是让本工具自带
//! 一个更窄的沙盒：根是**该 skill 自己的目录**，两道校验：
//!
//! 1. 路径成分检查：`file` 里出现绝对路径 / `..` 直接拒（目标不存在时
//!    `canonicalize` 会失败，光靠第 2 道会漏判）
//! 2. `canonicalize` 后必须 `starts_with` 该 skill 目录（挡软链接逃出去）
//!
//! 另加：只读普通文件（不读目录）、拒二进制、[`MAX_BYTES`] 上限截断。

use std::path::{Component, Path};

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::skills::{self, SkillMeta};

use super::{RiskClass, Tool, ToolContext, ToolError, ToolResult};

/// 单次返回给 LLM 的最大字节数（skill 正文与辅助文件共用）。
///
/// 32KB ≈ 8K token，够装一份很长的 skill 指令，又不至于一次把上下文吃掉。
const MAX_BYTES: usize = 32 * 1024;
const TRUNCATED_NOTE: &str = "\n\n[内容过大已截断到前 32KB]";
/// 找不到 skill 时最多回列几个可用名字（避免报错信息本身撑爆上下文）。
const MAX_HINT_NAMES: usize = 30;

pub struct LoadSkillTool;

#[derive(Deserialize)]
struct Args {
    name: String,
    #[serde(default)]
    file: Option<String>,
}

#[async_trait]
impl Tool for LoadSkillTool {
    fn name(&self) -> &str {
        "load_skill"
    }

    fn description(&self) -> &str {
        "加载一个 skill 的完整指令正文（要照某个 skill 干活必须先调本工具）。skill 名字用 list_skills 搜。可选 file 参数读该 skill 目录下的辅助文件，如 references/xxx.md。"
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "skill 名字，取自 list_skills 的搜索结果。"
                },
                "file": {
                    "type": "string",
                    "description": "可选。该 skill 目录下的相对文件路径（如 references/xxx.md）。省略则返回 SKILL.md 正文。"
                }
            },
            "required": ["name"]
        })
    }

    fn risk_class(&self, _args: &Value) -> RiskClass {
        RiskClass::Low
    }

    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<ToolResult, ToolError> {
        let parsed: Args = serde_json::from_value(args)
            .map_err(|e| ToolError::InvalidArgs(format!("load_skill 参数: {e}")))?;

        let cwd = ctx.cwd.clone();
        // 扫目录 + 读文件都是阻塞 IO，丢到 blocking 线程池
        let content = tokio::task::spawn_blocking(move || {
            let all = skills::load_skills_cached(&cwd);
            let Some(skill) = skills::find(&all, &parsed.name) else {
                return Err(ToolError::Exec(format!(
                    "找不到 skill「{}」。{}",
                    parsed.name,
                    hint_available(&all)
                )));
            };
            read_skill_content(skill, parsed.file.as_deref())
        })
        .await
        .map_err(|e| ToolError::Exec(format!("skill 加载任务失败: {e}")))??;

        Ok(ToolResult {
            content,
            is_error: false,
        })
    }
}

/// 拼「可用 skill 名字」提示（找不到时给 LLM 纠错用）。
fn hint_available(all: &[SkillMeta]) -> String {
    if all.is_empty() {
        return "当前没有安装任何 skill。".to_string();
    }
    let names: Vec<&str> = all
        .iter()
        .take(MAX_HINT_NAMES)
        .map(|s| s.name.as_str())
        .collect();
    let more = all.len().saturating_sub(names.len());
    if more > 0 {
        format!("可用：{}（另有 {more} 个未列出）", names.join(", "))
    } else {
        format!("可用：{}", names.join(", "))
    }
}

/// 读取 skill 内容的纯逻辑 —— **沙盒校验全在这里**（单测直接打这个函数）。
///
/// - `file = None` / 空白串 → 读该 skill 的 `SKILL.md` 并剥掉 frontmatter
/// - `file = Some(rel)` → 读该 skill 目录下的相对文件（如 `references/x.md`），
///   原样返回（辅助文件不做 frontmatter 处理）
fn read_skill_content(skill: &SkillMeta, file: Option<&str>) -> Result<String, ToolError> {
    // 沙盒根 = 该 skill 自己的目录（**不是 cwd**）
    let root = skill
        .dir
        .canonicalize()
        .map_err(|e| ToolError::Exec(format!("skill 目录不可访问: {e}")))?;

    // LLM 常给 optional 参数填空串（项目 CLAUDE.md 记过这个坑）→ 视同未传
    let rel = file.map(str::trim).filter(|s| !s.is_empty());

    let target = match rel {
        None => root.join(skills::SKILL_ENTRY),
        Some(rel) => {
            // 第 1 道：路径成分检查。绝对路径 / `..` 一律拒。
            // 必须在 canonicalize 之前做——目标不存在时 canonicalize 直接失败，
            // 只靠第 2 道会把「穿越」误报成「文件不存在」。
            for c in Path::new(rel).components() {
                if !matches!(c, Component::Normal(_) | Component::CurDir) {
                    return Err(ToolError::Blocked {
                        reason: format!(
                            "skill 辅助文件路径必须是 skill 目录下的相对路径，不允许绝对路径或 `..`：{rel}"
                        ),
                    });
                }
            }
            root.join(rel)
        }
    };

    let canonical = target
        .canonicalize()
        .map_err(|e| ToolError::Exec(format!("skill 文件不存在: {e}")))?;

    // 第 2 道：canonicalize 后必须仍在该 skill 目录内（挡软链接逃逸）。
    // Path::starts_with 按**路径成分**比较，所以 `demo` 不会误配 `demo-evil`。
    if !canonical.starts_with(&root) {
        return Err(ToolError::Blocked {
            reason: format!("路径越出 skill 目录（不在 {} 内）", root.display()),
        });
    }

    if !canonical.is_file() {
        return Err(ToolError::Exec(format!(
            "目标不是普通文件: {}",
            canonical.display()
        )));
    }

    let bytes = std::fs::read(&canonical)
        .map_err(|e| ToolError::Exec(format!("读 skill 文件失败: {e}")))?;
    // 只给 LLM 文本：探测前 8KB 有无 NUL 字节判二进制
    if bytes.iter().take(8192).any(|b| *b == 0) {
        return Err(ToolError::Exec(
            "目标不是文本文件（含 NUL 字节），拒绝加载".into(),
        ));
    }

    let lossy = String::from_utf8_lossy(&bytes);
    let content: &str = if rel.is_none() {
        skills::strip_frontmatter(&lossy)
    } else {
        &lossy
    };
    Ok(truncate_bytes(content))
}

/// 截到 [`MAX_BYTES`] 字节（落在 UTF-8 char boundary 上），超限时补说明。
fn truncate_bytes(s: &str) -> String {
    if s.len() <= MAX_BYTES {
        return s.to_string();
    }
    let mut cut = MAX_BYTES;
    while cut > 0 && !s.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}{TRUNCATED_NOTE}", &s[..cut])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use tempfile::TempDir;

    /// 造一个 skill 目录并返回 SkillMeta。
    fn make_skill(root: &Path, name: &str, body: &str) -> SkillMeta {
        let dir = root.join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: 测试 skill\nversion: 0.1.0\n---\n{body}"),
        )
        .unwrap();
        SkillMeta {
            name: name.to_string(),
            description: "测试 skill".into(),
            dir,
        }
    }

    fn make_ctx(cwd: PathBuf) -> ToolContext {
        let session_state = Arc::new(crate::ipc::session::SessionState::new());
        ToolContext {
            session_state,
            cwd,
            active_session_id: None,
            whitelist: Arc::new(crate::safety::whitelist::CompiledWhitelist::empty()),
            browser_state: Arc::new(crate::ipc::browser::BrowserState::default()),
        }
    }

    // ============================================================
    // 正常路径
    // ============================================================

    #[test]
    fn 读正文_去掉_frontmatter() {
        let tmp = TempDir::new().unwrap();
        let skill = make_skill(tmp.path(), "demo", "# 指令\n照我说的做\n");
        let got = read_skill_content(&skill, None).unwrap();
        assert!(!got.contains("description:"), "正文里不应残留 frontmatter");
        assert!(!got.starts_with("---"), "正文不应以 --- 开头");
        assert!(got.contains("# 指令"));
        assert!(got.contains("照我说的做"));
    }

    #[test]
    fn 读_references_辅助文件() {
        let tmp = TempDir::new().unwrap();
        let skill = make_skill(tmp.path(), "demo", "正文");
        fs::create_dir_all(skill.dir.join("references")).unwrap();
        fs::write(skill.dir.join("references").join("x.md"), "辅助内容").unwrap();
        let got = read_skill_content(&skill, Some("references/x.md")).unwrap();
        assert_eq!(got, "辅助内容");
    }

    #[test]
    fn file_是_curdir_前缀也允许() {
        let tmp = TempDir::new().unwrap();
        let skill = make_skill(tmp.path(), "demo", "正文");
        fs::write(skill.dir.join("note.md"), "笔记").unwrap();
        let got = read_skill_content(&skill, Some("./note.md")).unwrap();
        assert_eq!(got, "笔记");
    }

    #[test]
    fn file_空串视同未传_返回正文() {
        let tmp = TempDir::new().unwrap();
        let skill = make_skill(tmp.path(), "demo", "# 正文标记\n");
        // LLM 常把 optional 参数填空串（项目 CLAUDE.md 记过这个坑）
        let got = read_skill_content(&skill, Some("   ")).unwrap();
        assert!(got.contains("# 正文标记"));
    }

    // ============================================================
    // 🔴 沙盒红线：路径穿越正反例
    // ============================================================

    #[test]
    fn 穿越_dotdot_被拒() {
        let tmp = TempDir::new().unwrap();
        let skill = make_skill(tmp.path(), "demo", "正文");
        fs::write(tmp.path().join("secret.txt"), "机密").unwrap();
        let r = read_skill_content(&skill, Some("../secret.txt"));
        assert!(matches!(r, Err(ToolError::Blocked { .. })), "实得 {r:?}");
    }

    #[test]
    fn 穿越_多级_dotdot_被拒() {
        let tmp = TempDir::new().unwrap();
        let skill = make_skill(tmp.path(), "demo", "正文");
        let r = read_skill_content(&skill, Some("../../../../etc/passwd"));
        assert!(matches!(r, Err(ToolError::Blocked { .. })), "实得 {r:?}");
    }

    #[test]
    fn 穿越_中间夹_dotdot_被拒() {
        // references/../../secret.txt —— 表面看着像在 skill 目录里
        let tmp = TempDir::new().unwrap();
        let skill = make_skill(tmp.path(), "demo", "正文");
        fs::create_dir_all(skill.dir.join("references")).unwrap();
        fs::write(tmp.path().join("secret.txt"), "机密").unwrap();
        let r = read_skill_content(&skill, Some("references/../../secret.txt"));
        assert!(matches!(r, Err(ToolError::Blocked { .. })), "实得 {r:?}");
    }

    #[test]
    fn 绝对路径被拒() {
        let tmp = TempDir::new().unwrap();
        let skill = make_skill(tmp.path(), "demo", "正文");
        let outside = tmp.path().join("secret.txt");
        fs::write(&outside, "机密").unwrap();
        let r = read_skill_content(&skill, Some(&outside.to_string_lossy()));
        assert!(matches!(r, Err(ToolError::Blocked { .. })), "实得 {r:?}");
    }

    #[test]
    fn 绝对路径_etc_passwd_被拒() {
        let tmp = TempDir::new().unwrap();
        let skill = make_skill(tmp.path(), "demo", "正文");
        let r = read_skill_content(&skill, Some("/etc/passwd"));
        assert!(matches!(r, Err(ToolError::Blocked { .. })), "实得 {r:?}");
    }

    #[cfg(unix)]
    #[test]
    fn 软链接指向外部被拒() {
        let tmp = TempDir::new().unwrap();
        let skill = make_skill(tmp.path(), "demo", "正文");
        let outside = tmp.path().join("outside.txt");
        fs::write(&outside, "外部机密").unwrap();
        // skill 目录内放一个指向外部的软链接
        std::os::unix::fs::symlink(&outside, skill.dir.join("link.txt")).unwrap();
        let r = read_skill_content(&skill, Some("link.txt"));
        assert!(
            matches!(r, Err(ToolError::Blocked { .. })),
            "软链接逃逸必须被 canonicalize 后拦下，实得 {r:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn 软链接指向_skill_目录内_允许() {
        // 反例的反面：链接目标仍在沙盒内应放行
        let tmp = TempDir::new().unwrap();
        let skill = make_skill(tmp.path(), "demo", "正文");
        fs::write(skill.dir.join("real.md"), "内部内容").unwrap();
        std::os::unix::fs::symlink(skill.dir.join("real.md"), skill.dir.join("alias.md")).unwrap();
        let got = read_skill_content(&skill, Some("alias.md")).unwrap();
        assert_eq!(got, "内部内容");
    }

    #[test]
    fn 兄弟_skill_目录不可读() {
        // 前缀相同的兄弟目录（demo / demo-evil）不能靠字符串前缀绕过
        let tmp = TempDir::new().unwrap();
        let skill = make_skill(tmp.path(), "demo", "正文");
        let evil = tmp.path().join("demo-evil");
        fs::create_dir_all(&evil).unwrap();
        fs::write(evil.join("x.md"), "别的 skill").unwrap();
        let r = read_skill_content(&skill, Some("../demo-evil/x.md"));
        assert!(matches!(r, Err(ToolError::Blocked { .. })), "实得 {r:?}");
    }

    // ============================================================
    // 大小上限 / 类型校验
    // ============================================================

    #[test]
    fn 正文超限截断并注明() {
        let tmp = TempDir::new().unwrap();
        let big = "A".repeat(MAX_BYTES + 5000);
        let skill = make_skill(tmp.path(), "big", &big);
        let got = read_skill_content(&skill, None).unwrap();
        assert!(got.contains("已截断"), "超限应有截断提示");
        assert!(got.len() <= MAX_BYTES + 128);
    }

    #[test]
    fn 辅助文件超限截断并注明() {
        let tmp = TempDir::new().unwrap();
        let skill = make_skill(tmp.path(), "demo", "正文");
        fs::write(skill.dir.join("big.md"), "B".repeat(MAX_BYTES + 5000)).unwrap();
        let got = read_skill_content(&skill, Some("big.md")).unwrap();
        assert!(got.contains("已截断"));
        assert!(got.len() <= MAX_BYTES + 128);
    }

    #[test]
    fn 文件不存在报错() {
        let tmp = TempDir::new().unwrap();
        let skill = make_skill(tmp.path(), "demo", "正文");
        let r = read_skill_content(&skill, Some("references/nope.md"));
        assert!(matches!(r, Err(ToolError::Exec(_))), "实得 {r:?}");
    }

    #[test]
    fn 读目录被拒() {
        let tmp = TempDir::new().unwrap();
        let skill = make_skill(tmp.path(), "demo", "正文");
        fs::create_dir_all(skill.dir.join("references")).unwrap();
        let r = read_skill_content(&skill, Some("references"));
        assert!(r.is_err(), "读目录应报错，实得 {r:?}");
    }

    #[test]
    fn 二进制文件被拒() {
        let tmp = TempDir::new().unwrap();
        let skill = make_skill(tmp.path(), "demo", "正文");
        fs::write(skill.dir.join("blob.bin"), [0x00u8, 0x01, 0x02, 0x00]).unwrap();
        let r = read_skill_content(&skill, Some("blob.bin"));
        assert!(r.is_err(), "二进制文件应被拒，实得 {r:?}");
    }

    // ============================================================
    // Tool trait 契约 + 端到端 execute
    // ============================================================

    #[test]
    fn risk_class_是_low_不弹审批() {
        assert_eq!(LoadSkillTool.risk_class(&json!({})), RiskClass::Low);
    }

    #[test]
    fn schema_name_必填_file_可选() {
        let s = LoadSkillTool.input_schema();
        assert_eq!(s["type"], "object");
        assert!(s["properties"]["name"].is_object());
        assert!(s["properties"]["file"].is_object());
        assert_eq!(s["required"][0], "name");
        assert_eq!(s["required"].as_array().unwrap().len(), 1, "file 不该必填");
    }

    #[tokio::test]
    async fn execute_加载项目级_skill_正文() {
        let cwd = TempDir::new().unwrap();
        let root = cwd.path().join(".claude").join("skills");
        fs::create_dir_all(&root).unwrap();
        make_skill(&root, "aitm-test-e2e", "# 端到端正文标记\n");
        let ctx = make_ctx(cwd.path().to_path_buf());
        let r = LoadSkillTool
            .execute(json!({ "name": "aitm-test-e2e" }), &ctx)
            .await
            .unwrap();
        assert!(!r.is_error);
        assert!(r.content.contains("# 端到端正文标记"));
        assert!(!r.content.contains("description:"));
    }

    #[tokio::test]
    async fn execute_穿越路径_blocked() {
        let cwd = TempDir::new().unwrap();
        let root = cwd.path().join(".claude").join("skills");
        fs::create_dir_all(&root).unwrap();
        make_skill(&root, "aitm-test-e2e2", "正文");
        fs::write(root.join("secret.txt"), "机密").unwrap();
        let ctx = make_ctx(cwd.path().to_path_buf());
        let r = LoadSkillTool
            .execute(
                json!({ "name": "aitm-test-e2e2", "file": "../secret.txt" }),
                &ctx,
            )
            .await;
        assert!(matches!(r, Err(ToolError::Blocked { .. })), "实得 {r:?}");
    }

    #[tokio::test]
    async fn execute_skill_不存在_报错() {
        let cwd = TempDir::new().unwrap();
        let ctx = make_ctx(cwd.path().to_path_buf());
        let r = LoadSkillTool
            .execute(json!({ "name": "绝对不存在的-skill-名字-xyz" }), &ctx)
            .await;
        assert!(r.is_err(), "实得 {r:?}");
    }

    #[tokio::test]
    async fn execute_缺_name_参数_invalid() {
        let cwd = TempDir::new().unwrap();
        let ctx = make_ctx(cwd.path().to_path_buf());
        let r = LoadSkillTool.execute(json!({}), &ctx).await;
        assert!(matches!(r, Err(ToolError::InvalidArgs(_))));
    }
}
