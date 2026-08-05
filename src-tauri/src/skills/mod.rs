//! Claude Code skills 兼容层（v1.3.0 B1）。
//!
//! CC skill 的磁盘格式（对照真实安装目录调研得出）：
//!
//! ```text
//! ~/.claude/skills/<name>/SKILL.md
//! ---
//! name: mem-doctor
//! description: AI 记忆库体检医生——……（含 Triggers 关键词，可能 300+ 字）
//! version: 0.1.0
//! changelog:
//!   - "0.1.0 (...): ..."
//! ---
//! <markdown 正文 = 给 LLM 的指令>
//! ```
//!
//! 部分 skill 目录下还带 `references/xxx.md` 等辅助文件。
//!
//! # 三级扫描（v1.3.0 P2 补：plugin skills 覆盖缺口）
//!
//! 1. 全局：`~/.claude/skills/*/SKILL.md`
//! 2. 项目级：`<cwd>/.claude/skills/*/SKILL.md`
//! 3. plugin 级：`~/.claude/plugins/marketplaces/**/skills/*/SKILL.md`（Claude Code
//!    市场安装的 plugin 自带的 skill，此前完全没被扫到——真机确认一整套
//!    市场安装的 skill 全在这一级，此前一个都没加载）
//!
//! 同名时**项目级 > 全局（用户级）> plugin 级**。
//!
//! plugin 级的实际目录深度不固定，实地调研（2026-07）发现至少三种真实共存：
//! - `marketplaces/<market>/skills/<skill>/SKILL.md`（市场名下直接是 skills）
//! - `marketplaces/<market>/<plugin>/skills/<skill>/SKILL.md`（市场/插件/skills）
//! - `marketplaces/<market>/plugins/<plugin>/skills/<skill>/SKILL.md`（市场
//!   /`plugins` 字面量目录/插件/skills，官方 `claude-plugins-official` 市场下的
//!   插件都是这个深度）
//!
//! 与其针对每种深度写死一条 glob，[`scan_plugin_skills`] 改成有界深度的递归：
//! 只要找到一个名字恰好是 `skills` 的目录就当成一个 skills 根（复用
//! [`scan_dir`]）。这样不管市场仓库怎么嵌套插件目录都能覆盖，也不用每发现
//! 一种新布局就再加一条模式。
//!
//! # 容错约定（绝不让 AI 主流程崩）
//!
//! - 目录不存在 / 读取失败 → 返回空列表
//! - 单个 skill 无 frontmatter → **跳过它**，不影响其它
//! - 有 frontmatter 但缺 `name` → 用**目录名**兜底
//! - 缺 `description` → 留空串（清单里显示 `(无描述)`），仍可被 `load_skill` 加载
//!
//! # 为什么手写 frontmatter 解析而不引 YAML 库
//!
//! 本模块只需要 `name` + `description` 两个顶层标量字段。项目现有依赖里没有任何
//! YAML crate（只有 `toml`），为两个字段引入 `serde_yaml` 这类完整 YAML 实现
//! 不划算（军规 §12 依赖最小化）。这里手写一个「取 `---` 之间的顶层 `key: value`」
//! 的极简解析器，额外支持块标量（`|` / `>` 及其 `-` / `+` 变体），足够覆盖 CC 的
//! 实际写法；解析不了的字段一律忽略（不影响其它 skill）。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

/// 单条 description 在搜索结果里的最大字符数（按 char 截断，中文友好）。
///
/// CC 惯例把「用途 + Triggers 关键词」写在 description 开头，所以保留开头即可
/// 让 LLM 判断该不该加载这个 skill。
pub const DESC_MAX_CHARS: usize = 200;

/// 项目级 skill 在 system prompt 提示段里最多点名几个。
///
/// 项目级 skill（`<cwd>/.claude/skills`）通常只有 0~2 个，这个上限只是防
/// 极端情况下把提示段撑大；超出部分注明数量，AI 仍可用 `list_skills` 搜到。
const PROJECT_SKILL_NAMES_MAX: usize = 20;

/// skill 根目录里每个 skill 的入口文件名（CC 约定）。
pub const SKILL_ENTRY: &str = "SKILL.md";

/// `.claude` 下存放 skill 的子目录名（CC 约定）。
const SKILLS_SUBDIR: &str = "skills";

/// 一个 skill 的元信息。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillMeta {
    /// skill 名（frontmatter `name`，缺失时用目录名兜底）。
    pub name: String,
    /// frontmatter `description` 原文（**未截断**；截断只发生在渲染清单时）。
    pub description: String,
    /// 该 skill 的目录（`load_skill` 的沙盒根就是它）。
    pub dir: PathBuf,
}

/// frontmatter 里我们关心的字段。
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Frontmatter {
    pub name: Option<String>,
    pub description: Option<String>,
}

