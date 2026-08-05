//! list_skills 工具：按需搜索 skill（v1.3.0 P8）。
//!
//! # 为什么要有这个工具（真机实证，不是假设）
//!
//! v1.3.0 P2 补扫 plugin skills 后，真机上 skill 数可从几十涨到 **上百个**。当时的做法是
//! 把**全量清单**（名字 + 截断简介，预算 20KB）注入 system prompt，真机暴露三个问题：
//!
//! 1. AI 只「看到」三分之一 —— 清单里 118 条，AI 连续两次回答「共 37 个」
//! 2. 冲淡了排在前面的反幻觉铁律 —— 同一轮里没调浏览器工具就宣称「浏览器已经打开了」
//! 3. 每轮发消息卡几秒 —— 每次 `ai_chat_send` 都重扫 119 个 plugin skill 目录
//!
//! 所以清单不再进 system prompt：system prompt 只留一段几百字节的说明（见
//! [`crate::skills::render_hint`]），AI 要用 skill 时**自己调本工具搜**。
//!
//! # 与 `load_skill` 的分工
//!
//! - `list_skills`：找得到（名字 + 简介，便宜）
//! - `load_skill`：拿得到（完整正文 / 辅助文件，贵）

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::skills::{self, DESC_MAX_CHARS, SkillMeta};

use super::{RiskClass, Tool, ToolContext, ToolError, ToolResult};

/// 一次搜索最多列出的条数。
///
/// 20 条 × 200 字符简介 ≈ 12KB 上限，够 AI 挑出想要的那个；命中更多时提示它
/// 换更具体的关键词，而不是把上下文灌满 —— 这正是全量清单模式的老毛病。
const MAX_RESULTS: usize = 20;

pub struct ListSkillsTool;

#[derive(Deserialize)]
struct Args {
    #[serde(default)]
    query: Option<String>,
}

#[async_trait]
impl Tool for ListSkillsTool {
    fn name(&self) -> &str {
        "list_skills"
    }

    fn description(&self) -> &str {
        "搜索可用的 skill（Claude Code 兼容）。传 query 按关键词匹配名字和简介，不传则只返回全部 skill 的名字。拿到名字后用 load_skill 加载正文。"
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "可选。搜索关键词，匹配 skill 的名字和简介（大小写不敏感，支持中文）。省略则返回全部 skill 的名字（不含简介）。"
                }
            },
            "required": []
        })
    }

    fn risk_class(&self, _args: &Value) -> RiskClass {
        // 纯只读（只扫 skill 目录的元信息），不该弹审批
        RiskClass::Low
    }

    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<ToolResult, ToolError> {
        let parsed: Args = serde_json::from_value(args)
            .map_err(|e| ToolError::InvalidArgs(format!("list_skills 参数: {e}")))?;

        let cwd = ctx.cwd.clone();
        // 扫目录是阻塞 IO（虽然通常命中缓存），丢到 blocking 线程池
        let content = tokio::task::spawn_blocking(move || {
            let all = skills::load_skills_cached(&cwd);
            render(&all, parsed.query.as_deref())
        })
        .await
        .map_err(|e| ToolError::Exec(format!("skill 搜索任务失败: {e}")))?;

        Ok(ToolResult {
            content,
            is_error: false,
        })
    }
}

