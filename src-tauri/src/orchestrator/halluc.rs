//! v1.3.0 反幻觉结构性检测。
//!
//! 背景：真机反复出现「用户说『切换到 github』→ AI 回『已跳转到 GitHub』→ 浏览器
//! 还停在原页面，工具气泡区一个调用都没有」。system prompt 里的三层反幻觉铁律
//! （含正反例 + 关键词清单）挡不住，v1.3.0 把 skills 清单从 20KB 瘦到 379 字节
//! 排除「长 prompt 冲淡铁律」后照样谎报——这是模型能力问题，靠 prompt 堵不住。
//!
//! 但工具循环**本来就精确知道这一轮调了哪些工具**，于是改做结构性检测：
//! 一轮 assistant 回复收尾时，比对「回复文本里的完成声明」与「本轮真实发生的
//! 工具调用」，不一致就在该条消息气泡上打警告标记（**只标记，不自动重试**）。
//!
//! 设计要点：
//! - 判定是纯函数（输入 = 最终文本 + 本轮调用过的工具名），便于单测穷举
//! - 声明关键词表**对齐 [`crate::ipc::ai::default_system_prompt`] 里已有的那套**
//!   （"已跳转 / 已打开 / 已导航 / 已搜索 / 已点击 / 已填写 / 成功跳转 ..."），
//!   不另起一套
//! - **只在「本轮完全没有该类工具调用」时才警告**：调了但失败不算幻觉（那是
//!   真实失败，已有错误气泡），所以调用名一律记账，不看成功与否
//! - 误报优先级高于漏报：疑问句 / 未来时 / 否定 / 条件 / 追述历史一律不触发

use once_cell::sync::Lazy;
use regex::Regex;
use serde::Serialize;

/// 完成声明的类别。每类对应「本来应该出现」的一组工具。
#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ClaimCategory {
    /// 浏览器操作：跳转 / 导航 / 点击 / 填写 / 打开网页 / 网页搜索
    Browser,
    /// 文件写入：创建 / 写入 / 修改 / 保存文件
    File,
    /// 命令执行：执行 / 运行 / 安装
    Command,
}

/// 结构性幻觉警告：文本里声称做了某类操作，但本轮一个对应工具都没调。
#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct HallucinationWarning {
    /// 缺失的工具类别（按 Browser / File / Command 固定顺序去重）。
    pub missing: Vec<ClaimCategory>,
}

/// 判断某个工具名能否兑现某类声明。
///
/// 放宽处（都是为了压误报）：
/// - 文件类把 `run_command` 也算数——AI 完全可能用 `echo > f` / `sed -i` 改文件
/// - 命令类把 `browser_eval` 也算数——"已执行脚本" 可能指页面里跑 JS
fn satisfies(cat: ClaimCategory, tool: &str) -> bool {
    match cat {
        ClaimCategory::Browser => tool.starts_with("browser_"),
        ClaimCategory::File => matches!(tool, "write_file" | "edit_file" | "run_command"),
        ClaimCategory::Command => matches!(tool, "run_command" | "browser_eval"),
    }
}

/// 完成式前缀：`已 / 已经 / 成功`（可带 `帮你 / 为您 / 替用户` 之类的插入语）。
///
/// 只认这种**过去完成式**，是压误报的第一道闸：
/// "我准备调用 browser_navigate 跳转" / "需要我帮你跳转吗" 都不含 `已/成功` 前缀。
const DONE_PREFIX: &str = r"(已经|已|成功)\s*((帮|为|替)\s*(你|您|用户)?)?\s*";

/// 宽松完成式前缀：完成式与动词之间允许最多 8 个字的插入语
/// （"已**在页面搜索框**搜索" / "已**帮你把配置**写入"）。
/// 只给「必须带领域伴随词」的弱触发用，单独用会误伤太多。
const DONE_PREFIX_LOOSE: &str = r"(已经|已|成功).{0,8}?";