/// 解析 markdown 头部的 YAML frontmatter，只取 `name` / `description`。
///
/// 没有合法 frontmatter（首行不是 `---`，或找不到闭合 `---`）→ `None`。
pub(crate) fn parse_frontmatter(content: &str) -> Option<Frontmatter> {
    let lines: Vec<&str> = content.lines().collect();
    let first = lines.first()?.trim_end();
    // 允许 UTF-8 BOM 开头
    if first.trim_start_matches('\u{feff}') != "---" {
        return None;
    }
    // 找闭合的 `---`
    let end = lines
        .iter()
        .skip(1)
        .position(|l| l.trim_end() == "---")
        .map(|i| i + 1)?;

    let mut fm = Frontmatter::default();
    let body = &lines[1..end];
    let mut i = 0;
    while i < body.len() {
        let line = body[i];
        i += 1;
        // 只认顶层字段：有前导空白的是嵌套内容（如 changelog 的列表项），跳过
        if line.starts_with(' ') || line.starts_with('\t') || line.trim().is_empty() {
            continue;
        }
        let Some((key, rest)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim();
        if key != "name" && key != "description" {
            continue;
        }
        let rest = rest.trim();
        let value = if is_block_indicator(rest) {
            // 块标量（`|` / `>` / `|-` / `>-` …）：吞掉后续缩进行
            let folded = rest.starts_with('>');
            let mut collected: Vec<String> = Vec::new();
            while i < body.len() {
                let l = body[i];
                if l.trim().is_empty() {
                    collected.push(String::new());
                    i += 1;
                    continue;
                }
                if !(l.starts_with(' ') || l.starts_with('\t')) {
                    break;
                }
                collected.push(l.trim().to_string());
                i += 1;
            }
            let sep = if folded { " " } else { "\n" };
            collected.join(sep).trim().to_string()
        } else {
            unquote(rest).to_string()
        };
        match key {
            "name" => fm.name = Some(value),
            "description" => fm.description = Some(value),
            _ => unreachable!("上面已过滤"),
        }
    }
    Some(fm)
}

/// 是否是 YAML 块标量指示符（`|` / `>` 及其 `-` / `+` chomping 变体）。
fn is_block_indicator(s: &str) -> bool {
    matches!(s, "|" | ">" | "|-" | ">-" | "|+" | ">+")
}

/// 去掉成对的首尾引号（单 / 双）。不成对则原样返回。
fn unquote(s: &str) -> &str {
    for q in ['"', '\''] {
        if s.len() >= 2 && s.starts_with(q) && s.ends_with(q) {
            return &s[1..s.len() - 1];
        }
    }
    s
}

/// 剥掉 frontmatter，返回正文（给 LLM 看的那部分）。
///
/// 没有合法 frontmatter → 原样返回整篇。
pub fn strip_frontmatter(content: &str) -> &str {
    let trimmed = content.trim_start_matches('\u{feff}');
    let mut lines = trimmed.lines();
    if lines.next().map(str::trim_end) != Some("---") {
        return content;
    }
    // 逐行推进，找闭合 `---` 后第一个字符的字节偏移
    let mut offset = 0usize;
    let mut seen_open = false;
    for line in trimmed.split_inclusive('\n') {
        offset += line.len();
        if line.trim_end() == "---" {
            if seen_open {
                return trimmed[offset..].trim_start_matches('\n');
            }
            seen_open = true;
        }
    }
    // 没有闭合 `---` → 不是合法 frontmatter，原样返回
    content
}

/// 扫描单个 skills 根目录：`<root>/*/SKILL.md`。
///
/// 目录不存在 / 无权限 → 空列表（不 warn 到刷屏，只 debug）。
/// 单个 skill 读取或解析失败 → 跳过它。
pub fn scan_dir(root: &Path) -> Vec<SkillMeta> {
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(e) => {
            if e.kind() != std::io::ErrorKind::NotFound {
                tracing::debug!("扫描 skills 目录失败 {}：{e}", root.display());
            }
            return Vec::new();
        }
    };

    let mut out = Vec::new();
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let entry_file = dir.join(SKILL_ENTRY);
        let Ok(content) = std::fs::read_to_string(&entry_file) else {
            continue; // 没有 SKILL.md 的目录不是 skill
        };
        let Some(fm) = parse_frontmatter(&content) else {
            tracing::debug!("skill 无 frontmatter，跳过：{}", entry_file.display());
            continue;
        };
        // 缺 name → 目录名兜底
        let dir_name = dir
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let name = match fm.name {
            Some(n) if !n.trim().is_empty() => n.trim().to_string(),
            _ => dir_name,
        };
        if name.is_empty() {
            continue;
        }
        out.push(SkillMeta {
            name,
            description: fm.description.unwrap_or_default(),
            dir,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// 两级扫描 + 合并：项目级同名**覆盖**全局。结果按名字排序（稳定输出）。
///
/// 参数是**已经拼好的 skills 根目录**（即 `.../.claude/skills`），
/// 便于单测传 tempdir，不依赖真实 `~/.claude`。
///
/// 保留这个双参数签名是因为它是历史 API、单测量大；三级合并见
/// [`discover_all`]（本函数现在只是它的一个特化调用）。
pub fn discover(global_root: Option<&Path>, project_root: Option<&Path>) -> Vec<SkillMeta> {
    discover_all(global_root, project_root, None)
}

/// 递归找 `skills` 目录的最大深度（相对传入的根目录）。
///
/// 实测最深的真实布局是 `market/plugins/<plugin>/skills`（根往下数 4 层），
/// 这里留一层余量。
const PLUGIN_SKILLS_MAX_DEPTH: usize = 5;

/// 递归扫描 plugin skills 时跳过的目录名：要么体积大 IO 无谓（`node_modules`
/// / `target` / `dist` / `build`），要么是版本控制 / CI 元数据，与 skill 无关。
/// 隐藏目录（`.git` / `.claude-plugin` 等）另有 `starts_with('.')` 判断兜底。
const SKIP_DIR_NAMES: &[&str] = &["node_modules", "target", "dist", "build"];

/// 在 `dir` 下递归找所有名字恰好是 `skills` 的目录，收进 `out`。
///
/// 找到一个 `skills` 目录后不再往它内部递归——按 CC 约定，一个 skills 根
/// 下面直接是 `<skill>/SKILL.md`，不会再嵌套出另一层 `skills`。
fn find_skills_dirs(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth == 0 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return; // 目录不存在 / 无权限 → 静默跳过，绝不让扫描主流程崩
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if name == "skills" {
            out.push(path);
            continue;
        }
        if name.starts_with('.') || SKIP_DIR_NAMES.contains(&name) {
            continue;
        }
        find_skills_dirs(&path, depth - 1, out);
    }
}

/// 扫描 `~/.claude/plugins/marketplaces` 下所有市场仓库里的 plugin skills。
///
/// 目录不存在 / 权限错误 → 空列表。同名 skill 跨市场撞车时**保留先扫到的
/// 那份**（`find_skills_dirs` 结果先排序，扫描顺序即目录路径的字典序，
/// 保证结果确定性可测）；正常同名场景应走三级合并的项目/用户级覆盖，
/// 这里只是兜底不让重名的 plugin skill 在清单里出现两次。
pub fn scan_plugin_skills(marketplaces_root: &Path) -> Vec<SkillMeta> {
    let mut dirs = Vec::new();
    find_skills_dirs(marketplaces_root, PLUGIN_SKILLS_MAX_DEPTH, &mut dirs);
    dirs.sort();

    let mut out: Vec<SkillMeta> = Vec::new();
    for d in dirs {
        for skill in scan_dir(&d) {
            if out.iter().any(|s| s.name == skill.name) {
                tracing::debug!(
                    "plugin skill 重名，保留先扫到的一份，丢弃：{}",
                    skill.dir.display()
                );
                continue;
            }
            out.push(skill);
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// 三级扫描 + 合并：**项目级 > 全局（用户级）> plugin 级**。结果按名字排序。
///
/// 参数都是**已经拼好的根目录**（`plugin_root` 是 `.../plugins/marketplaces`，
/// 其余两个同 [`discover`]），便于单测传 tempdir。
pub fn discover_all(
    global_root: Option<&Path>,
    project_root: Option<&Path>,
    plugin_root: Option<&Path>,
) -> Vec<SkillMeta> {
    // 从最低优先级开始铺，后面的同名覆盖前面的——与 discover() 原有的
    // "项目覆盖全局" 逻辑同构，这里只是多插一级更低优先级的 plugin。
    let mut merged: Vec<SkillMeta> = plugin_root.map(scan_plugin_skills).unwrap_or_default();
    for tier in [
        global_root.map(scan_dir).unwrap_or_default(),
        project_root.map(scan_dir).unwrap_or_default(),
    ] {
        for item in tier {
            match merged.iter_mut().find(|s| s.name == item.name) {
                Some(slot) => *slot = item,
                None => merged.push(item),
            }
        }
    }
    merged.sort_by(|a, b| a.name.cmp(&b.name));
    merged
}

/// 真实入口：全局 `~/.claude/skills` + 项目 `<cwd>/.claude/skills` +
/// plugin 级 `~/.claude/plugins/marketplaces/**/skills`。
///
/// 拿不到 HOME → 只扫项目级。任何失败都退化成空列表，绝不 panic。
pub fn load_skills(cwd: &Path) -> Vec<SkillMeta> {
    let home = dirs::home_dir();
    let global = home.as_deref().map(|h| h.join(".claude").join(SKILLS_SUBDIR));
    let project = cwd.join(".claude").join(SKILLS_SUBDIR);
    let plugin_root = home
        .as_deref()
        .map(|h| h.join(".claude").join("plugins").join("marketplaces"));
    discover_all(global.as_deref(), Some(&project), plugin_root.as_deref())
}

/// 扫描结果缓存的有效期。
///
/// # 为什么用 TTL 而不是 mtime 校验（v1.3.0 P8）
///
/// 真机反馈「每次发消息卡几秒」：老实现每轮 `ai_chat_send` 都重新递归扫 119 个
/// plugin skill 目录，无任何缓存。改法有两种：
///
/// - **目录 mtime 校验**：要校验就得递归 stat 那一百多个目录 —— 递归遍历本身就是
///   开销大头，省不下多少，还得处理「新目录出现在没被 stat 的层级」这类漏判
/// - **时间 TTL**（选这个）：一行逻辑，60s 内同一 cwd 直接复用；用户新装 skill 后
///   最多等一分钟就能用上，**不必重启 app**，这是唯一的硬需求
///
/// 60s 兼顾「一轮对话里多次调 list_skills / load_skill 都命中」和「装完 skill 很快能用」。
pub const CACHE_TTL: Duration = Duration::from_secs(60);

/// 进程内扫描缓存：cwd → (写入时刻, 结果)。
///
/// key 必须含 cwd —— 项目级 skill（`<cwd>/.claude/skills`）随 cwd 变，
/// 用户在两个项目间切换时不能串味。
static SKILLS_CACHE: LazyLock<Mutex<HashMap<PathBuf, CacheEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 一条缓存：(写入时刻, 扫描结果)。
type CacheEntry = (Instant, Arc<Vec<SkillMeta>>);

/// [`load_skills`] 的带缓存版本：同一 cwd 在 [`CACHE_TTL`] 内只扫一次盘。
///
/// AI 主流程（system prompt 提示段 / `list_skills` / `load_skill`）一律走这个。
pub fn load_skills_cached(cwd: &Path) -> Arc<Vec<SkillMeta>> {
    cached_with(cwd, CACHE_TTL, load_skills)
}

/// 缓存主体（TTL 与扫描函数可注入，方便单测验证「命中不重复扫盘」）。
///
/// 锁只在查 / 写两个瞬间持有，**扫描发生在锁外**：扫 119 个目录可能上百毫秒，
/// 持锁扫会让并发对话互相阻塞。代价是同时未命中的两个调用可能都扫一遍，
/// 结果一致，无正确性问题（不值得为此加 single-flight）。
fn cached_with(
    cwd: &Path,
    ttl: Duration,
    loader: impl FnOnce(&Path) -> Vec<SkillMeta>,
) -> Arc<Vec<SkillMeta>> {
    // 锁中毒也不能让 AI 主流程崩：直接接管内部数据继续用
    let hit = {
        let guard = SKILLS_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        guard
            .get(cwd)
            .filter(|(at, _)| at.elapsed() < ttl)
            .map(|(_, skills)| Arc::clone(skills))
    };
    if let Some(skills) = hit {
        return skills;
    }

    let fresh = Arc::new(loader(cwd));
    let mut guard = SKILLS_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    guard.insert(cwd.to_path_buf(), (Instant::now(), Arc::clone(&fresh)));
    fresh
}

/// 按名字找 skill：先精确匹配 `name`，再退回匹配目录名。
///
/// 退回匹配是因为 LLM 可能按目录名称呼一个 frontmatter `name` 不一致的 skill。
pub fn find<'a>(skills: &'a [SkillMeta], name: &str) -> Option<&'a SkillMeta> {
    let want = name.trim();
    skills
        .iter()
        .find(|s| s.name == want)
        .or_else(|| skills.iter().find(|s| s.dir.file_name().is_some_and(|d| d == want)))
}

/// 渲染注入 system prompt 的 skills **提示段**（不是清单）。空列表 → `None`。
///
/// # 为什么不再注入全量清单（v1.3.0 P8，真机实证）
///
/// 老实现把「全部 skill 的名字 + 截断简介」塞进 system prompt（预算 20KB）。
/// 补扫 plugin skills 后，真机上 skill 总数可达上百个，连锁暴露三个问题：
///
/// 1. **AI 只「看到」三分之一**：清单里 118 条，AI 连续两次回答「共 37 个」——
///    长清单靠后的内容它压根没充分注意到，等于白塞
/// 2. **冲淡了排在前面的反幻觉铁律**：system prompt 从几 KB 涨到 20KB+ 后，同一轮
///    对话里 AI 没调任何浏览器工具就宣称「浏览器已经打开了」——典型的长上下文
///    「中间遗忘」，最该守住的铁律被稀释
/// 3. **每轮卡几秒**：清单要每次重扫 119 个 plugin skill 目录（缓存见
///    [`load_skills_cached`]）
///
/// 所以这里只留几百字节的**导航说明**：告诉 AI 有多少个 skill、怎么搜、怎么加载。
/// 清单改由 `list_skills` 工具按需返回 —— 需要时才花 token，且一次只返回相关的那几条。
///
/// # 唯一的例外：项目级 skill 直接点名
///
/// `<cwd>/.claude/skills` 下的 skill 是用户**为当前项目专门装的**，数量通常 0~2 个
/// 且与手头的活强相关，点名的收益远大于那几十字节；用户级 / plugin 级（100+ 个）
/// 一律走搜索。
pub fn render_hint(skills: &[SkillMeta], cwd: &Path) -> Option<String> {
    if skills.is_empty() {
        return None;
    }
    let mut out = format!(
        "# 可用 Skills（Claude Code 兼容，共 {} 个）\n\
        skill 是可复用的操作指南。**清单不在这里，也不要凭名字猜内容**：\n\
        - 找：`list_skills(query=\"关键词\")` 按名字 + 简介搜（不传 query 只返回全部名字）\n\
        - 用：`load_skill(name=\"名字\")` 加载正文后照做；辅助文件用 `load_skill(name=\"名字\", file=\"references/xxx.md\")`\n",
        skills.len()
    );

    // 项目级 = 目录落在 `<cwd>/.claude/skills` 下（三级合并后仍保留真实 dir）
    let project_root = cwd.join(".claude").join(SKILLS_SUBDIR);
    let project: Vec<&str> = skills
        .iter()
        .filter(|s| s.dir.starts_with(&project_root))
        .map(|s| s.name.as_str())
        .collect();
    if !project.is_empty() {
        let shown: Vec<&str> = project.iter().take(PROJECT_SKILL_NAMES_MAX).copied().collect();
        let more = project.len() - shown.len();
        let tail = if more > 0 {
            format!("（另有 {more} 个，用 list_skills 搜）")
        } else {
            String::new()
        };
        out.push_str(&format!(
            "\n本项目自带的 skill（`.claude/skills/`，与当前项目强相关）：{}{tail}\n",
            shown.join("、")
        ));
    }
    Some(out)
}

/// 把 description 折成单行（换行 / 连续空白 → 单个空格），保证一行一个 skill。
pub(crate) fn normalize_desc(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 按 **char** 截断（中文一个字符也只算 1），超长时补省略号。
pub(crate) fn truncate_chars(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max_chars).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    /// 在 `root` 下造一个 skill 目录，写入指定的 SKILL.md 全文。
    fn write_skill_raw(root: &Path, dir_name: &str, content: &str) -> PathBuf {
        let dir = root.join(dir_name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(SKILL_ENTRY), content).unwrap();
        dir
    }

    /// 造一个带标准 frontmatter 的 skill。
    fn write_skill(root: &Path, dir_name: &str, name: &str, desc: &str, body: &str) -> PathBuf {
        let content = format!("---\nname: {name}\ndescription: {desc}\nversion: 0.1.0\n---\n{body}");
        write_skill_raw(root, dir_name, &content)
    }

    // ============================================================
    // frontmatter 解析
    // ============================================================

    #[test]
    fn parse_frontmatter_正常取到_name_和_description() {
        let c = "---\nname: mem-doctor\ndescription: 记忆库体检医生\nversion: 0.1.0\n---\n# 正文\n";
        let fm = parse_frontmatter(c).expect("应解析出 frontmatter");
        assert_eq!(fm.name.as_deref(), Some("mem-doctor"));
        assert_eq!(fm.description.as_deref(), Some("记忆库体检医生"));
    }

    #[test]
    fn parse_frontmatter_无_frontmatter_返回_none() {
        assert_eq!(parse_frontmatter("# 直接就是正文\n没有 ---"), None);
        assert_eq!(parse_frontmatter(""), None);
    }

    #[test]
    fn parse_frontmatter_只有开头_没有闭合_返回_none() {
        assert_eq!(parse_frontmatter("---\nname: x\n还没闭合"), None);
    }

    #[test]
    fn parse_frontmatter_缺_description_字段() {
        let fm = parse_frontmatter("---\nname: only-name\n---\n正文").unwrap();
        assert_eq!(fm.name.as_deref(), Some("only-name"));
        assert_eq!(fm.description, None);
    }

    #[test]
    fn parse_frontmatter_缺_name_字段() {
        let fm = parse_frontmatter("---\ndescription: 只有描述\n---\n正文").unwrap();
        assert_eq!(fm.name, None);
        assert_eq!(fm.description.as_deref(), Some("只有描述"));
    }

    #[test]
    fn parse_frontmatter_description_含冒号不被截断() {
        // CC 的 description 常含 "Triggers：写论文 / paper" 这种冒号
        let c = "---\nname: x\ndescription: 写作专家。Triggers：写文章 / draft: 起草\n---\n";
        let fm = parse_frontmatter(c).unwrap();
        assert_eq!(
            fm.description.as_deref(),
            Some("写作专家。Triggers：写文章 / draft: 起草")
        );
    }

    #[test]
    fn parse_frontmatter_忽略嵌套的_changelog_列表项() {
        // changelog 的缩进列表项不能被当成顶层字段解析，也不能污染 description
        let c = "---\nname: x\ndescription: 描述\nversion: 0.1.0\nchangelog:\n  - \"0.1.0: 初版\"\n  - \"0.0.1: name: 假的\"\n---\n正文";
        let fm = parse_frontmatter(c).unwrap();
        assert_eq!(fm.name.as_deref(), Some("x"));
        assert_eq!(fm.description.as_deref(), Some("描述"));
    }

    #[test]
    fn parse_frontmatter_引号包裹会去掉引号() {
        let fm = parse_frontmatter("---\nname: \"quoted\"\ndescription: '单引号'\n---\n").unwrap();
        assert_eq!(fm.name.as_deref(), Some("quoted"));
        assert_eq!(fm.description.as_deref(), Some("单引号"));
    }

    #[test]
    fn parse_frontmatter_块标量_folded() {
        let c = "---\nname: x\ndescription: >-\n  第一行\n  第二行\nversion: 1\n---\n正文";
        let fm = parse_frontmatter(c).unwrap();
        assert_eq!(fm.description.as_deref(), Some("第一行 第二行"));
    }

    #[test]
    fn parse_frontmatter_块标量_literal() {
        let c = "---\nname: x\ndescription: |\n  第一行\n  第二行\n---\n正文";
        let fm = parse_frontmatter(c).unwrap();
        assert_eq!(fm.description.as_deref(), Some("第一行\n第二行"));
    }

    // ============================================================
    // strip_frontmatter
    // ============================================================

    #[test]
    fn strip_frontmatter_去掉头部只留正文() {
        let c = "---\nname: x\ndescription: d\n---\n# 标题\n内容\n";
        assert_eq!(strip_frontmatter(c), "# 标题\n内容\n");
    }

    #[test]
    fn strip_frontmatter_无_frontmatter_原样返回() {
        let c = "# 没有 frontmatter\n正文\n";
        assert_eq!(strip_frontmatter(c), c);
    }

    #[test]
    fn strip_frontmatter_没闭合_原样返回() {
        let c = "---\nname: x\n没闭合的正文";
        assert_eq!(strip_frontmatter(c), c);
    }

    #[test]
    fn strip_frontmatter_正文里的三横线不受影响() {
        let c = "---\nname: x\n---\n# 标题\n\n---\n\n分隔线后面\n";
        assert_eq!(strip_frontmatter(c), "# 标题\n\n---\n\n分隔线后面\n");
    }

    // ============================================================
    // scan_dir
    // ============================================================

    #[test]
    fn scan_dir_目录不存在_返回空() {
        let tmp = TempDir::new().unwrap();
        assert!(scan_dir(&tmp.path().join("不存在")).is_empty());
    }

    #[test]
    fn scan_dir_扫到多个_按名字排序() {
        let tmp = TempDir::new().unwrap();
        write_skill(tmp.path(), "zzz", "zzz", "最后", "正文");
        write_skill(tmp.path(), "aaa", "aaa", "最前", "正文");
        let got = scan_dir(tmp.path());
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].name, "aaa");
        assert_eq!(got[1].name, "zzz");
        assert_eq!(got[0].description, "最前");
    }

    #[test]
    fn scan_dir_跳过无_frontmatter_的_skill_不影响其它() {
        let tmp = TempDir::new().unwrap();
        write_skill(tmp.path(), "good", "good", "好的", "正文");
        write_skill_raw(tmp.path(), "bad", "# 没有 frontmatter\n");
        let got = scan_dir(tmp.path());
        assert_eq!(got.len(), 1, "坏 skill 应被跳过，好的仍在");
        assert_eq!(got[0].name, "good");
    }

    #[test]
    fn scan_dir_缺_name_用目录名兜底() {
        let tmp = TempDir::new().unwrap();
        write_skill_raw(tmp.path(), "fallback-dir", "---\ndescription: 只有描述\n---\n正文");
        let got = scan_dir(tmp.path());
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name, "fallback-dir");
    }

    #[test]
    fn scan_dir_缺_description_留空串仍收录() {
        let tmp = TempDir::new().unwrap();
        write_skill_raw(tmp.path(), "nodesc", "---\nname: nodesc\n---\n正文");
        let got = scan_dir(tmp.path());
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].description, "");
    }

    #[test]
    fn scan_dir_忽略无_skill_md_的目录和散落文件() {
        let tmp = TempDir::new().unwrap();
        write_skill(tmp.path(), "real", "real", "真的", "正文");
        fs::create_dir_all(tmp.path().join("空目录")).unwrap();
        fs::write(tmp.path().join("README.md"), "不是 skill").unwrap();
        let got = scan_dir(tmp.path());
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name, "real");
    }

    // ============================================================
    // discover（两级 + 覆盖）
    // ============================================================

    #[test]
    fn discover_两级都不存在_返回空() {
        let tmp = TempDir::new().unwrap();
        let got = discover(
            Some(&tmp.path().join("no-global")),
            Some(&tmp.path().join("no-project")),
        );
        assert!(got.is_empty());
    }

    #[test]
    fn discover_项目级同名覆盖全局() {
        let g = TempDir::new().unwrap();
        let p = TempDir::new().unwrap();
        write_skill(g.path(), "dup", "dup", "全局版本", "全局正文");
        write_skill(g.path(), "only-global", "only-global", "仅全局", "正文");
        write_skill(p.path(), "dup", "dup", "项目版本", "项目正文");

        let got = discover(Some(g.path()), Some(p.path()));
        assert_eq!(got.len(), 2, "同名只保留一份");
        let dup = find(&got, "dup").unwrap();
        assert_eq!(dup.description, "项目版本", "项目级应覆盖全局");
        assert!(dup.dir.starts_with(p.path()), "覆盖后 dir 应指向项目级目录");
        assert!(find(&got, "only-global").is_some());
    }

    #[test]
    fn discover_合并结果按名字排序() {
        let g = TempDir::new().unwrap();
        let p = TempDir::new().unwrap();
        write_skill(g.path(), "m-global", "m-global", "g", "正文");
        write_skill(p.path(), "a-project", "a-project", "p", "正文");
        write_skill(p.path(), "z-project", "z-project", "p", "正文");
        let got = discover(Some(g.path()), Some(p.path()));
        let names: Vec<&str> = got.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["a-project", "m-global", "z-project"]);
    }

    #[test]
    fn discover_全局为_none_只扫项目() {
        let p = TempDir::new().unwrap();
        write_skill(p.path(), "only", "only", "d", "正文");
        let got = discover(None, Some(p.path()));
        assert_eq!(got.len(), 1);
    }

    // ============================================================
    // find
    // ============================================================

    #[test]
    fn find_按_name_精确匹配_也支持目录名兜底() {
        let tmp = TempDir::new().unwrap();
        // frontmatter name 与目录名不一致
        write_skill_raw(
            tmp.path(),
            "dir-name",
            "---\nname: fm-name\ndescription: d\n---\n正文",
        );
        let skills = scan_dir(tmp.path());
        assert_eq!(find(&skills, "fm-name").unwrap().name, "fm-name");
        assert_eq!(find(&skills, "dir-name").unwrap().name, "fm-name");
        assert!(find(&skills, "不存在").is_none());
    }

    // ============================================================
    // render_hint（v1.3.0 P8：system prompt 只留几百字节导航说明）
    // ============================================================

    /// 造一批只有名字 / 简介的 SkillMeta（dir 指向 `<base>/<name>`）。
    fn metas(base: &Path, specs: &[(&str, &str)]) -> Vec<SkillMeta> {
        specs
            .iter()
            .map(|(n, d)| SkillMeta {
                name: (*n).to_string(),
                description: (*d).to_string(),
                dir: base.join(n),
            })
            .collect()
    }

    #[test]
    fn render_hint_空列表_返回_none() {
        let tmp = TempDir::new().unwrap();
        assert_eq!(render_hint(&[], tmp.path()), None);
    }

    #[test]
    fn render_hint_报真实数量并引导两个工具() {
        let tmp = TempDir::new().unwrap();
        let skills = metas(
            &tmp.path().join("global"),
            &[("a", "描述 A"), ("b", "描述 B"), ("c", "描述 C")],
        );
        let got = render_hint(&skills, tmp.path()).unwrap();
        assert!(got.contains("共 3 个"), "数量必须是真实值，实得：\n{got}");
        assert!(got.contains("list_skills"), "必须引导去搜索");
        assert!(got.contains("load_skill"), "必须引导去加载正文");
        assert!(got.contains("不要凭名字猜"));
    }

    /// 🔴 P8 的核心：**全量清单不再进 system prompt**。
    #[test]
    fn render_hint_不含全量清单_也不含任何简介() {
        let tmp = TempDir::new().unwrap();
        let skills = metas(
            &tmp.path().join("global"),
            &[
                ("writing-expert", "资深写作专家。写技术文 / 公众号"),
                ("risk-expert", "风险评估与控制专家"),
            ],
        );
        let got = render_hint(&skills, tmp.path()).unwrap();
        assert!(!got.contains("资深写作专家"), "🔴 简介不该进 system prompt");
        assert!(!got.contains("风险评估与控制专家"), "🔴 简介不该进 system prompt");
        assert!(!got.contains("- `writing-expert`"), "🔴 清单行不该进 system prompt");
        assert!(!got.contains("risk-expert"), "🔴 用户级 skill 的名字也不该逐个列出");
    }

    /// 真实规模（118 个）下提示段必须是**几百字节**量级，而不是老实现的 20KB。
    #[test]
    fn render_hint_真实规模_118_个_体积仍在数百字节() {
        let tmp = TempDir::new().unwrap();
        let specs: Vec<(String, String)> = (0..118)
            .map(|i| (format!("some-plugin-skill-name-{i:03}"), "描".repeat(300)))
            .collect();
        let skills: Vec<SkillMeta> = specs
            .iter()
            .map(|(n, d)| SkillMeta {
                name: n.clone(),
                description: d.clone(),
                dir: tmp.path().join("plugin").join(n),
            })
            .collect();
        let got = render_hint(&skills, tmp.path()).unwrap();
        assert!(
            got.len() < 1024,
            "提示段必须是数百字节量级（老实现 20KB），实得 {} 字节：\n{got}",
            got.len()
        );
        assert!(got.contains("共 118 个"), "数量要真实");
    }

    #[test]
    fn render_hint_项目级_skill_直接点名() {
        // 项目级（<cwd>/.claude/skills）是用户为这个项目专门装的，值得点名；
        // 用户级 / plugin 级只报总数走搜索。
        let cwd = TempDir::new().unwrap();
        let project_root = cwd.path().join(".claude").join("skills");
        let mut skills = metas(&project_root, &[("proj-only", "项目专用")]);
        skills.extend(metas(
            &cwd.path().join("home").join("skills"),
            &[("user-level", "用户级")],
        ));
        let got = render_hint(&skills, cwd.path()).unwrap();
        assert!(got.contains("proj-only"), "项目级 skill 应被点名，实得：\n{got}");
        assert!(!got.contains("user-level"), "用户级不该点名（走搜索）");
        assert!(!got.contains("项目专用"), "点名只给名字，不给简介");
    }

    #[test]
    fn render_hint_无项目级_skill_时不出现该段() {
        let cwd = TempDir::new().unwrap();
        let skills = metas(&cwd.path().join("home"), &[("user-level", "用户级")]);
        let got = render_hint(&skills, cwd.path()).unwrap();
        assert!(!got.contains("本项目自带"), "没有项目级 skill 就不该有这段");
    }

    #[test]
    fn render_hint_项目级过多时截断并注明() {
        let cwd = TempDir::new().unwrap();
        let project_root = cwd.path().join(".claude").join("skills");
        let names: Vec<String> = (0..25).map(|i| format!("p{i:02}")).collect();
        let skills: Vec<SkillMeta> = names
            .iter()
            .map(|n| SkillMeta {
                name: n.clone(),
                description: "d".into(),
                dir: project_root.join(n),
            })
            .collect();
        let got = render_hint(&skills, cwd.path()).unwrap();
        assert!(got.contains("另有 5 个"), "超出上限应注明，实得：\n{got}");
    }

    // ============================================================
    // 扫描缓存（v1.3.0 P8：真机每轮发消息卡几秒的根因）
    // ============================================================

    #[test]
    fn 缓存命中_不重复扫盘() {
        let tmp = TempDir::new().unwrap();
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let load = |_: &Path| {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            vec![SkillMeta {
                name: "cached".into(),
                description: "d".into(),
                dir: PathBuf::from("/tmp/cached"),
            }]
        };
        let ttl = Duration::from_secs(60);
        let first = cached_with(tmp.path(), ttl, load);
        let second = cached_with(tmp.path(), ttl, load);
        let third = cached_with(tmp.path(), ttl, load);
        assert_eq!(
            calls.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "TTL 内多次调用只该扫一次盘"
        );
        assert_eq!(first[0].name, "cached");
        assert_eq!(second.len(), 1);
        assert_eq!(third.len(), 1);
    }

    #[test]
    fn 缓存按_cwd_分键_不同项目不串味() {
        // 项目级 skill 随 cwd 变，缓存 key 必须含 cwd
        let a = TempDir::new().unwrap();
        let b = TempDir::new().unwrap();
        let ttl = Duration::from_secs(60);
        let got_a = cached_with(a.path(), ttl, |p| {
            vec![SkillMeta {
                name: "a-side".into(),
                description: p.display().to_string(),
                dir: p.to_path_buf(),
            }]
        });
        let got_b = cached_with(b.path(), ttl, |p| {
            vec![SkillMeta {
                name: "b-side".into(),
                description: p.display().to_string(),
                dir: p.to_path_buf(),
            }]
        });
        assert_eq!(got_a[0].name, "a-side");
        assert_eq!(got_b[0].name, "b-side", "另一个 cwd 不该命中前一个的缓存");
    }

    #[test]
    fn 缓存_ttl_到期后能扫到新装的_skill() {
        // 硬需求：用户新装 skill 后不必重启 app
        let tmp = TempDir::new().unwrap();
        let ttl = Duration::from_millis(30);
        let before = cached_with(tmp.path(), ttl, |_| {
            vec![SkillMeta {
                name: "old-only".into(),
                description: "d".into(),
                dir: PathBuf::from("/tmp/old"),
            }]
        });
        assert_eq!(before.len(), 1);

        std::thread::sleep(Duration::from_millis(60));

        let after = cached_with(tmp.path(), ttl, |_| {
            vec![
                SkillMeta {
                    name: "old-only".into(),
                    description: "d".into(),
                    dir: PathBuf::from("/tmp/old"),
                },
                SkillMeta {
                    name: "newly-installed".into(),
                    description: "d".into(),
                    dir: PathBuf::from("/tmp/new"),
                },
            ]
        });
        assert_eq!(after.len(), 2, "TTL 到期应重扫，扫到新装的 skill");
        assert!(find(&after, "newly-installed").is_some());
    }

    #[test]
    fn load_skills_cached_真实入口能扫到项目级() {
        let cwd = TempDir::new().unwrap();
        let root = cwd.path().join(".claude").join("skills");
        fs::create_dir_all(&root).unwrap();
        write_skill(&root, "aitm-test-cache-x1", "aitm-test-cache-x1", "缓存测试", "正文");
        let got = load_skills_cached(cwd.path());
        assert!(find(&got, "aitm-test-cache-x1").is_some());
        // 第二次走缓存，返回同一份数据
        let again = load_skills_cached(cwd.path());
        assert_eq!(*got, *again);
    }

    // ============================================================
    // load_skills（真实入口 —— 只验项目级，避免依赖真实 ~/.claude）
    // ============================================================

    #[test]
    fn load_skills_能扫到项目级_claude_skills() {
        let cwd = TempDir::new().unwrap();
        let root = cwd.path().join(".claude").join("skills");
        fs::create_dir_all(&root).unwrap();
        // 名字加随机后缀，避免与维护者真实 ~/.claude/skills 里的同名 skill 撞
        write_skill(&root, "aitm-test-skill-x1", "aitm-test-skill-x1", "测试用", "正文");
        let got = load_skills(cwd.path());
        assert!(
            find(&got, "aitm-test-skill-x1").is_some(),
            "项目级 skill 应被扫到"
        );
    }

    #[test]
    fn load_skills_项目无_claude_目录_不炸() {
        let cwd = TempDir::new().unwrap();
        // 不应 panic；结果可能含真实全局 skill，这里只断言「没崩」
        let _ = load_skills(cwd.path());
    }

    // ============================================================
    // scan_plugin_skills（v1.3.0 P2：plugin skills 覆盖缺口）
    // ============================================================

    /// 在 `marketplaces_root/<segments...>/skills/<skill_dir>/SKILL.md` 造一个
    /// plugin skill，`segments` 用来模拟不同的真实市场目录深度。
    fn write_plugin_skill(
        marketplaces_root: &Path,
        segments: &[&str],
        skill_dir: &str,
        name: &str,
        desc: &str,
    ) -> PathBuf {
        let mut skills_root = marketplaces_root.to_path_buf();
        for seg in segments {
            skills_root = skills_root.join(seg);
        }
        skills_root = skills_root.join("skills");
        write_skill(&skills_root, skill_dir, name, desc, "正文")
    }

    #[test]
    fn scan_plugin_skills_市场名下直接是_skills() {
        // 布局一：marketplaces/<市场>/skills/*/SKILL.md（市场名下直接是 skills）
        let tmp = TempDir::new().unwrap();
        write_plugin_skill(tmp.path(), &["demo-market"], "demo-prd", "demo-prd", "创建 PRD 文档");
        let got = scan_plugin_skills(tmp.path());
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name, "demo-prd");
    }

    #[test]
    fn scan_plugin_skills_市场_插件_skills() {
        // 布局二：marketplaces/<市场>/<插件>/skills/*/SKILL.md
        let tmp = TempDir::new().unwrap();
        write_plugin_skill(tmp.path(), &["demo-market", "demo-plugin"], "do", "do", "执行分阶段实施计划");
        let got = scan_plugin_skills(tmp.path());
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name, "do");
    }

    #[test]
    fn scan_plugin_skills_市场_plugins字面量_插件_skills_更深层级() {
        // 真机实测：claude-plugins-official 官方市场还有更深一层
        // marketplaces/<market>/plugins/<plugin>/skills，任务描述里只提到两种
        // 深度，实地核对发现第三种也真实存在——递归扫描要能兜住，不能只支持
        // 写死的两层。
        let tmp = TempDir::new().unwrap();
        write_plugin_skill(
            tmp.path(),
            &["claude-plugins-official", "plugins", "hookify"],
            "hookify",
            "hookify",
            "钩子管理",
        );
        let got = scan_plugin_skills(tmp.path());
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name, "hookify");
    }

    #[test]
    fn scan_plugin_skills_混合三种深度_全部扫到() {
        let tmp = TempDir::new().unwrap();
        write_plugin_skill(tmp.path(), &["demo-market"], "a", "a", "d");
        write_plugin_skill(tmp.path(), &["demo-market", "demo-plugin"], "b", "b", "d");
        write_plugin_skill(
            tmp.path(),
            &["claude-plugins-official", "plugins", "hookify"],
            "c",
            "c",
            "d",
        );
        let got = scan_plugin_skills(tmp.path());
        let names: Vec<&str> = got.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["a", "b", "c"]);
    }

    #[test]
    fn scan_plugin_skills_目录不存在_返回空_不崩() {
        let tmp = TempDir::new().unwrap();
        assert!(scan_plugin_skills(&tmp.path().join("不存在的市场目录")).is_empty());
    }

    #[test]
    fn scan_plugin_skills_跳过_node_modules_等大目录() {
        let tmp = TempDir::new().unwrap();
        // node_modules 下塞一个假的 skills 目录，不该被扫到（避免误扫无关内容）
        write_plugin_skill(
            tmp.path(),
            &["some-market", "node_modules", "whatever"],
            "fake",
            "fake",
            "假的",
        );
        write_plugin_skill(tmp.path(), &["some-market"], "real", "real", "真的");
        let got = scan_plugin_skills(tmp.path());
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name, "real");
    }

    #[test]
    fn scan_plugin_skills_同名跨市场只保留先扫到的一份() {
        let tmp = TempDir::new().unwrap();
        write_plugin_skill(tmp.path(), &["market-a"], "dup", "dup", "来自 A");
        write_plugin_skill(tmp.path(), &["market-b"], "dup", "dup", "来自 B");
        let got = scan_plugin_skills(tmp.path());
        let dups: Vec<&SkillMeta> = got.iter().filter(|s| s.name == "dup").collect();
        assert_eq!(dups.len(), 1, "同名 plugin skill 不能在清单里出现两次");
    }

    // ============================================================
    // discover_all（三级合并：项目 > 用户 > plugin）
    // ============================================================

    #[test]
    fn discover_all_项目覆盖用户覆盖_plugin() {
        let plugin_root = TempDir::new().unwrap();
        let global = TempDir::new().unwrap();
        let project = TempDir::new().unwrap();
        write_plugin_skill(plugin_root.path(), &["market"], "dup", "dup", "plugin 版本");
        write_skill(global.path(), "dup", "dup", "用户版本", "正文");
        write_skill(project.path(), "dup", "dup", "项目版本", "正文");

        let got = discover_all(Some(global.path()), Some(project.path()), Some(plugin_root.path()));
        assert_eq!(got.len(), 1, "同名只保留一份");
        assert_eq!(find(&got, "dup").unwrap().description, "项目版本");
    }

    #[test]
    fn discover_all_用户覆盖_plugin() {
        let plugin_root = TempDir::new().unwrap();
        let global = TempDir::new().unwrap();
        write_plugin_skill(plugin_root.path(), &["market"], "dup", "dup", "plugin 版本");
        write_skill(global.path(), "dup", "dup", "用户版本", "正文");

        let got = discover_all(Some(global.path()), None, Some(plugin_root.path()));
        assert_eq!(got.len(), 1);
        assert_eq!(find(&got, "dup").unwrap().description, "用户版本");
    }

    #[test]
    fn discover_all_三级都提供_不重名的各自保留_去重不出现两次() {
        let plugin_root = TempDir::new().unwrap();
        let global = TempDir::new().unwrap();
        let project = TempDir::new().unwrap();
        write_plugin_skill(plugin_root.path(), &["market"], "only-plugin", "only-plugin", "d");
        write_skill(global.path(), "only-global", "only-global", "d", "正文");
        write_skill(project.path(), "only-project", "only-project", "d", "正文");

        let got = discover_all(Some(global.path()), Some(project.path()), Some(plugin_root.path()));
        assert_eq!(got.len(), 3);
        for name in ["only-plugin", "only-global", "only-project"] {
            assert_eq!(
                got.iter().filter(|s| s.name == name).count(),
                1,
                "{name} 不能出现两次"
            );
        }
    }

    #[test]
    fn discover_all_plugin级目录不存在_不影响其它两级() {
        let global = TempDir::new().unwrap();
        write_skill(global.path(), "g", "g", "d", "正文");
        let got = discover_all(
            Some(global.path()),
            None,
            Some(&global.path().join("不存在的plugin根")),
        );
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name, "g");
    }

    #[test]
    fn discover_all_plugin参数为_none_只走两级_行为等同_discover() {
        let global = TempDir::new().unwrap();
        let project = TempDir::new().unwrap();
        write_skill(global.path(), "g", "g", "d", "正文");
        write_skill(project.path(), "p", "p", "d", "正文");
        let via_all = discover_all(Some(global.path()), Some(project.path()), None);
        let via_discover = discover(Some(global.path()), Some(project.path()));
        assert_eq!(via_all, via_discover);
    }
}