/// 渲染搜索结果（纯函数，单测直接打这个）。
///
/// - `query = None` / 空白串 → 只返回**名字全集**（不含简介，便宜）
/// - `query = Some(q)` → 名字或简介含 `q`（大小写不敏感）的条目，最多
///   [`MAX_RESULTS`] 条，超出时注明还有多少条
pub(crate) fn render(all: &[SkillMeta], query: Option<&str>) -> String {
    if all.is_empty() {
        return "当前没有安装任何 skill。".to_string();
    }

    // LLM 常给 optional 参数填空串（项目 CLAUDE.md 记过这个坑）→ 视同未传
    let q = query.map(str::trim).filter(|s| !s.is_empty());
    let Some(q) = q else {
        return render_all_names(all);
    };

    let needle = q.to_lowercase();
    let hits: Vec<&SkillMeta> = all
        .iter()
        .filter(|s| {
            s.name.to_lowercase().contains(&needle)
                || s.description.to_lowercase().contains(&needle)
        })
        .collect();

    if hits.is_empty() {
        return format!(
            "关键词「{q}」没有匹配到任何 skill（共 {} 个可用）。换个关键词再搜，或不带 query 调 list_skills 看全部名字。",
            all.len()
        );
    }

    let mut out = format!(
        "关键词「{q}」命中 {} 个 skill（共 {} 个可用）：\n\n",
        hits.len(),
        all.len()
    );
    for s in hits.iter().take(MAX_RESULTS) {
        let desc = skills::normalize_desc(&s.description);
        let desc = if desc.is_empty() {
            "(无描述)".to_string()
        } else {
            skills::truncate_chars(&desc, DESC_MAX_CHARS)
        };
        out.push_str(&format!("- `{}`：{}\n", s.name, desc));
    }
    if hits.len() > MAX_RESULTS {
        out.push_str(&format!(
            "\n[只列出前 {MAX_RESULTS} 条，还有 {} 条未列出；换更具体的关键词缩小范围]\n",
            hits.len() - MAX_RESULTS
        ));
    }
    out.push_str("\n用 `load_skill(name=\"名字\")` 加载正文后照做，不要凭名字猜内容。\n");
    out
}

