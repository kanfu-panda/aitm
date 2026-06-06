//! conversations IPC 集成测试。
//!
//! 直接调 `ipc::conversations` 的 `*_impl` 同步函数，避开 Tauri AppHandle /
//! State 系统（命令 wrapper 只是 spawn_blocking 转发，impl = 命令行为）。
//!
//! 覆盖：
//! - 基本 CRUD：create / list / delete
//! - rename 行为：title_auto 自动置 false（用户手动改名）
//! - set_model：保留 title 改 provider/model
//! - append_message：seq 单调递增 / replace_payload 不动 seq
//! - get_messages：按 seq ASC
//! - delete CASCADE：删 conversation 自动清 messages
//! - scope 隔离：Project bucket vs Global bucket 互相看不到
//!
//! AITM_HOME 是进程级 env，多测试串行（沿用 store::tests 模式）。

// 测试函数名带中文 + 偶尔保留大写缩写（DESC / ASC），关掉 lint 噪音。
#![allow(non_snake_case)]

use std::sync::Mutex;
use tempfile::TempDir;

use aitm_lib::ipc::conversations::{
    conv_append_message_impl, conv_create_impl, conv_delete_impl, conv_get_messages_impl,
    conv_list_impl, conv_rename_impl, conv_replace_message_payload_impl, conv_set_model_impl,
};
use aitm_lib::ipc::scope::ScopeDto;
use aitm_lib::store::AitmDb;

/// AITM_HOME 进程级 env，多测试串行。
static HOME_LOCK: Mutex<()> = Mutex::new(());

fn with_home<F: FnOnce(&std::path::Path)>(f: F) {
    let _g = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let tmp = TempDir::new().unwrap();
    let prev = std::env::var("AITM_HOME").ok();
    // SAFETY: HOME_LOCK 串行
    unsafe {
        std::env::set_var("AITM_HOME", tmp.path());
    }
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(tmp.path())));
    unsafe {
        match prev {
            Some(v) => std::env::set_var("AITM_HOME", v),
            None => std::env::remove_var("AITM_HOME"),
        }
    }
    if let Err(e) = r {
        std::panic::resume_unwind(e);
    }
}

fn global_scope() -> ScopeDto {
    ScopeDto::Global
}

fn project_scope(uuid: &str) -> ScopeDto {
    ScopeDto::Project {
        uuid: uuid.to_string(),
        root_path: "/fake/root".to_string(),
    }
}

// ===================== create / list / delete =====================

#[test]
fn conv_create_然后_conv_list_看见() {
    with_home(|_| {
        let db = AitmDb::new();
        let scope = global_scope();

        let dto = conv_create_impl(&db, &scope, "新对话".to_string()).unwrap();
        assert!(!dto.id.is_empty(), "应生成 UUID");
        assert_eq!(dto.title, "新对话");
        assert!(dto.title_auto, "默认 title_auto = true");
        assert_eq!(dto.provider_id, "");
        assert_eq!(dto.model_id, "");
        assert!(dto.created_at > 0);
        assert_eq!(dto.created_at, dto.updated_at);

        let list = conv_list_impl(&db, &scope).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, dto.id);
        assert_eq!(list[0].title, "新对话");
    });
}

#[test]
fn conv_create_多条_按_updated_at_DESC() {
    with_home(|_| {
        let db = AitmDb::new();
        let scope = global_scope();

        let a = conv_create_impl(&db, &scope, "A".into()).unwrap();
        // 间隔 1 秒确保 updated_at 单调递增
        std::thread::sleep(std::time::Duration::from_millis(1100));
        let b = conv_create_impl(&db, &scope, "B".into()).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        let c = conv_create_impl(&db, &scope, "C".into()).unwrap();

        let list = conv_list_impl(&db, &scope).unwrap();
        let titles: Vec<&str> = list.iter().map(|r| r.title.as_str()).collect();
        // 最新创建的在最前
        assert_eq!(titles, vec!["C", "B", "A"]);
        assert_eq!(list[0].id, c.id);
        assert_eq!(list[2].id, a.id);
        let _ = b; // 静默 unused
    });
}

