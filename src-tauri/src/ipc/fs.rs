//! 文件系统相关 IPC 命令（Phase 3A T1）。
//!
//! 三个能力：
//! - [`fs_tree`]：给前端 TreeView 用，递归列目录到 `max_depth`，超出深度的
//!   dir 节点 `children = None`（前端识别 None 触发懒加载继续展开）。
//!   硬编码 [`SKIP_NAMES`] 跳过 `.git` / `node_modules` / `target` 等噪音目录，
//!   省一棵几万节点的树。
//! - [`fs_read_text`]：给前端 MD/文本预览面板用。`max_bytes` 截断保护。
//!   含 `\0` 字节认作二进制 → Err。UTF-8 用 `from_utf8_lossy` 兼容 latin1
//!   等老编码。
//!
//! ## 设计取舍
//!
//! - 不引 walkdir / ignore 等 crate：std::fs 够用；项目目标包体 < 25MB。
//! - 不跟随 symlink：`read_dir` 的默认行为，metadata 用 `symlink_metadata`
//!   + `file_type()` 判类型，不主动 follow。
//! - 单个子项读不了（permission denied / 损坏的 symlink）→ 跳过该项继续，
//!   不让整次调用失败。
//! - 隐藏文件（`.foo`）默认显示；只有 [`SKIP_NAMES`] 里的精确名字过滤。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, FileIdMap};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// 硬编码跳过名单。命中精确 name 即不进树。
const SKIP_NAMES: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    ".next",
    ".venv",
    "venv",
    ".svn",
    ".hg",
    ".idea",
    ".vscode",
    ".DS_Store",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
];

/// 树节点。`children` 三态：
/// - `Some(vec)`：dir 已展开（vec 可为空表空目录）
/// - `None`：dir 还没展开（max_depth 用完，懒加载信号）；file 始终 `None`
#[derive(Debug, Serialize, PartialEq)]
pub struct TreeNode {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub children: Option<Vec<TreeNode>>,
}

/// 递归列出 `path` 下的目录树到深度 `max_depth`。
///
/// - `max_depth = 0`：返回根节点本身 + `children = None`
/// - `max_depth = N`：根 + N 层子节点；第 N 层 dir `children = None`
///
/// 子项排序：dir 在前 file 在后；同类按 name 升序。
#[tauri::command]
pub fn fs_tree(path: String, max_depth: u32) -> Result<TreeNode, String> {
    let canonical = std::fs::canonicalize(&path)
        .map_err(|e| format!("路径无法 canonicalize：{path}：{e}"))?;
    let meta = std::fs::metadata(&canonical)
        .map_err(|e| format!("读不到 metadata：{}：{e}", canonical.display()))?;
    if !meta.is_dir() {
        return Err(format!("不是目录：{}", canonical.display()));
    }
    Ok(build_node(&canonical, max_depth))
}

/// 递归构建 dir 节点。
fn build_node(path: &Path, depth_remaining: u32) -> TreeNode {
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        // canonicalize 后的根目录（如 `/`）没有 file_name，用整路径兜底
        .unwrap_or_else(|| path.to_string_lossy().into_owned());
    let path_str = path.to_string_lossy().into_owned();

    let children = if depth_remaining == 0 {
        // 深度用完 → 懒加载信号
        None
    } else {
        Some(read_children(path, depth_remaining - 1))
    };

    TreeNode {
        name,
        path: path_str,
        kind: "dir".to_string(),
        children,
    }
}

/// 读 `dir` 的直接子项（已排序、已过滤跳过名单）；
/// 子目录递归到 `child_depth`（0 表 dir 子节点 children=None）。
fn read_children(dir: &Path, child_depth: u32) -> Vec<TreeNode> {
    let entries = match std::fs::read_dir(dir) {
        Ok(it) => it,
        Err(_) => return Vec::new(), // 读不动整个目录 → 当空目录处理
    };

    let mut dirs: Vec<TreeNode> = Vec::new();
    let mut files: Vec<TreeNode> = Vec::new();

    for entry_res in entries {
        let entry = match entry_res {
            Ok(e) => e,
            Err(_) => continue, // 跳过单条读不了的项
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        if SKIP_NAMES.contains(&name.as_str()) {
            continue;
        }

        // 用 file_type 不 follow symlink；symlink 失败也跳过该项
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };

        let entry_path = entry.path();
        if file_type.is_dir() {
            dirs.push(build_node(&entry_path, child_depth));
        } else if file_type.is_file() {
            files.push(TreeNode {
                name,
                path: entry_path.to_string_lossy().into_owned(),
                kind: "file".to_string(),
                children: None,
            });
        }
        // symlink / 其它特殊类型：跳过（不跟随）
    }

    // dir 前 file 后；同类 name asc
    dirs.sort_by(|a, b| a.name.cmp(&b.name));
    files.sort_by(|a, b| a.name.cmp(&b.name));
    dirs.append(&mut files);
    dirs
}

/// 读文本文件，长度截到 `max_bytes`。
///
/// - 路径必须存在且是 file
/// - 读到 `\0` 视作二进制 → Err
/// - UTF-8 用 lossy 解码，兼容 latin1 等
#[tauri::command]
pub fn fs_read_text(path: String, max_bytes: u32) -> Result<String, String> {
    let canonical = std::fs::canonicalize(&path)
        .map_err(|e| format!("路径无法 canonicalize：{path}：{e}"))?;
    let meta = std::fs::metadata(&canonical)
        .map_err(|e| format!("读不到 metadata：{}：{e}", canonical.display()))?;
    if !meta.is_file() {
        return Err(format!("不是文件：{}", canonical.display()));
    }

    let mut bytes = std::fs::read(&canonical)
        .map_err(|e| format!("读文件失败：{}：{e}", canonical.display()))?;

    // 二进制嗅探：含 \0 字节
    if bytes.contains(&0u8) {
        return Err("看起来是二进制文件".to_string());
    }

    // 截断
    let limit = max_bytes as usize;
    if bytes.len() > limit {
        bytes.truncate(limit);
    }

    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

// ====== v0.5.0-C T1：文件预览扩展（5 kind 分类）======

/// 文件预览结果，按 kind 分流（plan §3.1）。
///
/// 前端按 kind 选 renderer：markdown → react-markdown，code → highlight.js，
/// text → 纯 `<pre>`，image → `<img>` base64，binary/too_large → fallback Dialog。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PreviewResult {
    Markdown { content: String, truncated: bool },
    Code { content: String, language: String, truncated: bool },
    Text { content: String, truncated: bool },
    Image { mime: String, base64: String },
    Binary { reason: String },
    TooLarge { size: u64, max_size: u64 },
}

/// 文本类（markdown/code/text）最大读取字节数：1 MB。
const TEXT_MAX_BYTES: u64 = 1024 * 1024;
/// 图片最大字节数：5 MB（base64 编码后 ~6.7 MB）。
const IMAGE_MAX_BYTES: u64 = 5 * 1024 * 1024;

