//! shell integration 钩子脚本（v1.3.0 P1）。
//!
//! **要解决的问题**：v1.3.0 的 `run_command` 用「命令包装法」拿退出码 ——
//! 把用户命令包成 `eval '<原命令>'; printf '\033]6969;…'` 再写进 PTY。
//! sentinel 本身是私有 OSC、用户看不见，但**命令行会被终端原样回显**：
//! 满屏 `eval '...'; printf '\033]6969;...'` 干扰阅读；包装后的整行还会进
//! shell history（以前进 history 的是原始命令）。
//!
//! **改法**（与 VS Code shell integration 同思路）：命令本身**一个字都不改**，
//! 靠 shell 自己的钩子在每条命令**开始 / 结束**时各发一个私有 OSC 序列：
//!
//! | 时机 | 钩子 | 序列 |
//! |---|---|---|
//! | 命令开始 | zsh `preexec` / bash `trap DEBUG` | `aitm-exec;<序号>;<命令行原文>` |
//! | 命令结束 | zsh `precmd` / bash `PROMPT_COMMAND` | `aitm-end;<退出码>;<序号>` |
//!
//! 开始 / 结束成对，后端据此**确认"AI 刚写进去的那条命令"真的开始跑了**（靠命令行
//! 原文比对，防止串到用户手敲命令的结果上），再等同序号的结束标记拿真实退出码。
//!
//! **注入方式**：不改用户的 rc 文件，而是给 PTY 子进程指一个临时启动文件
//! （zsh 走 `ZDOTDIR`、bash 走 `--rcfile`），临时文件**先 source 用户原配置**
//! 再追加本模块的片段 —— 用户的 alias / 主题 / 插件一律不受影响。
//!
//! **只做 zsh / bash**：fish 语法完全不同、cmd.exe 没有钩子机制。它们继续走
//! [`crate::session::sentinel::wrap_command`] 的包装法兜底（已实现且能工作）。

use super::sentinel::{END_KIND, EXEC_KIND, SENTINEL_OSC_CODE};

/// 支持钩子注入的 shell 种类。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookShell {
    Zsh,
    Bash,
}

/// 按 shell 路径 basename 判断能不能注入钩子。不支持的返回 `None`（走包装法兜底）。
pub fn detect(shell: &str) -> Option<HookShell> {
    let base = std::path::Path::new(shell)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(shell)
        .to_ascii_lowercase();
    let base = base.strip_suffix(".exe").unwrap_or(&base);
    match base {
        "zsh" => Some(HookShell::Zsh),
        "bash" => Some(HookShell::Bash),
        _ => None,
    }
}

