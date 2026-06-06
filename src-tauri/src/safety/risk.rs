//! L2 风险评分启发式（spec §9）。
//!
//! 给 `run_command` 的命令字符串静态分级，不调用 LLM、不解析 shell。
//! 评估顺序：
//! 1. **DESTRUCTIVE** 模式正则匹配整条 cmd（命中即升级，宁可错杀）
//! 2. **LOW** 命令前缀（第一/前两个 token 命中已知只读列表）+ 元字符防御
//! 3. 默认 **HIGH**（兜底）
//!
//! 设计原则：保守胜过宽松——分不准时往 HIGH 靠。一次误把 `sudo` 归 LOW 比
//! 100 次多弹一下损失大得多。
//!
//! 元字符防御：LOW 命令的剩余部分若含 `;` `&&` `||` `|` `` ` `` `$(` `>` `<`
//! 则直接升 HIGH，防 `ls; rm -rf .` 这类钻空子。
//!
//! 与 L1 黑名单的关系：L1 是硬拦截（直接 reject），L2 只是分级（HIGH/LOW 影响
//! 是否弹窗）。即使一个命令同时命中 L1 + L2.DESTRUCTIVE，也是 L1 优先。

use crate::tools::RiskClass;
use once_cell::sync::Lazy;
use regex::Regex;

/// L2 评分结果：风险类 + 解释（透到 UI 给用户看）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RiskAssessment {
    pub risk: RiskClass,
    /// 为什么得到这个 risk。例如 "sudo 提权" / "只读命令 ls" / "默认 HIGH"。
    pub reason: String,
}

/// DESTRUCTIVE 模式表。命中任一即升 Destructive。
///
/// 写法约定：
/// - 命令名前后用 `\b` 锚定，防 `sudoku` 误判
/// - 大小写敏感的 cmd 名（sudo/chmod 等）保持小写
/// - SQL drop 等可能大小写混用的用 `(?i)` 前缀
static DESTRUCTIVE_PATTERNS: Lazy<Vec<(Regex, &'static str)>> = Lazy::new(|| {
    vec![
        // 提权
        (Regex::new(r"\bsudo\b").unwrap(), "sudo 提权"),
        (Regex::new(r"\bdoas\b").unwrap(), "doas 提权"),
        // 开放写权限：chmod 777 / 666 / a+w（含可选 -R）
        (
            Regex::new(r"\bchmod\s+(-R\s+)?(777|666|a\+w)\b").unwrap(),
            "chmod 开放写权限",
        ),
        // 递归改 owner
        (Regex::new(r"\bchown\s+-R\b").unwrap(), "chown -R 递归改 owner"),
        // git 强推
        (
            Regex::new(r"\bgit\s+push\s+(.*--force\b|.*-f\b)").unwrap(),
            "git push --force 强推",
        ),
        // git 强重置 / 强清理
        (
            Regex::new(r"\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f)").unwrap(),
            "git reset --hard / clean -f",
        ),
        // SQL 删库删表（大小写不敏感）
        (
            Regex::new(r"(?i)\bdrop\s+(table|database|schema)\b").unwrap(),
            "SQL drop 删表/库",
        ),
        // kubectl 删 k8s 资源
        (
            Regex::new(r"\bkubectl\s+delete\b").unwrap(),
            "kubectl delete",
        ),
        // docker 清容器/镜像
        (
            Regex::new(r"\bdocker\s+(rm\b|rmi\b|system\s+prune\b)").unwrap(),
            "docker rm/rmi/prune",
        ),
        // killall -9 / kill -9
        (Regex::new(r"\bkill(all)?\s+-9\b").unwrap(), "kill -9 强杀"),
        // 包发布（npm / cargo / pnpm publish）
        (
            Regex::new(r"\b(npm|cargo|pnpm)\s+publish\b").unwrap(),
            "包发布 publish",
        ),
        // 重定向到系统目录
        (
            Regex::new(r">\s*(/etc/|~/\.ssh/|/usr/|/var/|/boot/)").unwrap(),
            "重定向到系统目录",
        ),
        // find 搭配 -delete / -exec rm
        (
            Regex::new(r"\bfind\b.*\s(-delete\b|-exec\s+rm\b)").unwrap(),
            "find -delete / -exec rm",
        ),
    ]
});