/// 扩展名 → 高亮语言；不在白名单返 None 表示走 text 路径。
fn ext_to_code_language(ext: &str) -> Option<&'static str> {
    Some(match ext.to_ascii_lowercase().as_str() {
        "ts" | "tsx" | "mts" | "cts" => "typescript",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "rs" => "rust",
        "py" => "python",
        "go" => "go",
        "rb" => "ruby",
        "sh" | "bash" | "zsh" => "bash",
        "toml" => "toml",
        "yaml" | "yml" => "yaml",
        "json" => "json",
        "html" | "htm" => "html",
        "css" | "scss" | "sass" => "css",
        "sql" => "sql",
        "swift" => "swift",
        "kt" | "kts" => "kotlin",
        "java" => "java",
        "c" | "h" => "c",
        "cpp" | "cc" | "cxx" | "hpp" | "hxx" => "cpp",
        "dockerfile" => "dockerfile",
        "lua" => "lua",
        "vue" => "html",
        _ => return None,
    })
}

/// 扩展名 → 图片 mime；不在白名单返 None。
fn ext_to_image_mime(ext: &str) -> Option<&'static str> {
    Some(match ext.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        _ => return None,
    })
}

/// 判 UTF-8 文本：无 NUL 字节 + UTF-8 严格可解码（含中文等多字节字符）。
///
/// **必须传入完整字节流**——不能只传前 N 字节，否则多字节字符跨边界被截断
/// 时 `from_utf8` 误报错（v0.5.3 维护者 真机反馈 bug：CLAUDE.md 中文文档被误判
/// Binary 就是嗅探只看前 4096 byte 引起的）。
fn is_text_content(bytes: &[u8]) -> bool {
    if bytes.contains(&0u8) {
        return false;
    }
    std::str::from_utf8(bytes).is_ok()
}

