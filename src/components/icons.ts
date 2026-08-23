/**
 * v0.4.1: lucide-react 图标集中导出
 *
 * 规则：
 * - 所有 UI 图标必须从这里 import，不直接 import 'lucide-react'
 *   （这样可一处看清楚 app 用了哪些 icon、未来换库也只改一处）
 * - 命名跟 lucide 原名一致（不重命名）以利于查文档
 * - 新增图标在此 export 后再用，便于 tree-shake 检查
 *
 * 尺寸三档（plan §3.2，禁止 token 之外尺寸）：
 *   <Icon size={12} /> icon-xs  内联状态
 *   <Icon size={16} /> icon-sm  UI 默认
 *   <Icon size={20} /> icon-md  Activity Bar / toolbar
 *
 * 颜色继承 currentColor，配合 text-* utility，禁止硬编码 color={}
 */
export {
  Globe,
  Settings,
  Sparkles,
  Folder,
  FolderOpen,
  File,
  Pin,
  Pause,
  ChevronDown,
  ChevronRight,
  Plus,
  X, // 关闭按钮
  RotateCw, // 刷新
  ArrowLeft, // 后退
  ArrowRight, // 前进
  PanelRight, // 浏览器面板（备选给 ActivityBar）
  GitBranch, // v0.5.0-B Tab metadata：分支
  Activity, // v0.5.0-B Tab metadata：监听端口
  // v0.9.0 HR2-8：文件树彩色图标体系（material-icon-theme 风格）
  FileCode2, // 代码文件（ts/js/rs/py/html/css/vue...）
  FileText, // 文本类（md/txt/yml/toml/log）
  FileJson, // json 文件
  FileType2, // 字体文件（ttf/woff/woff2）
  Braces, // 代码括号风格（备用）
  Image, // 图片（png/jpg/svg/gif）
  Terminal, // shell 脚本（sh/bash/zsh/ps1）
  Lock, // lock 文件（package-lock / pnpm-lock / Cargo.lock）
  Settings2, // 配置文件（tsconfig / vite.config / .env / dockerfile）
  Package, // 包管理（package.json / Cargo.toml / Dockerfile）
  Database, // 数据库（db / sqlite）
  FolderGit2, // .git / .github / .worktrees
  FolderArchive, // node_modules / dist / build / releases
  // v0.9.1 HR3-3：StatusBar 重排
  Copy, // 文件路径复制按钮
  Wifi, // 网络在线
  WifiOff, // 网络离线
  HardDrive, // 磁盘使用率
  // v0.10.0 HR6-2：工具调用气泡 VS Code 风格折叠
  Wrench, // 默认工具图标
  History, // terminal_history / *_history
  Loader2, // running 自旋
  Check, // done 成功
  AlertCircle, // error 错误
  AlertTriangle, // awaiting_approval 等待确认
  // v0.10.3 HR9-2：tab 通知小喇叭图标（macOS Terminal 风格）
  Bell,
  // v1.2.0 A1/A2：AI 停止生成 / 重试按钮
  Square, // 停止生成（实心方块，terminal/播放器通用语义）
  RotateCcw, // 重试 / regenerate
  // 浏览器"请求移动版 / 桌面版站点"切换
  Smartphone,
  Monitor,
} from "lucide-react";
