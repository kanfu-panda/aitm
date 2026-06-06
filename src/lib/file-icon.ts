/**
 * v0.9.0 HR2-8：文件树彩色图标 mapping（material-icon-theme 风格）。
 *
 * 按文件名 / 扩展名 / 文件夹名查 lucide icon + Tailwind 颜色 class。
 * 命中顺序：FILE_NAME_MAP > FILE_EXT_MAP > DEFAULT_FILE。
 * 颜色用 Tailwind 4 直 utility（icon decoration 用，非 status semantic，
 * 不走 tokens.css —— icon 系统比项目主色系统覆盖面广）。
 *
 * 性能：lucide icon 个个 tree-shake，新增 ~13 个 icon 估算 +3-5 KB gzip。
 */

import type { LucideIcon } from "lucide-react";
import {
  Braces,
  Database,
  File,
  FileCode2,
  FileJson,
  FileText,
  FileType2,
  Folder,
  FolderArchive,
  FolderGit2,
  FolderOpen,
  GitBranch,
  Image,
  Lock,
  Package,
  Settings2,
  Terminal,
} from "../components/icons";

export interface IconSpec {
  Icon: LucideIcon;
  /** Tailwind 颜色 class（如 "text-sky-400"） */
  color: string;
}

/**
 * 按文件**完整名**（小写）精确匹配。优先级最高，覆盖通用扩展名规则。
 *
 * 收录原则：
 * - JS 生态常见配置（package.json / tsconfig.json / vite.config.* / eslint.config.*）
 * - Rust 生态常见（Cargo.toml / Cargo.lock / rust-toolchain.toml）
 * - Git / Docker / CI 常见（.gitignore / Dockerfile / docker-compose.yml）
 * - 文档惯例（README / CHANGELOG / LICENSE / CLAUDE.md）
 */
const FILE_NAME_MAP: Record<string, IconSpec> = {
  // JS 生态
  "package.json": { Icon: Package, color: "text-emerald-500" },
  "package-lock.json": { Icon: Lock, color: "text-zinc-500" },
  "pnpm-lock.yaml": { Icon: Lock, color: "text-amber-500" },
  "yarn.lock": { Icon: Lock, color: "text-sky-400" },
  "tsconfig.json": { Icon: Settings2, color: "text-sky-500" },
  "tsconfig.node.json": { Icon: Settings2, color: "text-sky-500" },
  "tsconfig.tsbuildinfo": { Icon: Settings2, color: "text-sky-700" },
  "tsconfig.node.tsbuildinfo": { Icon: Settings2, color: "text-sky-700" },
  "vite.config.ts": { Icon: Settings2, color: "text-purple-400" },
  "vite.config.js": { Icon: Settings2, color: "text-purple-400" },
  "vite.config.d.ts": { Icon: Settings2, color: "text-purple-300" },
  "vitest.config.ts": { Icon: Settings2, color: "text-emerald-400" },
  "playwright.config.ts": { Icon: Settings2, color: "text-emerald-500" },
  "eslint.config.js": { Icon: Settings2, color: "text-purple-500" },
  ".eslintrc.json": { Icon: Settings2, color: "text-purple-500" },
  ".prettierrc": { Icon: Settings2, color: "text-pink-400" },
  "tailwind.config.js": { Icon: Settings2, color: "text-cyan-400" },
  "tailwind.config.ts": { Icon: Settings2, color: "text-cyan-400" },
  // Rust 生态
  "cargo.toml": { Icon: Package, color: "text-orange-500" },
  "cargo.lock": { Icon: Lock, color: "text-orange-400" },
  "rust-toolchain.toml": { Icon: Settings2, color: "text-orange-500" },
  // Docker / CI
  dockerfile: { Icon: Package, color: "text-blue-400" },
  "docker-compose.yml": { Icon: Package, color: "text-blue-400" },
  "docker-compose.yaml": { Icon: Package, color: "text-blue-400" },
  ".dockerignore": { Icon: Package, color: "text-blue-300" },
  // Git
  ".gitignore": { Icon: GitBranch, color: "text-rose-400" },
  ".gitattributes": { Icon: GitBranch, color: "text-rose-400" },
  ".gitmodules": { Icon: GitBranch, color: "text-rose-400" },
  // 环境 / 工具
  ".env": { Icon: Settings2, color: "text-amber-300" },
  ".env.local": { Icon: Settings2, color: "text-amber-300" },
  ".env.example": { Icon: Settings2, color: "text-amber-400" },
  ".nvmrc": { Icon: Settings2, color: "text-emerald-500" },
  // 文档惯例（不分大小写，FALLBACK 时也会查 lower-cased name）
  "readme.md": { Icon: FileText, color: "text-sky-300" },
  "changelog.md": { Icon: FileText, color: "text-amber-400" },
  "claude.md": { Icon: FileText, color: "text-purple-300" },
  "license": { Icon: FileText, color: "text-zinc-400" },
  "license.md": { Icon: FileText, color: "text-zinc-400" },
};

/**
 * 按扩展名（小写，不含点）匹配。
 */