/// LOW 单 token 前缀表。命令的第一个 token 命中即视为只读 fast-path 候选，
/// 仍需通过元字符防御才能最终归 LOW。
static LOW_SINGLE_PREFIXES: &[&str] = &[
    // 只读 shell
    "ls", "pwd", "whoami", "date", "uptime", "uname", "hostname", "id", "echo", "printf", "true",
    "false", "which", "type", "env",
    // 文件读
    "cat", "less", "more", "head", "tail", "file", "stat", "wc", "md5sum", "sha256sum",
    // 搜索
    "grep", "egrep", "fgrep", "find", "rg", "ag", "locate",
    // 进程信息
    "ps", "top", "lsof", "netstat", "ss", "dig", "nslookup", "ifconfig", "ip",
];

/// LOW 双 token 前缀表（如 `git status`）。命令的前两个 token 拼起来命中即可。
static LOW_DOUBLE_PREFIXES: &[&str] = &[
    // git 只读
    "git status",
    "git log",
    "git diff",
    "git show",
    "git branch",
    "git remote",
    "git config",
    // node 生态只读
    "npm ls",
    "npm list",
    "pnpm list",
    "pnpm why",
    "pnpm ls",
    "yarn list",
    // cargo 只读
    "cargo --version",
    "cargo metadata",
    "cargo tree",
];

/// LOW 命令的剩余部分若含这些元字符，强制升 HIGH（防 `ls; rm -rf .`）。
///
/// 注意：这里检查的是**整条 cmd**而非"剩余 token"——即使元字符出现在 prefix
/// 里也不该走 LOW（实际上 prefix 都是命令名，不会含元字符；但万一 LLM 拼了
/// 奇怪的字符串如 `"ls"` 加引号也保险些）。
fn has_dangerous_metachar(cmd: &str) -> bool {
    // 单字符元字符
    for ch in [';', '`', '\n', '\r'] {
        if cmd.contains(ch) {
            return true;
        }
    }
    // 多字符序列
    for seq in ["&&", "||", "$(", ">", "<"] {
        if cmd.contains(seq) {
            return true;
        }
    }
    // 单独的 | 也算（管道）；但不能匹配 ||（已上面拦了，这里只剩单 |）
    if cmd.contains('|') {
        return true;
    }
    // 单独的 & 也算（后台运行 / fork bomb 边角）
    if cmd.contains('&') {
        return true;
    }
    false
}

