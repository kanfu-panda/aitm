//! 界面可见的后端错误 / 提示：编码 + 参数 + 中文兜底。
//!
//! 界面支持中 / 英 / 日，后端却只会说中文。会原样显示到界面上的错误，统一用
//! [`ui_err`] 生成一段 JSON 字符串：
//!
//! ```text
//! {"code":"fs.notDir","params":{"path":"/a"},"message":"不是目录：/a"}
//! ```
//!
//! 前端 `formatBackendError` 识别出 `code` 后查语言包 `backendErrors.<code>`，
//! 用 `params` 填占位符；查不到时显示 `message`。IPC 命令的返回类型仍是
//! `Result<T, String>`，调用方不用改签名。
//!
//! 只用于**会显示给用户**的文本。给大模型看的工具结果、日志不要用它——
//! 需要把这类字符串转给模型或写日志时，用 [`plain`] 取回中文 `message`。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
struct UiError {
    code: String,
    params: BTreeMap<String, String>,
    message: String,
}

/// 生成一条界面可见的错误字符串。`code` 对应语言包 `backendErrors.<code>`，
/// `params` 的键对应语言包里的 `{{占位符}}`，`message` 是中文兜底。
pub fn ui_err(code: &str, params: &[(&str, String)], message: impl Into<String>) -> String {
    let e = UiError {
        code: code.to_string(),
        params: params
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect(),
        message: message.into(),
    };
    // 结构里只有字符串，序列化不会失败
    serde_json::to_string(&e).unwrap_or_else(|_| e.message.clone())
}

/// 取回可读文本：是 [`ui_err`] 生成的就返回中文 `message`，否则原样返回。
pub fn plain(s: &str) -> String {
    match serde_json::from_str::<UiError>(s) {
        Ok(e) => e.message,
        Err(_) => s.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn ui_err_生成带编码参数与中文兜底的_json() {
        let s = ui_err("fs.notDir", &[("path", "/a\"b".into())], "不是目录：/a\"b");
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["code"], "fs.notDir");
        assert_eq!(v["params"]["path"], "/a\"b");
        assert_eq!(v["message"], "不是目录：/a\"b");
    }

    #[test]
    fn plain_取回中文兜底_普通字符串原样返回() {
        assert_eq!(plain(&ui_err("x.y", &[], "中文")), "中文");
        assert_eq!(plain("普通错误"), "普通错误");
        assert_eq!(plain("{\"other\":1}"), "{\"other\":1}");
    }

    /// 收集源码里 `ui_err("<code>"` 用到的全部编码。
    fn codes_in_source() -> Vec<(String, String)> {
        fn walk(dir: &Path, re: &regex::Regex, out: &mut Vec<(String, String)>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let p = entry.unwrap().path();
                if p.is_dir() {
                    walk(&p, re, out);
                } else if p.extension().is_some_and(|e| e == "rs") && !p.ends_with("ui_error.rs") {
                    let src = std::fs::read_to_string(&p).unwrap();
                    // 测试代码里会用假编码，只扫生产代码
                    let src = src.split("#[cfg(test)]").next().unwrap_or("");
                    for c in re.captures_iter(src) {
                        out.push((c[1].to_string(), p.display().to_string()));
                    }
                }
            }
        }
        let re = regex::Regex::new(r#"ui_err\(\s*"([A-Za-z0-9_.]+)""#).unwrap();
        let mut out = Vec::new();
        walk(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
            &re,
            &mut out,
        );
        out
    }

    fn lookup<'a>(v: &'a serde_json::Value, code: &str) -> Option<&'a str> {
        let mut cur = v.get("backendErrors")?;
        for part in code.split('.') {
            cur = cur.get(part)?;
        }
        cur.as_str()
    }

    fn placeholders(s: &str) -> Vec<String> {
        let re = regex::Regex::new(r"\{\{\s*([A-Za-z0-9_]+)\s*\}\}").unwrap();
        let mut v: Vec<String> = re.captures_iter(s).map(|c| c[1].to_string()).collect();
        v.sort();
        v.dedup();
        v
    }

    #[test]
    fn 应该_当后端用到错误编码时_三种语言包都有对应文案且占位符一致() {
        let locales = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/locales");
        let langs: Vec<(String, serde_json::Value)> = ["zh-CN", "en", "ja"]
            .iter()
            .map(|l| {
                let raw = std::fs::read_to_string(locales.join(format!("{l}.json"))).unwrap();
                (l.to_string(), serde_json::from_str(&raw).unwrap())
            })
            .collect();
        let mut problems = Vec::new();
        for (code, file) in codes_in_source() {
            let zh = lookup(&langs[0].1, &code).map(placeholders);
            for (lang, v) in &langs {
                match lookup(v, &code) {
                    None => problems.push(format!("{lang} 缺 backendErrors.{code}（{file}）")),
                    Some(s) if Some(placeholders(s)) != zh => {
                        problems.push(format!("{lang} backendErrors.{code} 占位符与中文不一致"))
                    }
                    _ => {}
                }
            }
        }
        assert!(problems.is_empty(), "{}", problems.join("\n"));
    }
}