#[test]
fn conv_delete_删除对话_列表减少() {
    with_home(|_| {
        let db = AitmDb::new();
        let scope = global_scope();

        let a = conv_create_impl(&db, &scope, "A".into()).unwrap();
        let _b = conv_create_impl(&db, &scope, "B".into()).unwrap();
        assert_eq!(conv_list_impl(&db, &scope).unwrap().len(), 2);

        conv_delete_impl(&db, &scope, a.id.clone()).unwrap();
        let list = conv_list_impl(&db, &scope).unwrap();
        assert_eq!(list.len(), 1);
        assert!(list.iter().all(|c| c.id != a.id));
    });
}

#[test]
fn conv_delete_级联删_messages() {
    with_home(|_| {
        let db = AitmDb::new();
        let scope = global_scope();
        let c = conv_create_impl(&db, &scope, "T".into()).unwrap();

        conv_append_message_impl(
            &db,
            &scope,
            c.id.clone(),
            "user".into(),
            r#"{"content":"hi"}"#.into(),
        )
        .unwrap();
        conv_append_message_impl(
            &db,
            &scope,
            c.id.clone(),
            "assistant".into(),
            r#"{"content":"hello"}"#.into(),
        )
        .unwrap();
        assert_eq!(
            conv_get_messages_impl(&db, &scope, c.id.clone())
                .unwrap()
                .len(),
            2
        );

        conv_delete_impl(&db, &scope, c.id.clone()).unwrap();
        let msgs = conv_get_messages_impl(&db, &scope, c.id.clone()).unwrap();
        assert!(
            msgs.is_empty(),
            "FK ON DELETE CASCADE 应清掉 messages，剩 {} 条",
            msgs.len()
        );
    });
}

// ===================== rename / set_model =====================

#[test]
fn conv_rename_后_title_auto_变_false() {
    with_home(|_| {
        let db = AitmDb::new();
        let scope = global_scope();
        let c = conv_create_impl(&db, &scope, "原标题".into()).unwrap();
        assert!(c.title_auto, "新建时 title_auto=true");

        conv_rename_impl(&db, &scope, c.id.clone(), "用户改的".into()).unwrap();

        let list = conv_list_impl(&db, &scope).unwrap();
        let got = list.iter().find(|r| r.id == c.id).unwrap();
        assert_eq!(got.title, "用户改的");
        assert!(!got.title_auto, "rename 后应锁定 title_auto = false");
    });
}

#[test]
fn conv_rename_保留_provider_model() {
    with_home(|_| {
        let db = AitmDb::new();
        let scope = global_scope();
        let c = conv_create_impl(&db, &scope, "T".into()).unwrap();

        // 先设个 provider/model，再 rename
        conv_set_model_impl(
            &db,
            &scope,
            c.id.clone(),
            "anthropic".into(),
            "claude-4".into(),
        )
        .unwrap();
        conv_rename_impl(&db, &scope, c.id.clone(), "新名字".into()).unwrap();

        let list = conv_list_impl(&db, &scope).unwrap();
        let got = list.iter().find(|r| r.id == c.id).unwrap();
        assert_eq!(got.title, "新名字");
        assert_eq!(got.provider_id, "anthropic", "rename 应保留 provider");
        assert_eq!(got.model_id, "claude-4", "rename 应保留 model");
    });
}

#[test]
fn conv_set_model_后_provider_model_保存() {
    with_home(|_| {
        let db = AitmDb::new();
        let scope = global_scope();
        let c = conv_create_impl(&db, &scope, "T".into()).unwrap();
        assert_eq!(c.provider_id, "");
        assert_eq!(c.model_id, "");

        conv_set_model_impl(
            &db,
            &scope,
            c.id.clone(),
            "openai".into(),
            "gpt-4o".into(),
        )
        .unwrap();

        let list = conv_list_impl(&db, &scope).unwrap();
        let got = list.iter().find(|r| r.id == c.id).unwrap();
        assert_eq!(got.provider_id, "openai");
        assert_eq!(got.model_id, "gpt-4o");
        // title 不应被 set_model 改
        assert_eq!(got.title, "T");
        // title_auto 也保留
        assert!(got.title_auto);
    });
}

// ===================== messages =====================