/// 浏览器领域伴随词。
const BROWSER_HINT: &str = r"(?i)(网页|浏览器|页面|网站|网址|链接|标签页|地址栏|搜索框|http|www\.|\.com|\.cn|\.org|\.net|\.io|google|github|百度|bing|必应)";
/// 文件领域伴随词。
const FILE_HINT: &str = r"(?i)(文件|目录|文件夹|脚本|配置|代码|内容|路径|README|\.md|\.txt|\.json|\.toml|\.ya?ml|\.rs|\.tsx?|\.jsx?|\.py|\.sh)";
/// 命令领域伴随词。
const COMMAND_HINT: &str = r"(?i)(命令|指令|脚本|终端|shell|npm|pnpm|yarn|git|cargo|brew|pip|python|node|make|docker)";

/// 强触发：完成式**紧挨**动词即判定，不需要伴随词。
///
/// 这批动词本身就唯一指向一类操作（"已跳转" 不可能指别的），紧挨的写法
/// 又排除了"已经根据你的要求执行了分析"这种插了长定语的泛化表述。
static STRONG: Lazy<Vec<(Regex, ClaimCategory)>> = Lazy::new(|| {
    vec![
        (
            Regex::new(&format!(r"{DONE_PREFIX}(跳转|导航|点击|填写|填入|填好)")).unwrap(),
            ClaimCategory::Browser,
        ),
        (
            Regex::new(&format!(r"{DONE_PREFIX}写入")).unwrap(),
            ClaimCategory::File,
        ),
        (
            Regex::new(&format!(r"{DONE_PREFIX}(执行|运行|安装)")).unwrap(),
            ClaimCategory::Command,
        ),
    ]
});

/// 弱触发：动词泛化（"已打开" 可能指面板 / 抽屉，"已创建" 可能指终端 tab），
/// 或完成式与动词之间插了别的成分，**必须同一小句里再出现领域伴随词**才判定。
static WEAK: Lazy<Vec<(Regex, Regex, ClaimCategory)>> = Lazy::new(|| {
    vec![
        (
            Regex::new(&format!(
                r"{DONE_PREFIX_LOOSE}(打开|切换|访问|浏览|搜索|查询|跳转|导航|点击|填写|填入)"
            ))
            .unwrap(),
            Regex::new(BROWSER_HINT).unwrap(),
            ClaimCategory::Browser,
        ),
        (
            Regex::new(&format!(
                r"{DONE_PREFIX_LOOSE}(创建|新建|修改|保存|更新|编辑|写入)"
            ))
            .unwrap(),
            Regex::new(FILE_HINT).unwrap(),
            ClaimCategory::File,
        ),
        (
            Regex::new(&format!(r"{DONE_PREFIX_LOOSE}(执行|运行|安装)")).unwrap(),
            Regex::new(COMMAND_HINT).unwrap(),
            ClaimCategory::Command,
        ),
    ]
});

/// 小句级豁免词：命中任一，这一小句一律不判定（宁可漏报不可误报）。
///
/// 六组：疑问 / 意图未来时 / 否定失败 / 条件假设 / 举例引用 / 追述历史。
static GUARD: Lazy<Regex> = Lazy::new(|| {
    Regex::new(concat!(
        // 疑问
        r"(吗|呢|是否|要不要|好吗|如何|怎么样|需要我|要我)",
        // 意图 / 未来时
        r"|(我准备|准备调用|我将|我会|我要|我打算|打算|即将|接下来|下一步|马上|稍后|正在|正要|请你|建议|可以帮|能帮|需要先|让我)",
        // 否定 / 失败
        r"|(没有|没能|未能|未成功|无法|不能|不会|失败|并未|尚未|还没|不曾|未被|未能够)",
        // 条件 / 假设
        r"|(如果|若|假如|一旦|除非|要是|的话)",
        // 举例 / 引用规则原文（AI 复述 system prompt 时最容易撞词表）
        r"|(例如|比如|举例|示例|反例|正例|禁止|不许|不要说|不应说|铁律|注意：)",
        // 追述历史（说的是之前某轮做过的事，不是本轮）
        r"|(之前|刚才|先前|此前|上一轮|上一步|上次|早前|前面提到|上面提到)",
    ))
    .unwrap()
});

