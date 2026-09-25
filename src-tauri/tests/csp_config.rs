//! 主窗口 CSP 配置的防回退检查。
//!
//! CSP 是纵深防御：即便前端某处出现注入点，也不能执行外来脚本或把数据发往外部。
//! 生产 CSP 一旦被改成 null 或放开内联脚本，这层防御就形同虚设，所以用测试钉住。

fn security() -> serde_json::Value {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tauri.conf.json"))
        .expect("读取 tauri.conf.json");
    let conf: serde_json::Value = serde_json::from_str(&text).expect("解析 tauri.conf.json");
    conf["app"]["security"].clone()
}

fn directive(csp: &str, name: &str) -> String {
    csp.split(';')
        .map(str::trim)
        .find(|d| d.starts_with(&format!("{name} ")))
        .unwrap_or_default()
        .to_string()
}

#[test]
fn 应该_为主窗口设置生产_csp() {
    assert!(
        security()["csp"].is_string(),
        "app.security.csp 不能为 null"
    );
}

#[test]
fn 应该_只允许加载本应用自己的脚本() {
    let csp = security()["csp"].as_str().unwrap_or_default().to_string();
    let script = directive(&csp, "script-src");
    assert_eq!(script, "script-src 'self'");
}

#[test]
fn 应该_只允许连接_ipc_不允许向外部发请求() {
    let csp = security()["csp"].as_str().unwrap_or_default().to_string();
    let connect = directive(&csp, "connect-src");
    assert!(!connect.is_empty(), "缺少 connect-src");
    for src in connect.split_whitespace().skip(1) {
        assert!(
            ["'self'", "ipc:", "http://ipc.localhost"].contains(&src),
            "connect-src 不应放行 {src}"
        );
    }
}

#[test]
fn 应该_禁止插件对象与改写_base() {
    let csp = security()["csp"].as_str().unwrap_or_default().to_string();
    assert_eq!(directive(&csp, "object-src"), "object-src 'none'");
    assert_eq!(directive(&csp, "base-uri"), "base-uri 'self'");
}