const FILE_EXT_MAP: Record<string, IconSpec> = {
  // TypeScript / JavaScript 家族
  ts: { Icon: FileCode2, color: "text-sky-400" },
  tsx: { Icon: FileCode2, color: "text-sky-400" },
  mts: { Icon: FileCode2, color: "text-sky-400" },
  cts: { Icon: FileCode2, color: "text-sky-400" },
  js: { Icon: FileCode2, color: "text-amber-400" },
  jsx: { Icon: FileCode2, color: "text-amber-400" },
  mjs: { Icon: FileCode2, color: "text-amber-400" },
  cjs: { Icon: FileCode2, color: "text-amber-400" },
  // 其他主流语言
  rs: { Icon: FileCode2, color: "text-orange-500" },
  py: { Icon: FileCode2, color: "text-yellow-400" },
  pyi: { Icon: FileCode2, color: "text-yellow-300" },
  go: { Icon: FileCode2, color: "text-cyan-400" },
  java: { Icon: FileCode2, color: "text-rose-400" },
  kt: { Icon: FileCode2, color: "text-purple-500" },
  swift: { Icon: FileCode2, color: "text-orange-400" },
  c: { Icon: FileCode2, color: "text-sky-500" },
  h: { Icon: FileCode2, color: "text-sky-500" },
  cpp: { Icon: FileCode2, color: "text-sky-500" },
  hpp: { Icon: FileCode2, color: "text-sky-500" },
  rb: { Icon: FileCode2, color: "text-rose-500" },
  php: { Icon: FileCode2, color: "text-indigo-400" },
  lua: { Icon: FileCode2, color: "text-blue-500" },
  // Web 前端
  html: { Icon: FileCode2, color: "text-orange-500" },
  htm: { Icon: FileCode2, color: "text-orange-500" },
  css: { Icon: FileCode2, color: "text-sky-400" },
  scss: { Icon: FileCode2, color: "text-pink-400" },
  sass: { Icon: FileCode2, color: "text-pink-400" },
  less: { Icon: FileCode2, color: "text-blue-400" },
  vue: { Icon: FileCode2, color: "text-emerald-400" },
  svelte: { Icon: FileCode2, color: "text-orange-500" },
  // 数据 / 配置
  json: { Icon: FileJson, color: "text-amber-400" },
  jsonc: { Icon: FileJson, color: "text-amber-400" },
  json5: { Icon: FileJson, color: "text-amber-400" },
  yml: { Icon: FileText, color: "text-rose-400" },
  yaml: { Icon: FileText, color: "text-rose-400" },
  toml: { Icon: FileText, color: "text-orange-400" },
  xml: { Icon: Braces, color: "text-orange-400" },
  ini: { Icon: Settings2, color: "text-zinc-400" },
  conf: { Icon: Settings2, color: "text-zinc-400" },
  env: { Icon: Settings2, color: "text-amber-300" },
  // 文档
  md: { Icon: FileText, color: "text-sky-300" },
  markdown: { Icon: FileText, color: "text-sky-300" },
  mdx: { Icon: FileText, color: "text-sky-300" },
  txt: { Icon: FileText, color: "text-zinc-400" },
  rst: { Icon: FileText, color: "text-zinc-300" },
  log: { Icon: FileText, color: "text-zinc-500" },
  // Shell
  sh: { Icon: Terminal, color: "text-emerald-400" },
  bash: { Icon: Terminal, color: "text-emerald-400" },
  zsh: { Icon: Terminal, color: "text-emerald-400" },
  fish: { Icon: Terminal, color: "text-emerald-400" },
  ps1: { Icon: Terminal, color: "text-sky-400" },
  bat: { Icon: Terminal, color: "text-zinc-400" },
  cmd: { Icon: Terminal, color: "text-zinc-400" },
  // 图片
  png: { Icon: Image, color: "text-emerald-400" },
  jpg: { Icon: Image, color: "text-emerald-400" },
  jpeg: { Icon: Image, color: "text-emerald-400" },
  gif: { Icon: Image, color: "text-pink-400" },
  svg: { Icon: Image, color: "text-amber-400" },
  webp: { Icon: Image, color: "text-emerald-400" },
  ico: { Icon: Image, color: "text-sky-400" },
  icns: { Icon: Image, color: "text-sky-400" },
  bmp: { Icon: Image, color: "text-emerald-300" },
  // 二进制 / 文档
  pdf: { Icon: FileText, color: "text-rose-400" },
  // 字体
  ttf: { Icon: FileType2, color: "text-purple-400" },
  otf: { Icon: FileType2, color: "text-purple-400" },
  woff: { Icon: FileType2, color: "text-purple-400" },
  woff2: { Icon: FileType2, color: "text-purple-400" },
  eot: { Icon: FileType2, color: "text-purple-400" },
  // 压缩
  zip: { Icon: Package, color: "text-amber-500" },
  tar: { Icon: Package, color: "text-amber-500" },
  gz: { Icon: Package, color: "text-amber-500" },
  "7z": { Icon: Package, color: "text-amber-500" },
  rar: { Icon: Package, color: "text-amber-500" },
  // 数据库
  db: { Icon: Database, color: "text-blue-400" },
  sqlite: { Icon: Database, color: "text-blue-400" },
  sqlite3: { Icon: Database, color: "text-blue-400" },
  sql: { Icon: Database, color: "text-blue-400" },
  // 包 / 模块
  lock: { Icon: Lock, color: "text-zinc-500" },
  dmg: { Icon: Package, color: "text-zinc-400" },
  msi: { Icon: Package, color: "text-zinc-400" },
  exe: { Icon: Package, color: "text-zinc-400" },
  app: { Icon: Package, color: "text-zinc-400" },
  deb: { Icon: Package, color: "text-orange-400" },
  rpm: { Icon: Package, color: "text-orange-400" },
};