#[test]
fn conv_append_message_seq_单调递增() {
    with_home(|_| {
        let db = AitmDb::new();
        let scope = global_scope();
        let c = conv_create_impl(&db, &scope, "T".into()).unwrap();

        let m1 = conv_append_message_impl(
            &db,
            &scope,
            c.id.clone(),
            "user".into(),
            r#"{"content":"a"}"#.into(),
        )
        .unwrap();
        let m2 = conv_append_message_impl(
            &db,
            &scope,
            c.id.clone(),
            "assistant".into(),
            r#"{"content":"b"}"#.into(),
        )
        .unwrap();
        let m3 = conv_append_message_impl(
            &db,
            &scope,
            c.id.clone(),
            "tool_call".into(),
            r#"{"call_id":"t","name":"x"}"#.into(),
        )
        .unwrap();

        assert_eq!(m1.seq, 1);
        assert_eq!(m2.seq, 2);
        assert_eq!(m3.seq, 3);
        assert!(m1.id > 0);
        assert_eq!(m1.kind, "user");
        assert!(m1.created_at > 0);
        assert_eq!(m1.payload_json, r#"{"content":"a"}"#);
    });
}

#[test]
fn conv_get_messages_返回所有_按_seq_ASC() {
    with_home(|_| {
        let db = AitmDb::new();
        let scope = global_scope();
        let c = conv_create_impl(&db, &scope, "T".into()).unwrap();

        conv_append_message_impl(
            &db,
            &scope,
            c.id.clone(),
            "user".into(),
            r#"{"content":"1"}"#.into(),
        )
        .unwrap();
        conv_append_message_impl(
            &db,
            &scope,
            c.id.clone(),
            "assistant".into(),
            r#"{"content":"2"}"#.into(),
        )
        .unwrap();
        conv_append_message_impl(
            &db,
            &scope,
            c.id.clone(),
            "tool_call".into(),
            r#"{"call_id":"t","name":"x"}"#.into(),
        )
        .unwrap();

        let list = conv_get_messages_impl(&db, &scope, c.id.clone()).unwrap();
        assert_eq!(list.len(), 3);
        // seq 升序
        assert_eq!(list[0].seq, 1);
        assert_eq!(list[1].seq, 2);
        assert_eq!(list[2].seq, 3);
        assert_eq!(list[0].kind, "user");
        assert_eq!(list[1].kind, "assistant");
        assert_eq!(list[2].kind, "tool_call");
        // payload 原样回传
        assert_eq!(list[0].payload_json, r#"{"content":"1"}"#);
    });
}

#[test]
fn conv_replace_message_payload_只改_payload() {
    with_home(|_| {
        let db = AitmDb::new();
        let scope = global_scope();
        let c = conv_create_impl(&db, &scope, "T".into()).unwrap();

        let m = conv_append_message_impl(
            &db,
            &scope,
            c.id.clone(),
            "tool_call".into(),
            r#"{"status":"awaiting_approval"}"#.into(),
        )
        .unwrap();
        // 再追加一条无关消息，确保 replace 只改指定 seq
        let m2 = conv_append_message_impl(
            &db,
            &scope,
            c.id.clone(),
            "user".into(),
            r#"{"content":"untouched"}"#.into(),
        )
        .unwrap();

        conv_replace_message_payload_impl(
            &db,
            &scope,
            c.id.clone(),
            m.seq,
            r#"{"status":"done"}"#.into(),
        )
        .unwrap();

        let list = conv_get_messages_impl(&db, &scope, c.id.clone()).unwrap();
        assert_eq!(list.len(), 2);

        let updated = list.iter().find(|r| r.seq == m.seq).unwrap();
        assert_eq!(updated.payload_json, r#"{"status":"done"}"#);
        assert_eq!(updated.kind, "tool_call", "kind 不应改");

        let untouched = list.iter().find(|r| r.seq == m2.seq).unwrap();
        assert_eq!(
            untouched.payload_json, r#"{"content":"untouched"}"#,
            "未指定的 seq 应保持原值"
        );
    });
}

// ===================== scope 隔离 =====================

#[test]
fn project_scope_和_global_scope_使用不同_bucket() {
    with_home(|_| {
        let db = AitmDb::new();
        let g = global_scope();
        let p = project_scope("proj-uuid-1");

        let g_conv = conv_create_impl(&db, &g, "全局对话".into()).unwrap();
        let p_conv = conv_create_impl(&db, &p, "项目对话".into()).unwrap();
        assert_ne!(g_conv.id, p_conv.id);

        // 全局桶只看到全局对话
        let g_list = conv_list_impl(&db, &g).unwrap();
        assert_eq!(g_list.len(), 1);
        assert_eq!(g_list[0].title, "全局对话");

        // 项目桶只看到项目对话
        let p_list = conv_list_impl(&db, &p).unwrap();
        assert_eq!(p_list.len(), 1);
        assert_eq!(p_list[0].title, "项目对话");

        // append message 也按 scope 分桶
        conv_append_message_impl(
            &db,
            &g,
            g_conv.id.clone(),
            "user".into(),
            r#"{"content":"global hi"}"#.into(),
        )
        .unwrap();
        conv_append_message_impl(
            &db,
            &p,
            p_conv.id.clone(),
            "user".into(),
            r#"{"content":"project hi"}"#.into(),
        )
        .unwrap();

        let g_msgs = conv_get_messages_impl(&db, &g, g_conv.id.clone()).unwrap();
        let p_msgs = conv_get_messages_impl(&db, &p, p_conv.id.clone()).unwrap();
        assert_eq!(g_msgs.len(), 1);
        assert_eq!(p_msgs.len(), 1);
        assert_eq!(g_msgs[0].payload_json, r#"{"content":"global hi"}"#);
        assert_eq!(p_msgs[0].payload_json, r#"{"content":"project hi"}"#);

        // 跨 bucket 查不存在的 conv 返回空
        let cross = conv_get_messages_impl(&db, &g, p_conv.id.clone()).unwrap();
        assert!(cross.is_empty(), "全局桶不该看到项目对话的消息");
    });
}

#[test]
fn 多个_project_scope_互相隔离() {
    with_home(|_| {
        let db = AitmDb::new();
        let p1 = project_scope("p1");
        let p2 = project_scope("p2");

        conv_create_impl(&db, &p1, "p1 对话".into()).unwrap();
        conv_create_impl(&db, &p2, "p2 对话".into()).unwrap();

        let l1 = conv_list_impl(&db, &p1).unwrap();
        let l2 = conv_list_impl(&db, &p2).unwrap();
        assert_eq!(l1.len(), 1);
        assert_eq!(l2.len(), 1);
        assert_eq!(l1[0].title, "p1 对话");
        assert_eq!(l2[0].title, "p2 对话");
    });
}

// ===================== 边界 =====================

#[test]
fn conv_list_空桶返回空_vec() {
    with_home(|_| {
        let db = AitmDb::new();
        let list = conv_list_impl(&db, &global_scope()).unwrap();
        assert!(list.is_empty());
    });
}

#[test]
fn conv_create_id_格式_uuid_v7() {
    with_home(|_| {
        let db = AitmDb::new();
        let dto = conv_create_impl(&db, &global_scope(), "T".into()).unwrap();
        // UUID v7 hyphenated 长度 = 36
        assert_eq!(dto.id.len(), 36, "UUID hyphenated 应为 36 字符: {}", dto.id);
        assert_eq!(dto.id.chars().filter(|c| *c == '-').count(), 4);
    });
}

#[test]
fn append_刷新_conversation_的_updated_at_在_list_排前() {
    with_home(|_| {
        let db = AitmDb::new();
        let scope = global_scope();
        let a = conv_create_impl(&db, &scope, "A".into()).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        let _b = conv_create_impl(&db, &scope, "B".into()).unwrap();
        // 此时 list: B, A

        std::thread::sleep(std::time::Duration::from_millis(1100));
        // 给 A 追加消息 → A 的 updated_at 刷成 now，应排到最前
        conv_append_message_impl(
            &db,
            &scope,
            a.id.clone(),
            "user".into(),
            r#"{"content":"poke"}"#.into(),
        )
        .unwrap();

        let list = conv_list_impl(&db, &scope).unwrap();
        assert_eq!(
            list[0].id, a.id,
            "刚追加消息的 A 应排到最前；list = {:?}",
            list.iter().map(|r| &r.title).collect::<Vec<_>>()
        );
    });
}