/// 去掉 fenced code block（```…```）。
///
/// AI 常在代码块里贴文件内容 / 命令原文 / 复述规则，那里的"已执行"之类是**数据不是
/// 声明**，先剥掉能显著压误报。行内 code 的反引号只去掉标记、保留文字（"已执行
/// `ls -la`" 仍应被判定为命令声明）。
fn strip_code(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_fence = false;
    for line in text.lines() {
        if line.trim_start().starts_with("```") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        out.push_str(&line.replace('`', ""));
        out.push('\n');
    }
    out
}

/// 小句切分：中英文句末标点 + 逗号 + 顿号 + 换行 + 分号。
///
/// 切到**小句**而不是整句，是为了让豁免词的作用域跟着从句走：
/// "已经跳转到 Google，如果需要搜索请告诉我" 里的 `如果` 只该豁免后半句。
fn clauses(text: &str) -> Vec<&str> {
    text.split(|c: char| {
        matches!(
            c,
            '。' | '！' | '？' | '!' | '?' | '\n' | '；' | ';' | '，' | ',' | '、'
        )
    })
    .map(str::trim)
    .filter(|s| !s.is_empty())
    .collect()
}

/// 结构性幻觉判定。
///
/// - `text`：本轮 assistant 的最终文本
/// - `called_tools`：本轮**实际发生过**的工具调用名（含失败 / 被拒 / 被拦的——
///   只要真的走到调用就算，失败不是幻觉）
///
/// 返回 `Some` 表示「文本声称做了某类操作，但本轮该类工具零调用」。
pub fn detect_hallucination(text: &str, called_tools: &[String]) -> Option<HallucinationWarning> {
    if text.trim().is_empty() {
        return None;
    }
    let cleaned = strip_code(text);

    let mut claimed: Vec<ClaimCategory> = Vec::new();
    for clause in clauses(&cleaned) {
        // markdown 引用行（`> …`）是在引别人的话，不算自己的声明
        if clause.starts_with('>') || GUARD.is_match(clause) {
            continue;
        }
        for (re, cat) in STRONG.iter() {
            if re.is_match(clause) && !claimed.contains(cat) {
                claimed.push(*cat);
            }
        }
        for (re, hint, cat) in WEAK.iter() {
            if re.is_match(clause) && hint.is_match(clause) && !claimed.contains(cat) {
                claimed.push(*cat);
            }
        }
    }
    if claimed.is_empty() {
        return None;
    }

    // 固定输出顺序（Browser → File → Command），跟 claimed 的发现顺序解耦，
    // 免得同样的一段文本因措辞先后给出不同的 missing 序列。
    let missing: Vec<ClaimCategory> = [
        ClaimCategory::Browser,
        ClaimCategory::File,
        ClaimCategory::Command,
    ]
    .into_iter()
    .filter(|cat| claimed.contains(cat))
    .filter(|cat| !called_tools.iter().any(|t| satisfies(*cat, t)))
    .collect();

    if missing.is_empty() {
        None
    } else {
        Some(HallucinationWarning { missing })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tools(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    fn missing_of(text: &str, called: &[&str]) -> Option<Vec<ClaimCategory>> {
        detect_hallucination(text, &tools(called)).map(|w| w.missing)
    }

    // ===== 1. 命中声明 + 零对应工具 → 警告 =====

    #[test]
    fn 真机_case_已跳转但零工具_报警() {
        assert_eq!(
            missing_of("好的，已跳转到 GitHub ✅", &[]),
            Some(vec![ClaimCategory::Browser])
        );
    }

    #[test]
    fn 浏览器类各关键词_零工具_报警() {
        for t in [
            "已经跳转到 Google 首页了",
            "已导航到目标地址",
            "已点击登录按钮",
            "已填写用户名",
            "成功跳转",
            "已经帮你跳转到该页面",
            "已为您导航过去",
            "已打开该网页",
            "已切换到 github.com",
            "已在页面搜索框搜索了关键字",
        ] {
            assert_eq!(
                missing_of(t, &[]),
                Some(vec![ClaimCategory::Browser]),
                "应判浏览器类幻觉：{t}"
            );
        }
    }

    #[test]
    fn 文件类零工具_报警() {
        for t in [
            "已写入配置",
            "已创建文件 notes.md",
            "已修改该文件的内容",
            "已保存到 config.toml",
        ] {
            assert_eq!(
                missing_of(t, &[]),
                Some(vec![ClaimCategory::File]),
                "应判文件类幻觉：{t}"
            );
        }
    }

    #[test]
    fn 命令类零工具_报警() {
        for t in ["已执行 npm install", "已运行测试", "已安装依赖"] {
            assert_eq!(
                missing_of(t, &[]),
                Some(vec![ClaimCategory::Command]),
                "应判命令类幻觉：{t}"
            );
        }
    }

    #[test]
    fn 多类混合_零工具_按固定顺序列全部缺失() {
        let text = "已跳转到 GitHub。已创建文件 a.md。已执行 npm install。";
        assert_eq!(
            missing_of(text, &[]),
            Some(vec![
                ClaimCategory::Browser,
                ClaimCategory::File,
                ClaimCategory::Command
            ])
        );
    }

    #[test]
    fn 多类混合_只缺其中一类() {
        let text = "已跳转到 GitHub，并且已执行 npm install。";
        assert_eq!(
            missing_of(text, &["run_command"]),
            Some(vec![ClaimCategory::Browser])
        );
    }

    // ===== 2. 有对应工具调用 → 不警告 =====

    #[test]
    fn 调了_browser_navigate_不报警() {
        assert_eq!(missing_of("已跳转到 GitHub", &["browser_navigate"]), None);
    }

    #[test]
    fn 任意_browser_前缀工具都算兑现浏览器声明() {
        for tool in [
            "browser_open",
            "browser_navigate",
            "browser_click",
            "browser_fill",
            "browser_snapshot",
        ] {
            assert_eq!(missing_of("已点击了搜索按钮", &[tool]), None, "{tool}");
        }
    }

    #[test]
    fn 文件声明_write_file_或_edit_file_或_run_command_都算兑现() {
        for tool in ["write_file", "edit_file", "run_command"] {
            assert_eq!(missing_of("已创建文件 a.md", &[tool]), None, "{tool}");
        }
    }

    #[test]
    fn 命令声明_run_command_或_browser_eval_都算兑现() {
        for tool in ["run_command", "browser_eval"] {
            assert_eq!(missing_of("已执行该命令", &[tool]), None, "{tool}");
        }
    }

    #[test]
    fn 无关工具不兑现声明() {
        // 读了文件不代表跳转过网页
        assert_eq!(
            missing_of("已跳转到 GitHub", &["read_file", "list_files"]),
            Some(vec![ClaimCategory::Browser])
        );
    }

    // ===== 3. 工具调用失败 → 不算幻觉（真实失败已有错误气泡）=====

    #[test]
    fn 工具调过但失败_不算幻觉() {
        // 判定只看"调没调"，调用名一律记账；失败/被拒/被黑名单拦都传进来
        assert_eq!(
            missing_of("已跳转到 GitHub（如失败请重试）", &["browser_navigate"]),
            None
        );
        assert_eq!(missing_of("已执行该命令", &["run_command"]), None);
    }

    // ===== 4. 未来时 / 疑问句 / 否定 / 条件 → 不警告（压误报）=====

    #[test]
    fn 未来时不报警() {
        for t in [
            "我准备调用 browser_navigate 跳转到 GitHub",
            "接下来我会打开该网页",
            "下一步执行 npm install",
            "我将运行测试",
            "马上帮你创建文件 a.md",
        ] {
            assert_eq!(missing_of(t, &[]), None, "未来时不该报警：{t}");
        }
    }

    #[test]
    fn 疑问句不报警() {
        for t in [
            "需要我帮你跳转吗？",
            "是否已跳转到 GitHub？",
            "要不要我执行 npm install？",
            "已经打开网页了吗",
        ] {
            assert_eq!(missing_of(t, &[]), None, "疑问句不该报警：{t}");
        }
    }

    #[test]
    fn 否定与失败陈述不报警() {
        for t in [
            "没有跳转成功",
            "无法打开该网页",
            "浏览器面板未打开，尚未跳转",
            "创建文件失败了",
        ] {
            assert_eq!(missing_of(t, &[]), None, "否定句不该报警：{t}");
        }
    }

    #[test]
    fn 条件句不报警() {
        for t in [
            "如果已跳转到 GitHub，请告诉我",
            "若已创建文件请确认内容",
            "需要的话我可以帮你运行命令",
        ] {
            assert_eq!(missing_of(t, &[]), None, "条件句不该报警：{t}");
        }
    }

    #[test]
    fn 复述规则原文不报警() {
        let t = "按铁律要求，禁止在未调工具时说\"已跳转\"。例如：已打开网页 就是反例。";
        assert_eq!(missing_of(t, &[]), None);
    }

    #[test]
    fn 追述之前轮次不报警() {
        for t in [
            "之前已跳转到 GitHub，现在给你解释页面结构",
            "刚才已执行过 npm install",
        ] {
            assert_eq!(missing_of(t, &[]), None, "追述历史不该报警：{t}");
        }
    }

    // ===== 5. 弱触发：缺伴随词不报警 =====

    #[test]
    fn 弱触发缺伴随词不报警() {
        for t in [
            "已打开侧栏",           // 打开的不是网页
            "已切换到深色主题",     // 切的是主题
            "已创建一个新的终端 tab", // 建的不是文件
            "已更新你的偏好设置",   // 改的不是文件
        ] {
            assert_eq!(missing_of(t, &[]), None, "弱触发缺伴随词不该报警：{t}");
        }
    }

    #[test]
    fn 宽松前缀_插了成分但带伴随词_仍报警() {
        assert_eq!(
            missing_of("已在页面搜索框搜索了关键字", &[]),
            Some(vec![ClaimCategory::Browser])
        );
        assert_eq!(
            missing_of("已帮你把配置写入 config.toml", &[]),
            Some(vec![ClaimCategory::File])
        );
        assert_eq!(
            missing_of("已在终端执行了这条命令", &[]),
            Some(vec![ClaimCategory::Command])
        );
    }

    #[test]
    fn 宽松前缀_无伴随词的泛化表述不报警() {
        // "执行了检查" 只是措辞，没有任何命令 / 终端语境，不该报警
        assert_eq!(missing_of("已经根据你的要求执行了检查", &[]), None);
        assert_eq!(missing_of("已经按你的说明完成了整理", &[]), None);
    }

    // ===== 6. 其他边界 =====

    #[test]
    fn 空文本或普通回答不报警() {
        assert_eq!(missing_of("", &[]), None);
        assert_eq!(missing_of("   \n ", &[]), None);
        assert_eq!(missing_of("这个目录下有 3 个文件。", &["list_files"]), None);
        assert_eq!(missing_of("你好，有什么可以帮你的？", &[]), None);
    }

    #[test]
    fn 代码块里的完成式不算声明() {
        let t = "参考下面的日志：\n```\n已执行 npm install\n已跳转到 GitHub\n```\n以上是历史输出。";
        assert_eq!(missing_of(t, &[]), None);
    }

    #[test]
    fn 行内_code_保留文字_仍能判定() {
        assert_eq!(
            missing_of("已执行 `npm install`", &[]),
            Some(vec![ClaimCategory::Command])
        );
    }

    #[test]
    fn markdown_引用行不算自己的声明() {
        assert_eq!(missing_of("> 已跳转到 GitHub", &[]), None);
    }

    #[test]
    fn 小句切分让豁免词只作用于所在从句() {
        // 前半句是真声明，后半句才是条件——不该被后半句的"如果"整段豁免
        assert_eq!(
            missing_of("已经跳转到 Google，如果需要搜索请告诉我", &[]),
            Some(vec![ClaimCategory::Browser])
        );
    }

    #[test]
    fn 警告可序列化为_snake_case_类别() {
        let w = detect_hallucination("已跳转到 GitHub", &[]).unwrap();
        let json = serde_json::to_string(&w).unwrap();
        assert_eq!(json, r#"{"missing":["browser"]}"#);
    }
}