/// zsh 钩子片段。追加在临时 `ZDOTDIR/.zshrc` 末尾（用户原 .zshrc 已在前面 source 过）。
///
/// **两个关键细节**：
/// 1. 我们的 `precmd` 末尾 `return $?` 原样透传，后面的主题 / 插件钩子仍能读到
///    真实退出码（不破坏用户已有行为）。
/// 2. 再把自己前插到 `precmd_functions` 最前作保险。zsh 5.x 调 hook 函数时会
///    保存 / 恢复 `$?`（实测：用户先注册的 precmd 跑完，我们仍拿到真实退出码），
///    所以前插不是必需；但有些插件会把别人的钩子包进自己的大函数里顺序调用，
///    那种包装不保证恢复 `$?` —— 排在最前最稳，且零代价。
pub fn zsh_snippet() -> String {
    format!(
        r#"
# ===== aitm shell integration：命令开始 / 结束 + 退出码上报 =====
# 发的是私有 OSC {code} 序列，xterm.js 不认识 → 用户终端里完全看不见；
# 后端在 PTY 原始字节流里扫它，拿到真实退出码。命令本身不做任何改写。
__aitm_seq=0
__aitm_active=0

__aitm_preexec() {{
  __aitm_seq=$(( __aitm_seq + 1 ))
  __aitm_active=1
  # 命令行原文放最后一段：里面含 ';' 也不影响解析（后端按段数切到底）
  printf '\033]{code};{exec_kind};%s;%s\007' "$__aitm_seq" "$1"
}}

__aitm_precmd() {{
  local __aitm_code=$?
  if [[ $__aitm_active == 1 ]]; then
    __aitm_active=0
    printf '\033]{code};{end_kind};%s;%s\007' "$__aitm_code" "$__aitm_seq"
  fi
  # 原样透传退出码，后面的 precmd 钩子（主题 / 插件）仍读得到真实 $?
  return $__aitm_code
}}

autoload -Uz add-zsh-hook 2>/dev/null
if (( $+functions[add-zsh-hook] )); then
  add-zsh-hook preexec __aitm_preexec
  add-zsh-hook precmd __aitm_precmd
else
  preexec_functions+=(__aitm_preexec)
  precmd_functions+=(__aitm_precmd)
fi
# 前插保险：绝大多数情况 zsh 会给每个钩子恢复 $?，但插件包装的场景不保证
precmd_functions=(__aitm_precmd ${{precmd_functions:#__aitm_precmd}})
"#,
        code = SENTINEL_OSC_CODE,
        exec_kind = EXEC_KIND,
        end_kind = END_KIND,
    )
}

/// bash 钩子片段。追加在临时 `--rcfile` 末尾（用户 `~/.bashrc` 已在前面 source 过）。
///
/// **三个关键细节**：
/// 1. **不覆盖用户的 `PROMPT_COMMAND`**：我们把自己插在最前（这样读到的 `$?` 是命令
///    的真实退出码）和最后（重新"上膛"），用户原有内容原封不动夹在中间；字符串和
///    bash 5.1+ 的数组两种形态都处理。我们的函数 `return $?` 透传，用户原有
///    `PROMPT_COMMAND` 仍读得到真实退出码。
/// 2. **DEBUG trap 只认提示符后的第一条命令**：bash 的 DEBUG 对复合命令的每一段都会
///    触发，靠 `__aitm_armed`（在 `PROMPT_COMMAND` 末尾上膛、首次触发即卸膛）过滤，
///    顺带把 `PROMPT_COMMAND` 自身产生的触发也挡掉。
/// 3. **不抢用户已有的 DEBUG trap**：已经有就整段不装（bash-preexec 用户等）。此时
///    后端收不到 exec 标记 → 自动降级回包装法，不会一直等到超时。
pub fn bash_snippet() -> String {
    format!(
        r#"
# ===== aitm shell integration：命令开始 / 结束 + 退出码上报 =====
# 发的是私有 OSC {code} 序列，xterm.js 不认识 → 用户终端里完全看不见。
__aitm_seq=0
__aitm_active=0
__aitm_armed=""

__aitm_exec_trap() {{
  # 补全（tab）时 bash 也会触发 DEBUG，跳过
  [ -n "$COMP_LINE" ] && return 0
  # 只认提示符后的第一条命令：PROMPT_COMMAND 末尾的 __aitm_arm 才上膛
  [ -z "$__aitm_armed" ] && return 0
  __aitm_armed=""
  local __aitm_hist __aitm_num __aitm_line
  # 取整行命令（$BASH_COMMAND 对 `a && b` 只给第一段，配对会不准）
  __aitm_hist=$(HISTTIMEFORMAT='' builtin history 1 2>/dev/null)
  read -r __aitm_num __aitm_line <<< "$__aitm_hist"
  # history 被关掉 / 命令以空格开头（HISTCONTROL=ignorespace）时拿不到，退回 $BASH_COMMAND
  [ -z "$__aitm_line" ] && __aitm_line="$BASH_COMMAND"
  __aitm_seq=$(( __aitm_seq + 1 ))
  __aitm_active=1
  printf '\033]{code};{exec_kind};%s;%s\007' "$__aitm_seq" "$__aitm_line"
  return 0
}}

__aitm_report() {{
  local __aitm_code=$?
  if [ "$__aitm_active" = 1 ]; then
    __aitm_active=0
    printf '\033]{code};{end_kind};%s;%s\007' "$__aitm_code" "$__aitm_seq"
  fi
  # 透传退出码，用户原有的 PROMPT_COMMAND 仍读得到真实 $?
  return $__aitm_code
}}

__aitm_arm() {{ __aitm_armed=1; return 0; }}

# 已有 DEBUG trap（bash-preexec 等）就不抢：后端会自动降级回包装法
if [ -z "$(trap -p DEBUG)" ]; then
  trap '__aitm_exec_trap' DEBUG
  if [ "${{BASH_VERSINFO[0]}}" -ge 5 ] && [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
    PROMPT_COMMAND=(__aitm_report "${{PROMPT_COMMAND[@]}}" __aitm_arm)
  elif [ -n "$PROMPT_COMMAND" ]; then
    PROMPT_COMMAND="__aitm_report;${{PROMPT_COMMAND}};__aitm_arm"
  else
    PROMPT_COMMAND="__aitm_report;__aitm_arm"
  fi
fi
"#,
        code = SENTINEL_OSC_CODE,
        exec_kind = EXEC_KIND,
        end_kind = END_KIND,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_只认_zsh_与_bash() {
        assert_eq!(detect("/bin/zsh"), Some(HookShell::Zsh));
        assert_eq!(detect("zsh"), Some(HookShell::Zsh));
        assert_eq!(detect("/opt/homebrew/bin/bash"), Some(HookShell::Bash));
        // 其余一律 None → 走 sentinel 包装法兜底
        assert_eq!(detect("/bin/sh"), None);
        assert_eq!(detect("/bin/dash"), None);
        assert_eq!(detect("/usr/local/bin/fish"), None);
        assert_eq!(detect("cmd.exe"), None);
        assert_eq!(detect("powershell.exe"), None);
        assert_eq!(detect(""), None);
        // 防误判：含 zsh 子串但 basename 不等
        assert_eq!(detect("/bin/zshrc"), None);
    }

    #[test]
    fn zsh_片段_挂_preexec_与_precmd_钩子() {
        let s = zsh_snippet();
        assert!(s.contains("__aitm_preexec"), "实际：{s}");
        assert!(s.contains("__aitm_precmd"), "实际：{s}");
        assert!(s.contains("add-zsh-hook preexec"), "实际：{s}");
        assert!(s.contains("add-zsh-hook precmd"), "实际：{s}");
    }

    /// precmd 前插保险（插件把别人的钩子包成大函数时不保证恢复 `$?`）。
    #[test]
    fn zsh_片段_把自己排到_precmd_functions_最前() {
        let s = zsh_snippet();
        assert!(
            s.contains("precmd_functions=(__aitm_precmd"),
            "必须前插而不是追加，实际：{s}"
        );
    }

    /// 命令本身不得被改写 —— 这是 P1 的全部意义。
    #[test]
    fn zsh_片段_不含任何命令包装() {
        let s = zsh_snippet();
        assert!(!s.contains("eval '"), "钩子法不应再包装用户命令：{s}");
    }

    #[test]
    fn bash_片段_用_prompt_command_加_debug_trap() {
        let s = bash_snippet();
        assert!(s.contains("trap '__aitm_exec_trap' DEBUG"), "实际：{s}");
        assert!(s.contains("PROMPT_COMMAND"), "实际：{s}");
    }

    /// 红线：绝不覆盖用户已有的 PROMPT_COMMAND（字符串 / 数组两种形态都要保留）。
    #[test]
    fn bash_片段_保留用户原有_prompt_command() {
        let s = bash_snippet();
        assert!(
            s.contains("PROMPT_COMMAND=(__aitm_report \"${PROMPT_COMMAND[@]}\" __aitm_arm)"),
            "数组形态要把原内容夹在中间：{s}"
        );
        assert!(
            s.contains("PROMPT_COMMAND=\"__aitm_report;${PROMPT_COMMAND};__aitm_arm\""),
            "字符串形态要把原内容夹在中间：{s}"
        );
    }

    /// 已有 DEBUG trap 的用户（bash-preexec 等）不抢；后端靠 fallback 链降级。
    #[test]
    fn bash_片段_不抢已有的_debug_trap() {
        let s = bash_snippet();
        assert!(s.contains("[ -z \"$(trap -p DEBUG)\" ]"), "实际：{s}");
    }

    /// 两个片段发的 OSC 码 / 字段名必须与 sentinel 解析端一致，否则永远配不上。
    #[test]
    fn 片段里的_osc_字段与_sentinel_常量一致() {
        for s in [zsh_snippet(), bash_snippet()] {
            assert!(s.contains(&format!("\\033]{SENTINEL_OSC_CODE};{EXEC_KIND};%s;%s\\007")));
            assert!(s.contains(&format!("\\033]{SENTINEL_OSC_CODE};{END_KIND};%s;%s\\007")));
        }
    }

    /// 真机语法体检：用真 zsh / bash 的 `-n`（只解析不执行）校验片段语法。
    /// 语法写错的话钩子静默不生效，只能靠这个在单测阶段暴露。
    #[cfg(unix)]
    mod 语法体检 {
        use super::*;
        use std::io::Write;

        fn syntax_ok(shell: &str, script: &str) -> Option<(bool, String)> {
            if !std::path::Path::new(shell).exists() {
                return None; // 本机没这个 shell，跳过
            }
            let mut f = tempfile::NamedTempFile::new().ok()?;
            f.write_all(script.as_bytes()).ok()?;
            let out = std::process::Command::new(shell)
                .arg("-n")
                .arg(f.path())
                .output()
                .ok()?;
            Some((
                out.status.success(),
                String::from_utf8_lossy(&out.stderr).into_owned(),
            ))
        }

        #[test]
        fn zsh_片段语法合法() {
            if let Some((ok, err)) = syntax_ok("/bin/zsh", &zsh_snippet()) {
                assert!(ok, "zsh -n 报语法错误：{err}");
            }
        }

        #[test]
        fn bash_片段语法合法() {
            if let Some((ok, err)) = syntax_ok("/bin/bash", &bash_snippet()) {
                assert!(ok, "bash -n 报语法错误：{err}");
            }
        }
    }
}