/// 不带 query 时的输出：只有名字，没有简介（便宜，118 个也就 2KB 左右）。
fn render_all_names(all: &[SkillMeta]) -> String {
    let names: Vec<&str> = all.iter().map(|s| s.name.as_str()).collect();
    format!(
        "共 {} 个可用 skill（下面**只有名字**）。要看简介用 `list_skills(query=\"关键词\")` 搜，要正文用 `load_skill(name=\"名字\")`。\n\n{}\n",
        all.len(),
        names.join("、")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use tempfile::TempDir;

    fn meta(name: &str, desc: &str) -> SkillMeta {
        SkillMeta {
            name: name.into(),
            description: desc.into(),
            dir: PathBuf::from(format!("/tmp/{name}")),
        }
    }

    fn sample() -> Vec<SkillMeta> {
        vec![
            meta("writing-expert", "资深写作专家。写技术文 / 公众号 / 博客。Triggers：写文章 / 起草"),
            meta("risk-expert", "风险评估与控制专家。覆盖技术 / 业务 / 法律合规。Triggers：风险 / risk"),
            meta("lark-base", "飞书多维表格（Base）操作：建表、字段、记录、视图"),
            meta("nodesc", ""),
        ]
    }

    /// 取一行「：」之后的简介字符数。
    fn desc_chars(line: &str) -> usize {
        line.chars().skip_while(|c| *c != '：').count().saturating_sub(1)
    }

    fn ctx_at(cwd: PathBuf) -> ToolContext {
        ToolContext {
            session_state: Arc::new(crate::ipc::session::SessionState::new()),
            cwd,
            active_session_id: None,
            whitelist: Arc::new(crate::safety::whitelist::CompiledWhitelist::empty()),
            browser_state: Arc::new(crate::ipc::browser::BrowserState::default()),
        }
    }

    /// 在 `<cwd>/.claude/skills/` 下造一个项目级 skill。
    fn write_project_skill(cwd: &Path, name: &str, desc: &str, body: &str) {
        let dir = cwd.join(".claude").join("skills").join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: {desc}\n---\n{body}"),
        )
        .unwrap();
    }

    // ============================================================
    // 关键词搜索
    // ============================================================

    #[test]
    fn 按中文关键词命中() {
        let got = render(&sample(), Some("飞书"));
        assert!(got.contains("- `lark-base`："), "中文关键词应命中简介，实得：\n{got}");
        assert!(!got.contains("- `writing-expert`："), "不相关的不该出现");
        assert!(got.contains("命中 1 个 skill"), "应报命中数");
        assert!(got.contains("共 4 个可用"), "应报总数");
    }

    #[test]
    fn 按英文关键词命中_大小写不敏感() {
        let upper = render(&sample(), Some("RISK"));
        assert!(upper.contains("- `risk-expert`："), "大写关键词应命中，实得：\n{upper}");
        // 表头会回显关键词原文，所以只比命中的条目行
        let hits = |s: &str| -> Vec<String> {
            s.lines().filter(|l| l.starts_with("- `")).map(str::to_string).collect()
        };
        let lower = render(&sample(), Some("risk"));
        assert_eq!(hits(&upper), hits(&lower), "大小写不该影响命中结果");
    }

    #[test]
    fn 关键词匹配名字而不只是简介() {
        // "lark" 只出现在名字里，简介里没有
        let got = render(&sample(), Some("lark"));
        assert!(got.contains("- `lark-base`："));
    }

    #[test]
    fn 命中项带截断后的简介() {
        let long = meta("long-one", &"描".repeat(500));
        let got = render(&[long], Some("long"));
        let line = got.lines().find(|l| l.starts_with("- `long-one`")).unwrap();
        assert_eq!(desc_chars(line), DESC_MAX_CHARS + 1, "简介应截到 200 字符 + 省略号");
        assert!(line.ends_with('…'));
    }

    #[test]
    fn 无描述的_skill_显示占位() {
        let got = render(&sample(), Some("nodesc"));
        assert!(got.contains("- `nodesc`：(无描述)"));
    }

    #[test]
    fn 结果带_load_skill_引导且禁止凭名字猜() {
        let got = render(&sample(), Some("飞书"));
        assert!(got.contains("load_skill"), "命中结果应引导去加载正文");
        assert!(got.contains("不要凭名字猜"));
    }

    // ============================================================
    // 条数上限
    // ============================================================

    #[test]
    fn 命中过多时截到上限并注明还有多少条() {
        let skills: Vec<SkillMeta> = (0..35)
            .map(|i| meta(&format!("plugin-skill-{i:02}"), "都能被 plugin 命中"))
            .collect();
        let got = render(&skills, Some("plugin"));
        let listed = got.lines().filter(|l| l.starts_with("- `")).count();
        assert_eq!(listed, MAX_RESULTS, "最多列 20 条");
        assert!(got.contains("命中 35 个 skill"), "命中总数仍要报给 AI");
        assert!(got.contains("还有 15 条未列出"), "应注明未列出的条数，实得：\n{got}");
    }

    #[test]
    fn 命中数不超上限时无未列出提示() {
        let got = render(&sample(), Some("专家"));
        assert!(!got.contains("未列出"));
    }

    /// 🔴 回归护栏（承接 `skills::render_catalog` 时代的
    /// 「真实规模 118 个简介不被压到无意义」）：
    ///
    /// 老实现把 118 条全量清单塞进 20KB 的 system prompt 预算，简介被二分压到平均
    /// 23~44 字符，AI 看不出用途。改成按需搜索后**不再有全局预算**：一次只返回 20 条，
    /// 每条按 [`DESC_MAX_CHARS`] 固定截断。这里锁住「简介不会因为 skill 总数多而被压缩」。
    #[test]
    fn 真实规模_118_个_搜索结果简介不被压缩() {
        let skills: Vec<SkillMeta> = (0..118)
            .map(|i| {
                meta(
                    &format!("some-plugin-skill-name-{i:03}"),
                    &"描".repeat(DESC_MAX_CHARS * 2),
                )
            })
            .collect();
        let got = render(&skills, Some("some-plugin-skill"));
        let descs: Vec<usize> = got
            .lines()
            .filter(|l| l.starts_with("- `"))
            .map(desc_chars)
            .collect();
        assert_eq!(descs.len(), MAX_RESULTS);
        for d in &descs {
            assert_eq!(
                *d,
                DESC_MAX_CHARS + 1,
                "简介必须按固定上限截断，不能因为总数多被压缩"
            );
        }
        assert!(got.contains("还有 98 条未列出"));
    }

    // ============================================================
    // 不传 query → 名字全集
    // ============================================================

    #[test]
    fn 不传_query_返回名字全集且不含简介() {
        let got = render(&sample(), None);
        for name in ["writing-expert", "risk-expert", "lark-base", "nodesc"] {
            assert!(got.contains(name), "{name} 应出现在全集里，实得：\n{got}");
        }
        assert!(!got.contains("资深写作专家"), "🔴 全集模式不该带简介（贵）");
        assert!(!got.contains("飞书多维表格"), "🔴 全集模式不该带简介（贵）");
        assert!(got.contains("共 4 个可用 skill"));
        assert!(got.contains("list_skills(query="), "应引导用关键词搜简介");
    }

    #[test]
    fn 空串_query_视同不传() {
        let sample = sample();
        assert_eq!(render(&sample, Some("   ")), render(&sample, None));
        assert_eq!(render(&sample, Some("")), render(&sample, None));
    }

    #[test]
    fn 全集模式_118_个也不算大() {
        let skills: Vec<SkillMeta> = (0..118)
            .map(|i| meta(&format!("some-plugin-skill-name-{i:03}"), &"描".repeat(300)))
            .collect();
        let got = render(&skills, None);
        assert!(
            got.len() < 5 * 1024,
            "118 个名字应远小于旧的 20KB 全量清单，实得 {} 字节",
            got.len()
        );
    }

    // ============================================================
    // 边界：无匹配 / 没装 skill
    // ============================================================

    #[test]
    fn 无匹配时给友好提示而不是空串() {
        let got = render(&sample(), Some("绝对不存在的关键词xyz"));
        assert!(got.contains("没有匹配到"), "实得：{got}");
        assert!(got.contains("绝对不存在的关键词xyz"), "应回显关键词");
        assert!(got.contains("共 4 个可用"), "应告诉 AI 总共有多少个可搜");
        assert!(!got.contains("- `"), "不该列出任何条目");
    }

    #[test]
    fn 一个_skill_都没装() {
        let got = render(&[], Some("随便"));
        assert!(got.contains("没有安装任何 skill"));
        assert_eq!(render(&[], None), got, "不传 query 也是同样的提示");
    }

    // ============================================================
    // Tool trait 契约 + 端到端 execute
    // ============================================================

    #[test]
    fn risk_class_是_low_不弹审批() {
        assert_eq!(ListSkillsTool.risk_class(&json!({})), RiskClass::Low);
    }

    #[test]
    fn schema_query_可选() {
        let s = ListSkillsTool.input_schema();
        assert_eq!(s["type"], "object");
        assert!(s["properties"]["query"].is_object());
        assert_eq!(
            s["required"].as_array().unwrap().len(),
            0,
            "query 必须可选（不传返回名字全集）"
        );
    }

    #[tokio::test]
    async fn execute_搜到项目级_skill() {
        let cwd = TempDir::new().unwrap();
        write_project_skill(
            cwd.path(),
            "aitm-test-p8-search",
            "P8 搜索测试专用简介",
            "# 正文不该出现在搜索结果里\n",
        );
        let ctx = ctx_at(cwd.path().to_path_buf());
        let r = ListSkillsTool
            .execute(json!({ "query": "P8 搜索测试" }), &ctx)
            .await
            .unwrap();
        assert!(!r.is_error);
        assert!(r.content.contains("aitm-test-p8-search"), "实得：\n{}", r.content);
        assert!(
            !r.content.contains("# 正文不该出现在搜索结果里"),
            "🔴 搜索结果只有名字 + 简介，正文走 load_skill"
        );
    }

    #[tokio::test]
    async fn execute_不传_query_不报错() {
        let cwd = TempDir::new().unwrap();
        write_project_skill(cwd.path(), "aitm-test-p8-all", "全集测试", "正文");
        let ctx = ctx_at(cwd.path().to_path_buf());
        let r = ListSkillsTool.execute(json!({}), &ctx).await.unwrap();
        assert!(!r.is_error);
        assert!(r.content.contains("aitm-test-p8-all"));
    }

    #[tokio::test]
    async fn execute_query_非字符串_invalid_args() {
        let cwd = TempDir::new().unwrap();
        let ctx = ctx_at(cwd.path().to_path_buf());
        let r = ListSkillsTool.execute(json!({ "query": 123 }), &ctx).await;
        assert!(matches!(r, Err(ToolError::InvalidArgs(_))), "实得 {r:?}");
    }
}