/// 静态分级一条 cmd。空字符串 / 全空白 → HIGH（默认）。
pub fn classify(cmd: &str) -> RiskAssessment {
    let trimmed = cmd.trim();

    // 1. DESTRUCTIVE 优先匹配
    for (re, label) in DESTRUCTIVE_PATTERNS.iter() {
        if re.is_match(trimmed) {
            return RiskAssessment {
                risk: RiskClass::Destructive,
                reason: format!("DESTRUCTIVE：{label}"),
            };
        }
    }

    // 2. LOW 前缀 + 元字符防御
    if !trimmed.is_empty() && !has_dangerous_metachar(trimmed) {
        let mut tokens = trimmed.split_whitespace();
        let first = tokens.next().unwrap_or("");
        let second = tokens.next().unwrap_or("");

        // 双 token 前缀优先（git status 比 git 更具体）
        if !second.is_empty() {
            let two = format!("{first} {second}");
            if LOW_DOUBLE_PREFIXES.iter().any(|p| *p == two) {
                return RiskAssessment {
                    risk: RiskClass::Low,
                    reason: format!("只读命令 {two}"),
                };
            }
        }

        // 单 token 前缀
        if LOW_SINGLE_PREFIXES.contains(&first) {
            return RiskAssessment {
                risk: RiskClass::Low,
                reason: format!("只读命令 {first}"),
            };
        }
    }

    // 3. 默认 HIGH
    RiskAssessment {
        risk: RiskClass::High,
        reason: "默认（无明显风险信号 / 无明显安全信号）".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn classify_risk(cmd: &str) -> RiskClass {
        classify(cmd).risk
    }

    // ===== DESTRUCTIVE 正例（命中升级）=====

    #[test]
    fn sudo_归_destructive() {
        assert_eq!(classify_risk("sudo ls /"), RiskClass::Destructive);
        assert_eq!(classify_risk("sudo apt update"), RiskClass::Destructive);
        let r = classify("sudo rm -rf /tmp/foo");
        assert_eq!(r.risk, RiskClass::Destructive);
        assert!(r.reason.contains("sudo"), "reason 应说明 sudo: {}", r.reason);
    }

    #[test]
    fn doas_归_destructive() {
        assert_eq!(classify_risk("doas pkg_add htop"), RiskClass::Destructive);
    }

    #[test]
    fn chmod_777_归_destructive() {
        assert_eq!(classify_risk("chmod 777 secret.txt"), RiskClass::Destructive);
        assert_eq!(classify_risk("chmod -R 777 /var/www"), RiskClass::Destructive);
        assert_eq!(classify_risk("chmod 666 db.sqlite"), RiskClass::Destructive);
        assert_eq!(classify_risk("chmod a+w foo"), RiskClass::Destructive);
    }

    #[test]
    fn chmod_644_不归_destructive() {
        // chmod 644 是常规权限，不该升 destructive
        let r = classify("chmod 644 README.md");
        assert_ne!(r.risk, RiskClass::Destructive, "chmod 644 不该 destructive");
    }

    #[test]
    fn chown_r_归_destructive() {
        assert_eq!(
            classify_risk("chown -R user:group /data"),
            RiskClass::Destructive
        );
    }

    #[test]
    fn chown_无_r_不归_destructive() {
        // chown 单文件视为高风险但不 destructive
        let r = classify("chown user foo.txt");
        assert_ne!(r.risk, RiskClass::Destructive);
    }

    #[test]
    fn git_push_force_归_destructive() {
        assert_eq!(
            classify_risk("git push --force origin main"),
            RiskClass::Destructive
        );
        assert_eq!(
            classify_risk("git push -f origin master"),
            RiskClass::Destructive
        );
        assert_eq!(
            classify_risk("git push origin main --force"),
            RiskClass::Destructive
        );
    }

    #[test]
    fn git_push_普通_不归_destructive() {
        let r = classify("git push origin main");
        assert_ne!(r.risk, RiskClass::Destructive);
    }

    #[test]
    fn git_reset_hard_归_destructive() {
        assert_eq!(
            classify_risk("git reset --hard HEAD"),
            RiskClass::Destructive
        );
        assert_eq!(
            classify_risk("git reset --hard origin/main"),
            RiskClass::Destructive
        );
    }

    #[test]
    fn git_clean_f_归_destructive() {
        assert_eq!(classify_risk("git clean -fd"), RiskClass::Destructive);
        assert_eq!(classify_risk("git clean -fdx"), RiskClass::Destructive);
        assert_eq!(classify_risk("git clean -f"), RiskClass::Destructive);
    }

    #[test]
    fn sql_drop_归_destructive() {
        assert_eq!(
            classify_risk("psql -c 'drop table users'"),
            RiskClass::Destructive
        );
        assert_eq!(
            classify_risk("mysql -e 'DROP DATABASE prod'"),
            RiskClass::Destructive
        );
        assert_eq!(
            classify_risk("sqlite3 db 'Drop Schema foo'"),
            RiskClass::Destructive
        );
    }

    #[test]
    fn kubectl_delete_归_destructive() {
        assert_eq!(
            classify_risk("kubectl delete pod my-pod"),
            RiskClass::Destructive
        );
        assert_eq!(
            classify_risk("kubectl delete -f manifest.yaml"),
            RiskClass::Destructive
        );
    }

    #[test]
    fn kubectl_get_不归_destructive() {
        let r = classify("kubectl get pods");
        assert_ne!(r.risk, RiskClass::Destructive);
    }

    #[test]
    fn docker_rm_归_destructive() {
        assert_eq!(
            classify_risk("docker rm container-id"),
            RiskClass::Destructive
        );
        assert_eq!(classify_risk("docker rmi image:tag"), RiskClass::Destructive);
        assert_eq!(
            classify_risk("docker system prune -af"),
            RiskClass::Destructive
        );
    }

    #[test]
    fn docker_run_不归_destructive() {
        let r = classify("docker run --rm -it alpine sh");
        // docker run 不在 destructive 列表里，归默认 HIGH（也合理）
        assert_ne!(r.risk, RiskClass::Destructive);
    }

    #[test]
    fn kill_9_归_destructive() {
        assert_eq!(classify_risk("kill -9 1234"), RiskClass::Destructive);
        assert_eq!(classify_risk("killall -9 node"), RiskClass::Destructive);
    }

    #[test]
    fn kill_term_不归_destructive() {
        // 普通 kill 不 -9 不归 destructive
        let r = classify("kill 1234");
        assert_ne!(r.risk, RiskClass::Destructive);
    }

    #[test]
    fn npm_publish_归_destructive() {
        assert_eq!(classify_risk("npm publish"), RiskClass::Destructive);
        assert_eq!(
            classify_risk("npm publish --access public"),
            RiskClass::Destructive
        );
        assert_eq!(classify_risk("cargo publish"), RiskClass::Destructive);
        assert_eq!(classify_risk("pnpm publish"), RiskClass::Destructive);
    }

    #[test]
    fn 重定向_系统目录_归_destructive() {
        assert_eq!(
            classify_risk("echo bad > /etc/passwd"),
            RiskClass::Destructive
        );
        assert_eq!(
            classify_risk("cat key.pub > ~/.ssh/authorized_keys"),
            RiskClass::Destructive
        );
        assert_eq!(
            classify_risk("echo x > /var/log/foo"),
            RiskClass::Destructive
        );
        assert_eq!(classify_risk("echo x >/usr/local/bar"), RiskClass::Destructive);
    }

    #[test]
    fn 重定向_用户目录_不归_destructive() {
        // 重定向到自己项目目录 OK，归 HIGH 走普通弹窗（不会因为有 `>` 就 destructive）
        let r = classify("echo hello > out.txt");
        assert_ne!(r.risk, RiskClass::Destructive);
    }

    #[test]
    fn find_delete_归_destructive() {
        assert_eq!(
            classify_risk("find . -name '*.log' -delete"),
            RiskClass::Destructive
        );
        assert_eq!(
            classify_risk("find /tmp -type f -exec rm {} \\;"),
            RiskClass::Destructive
        );
    }

    #[test]
    fn sudoku_不被_sudo_误判() {
        // \b 锚定防止 sudoku 这种长单词被命中
        let r = classify("sudoku --solve puzzle.txt");
        assert_ne!(r.risk, RiskClass::Destructive, "sudoku 不该当 sudo: {:?}", r);
    }

    // ===== LOW 正例 =====

    #[test]
    fn ls_归_low() {
        assert_eq!(classify_risk("ls"), RiskClass::Low);
        assert_eq!(classify_risk("ls -la"), RiskClass::Low);
        assert_eq!(classify_risk("ls /tmp"), RiskClass::Low);
        let r = classify("ls -la /home");
        assert_eq!(r.risk, RiskClass::Low);
        assert!(r.reason.contains("ls"), "reason 应含 ls: {}", r.reason);
    }

    #[test]
    fn cat_head_tail_归_low() {
        assert_eq!(classify_risk("cat README.md"), RiskClass::Low);
        assert_eq!(classify_risk("head -n 20 file.log"), RiskClass::Low);
        assert_eq!(classify_risk("tail -f /var/log/system.log"), RiskClass::Low);
        assert_eq!(classify_risk("less foo.txt"), RiskClass::Low);
    }

    #[test]
    fn 只读_shell_归_low() {
        for cmd in &[
            "pwd", "whoami", "date", "uptime", "uname -a", "hostname", "id", "echo hi",
            "true", "false", "which node", "type ls", "env",
        ] {
            assert_eq!(classify_risk(cmd), RiskClass::Low, "应 LOW: {cmd}");
        }
    }

    #[test]
    fn 搜索类_归_low() {
        assert_eq!(classify_risk("grep error log.txt"), RiskClass::Low);
        assert_eq!(classify_risk("rg pattern src/"), RiskClass::Low);
        assert_eq!(classify_risk("find . -name '*.rs'"), RiskClass::Low);
        assert_eq!(classify_risk("ag TODO"), RiskClass::Low);
    }

    #[test]
    fn 进程信息_归_low() {
        assert_eq!(classify_risk("ps aux"), RiskClass::Low);
        assert_eq!(classify_risk("top -n 1"), RiskClass::Low);
        assert_eq!(classify_risk("lsof -i:3000"), RiskClass::Low);
        assert_eq!(classify_risk("netstat -an"), RiskClass::Low);
        assert_eq!(classify_risk("dig example.com"), RiskClass::Low);
    }

    #[test]
    fn git_只读_归_low() {
        assert_eq!(classify_risk("git status"), RiskClass::Low);
        assert_eq!(classify_risk("git status -s"), RiskClass::Low);
        assert_eq!(classify_risk("git log --oneline -20"), RiskClass::Low);
        assert_eq!(classify_risk("git diff HEAD"), RiskClass::Low);
        assert_eq!(classify_risk("git show abc1234"), RiskClass::Low);
        assert_eq!(classify_risk("git branch -a"), RiskClass::Low);
        assert_eq!(classify_risk("git remote -v"), RiskClass::Low);
        assert_eq!(classify_risk("git config --get user.email"), RiskClass::Low);
    }

    #[test]
    fn npm_pnpm_cargo_只读_归_low() {
        assert_eq!(classify_risk("npm ls"), RiskClass::Low);
        assert_eq!(classify_risk("npm list --depth=0"), RiskClass::Low);
        assert_eq!(classify_risk("pnpm list"), RiskClass::Low);
        assert_eq!(classify_risk("pnpm why react"), RiskClass::Low);
        assert_eq!(classify_risk("cargo --version"), RiskClass::Low);
        assert_eq!(classify_risk("cargo metadata"), RiskClass::Low);
        assert_eq!(classify_risk("cargo tree"), RiskClass::Low);
    }

    // ===== LOW 反例：元字符破解 =====

    #[test]
    fn ls_加分号_不归_low() {
        // ls; rm -rf . 必须走 HIGH（哪怕 ls 是 low prefix）
        let r = classify("ls; rm -rf .");
        assert_ne!(r.risk, RiskClass::Low, "含分号不该 LOW: {:?}", r);
    }

    #[test]
    fn ls_加管道_不归_low() {
        let r = classify("ls | xargs rm");
        assert_ne!(r.risk, RiskClass::Low);
    }

    #[test]
    fn cat_加重定向_不归_low() {
        let r = classify("cat secret > /tmp/leaked");
        assert_ne!(r.risk, RiskClass::Low);
    }

    #[test]
    fn ls_加_and_链_不归_low() {
        let r = classify("ls && rm foo");
        assert_ne!(r.risk, RiskClass::Low);
        let r = classify("ls || echo failed");
        assert_ne!(r.risk, RiskClass::Low);
    }

    #[test]
    fn ls_加反引号_不归_low() {
        let r = classify("ls `whoami`");
        assert_ne!(r.risk, RiskClass::Low);
    }

    #[test]
    fn ls_加命令替换_不归_low() {
        let r = classify("ls $(pwd)");
        assert_ne!(r.risk, RiskClass::Low);
    }

    #[test]
    fn ls_加后台符_不归_low() {
        let r = classify("ls -la &");
        assert_ne!(r.risk, RiskClass::Low);
    }

    #[test]
    fn git_status_加分号_不归_low() {
        // 双 token 前缀也要受元字符防御
        let r = classify("git status; git push --force");
        assert_ne!(r.risk, RiskClass::Low);
        // 同时含 destructive 时 destructive 优先
        assert_eq!(r.risk, RiskClass::Destructive);
    }

    // ===== 默认 HIGH 兜底 =====

    #[test]
    fn 默认_未知命令_归_high() {
        assert_eq!(classify_risk("mv a.txt b.txt"), RiskClass::High);
        assert_eq!(classify_risk("touch new.txt"), RiskClass::High);
        assert_eq!(classify_risk("cp src dst"), RiskClass::High);
        let r = classify("some-random-tool --flag");
        assert_eq!(r.risk, RiskClass::High);
        assert!(
            r.reason.contains("默认") || r.reason.contains("HIGH"),
            "默认 reason: {}",
            r.reason
        );
    }

    #[test]
    fn 空字符串_归_high() {
        assert_eq!(classify_risk(""), RiskClass::High);
        assert_eq!(classify_risk("   "), RiskClass::High);
    }

    #[test]
    fn git_commit_归_high() {
        // git commit 不在 LOW 列表里，归 HIGH（合理：会改 repo 状态）
        let r = classify("git commit -m 'msg'");
        assert_eq!(r.risk, RiskClass::High);
    }

    #[test]
    fn npm_install_归_high() {
        // npm install 不只读，归 HIGH
        let r = classify("npm install foo");
        assert_eq!(r.risk, RiskClass::High);
    }

    // ===== 优先级：DESTRUCTIVE 永远赢 LOW =====

    #[test]
    fn destructive_优先于_low_前缀() {
        // ls 是 LOW 前缀，但 sudo ls / 升级到 destructive
        assert_eq!(classify_risk("sudo ls /"), RiskClass::Destructive);
        // git push --force 仍走 destructive 即使 git 是常见前缀
        assert_eq!(
            classify_risk("git push --force origin main"),
            RiskClass::Destructive
        );
    }

    // ===== reason 字段含义合理 =====

    #[test]
    fn destructive_reason_含模式标签() {
        let r = classify("sudo rm -rf /tmp/foo");
        assert!(r.reason.contains("sudo"), "{}", r.reason);

        let r = classify("git push --force");
        assert!(r.reason.contains("强推") || r.reason.contains("force"));

        let r = classify("kubectl delete pod x");
        assert!(r.reason.contains("kubectl"));
    }

    #[test]
    fn low_reason_含命令名() {
        let r = classify("git status");
        assert!(r.reason.contains("git status"), "{}", r.reason);

        let r = classify("cat foo");
        assert!(r.reason.contains("cat"), "{}", r.reason);
    }

    #[test]
    fn high_reason_含默认字眼() {
        let r = classify("some-tool foo");
        assert!(r.reason.contains("默认"), "{}", r.reason);
    }

    // ===== 大小写敏感性 =====

    #[test]
    fn sql_drop_大小写不敏感() {
        assert_eq!(
            classify_risk("DROP TABLE users"),
            RiskClass::Destructive
        );
        assert_eq!(
            classify_risk("Drop Database x"),
            RiskClass::Destructive
        );
    }

    #[test]
    fn sudo_大小写敏感() {
        // SUDO 大写在 unix 里不是合法命令，按字面不当 sudo 拦
        // 这里不强制 destructive（如果命中也行，但默认实现是大小写敏感）
        let _r = classify("SUDO ls");
        // 不断言具体值——只要别 panic 就行；保留 future 改大小写不敏感的灵活性
    }
}