/// 把 bytes 编码成 base64 string（图片预览给前端用 data URL）。
fn to_base64(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// v0.5.0-C：按扩展名 + 嗅探决定如何预览文件。
///
/// - markdown / code / text → 读 string + 截断 1 MB
/// - image → 读 bytes + base64 + max 5 MB
/// - 二进制 / too_large → 返结构化 reason 让前端弹 fallback Dialog
///
/// 全部失败路径返 Err（前端显示"读取失败"红框）。
#[tauri::command]
pub fn fs_read_preview(path: String) -> Result<PreviewResult, String> {
    let canonical = std::fs::canonicalize(&path)
        .map_err(|e| format!("路径无法 canonicalize：{path}：{e}"))?;
    let meta = std::fs::metadata(&canonical)
        .map_err(|e| format!("读不到 metadata：{}：{e}", canonical.display()))?;
    if !meta.is_file() {
        return Err(format!("不是文件：{}", canonical.display()));
    }

    let size = meta.len();
    let ext = canonical
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("");

    // === 图片分支 ===
    if let Some(mime) = ext_to_image_mime(ext) {
        if size > IMAGE_MAX_BYTES {
            return Ok(PreviewResult::TooLarge {
                size,
                max_size: IMAGE_MAX_BYTES,
            });
        }
        let bytes = std::fs::read(&canonical)
            .map_err(|e| format!("读文件失败：{}：{e}", canonical.display()))?;
        return Ok(PreviewResult::Image {
            mime: mime.to_string(),
            base64: to_base64(&bytes),
        });
    }

    // === 文本类（markdown/code/text）===
    if size > TEXT_MAX_BYTES {
        return Ok(PreviewResult::TooLarge {
            size,
            max_size: TEXT_MAX_BYTES,
        });
    }

    let mut bytes = std::fs::read(&canonical)
        .map_err(|e| format!("读文件失败：{}：{e}", canonical.display()))?;

    // 二进制嗅探：嗅探整个文件而非前 4096 字节，避免多字节 UTF-8 字符跨越
    // 4096 边界被切断导致中文 markdown / 代码文件被误判为二进制（v0.5.3 维护者
    // 真机反馈：CLAUDE.md 中文文档被判 Binary）。文件大小已被前面 TEXT_MAX_BYTES
    // 限制到 1MB，嗅探整文件性能可接受（~1ms）。
    if !is_text_content(&bytes) {
        return Ok(PreviewResult::Binary {
            reason: "包含非 UTF-8 / NUL 字节".to_string(),
        });
    }

    let truncated = bytes.len() > TEXT_MAX_BYTES as usize;
    if truncated {
        bytes.truncate(TEXT_MAX_BYTES as usize);
    }
    let content = String::from_utf8_lossy(&bytes).into_owned();

    // markdown
    if matches!(ext.to_ascii_lowercase().as_str(), "md" | "markdown") {
        return Ok(PreviewResult::Markdown { content, truncated });
    }
    // code（已识别语言）
    if let Some(language) = ext_to_code_language(ext) {
        return Ok(PreviewResult::Code {
            content,
            language: language.to_string(),
            truncated,
        });
    }
    // text fallback
    Ok(PreviewResult::Text { content, truncated })
}

// ====== v0.9.0 T5c：文件写入（编辑器保存）======

/// 写入文件内容到磁盘（v0.9.0 T5c 编辑器 Cmd+S 保存）。
///
/// 安全检查（必须先通过才落盘）：
/// - `path` 必须是**绝对路径**（不接受 `~` 或相对路径，避免依赖 cwd）
/// - 路径不能落在 [`is_blacklisted_path`] 的系统目录里（macOS / Linux / Windows）
///
/// 不做的事（刻意的）：
/// - **不做** canonicalize：要保存到的文件可能本身不存在（新建场景），或父目录是
///   symlink；canonicalize 会失败或解出非预期路径。绝对路径 + 黑名单已够（按
///   path 前缀做字符串匹配，跟实际 inode 无关）。
/// - **不创父目录**：父目录缺失时让 `tokio::fs::write` 自然返 IO 错误透传到 UI
///   （T5c 调用方是已经打开过的文件，父目录必存在；新建文件不在 T5c 范围）。
/// - **不做原子写**（tempfile + rename）：T5c 规模文本编辑场景下原子写收益不大；
///   未来若发现保存中崩溃丢内容的反馈再补。
#[tauri::command]
pub async fn file_write(path: String, content: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    if !p.is_absolute() {
        return Err(format!("path 必须是绝对路径：{path}"));
    }
    if is_blacklisted_path(&p) {
        return Err(format!("禁止写入系统目录：{path}"));
    }
    tokio::fs::write(&p, content.as_bytes())
        .await
        .map_err(|e| format!("写文件失败：{}：{e}", p.display()))
}

/// 系统目录黑名单：写入这些前缀的路径一律拒绝。
///
/// 覆盖：
/// - macOS：`/System/`、`/Library/System/`
/// - macOS + Linux：`/etc/`、`/usr/`
/// - Windows：`C:\Windows\`、`C:\Program Files\`（大小写不敏感，含 Program Files (x86)）
///
/// 注意：用 `to_string_lossy()` 跨平台。Windows 路径分隔符是 `\`，比较时也用 `\`。
/// 大小写处理：Windows 系统盘可能是 `D:` / `C:`；这里只防最常见的 C 盘默认布局，
/// 不做完整 ACL 校验（那是 OS 的事）。
fn is_blacklisted_path(p: &std::path::Path) -> bool {
    let s = p.to_string_lossy();
    // Unix（macOS / Linux）
    if s.starts_with("/etc/")
        || s.starts_with("/System/")
        || s.starts_with("/usr/")
        || s.starts_with("/Library/System/")
    {
        return true;
    }
    // Windows（不区分大小写比较 ASCII 前缀）
    let lower = s.to_ascii_lowercase();
    if lower.starts_with(r"c:\windows\")
        || lower.starts_with(r"c:\program files\")
        || lower.starts_with(r"c:\program files (x86)\")
    {
        return true;
    }
    false
}

// ====== v0.10.3 #10：文件元信息（外部改动检测）======

/// 文件元信息快照 —— FilePreviewWorkspace 轮询比对 mtime/size 判外部改动。
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
pub struct FileMeta {
    /// 文件是否存在；不存在时其它字段为 0。
    pub exists: bool,
    /// 修改时间（Unix epoch 毫秒）；存在时填实际值，不存在 0。
    pub mtime_ms: i64,
    /// 文件大小（字节）；目录返 0。
    pub size: u64,
    /// 是否目录（用于区分"被替换成同名 dir"边界场景）。
    pub is_dir: bool,
}

/// 读 `path` 的 mtime / size / exists。轻量、可频繁轮询。
///
/// 失败语义：路径根本访问不了（权限 / 上层目录被删）→ exists=false 不报错。
/// 让前端 banner 显示"文件不存在了"，不弹 dialog。
#[tauri::command]
pub async fn fs_stat(path: String) -> Result<FileMeta, String> {
    let p = std::path::PathBuf::from(&path);
    let meta = match tokio::fs::metadata(&p).await {
        Ok(m) => m,
        Err(_) => {
            return Ok(FileMeta {
                exists: false,
                mtime_ms: 0,
                size: 0,
                is_dir: false,
            });
        }
    };
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let is_dir = meta.is_dir();
    let size = if is_dir { 0 } else { meta.len() };
    Ok(FileMeta {
        exists: true,
        mtime_ms,
        size,
        is_dir,
    })
}

// ====== v0.10.2 #6：文件树 CRUD（新建/重命名/删除）======

/// 在 `path` 新建空文件。
///
/// 行为：
/// - path 必须绝对路径
/// - path 不能命中 blacklist（防止写系统目录）
/// - **父目录必须存在**（前端右键菜单都是基于已存在节点 → 父目录天然存在）
/// - 文件已存在 → Err（避免误覆盖；前端可基于错误消息提示"已存在"）
#[tauri::command]
pub async fn fs_create_file(path: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    if !p.is_absolute() {
        return Err(format!("path 必须是绝对路径：{path}"));
    }
    if is_blacklisted_path(&p) {
        return Err(format!("禁止在系统目录新建：{path}"));
    }
    // create_new = true：已存在直接 Err，不覆盖
    match tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&p)
        .await
    {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            Err(format!("文件已存在：{}", p.display()))
        }
        Err(e) => Err(format!("新建文件失败：{}：{e}", p.display())),
    }
}

/// 在 `path` 新建目录（不递归创建父）。
///
/// 行为同 fs_create_file：绝对路径 + blacklist + 已存在报错。
#[tauri::command]
pub async fn fs_create_dir(path: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    if !p.is_absolute() {
        return Err(format!("path 必须是绝对路径：{path}"));
    }
    if is_blacklisted_path(&p) {
        return Err(format!("禁止在系统目录新建：{path}"));
    }
    if p.exists() {
        return Err(format!("路径已存在：{}", p.display()));
    }
    tokio::fs::create_dir(&p)
        .await
        .map_err(|e| format!("新建目录失败：{}：{e}", p.display()))
}

/// 重命名 / 移动 `from` 到 `to`（同卷 rename，跨卷会失败）。
///
/// 行为：
/// - from / to 都必须绝对路径 + 不命中 blacklist
/// - to 已存在 → Err（避免覆盖；前端如果想 force 应该先调 fs_delete）
/// - from 不存在 → 透传 IO 错误消息
#[tauri::command]
pub async fn fs_rename(from: String, to: String) -> Result<(), String> {
    let pf = std::path::PathBuf::from(&from);
    let pt = std::path::PathBuf::from(&to);
    if !pf.is_absolute() || !pt.is_absolute() {
        return Err("from / to 都必须是绝对路径".to_string());
    }
    if is_blacklisted_path(&pf) || is_blacklisted_path(&pt) {
        return Err("禁止读写系统目录".to_string());
    }
    if pt.exists() {
        return Err(format!("目标路径已存在：{}", pt.display()));
    }
    tokio::fs::rename(&pf, &pt)
        .await
        .map_err(|e| format!("重命名失败：{} → {}：{e}", pf.display(), pt.display()))
}

/// 删除文件或目录（目录递归删除）。
///
/// 危险操作，UI 必须二次确认。后端不做确认，按 path 行事。
/// - blacklist 防系统目录
/// - 文件 → fs::remove_file；目录 → fs::remove_dir_all（递归）
/// - 不存在 → 透传 IO 错误（UI 提示）
#[tauri::command]
pub async fn fs_delete(path: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    if !p.is_absolute() {
        return Err(format!("path 必须是绝对路径：{path}"));
    }
    if is_blacklisted_path(&p) {
        return Err(format!("禁止删除系统目录：{path}"));
    }
    let meta = tokio::fs::metadata(&p)
        .await
        .map_err(|e| format!("访问路径失败：{}：{e}", p.display()))?;
    if meta.is_dir() {
        tokio::fs::remove_dir_all(&p)
            .await
            .map_err(|e| format!("删除目录失败：{}：{e}", p.display()))
    } else {
        tokio::fs::remove_file(&p)
            .await
            .map_err(|e| format!("删除文件失败：{}：{e}", p.display()))
    }
}

// ====== v0.9.1 HR3-3：磁盘使用率 IPC（StatusBar 右段）======

/// 磁盘使用情况快照。StatusBar 10s 轮询调一次。
///
/// - `free_bytes` / `total_bytes`：传入 path 所在分区的容量信息（来自 sysinfo）
/// - `used_pct`：已用百分比（0.0 ~ 100.0）；total=0 时返 0
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
pub struct DiskUsage {
    pub free_bytes: u64,
    pub total_bytes: u64,
    pub used_pct: f32,
}

/// 查询 `path` 所在文件系统的磁盘使用率。
///
/// 实现：用 `sysinfo::Disks::new_with_refreshed_list()` 列出所有挂载分区，
/// 找出 `mount_point` 是 `path` 前缀且最长（最贴合的挂载点），用它的
/// `available_space / total_space` 算 used_pct。
///
/// path 不存在 / 找不到对应分区 → Err（前端隐藏 disk 段）。
#[tauri::command]
pub fn fs_disk_usage(path: String) -> Result<DiskUsage, String> {
    use sysinfo::Disks;

    let canonical = std::fs::canonicalize(&path)
        .map_err(|e| format!("路径无法 canonicalize：{path}：{e}"))?;

    let disks = Disks::new_with_refreshed_list();

    // 找 mount_point 是 canonical 前缀且最长的那个分区
    let best = disks
        .iter()
        .filter(|d| canonical.starts_with(d.mount_point()))
        .max_by_key(|d| d.mount_point().as_os_str().len());

    let disk = best.ok_or_else(|| {
        format!("找不到 {} 对应的磁盘分区", canonical.display())
    })?;

    let total_bytes = disk.total_space();
    let free_bytes = disk.available_space();
    let used_pct = if total_bytes == 0 {
        0.0
    } else {
        ((total_bytes - free_bytes) as f64 / total_bytes as f64 * 100.0) as f32
    };

    Ok(DiskUsage {
        free_bytes,
        total_bytes,
        used_pct,
    })
}

// ====== v0.9.1 HR3-3：当前 cwd 的 git 分支（StatusBar 中段）======

/// 查询 `cwd` 所在 git 仓库的当前分支名。
///
/// - 不在 git repo 内 / 无 HEAD（裸仓库 / detached）→ Ok(None)，前端隐藏中段
/// - 在 repo 内但 HEAD 是 commit hash（detached）→ shorthand 返回截短 sha
/// - path 不存在 / 其它 IO 错误 → Err（前端可降级到隐藏）
///
/// 复用 git2 crate（已用于 session/metadata.rs read_git_metadata）。
#[tauri::command]
pub fn git_current_branch(cwd: String) -> Result<Option<String>, String> {
    let p = std::path::PathBuf::from(&cwd);
    if !p.exists() {
        return Err(format!("路径不存在：{cwd}"));
    }
    // discover：往上找 .git 目录；不在 repo 内返 Err → 映射为 Ok(None)
    let repo = match git2::Repository::discover(&p) {
        Ok(r) => r,
        Err(_) => return Ok(None),
    };
    let head = match repo.head() {
        Ok(h) => h,
        Err(_) => return Ok(None),
    };
    Ok(head.shorthand().map(|s| s.to_string()))
}

// ====== v1.1.0 F5：目录树 fs 自动刷新（notify watcher → fs:changed）======

/// fs watcher 句柄状态。Tauri `State` 管理，`Mutex<Option<...>>` 允许：
/// - `fs_watch_start` 覆盖旧 watcher（赋值瞬间旧值被 drop —— `Debouncer::drop`
///   内部 `set_stop`，后台线程下个 tick 内自行退出，不阻塞调用方）
/// - `fs_watch_stop` / 找不到活跃 watcher 时置 `None`
pub struct FsWatcherState(pub Mutex<Option<Debouncer<RecommendedWatcher, FileIdMap>>>);

impl FsWatcherState {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }
}

impl Default for FsWatcherState {
    fn default() -> Self {
        Self::new()
    }
}

/// `fs:changed` 事件 payload：一次 debounce 批次内涉及的（已过滤）绝对路径。
#[derive(Debug, Clone, Serialize)]
pub struct FsChangedPayload {
    pub paths: Vec<String>,
}

/// 判断路径的任一段是否命中 [`SKIP_NAMES`]。跟 `fs_tree`/`read_children`
/// 共用同一份跳过名单，防止 `.git`/`node_modules`/`target` 内的事件风暴
/// 触发前端刷新（大 repo 下这些目录改动极频繁，CPU/IO 都扛不住）。
fn path_has_skipped_component(path: &Path) -> bool {
    path.components().any(|c| {
        let s = c.as_os_str().to_string_lossy();
        SKIP_NAMES.contains(&s.as_ref())
    })
}

/// 核心 watch 逻辑：不依赖 `AppHandle`，方便单测直接验证 debounce + 过滤行为。
/// `on_batch` 在每个 debounce 周期（收到至少一条未被过滤路径时）回调一次，
/// 参数是本批次去重后的绝对路径列表。
///
/// debounce 窗口 400ms：足够合并一次 `mv`（等价 remove+create 两个事件）、
/// 一次编辑器保存（可能触发多次 modify），又不会让用户感觉刷新延迟明显。
fn start_watcher<F>(watch_path: &Path, on_batch: F) -> Result<Debouncer<RecommendedWatcher, FileIdMap>, String>
where
    F: Fn(Vec<String>) + Send + 'static,
{
    let mut debouncer = new_debouncer(
        Duration::from_millis(400),
        None,
        move |result: DebounceEventResult| {
            let events = match result {
                Ok(events) => events,
                // watcher 内部错误（如监听目标被删除）：静默丢弃，不阻塞后续批次。
                Err(_) => return,
            };
            // HashSet 去重（保持首次出现顺序）：一次批次可能含大量路径（批量
            // rename / checkout / 生成产物），用 Vec::contains 去重是 O(n²)。
            let mut seen: HashSet<String> = HashSet::new();
            let mut paths: Vec<String> = Vec::new();
            for event in &events {
                for p in &event.paths {
                    if path_has_skipped_component(p) {
                        continue;
                    }
                    let s = p.to_string_lossy().into_owned();
                    if seen.insert(s.clone()) {
                        paths.push(s);
                    }
                }
            }
            if paths.is_empty() {
                return;
            }
            on_batch(paths);
        },
    )
    .map_err(|e| format!("创建 fs watcher 失败：{e}"))?;

    debouncer
        .watcher()
        .watch(watch_path, RecursiveMode::Recursive)
        .map_err(|e| format!("watch 失败：{}：{e}", watch_path.display()))?;

    Ok(debouncer)
}

/// 开始监听 `path`（递归）。已有活跃 watcher 时直接覆盖（旧的自动 drop 停止）。
///
/// - macOS 走 notify 的 `RecommendedWatcher`（FSEvents 后端），目录级递归开销低。
/// - debounce 批次后 `emit_to(main webview)`（**不能**裸 `emit`——本项目多 webview，
///   裸 emit 会广播不到 / 漏到 main，历史上 OSC7/通知都踩过这个坑，参见
///   `ipc::session` 里同款注释）。
#[tauri::command]
pub fn fs_watch_start(
    path: String,
    app: AppHandle,
    state: State<'_, FsWatcherState>,
) -> Result<(), String> {
    let watch_path = PathBuf::from(&path);
    if !watch_path.exists() {
        return Err(format!("路径不存在：{path}"));
    }

    let app_for_handler = app.clone();
    let debouncer = start_watcher(&watch_path, move |paths| {
        let payload = FsChangedPayload { paths };
        if let Err(e) = app_for_handler.emit_to(
            tauri::EventTarget::webview("main"),
            "fs:changed",
            &payload,
        ) {
            tracing::warn!("emit fs:changed 失败: {e}");
        }
    })?;

    let mut guard = state
        .0
        .lock()
        .map_err(|_| "fs watcher 状态锁中毒".to_string())?;
    *guard = Some(debouncer);
    Ok(())
}

/// 停止当前活跃 watcher（若有）。没有活跃 watcher 时 no-op（不报错）。
#[tauri::command]
pub fn fs_watch_stop(state: State<'_, FsWatcherState>) -> Result<(), String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "fs watcher 状态锁中毒".to_string())?;
    *guard = None;
    Ok(())
}

// ====== 单测：避开真实 PTY；只用 tempfile 假目录树 ======

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use tempfile::TempDir;

    /// 在临时目录里建一棵典型的项目目录结构供测试用：
    /// ```
    /// root/
    ///   .git/             ← 应被跳过
    ///   node_modules/foo  ← 应被跳过
    ///   src/
    ///     a.rs
    ///     b.rs
    ///   docs/
    ///     readme.md
    ///   .env              ← 隐藏但不在跳过名单 → 显示
    ///   Cargo.toml
    /// ```
    fn make_sample_tree() -> TempDir {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        fs::create_dir(root.join(".git")).unwrap();
        fs::write(root.join(".git/HEAD"), "ref: x").unwrap();

        fs::create_dir(root.join("node_modules")).unwrap();
        fs::create_dir(root.join("node_modules/foo")).unwrap();

        fs::create_dir(root.join("src")).unwrap();
        fs::write(root.join("src/a.rs"), "fn a() {}").unwrap();
        fs::write(root.join("src/b.rs"), "fn b() {}").unwrap();

        fs::create_dir(root.join("docs")).unwrap();
        fs::write(root.join("docs/readme.md"), "# hi").unwrap();

        fs::write(root.join(".env"), "KEY=val").unwrap();
        fs::write(root.join("Cargo.toml"), "[package]\n").unwrap();

        tmp
    }

    #[test]
    fn fs_tree_max_depth_0_顶层_dir_children_none() {
        let tmp = make_sample_tree();
        let node = fs_tree(tmp.path().to_string_lossy().into_owned(), 0).unwrap();
        assert_eq!(node.kind, "dir");
        assert!(node.children.is_none(), "max_depth=0 应 children=None 触发懒加载");
    }

    #[test]
    fn fs_tree_跳过名单生效() {
        let tmp = make_sample_tree();
        let node = fs_tree(tmp.path().to_string_lossy().into_owned(), 1).unwrap();
        let kids = node.children.as_ref().unwrap();
        let names: Vec<&str> = kids.iter().map(|n| n.name.as_str()).collect();
        assert!(!names.contains(&".git"), "应跳过 .git，实际：{names:?}");
        assert!(!names.contains(&"node_modules"), "应跳过 node_modules，实际：{names:?}");
        // 未在跳过名单的隐藏文件 .env 应显示
        assert!(names.contains(&".env"), "应显示 .env，实际：{names:?}");
    }

    #[test]
    fn fs_tree_dir_前_file_后_同类_name_asc() {
        let tmp = make_sample_tree();
        let node = fs_tree(tmp.path().to_string_lossy().into_owned(), 1).unwrap();
        let kids = node.children.as_ref().unwrap();
        // 期望顺序：docs(d) src(d) .env(f) Cargo.toml(f)
        // dir 全在 file 前；dir 内按 name asc：docs < src
        // file 内 name asc（ASCII，'.' < 'C'）：.env < Cargo.toml
        let names: Vec<&str> = kids.iter().map(|n| n.name.as_str()).collect();
        let kinds: Vec<&str> = kids.iter().map(|n| n.kind.as_str()).collect();
        assert_eq!(kinds, vec!["dir", "dir", "file", "file"], "实际 kinds：{kinds:?} names: {names:?}");
        assert_eq!(names, vec!["docs", "src", ".env", "Cargo.toml"]);
    }

    #[test]
    fn fs_tree_max_depth_2_递归到第二层() {
        let tmp = make_sample_tree();
        let node = fs_tree(tmp.path().to_string_lossy().into_owned(), 2).unwrap();
        let kids = node.children.as_ref().unwrap();
        // src 这个 dir 在第一层 → max_depth=2 时它的 children 应有 a.rs / b.rs
        let src = kids.iter().find(|n| n.name == "src").unwrap();
        let src_kids = src.children.as_ref().expect("src 在 depth 2 应已展开");
        let src_names: Vec<&str> = src_kids.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(src_names, vec!["a.rs", "b.rs"]);
    }

    #[test]
    fn fs_tree_不存在路径_err() {
        let res = fs_tree("/this/path/should/not/exist/aitm-test".to_string(), 1);
        assert!(res.is_err(), "不存在路径应 Err");
    }

    #[test]
    fn fs_tree_不是目录_err() {
        let tmp = TempDir::new().unwrap();
        let f = tmp.path().join("a.txt");
        fs::write(&f, "x").unwrap();
        let res = fs_tree(f.to_string_lossy().into_owned(), 1);
        assert!(res.is_err(), "传 file 应 Err");
    }

    #[test]
    fn fs_read_text_读普通文本() {
        let tmp = TempDir::new().unwrap();
        let f = tmp.path().join("hi.txt");
        fs::write(&f, "hello aitm").unwrap();
        let out = fs_read_text(f.to_string_lossy().into_owned(), 1024).unwrap();
        assert_eq!(out, "hello aitm");
    }

    #[test]
    fn fs_read_text_含_null_视为二进制() {
        let tmp = TempDir::new().unwrap();
        let f = tmp.path().join("bin.dat");
        fs::write(&f, [0x48, 0x00, 0x49]).unwrap();
        let res = fs_read_text(f.to_string_lossy().into_owned(), 1024);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("二进制"));
    }

    #[test]
    fn fs_read_text_超_max_bytes_截断() {
        let tmp = TempDir::new().unwrap();
        let f = tmp.path().join("long.txt");
        fs::write(&f, "0123456789ABCDEF").unwrap();
        let out = fs_read_text(f.to_string_lossy().into_owned(), 5).unwrap();
        assert_eq!(out, "01234");
    }

    #[test]
    fn fs_read_text_不存在_err() {
        let res = fs_read_text(
            "/this/path/should/not/exist/aitm-read.txt".to_string(),
            1024,
        );
        assert!(res.is_err());
    }

    #[test]
    fn fs_read_text_目录_err() {
        let tmp = TempDir::new().unwrap();
        let res = fs_read_text(tmp.path().to_string_lossy().into_owned(), 1024);
        assert!(res.is_err());
    }

    #[test]
    fn fs_read_text_latin1_lossy_不报错() {
        // 0xFF 在严格 UTF-8 校验里是非法首字节；from_utf8_lossy 用 U+FFFD 替换
        let tmp = TempDir::new().unwrap();
        let f = tmp.path().join("latin.txt");
        fs::write(&f, [b'a', 0xFF, b'b']).unwrap();
        let out = fs_read_text(f.to_string_lossy().into_owned(), 1024).unwrap();
        assert!(out.starts_with('a') && out.ends_with('b'));
    }

    #[test]
    fn fs_tree_canonicalize_path_为绝对路径() {
        let tmp = make_sample_tree();
        let node = fs_tree(tmp.path().to_string_lossy().into_owned(), 0).unwrap();
        let p = PathBuf::from(&node.path);
        assert!(p.is_absolute(), "应是绝对路径，实际：{}", node.path);
    }

    // ====== v0.5.0-C T1：fs_read_preview 单测 ======

    #[test]
    fn preview_md_返_markdown_kind() {
        let tmp = TempDir::new().unwrap();
        let f = tmp.path().join("readme.md");
        fs::write(&f, b"# hi\n").unwrap();
        let r = fs_read_preview(f.to_string_lossy().into_owned()).unwrap();
        match r {
            PreviewResult::Markdown { content, truncated } => {
                assert_eq!(content, "# hi\n");
                assert!(!truncated);
            }
            _ => panic!("应是 Markdown"),
        }
    }

    #[test]
    fn preview_rs_返_code_rust_kind() {
        let tmp = TempDir::new().unwrap();
        let f = tmp.path().join("main.rs");
        fs::write(&f, b"fn main() {}\n").unwrap();
        let r = fs_read_preview(f.to_string_lossy().into_owned()).unwrap();
        match r {
            PreviewResult::Code { language, .. } => assert_eq!(language, "rust"),
            _ => panic!("应是 Code"),
        }
    }

    #[test]
    fn preview_ts_tsx_python_都有_对应语言() {
        let tmp = TempDir::new().unwrap();
        for (name, lang) in &[
            ("a.ts", "typescript"),
            ("a.tsx", "typescript"),
            ("a.py", "python"),
            ("a.go", "go"),
            ("a.toml", "toml"),
            ("a.json", "json"),
            ("a.yaml", "yaml"),
        ] {
            let f = tmp.path().join(name);
            fs::write(&f, b"x").unwrap();
            let r = fs_read_preview(f.to_string_lossy().into_owned()).unwrap();
            match r {
                PreviewResult::Code { language, .. } => assert_eq!(&language, lang, "{name}"),
                _ => panic!("{name} 应是 Code"),
            }
        }
    }

    #[test]
    fn preview_txt_返_text_kind() {
        let tmp = TempDir::new().unwrap();
        let f = tmp.path().join("notes.txt");
        fs::write(&f, b"plain text").unwrap();
        let r = fs_read_preview(f.to_string_lossy().into_owned()).unwrap();
        assert!(matches!(r, PreviewResult::Text { .. }));
    }

    #[test]
    fn preview_无扩展名_是文本_返_text_kind() {
        let tmp = TempDir::new().unwrap();
        let f = tmp.path().join("LICENSE");
        fs::write(&f, b"MIT").unwrap();
        let r = fs_read_preview(f.to_string_lossy().into_owned()).unwrap();
        assert!(matches!(r, PreviewResult::Text { .. }));
    }

    #[test]
    fn preview_png_返_image_kind() {
        let tmp = TempDir::new().unwrap();
        let f = tmp.path().join("logo.png");
        // 假 PNG header bytes（不需要真合法 PNG，只验返 Image kind）
        fs::write(&f, [0x89, 0x50, 0x4E, 0x47, 0x00, 0x01]).unwrap();
        let r = fs_read_preview(f.to_string_lossy().into_owned()).unwrap();
        match r {
            PreviewResult::Image { mime, base64 } => {
                assert_eq!(mime, "image/png");
                assert!(!base64.is_empty());
            }
            _ => panic!("应是 Image"),
        }
    }

    #[test]
    fn preview_svg_返_image_svg_xml() {
        let tmp = TempDir::new().unwrap();
        let f = tmp.path().join("icon.svg");
        fs::write(&f, b"<svg></svg>").unwrap();
        let r = fs_read_preview(f.to_string_lossy().into_owned()).unwrap();
        match r {
            PreviewResult::Image { mime, .. } => assert_eq!(mime, "image/svg+xml"),
            _ => panic!("应是 Image"),
        }
    }

    #[test]
    fn preview_含_null_返_binary_kind() {
        let tmp = TempDir::new().unwrap();
        let f = tmp.path().join("data.bin");
        fs::write(&f, [b'a', 0u8, b'b']).unwrap();
        let r = fs_read_preview(f.to_string_lossy().into_owned()).unwrap();
        assert!(matches!(r, PreviewResult::Binary { .. }));
    }

    #[test]
    fn preview_超_1mb_文本_截断() {
        let tmp = TempDir::new().unwrap();
        let f = tmp.path().join("big.txt");
        let big = vec![b'a'; (TEXT_MAX_BYTES + 100) as usize];
        fs::write(&f, &big).unwrap();
        let r = fs_read_preview(f.to_string_lossy().into_owned()).unwrap();
        match r {
            PreviewResult::TooLarge { size, max_size } => {
                assert!(size > max_size);
                assert_eq!(max_size, TEXT_MAX_BYTES);
            }
            _ => panic!("应是 TooLarge"),
        }
    }

    #[test]
    fn preview_超_5mb_图片_too_large() {
        let tmp = TempDir::new().unwrap();
        let f = tmp.path().join("huge.png");
        let big = vec![0x89u8; (IMAGE_MAX_BYTES + 100) as usize];
        fs::write(&f, &big).unwrap();
        let r = fs_read_preview(f.to_string_lossy().into_owned()).unwrap();
        match r {
            PreviewResult::TooLarge { max_size, .. } => {
                assert_eq!(max_size, IMAGE_MAX_BYTES);
            }
            _ => panic!("应是 TooLarge"),
        }
    }

    #[test]
    fn preview_不存在_err() {
        let r = fs_read_preview("/this/path/should/not/exist/x.txt".to_string());
        assert!(r.is_err());
    }

    #[test]
    fn preview_目录_err() {
        let tmp = TempDir::new().unwrap();
        let r = fs_read_preview(tmp.path().to_string_lossy().into_owned());
        assert!(r.is_err());
    }

    /// v0.5.3 维护者 真机反馈：中文 markdown 被误判为 Binary。原因：嗅探只看前 4096
    /// 字节，多字节 UTF-8 汉字跨越 4096 边界被截断 → from_utf8 失败。修：嗅探整
    /// 文件。本 case 构造一个大于 4096 字节的中文文件，验证不被误判。
    #[test]
    fn preview_含中文_超4kb_markdown_不被误判_binary() {
        let tmp = TempDir::new().unwrap();
        let f = tmp.path().join("CLAUDE.md");
        // 构造 > 4096 bytes 的中文 markdown（每个汉字 3 byte UTF-8）
        let mut content = String::from("# 中文标题\n\n");
        while content.len() < 5000 {
            content.push_str("这是一段中文段落，aitm 项目本地 Claude 规则。\n");
        }
        std::fs::write(&f, &content).unwrap();
        assert!(content.len() > 4096);

        let r = fs_read_preview(f.to_string_lossy().into_owned()).unwrap();
        match r {
            PreviewResult::Markdown { content: c, .. } => {
                assert!(c.contains("中文标题"));
                assert!(c.contains("aitm 项目"));
            }
            other => panic!("应是 Markdown，实际 {other:?}"),
        }
    }

    #[test]
    fn preview_含中文_超4kb_text_不被误判_binary() {
        let tmp = TempDir::new().unwrap();
        let f = tmp.path().join("notes.txt");
        let mut content = String::new();
        while content.len() < 5000 {
            content.push_str("这是中文笔记 aitm 测试。\n");
        }
        std::fs::write(&f, &content).unwrap();
        assert!(content.len() > 4096);

        let r = fs_read_preview(f.to_string_lossy().into_owned()).unwrap();
        assert!(matches!(r, PreviewResult::Text { .. }));
    }

    // ====== v0.9.0 T5c：file_write 单测 ======

    #[tokio::test]
    async fn file_write_绝对路径_成功落盘() {
        let tmp = TempDir::new().unwrap();
        let f = tmp.path().join("a.txt");
        file_write(f.to_string_lossy().into_owned(), "hello aitm".to_string())
            .await
            .unwrap();
        let got = fs::read_to_string(&f).unwrap();
        assert_eq!(got, "hello aitm");
    }

    #[tokio::test]
    async fn file_write_相对路径_拒() {
        let r = file_write("relative/path.txt".to_string(), "x".to_string()).await;
        assert!(r.is_err(), "相对路径应 Err，实际：{r:?}");
        assert!(r.unwrap_err().contains("绝对路径"));
    }

    #[tokio::test]
    async fn file_write_unix_黑名单_拒() {
        // 这些路径在测试环境下可能根本不存在或没权限；判错点是 **黑名单**
        // 在 tokio::fs::write 之前先拦截，所以即使路径存在也不会真写入。
        for bad in &[
            "/etc/passwd",
            "/etc/aitm-test-file",
            "/System/foo",
            "/usr/bin/ls",
            "/usr/local/aitm-test",
            "/Library/System/aitm-test",
        ] {
            let r = file_write((*bad).to_string(), "x".to_string()).await;
            assert!(r.is_err(), "{bad} 应被黑名单拦截，实际：{r:?}");
            assert!(
                r.unwrap_err().contains("系统目录"),
                "{bad} 错误信息应提示系统目录"
            );
        }
    }

    #[tokio::test]
    async fn file_write_windows_黑名单_拒_大小写不敏感() {
        for bad in &[
            r"C:\Windows\System32\foo.dll",
            r"c:\windows\system32\foo.dll",
            r"C:\Program Files\aitm\evil.exe",
            r"C:\program files (x86)\aitm\evil.exe",
        ] {
            let r = file_write((*bad).to_string(), "x".to_string()).await;
            // Windows 风格路径在 Unix 上 `is_absolute()` 返 false → 会先被相对
            // 路径检查拦截。在 Windows 上会被黑名单拦截。两边都该返 Err。
            assert!(r.is_err(), "{bad} 应被拦截，实际：{r:?}");
        }
    }

    #[tokio::test]
    async fn file_write_utf8_中文_emoji_round_trip() {
        let tmp = TempDir::new().unwrap();
        let f = tmp.path().join("zh.md");
        let body = "# 中文标题\n\n这是一段中文 + emoji \u{1F600} \u{1F389}\n";
        file_write(f.to_string_lossy().into_owned(), body.to_string())
            .await
            .unwrap();
        let got = fs::read_to_string(&f).unwrap();
        assert_eq!(got, body);
    }

    #[tokio::test]
    async fn file_write_覆盖已存在文件() {
        let tmp = TempDir::new().unwrap();
        let f = tmp.path().join("orig.txt");
        fs::write(&f, "v1").unwrap();
        file_write(f.to_string_lossy().into_owned(), "v2-edited".to_string())
            .await
            .unwrap();
        let got = fs::read_to_string(&f).unwrap();
        assert_eq!(got, "v2-edited");
    }

    #[tokio::test]
    async fn file_write_父目录不存在_优雅返_err_不_panic() {
        let tmp = TempDir::new().unwrap();
        let f = tmp.path().join("no-such-dir").join("nested.txt");
        let r = file_write(f.to_string_lossy().into_owned(), "x".to_string()).await;
        assert!(r.is_err(), "父目录不存在应 Err（不 panic），实际：{r:?}");
        // 错误信息应含 "写文件失败" 前缀
        assert!(r.unwrap_err().contains("写文件失败"));
    }

    #[tokio::test]
    async fn file_write_空内容_截断为空() {
        let tmp = TempDir::new().unwrap();
        let f = tmp.path().join("empty.txt");
        fs::write(&f, "some content").unwrap();
        file_write(f.to_string_lossy().into_owned(), String::new())
            .await
            .unwrap();
        let got = fs::read_to_string(&f).unwrap();
        assert_eq!(got, "");
    }

    // ====== v0.9.1 HR3-3：fs_disk_usage / git_current_branch 单测 ======

    #[test]
    fn fs_disk_usage_tempdir_返合理值() {
        // 跑测试机器的 / 或 /tmp 必有挂载点；调用应成功且 total > 0
        let tmp = TempDir::new().unwrap();
        let r = fs_disk_usage(tmp.path().to_string_lossy().into_owned()).unwrap();
        assert!(r.total_bytes > 0, "total 应该 > 0，实际 {}", r.total_bytes);
        assert!(r.free_bytes <= r.total_bytes, "free 应 <= total");
        assert!(
            (0.0..=100.0).contains(&r.used_pct),
            "used_pct 应在 0..=100，实际 {}",
            r.used_pct
        );
    }

    #[test]
    fn fs_disk_usage_不存在路径_err() {
        let r = fs_disk_usage("/this/path/should/never/exist/aitm-disk".to_string());
        assert!(r.is_err());
    }

    #[test]
    fn git_current_branch_非_git_目录_返_none() {
        let tmp = TempDir::new().unwrap();
        let r = git_current_branch(tmp.path().to_string_lossy().into_owned()).unwrap();
        assert!(r.is_none(), "非 git repo 应返 None，实际 {r:?}");
    }

    #[test]
    fn git_current_branch_git_repo_返分支名() {
        use std::process::Command;
        let tmp = TempDir::new().unwrap();
        let p = tmp.path();
        // 初始化 git repo + 一次提交（默认分支 main）
        let init = Command::new("git")
            .args(["init", "-b", "main"])
            .current_dir(p)
            .output()
            .expect("git init failed");
        if !init.status.success() {
            // git 1.x 可能不支持 -b；回退用 master + 改名
            Command::new("git").args(["init"]).current_dir(p).output().unwrap();
            Command::new("git")
                .args(["checkout", "-b", "main"])
                .current_dir(p)
                .output()
                .ok();
        }
        std::fs::write(p.join("README"), "hi\n").unwrap();
        Command::new("git")
            .args(["add", "README"])
            .current_dir(p)
            .output()
            .unwrap();
        Command::new("git")
            .args(["commit", "-m", "init"])
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t.com")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t.com")
            .current_dir(p)
            .output()
            .unwrap();

        let r = git_current_branch(p.to_string_lossy().into_owned()).unwrap();
        assert_eq!(r.as_deref(), Some("main"), "应返 main，实际 {r:?}");
    }

    #[test]
    fn git_current_branch_仓库子目录_也找得到分支() {
        use std::process::Command;
        let tmp = TempDir::new().unwrap();
        let p = tmp.path();
        Command::new("git")
            .args(["init", "-b", "feat/x"])
            .current_dir(p)
            .output()
            .unwrap();
        std::fs::write(p.join("a"), "x").unwrap();
        Command::new("git").args(["add", "a"]).current_dir(p).output().unwrap();
        Command::new("git")
            .args(["commit", "-m", "x"])
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t.com")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t.com")
            .current_dir(p)
            .output()
            .unwrap();
        // 创建子目录并查询
        let sub = p.join("src/nested");
        std::fs::create_dir_all(&sub).unwrap();

        let r = git_current_branch(sub.to_string_lossy().into_owned()).unwrap();
        // 注意：git init -b 在低版本 git 上可能不识别，此时 HEAD 还在默认 master
        assert!(
            r.as_deref() == Some("feat/x") || r.as_deref() == Some("master"),
            "子目录应能 discover repo 并返某分支，实际 {r:?}"
        );
    }

    #[test]
    fn git_current_branch_路径不存在_err() {
        let r = git_current_branch("/this/path/should/never/exist/aitm-git".to_string());
        assert!(r.is_err());
    }

    #[test]
    fn is_blacklisted_path_单元_覆盖() {
        // 命中
        assert!(is_blacklisted_path(std::path::Path::new("/etc/passwd")));
        assert!(is_blacklisted_path(std::path::Path::new("/System/Library/CoreServices")));
        assert!(is_blacklisted_path(std::path::Path::new("/usr/local/bin/ls")));
        assert!(is_blacklisted_path(std::path::Path::new("/Library/System/x")));
        assert!(is_blacklisted_path(std::path::Path::new(r"C:\Windows\System32\foo.dll")));
        assert!(is_blacklisted_path(std::path::Path::new(r"c:\WINDOWS\System32\foo.dll")));
        assert!(is_blacklisted_path(std::path::Path::new(r"C:\Program Files\aitm.exe")));
        assert!(is_blacklisted_path(std::path::Path::new(
            r"C:\Program Files (x86)\aitm.exe"
        )));
        // 放行
        assert!(!is_blacklisted_path(std::path::Path::new("/Users/leo/code/aitm/a.txt")));
        assert!(!is_blacklisted_path(std::path::Path::new("/home/leo/a.txt")));
        assert!(!is_blacklisted_path(std::path::Path::new("/tmp/x.txt")));
        // `/Library/...` 不带 `System` 不在黑名单（用户 Library 比如 ~/Library 已经是 /Users/x/Library）
        assert!(!is_blacklisted_path(std::path::Path::new(
            "/Library/Application Support/aitm/x.toml"
        )));
        assert!(!is_blacklisted_path(std::path::Path::new(
            r"D:\Projects\aitm\a.rs"
        )));
    }

    // ====== v1.1.0 F5：fs watcher 单测 ======

    /// `path_has_skipped_component` 是纯函数，跟真实 watcher/debounce 无关——
    /// 确定性单测（不依赖计时器 / 文件系统事件时序）。
    #[test]
    fn path_has_skipped_component_命中跳过名单() {
        assert!(path_has_skipped_component(Path::new(
            "/repo/node_modules/foo/index.js"
        )));
        assert!(path_has_skipped_component(Path::new("/repo/.git/HEAD")));
        assert!(path_has_skipped_component(Path::new(
            "/repo/target/debug/build"
        )));
        assert!(path_has_skipped_component(Path::new(
            "/repo/a/b/dist/bundle.js"
        )));
    }

    #[test]
    fn path_has_skipped_component_正常路径不命中() {
        assert!(!path_has_skipped_component(Path::new(
            "/repo/src/main.rs"
        )));
        assert!(!path_has_skipped_component(Path::new("/repo/README.md")));
        // 隐藏文件但不在名单里（.env）不应被跳过
        assert!(!path_has_skipped_component(Path::new("/repo/.env")));
    }

    /// 真实 watcher 集成测试：TempDir 建目录 → 真建/删文件 → debounce 后
    /// 收到批次事件；`node_modules` 内的改动被过滤不触发回调。
    ///
    /// debounce 是异步的（内部起 std::thread），用 mpsc channel + `recv_timeout`
    /// 等待批次到达，避免 sleep 固定时长导致偶发 flaky。
    #[test]
    fn start_watcher_真建删文件_debounce后收到事件() {
        let tmp = TempDir::new().unwrap();
        // macOS `/tmp` 是指向 `/private/tmp` 的 symlink；FSEvents 上报的路径是
        // canonicalize 后的（`/private/var/...`），跟 `tmp.path()`（`/var/...`）
        // 字符串不等值。这里先 canonicalize 一次，让期望路径跟 watcher 实际收到
        // 的路径可以直接字符串比较。
        let root = fs::canonicalize(tmp.path()).unwrap();
        fs::create_dir(root.join("node_modules")).unwrap();

        let (tx, rx) = std::sync::mpsc::channel::<Vec<String>>();
        let _debouncer = start_watcher(&root, move |paths| {
            let _ = tx.send(paths);
        })
        .expect("start_watcher 应成功");

        // 给 watcher 后台线程一点启动时间再触发文件事件，避免真机上第一批
        // 事件在 watcher 完全就绪前发生而丢失（FSEvents 注册有微小延迟）。
        std::thread::sleep(Duration::from_millis(200));

        let target = root.join("a.txt");
        fs::write(&target, "hello").unwrap();
        // 顺手在 node_modules 里也写一个文件：应被过滤，不产生独立触发文件的批次
        fs::write(root.join("node_modules/noise.js"), "// noise").unwrap();

        // debounce 窗口 400ms，留够余量等待第一批事件（最多等 3s，避免真机偶发慢导致挂死）
        let batch = rx
            .recv_timeout(Duration::from_secs(3))
            .expect("应在 debounce 窗口后收到至少一批事件");

        let target_str = target.to_string_lossy().into_owned();
        assert!(
            batch.iter().any(|p| p == &target_str),
            "批次应包含新建的 a.txt，实际：{batch:?}"
        );
        assert!(
            !batch.iter().any(|p| p.contains("node_modules")),
            "node_modules 内的路径应被过滤，实际：{batch:?}"
        );
    }

    #[test]
    fn start_watcher_不存在的目录_watch_失败() {
        let (tx, _rx) = std::sync::mpsc::channel::<Vec<String>>();
        let res = start_watcher(
            Path::new("/this/path/should/never/exist/aitm-watch"),
            move |paths| {
                let _ = tx.send(paths);
            },
        );
        assert!(res.is_err(), "监听不存在路径应返回 Err");
    }
}