/**
 * 按文件夹**完整名**（小写）匹配，命中时**忽略 open/closed**（用同一图标 + 颜色
 * 提供更稳定的视觉锚点）。未命中走默认 Folder/FolderOpen + sky-400 / sky-300。
 */
const FOLDER_NAME_MAP: Record<string, IconSpec> = {
  src: { Icon: Folder, color: "text-sky-400" },
  "src-tauri": { Icon: Folder, color: "text-orange-500" },
  tests: { Icon: Folder, color: "text-emerald-400" },
  test: { Icon: Folder, color: "text-emerald-400" },
  __tests__: { Icon: Folder, color: "text-emerald-400" },
  e2e: { Icon: Folder, color: "text-emerald-500" },
  docs: { Icon: Folder, color: "text-blue-400" },
  doc: { Icon: Folder, color: "text-blue-400" },
  scripts: { Icon: Folder, color: "text-amber-400" },
  bin: { Icon: Folder, color: "text-amber-500" },
  components: { Icon: Folder, color: "text-cyan-400" },
  stores: { Icon: Folder, color: "text-purple-400" },
  hooks: { Icon: Folder, color: "text-rose-400" },
  lib: { Icon: Folder, color: "text-sky-500" },
  utils: { Icon: Folder, color: "text-sky-500" },
  styles: { Icon: Folder, color: "text-pink-400" },
  assets: { Icon: Folder, color: "text-pink-400" },
  images: { Icon: Folder, color: "text-pink-400" },
  img: { Icon: Folder, color: "text-pink-400" },
  fonts: { Icon: Folder, color: "text-purple-400" },
  public: { Icon: Folder, color: "text-cyan-500" },
  // 归档类（暗色 + Archive 图标）
  node_modules: { Icon: FolderArchive, color: "text-zinc-500" },
  dist: { Icon: FolderArchive, color: "text-zinc-500" },
  build: { Icon: FolderArchive, color: "text-zinc-500" },
  target: { Icon: FolderArchive, color: "text-zinc-500" },
  out: { Icon: FolderArchive, color: "text-zinc-500" },
  releases: { Icon: FolderArchive, color: "text-amber-500" },
  // Git / CI
  ".git": { Icon: FolderGit2, color: "text-rose-400" },
  ".github": { Icon: FolderGit2, color: "text-zinc-400" },
  ".gitlab": { Icon: FolderGit2, color: "text-orange-400" },
  ".worktrees": { Icon: FolderGit2, color: "text-purple-400" },
  // 项目特定（aitm 自身）
  ".aitm": { Icon: Folder, color: "text-emerald-400" },
  ".claude": { Icon: Folder, color: "text-purple-400" },
  ".vscode": { Icon: Folder, color: "text-sky-500" },
  ".idea": { Icon: Folder, color: "text-pink-400" },
  ".cargo": { Icon: Folder, color: "text-orange-500" },
};

const DEFAULT_FILE: IconSpec = { Icon: File, color: "text-zinc-400" };
const DEFAULT_FOLDER: IconSpec = { Icon: Folder, color: "text-sky-400" };
const DEFAULT_FOLDER_OPEN: IconSpec = { Icon: FolderOpen, color: "text-sky-300" };

/**
 * 给文件名返回图标 + 颜色。优先完整名匹配，否则按扩展名查；都没命中走默认 File 灰。
 */
export function getFileIcon(name: string): IconSpec {
  const lower = name.toLowerCase();
  if (FILE_NAME_MAP[lower]) return FILE_NAME_MAP[lower];
  const lastDot = lower.lastIndexOf(".");
  if (lastDot >= 0 && lastDot < lower.length - 1) {
    const ext = lower.slice(lastDot + 1);
    if (FILE_EXT_MAP[ext]) return FILE_EXT_MAP[ext];
  }
  return DEFAULT_FILE;
}

/**
 * 给文件夹名返回图标 + 颜色。命中 FOLDER_NAME_MAP 时不区分 open/closed；
 * 未命中走默认 Folder（关）/ FolderOpen（开）+ sky 蓝。
 */
export function getFolderIcon(name: string, open: boolean): IconSpec {
  const lower = name.toLowerCase();
  if (FOLDER_NAME_MAP[lower]) return FOLDER_NAME_MAP[lower];
  return open ? DEFAULT_FOLDER_OPEN : DEFAULT_FOLDER;
}
