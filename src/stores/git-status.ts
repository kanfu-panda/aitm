import { create } from "zustand";

import { gitStatus, type GitFileStatus, type GitStatus } from "../lib/tauri";

/**
 * Git 状态 store（v0.9.1 HR3-6）。
 *
 * 单一职责：缓存当前 active cwd 下的 git 脏文件 → 状态映射，供 FileTree
 * FileTreeRow 染色读取。
 *
 * 数据形态：`byPath: Record<absolutePath, GitStatus>`。FileTree 用 `node.path`
 * 直接查；目录染色（"子文件改过"圆点）也由前端聚合 byPath 实现，store 不参与。
 *
 * 刷新策略（在 FileTree 组件里 setInterval 5s 一次调 `refresh(cwd)`）：
 * - cwd 变化时立刻 refresh 一次（让 UI 不出现"旧 cwd 文件状态残留 5s"）。
 * - refresh 抛错（极端 cwd 失效）→ 静默清空 byPath；不弹任何 UI（5s 刷一次，
 *   弹 dialog 会刷屏）。
 *
 * 设计取舍：
 * - **不**用 zustand 的 immer middleware：byPath 整对象替换，比 immer mutate
 *   单次 commit 更便宜（每次 refresh 都全量 rebuild）。
 * - **不**在 store 里 setInterval：测试时 fake timer 会卡 store 单测；轮询挂
 *   在 FileTree useEffect（组件卸载自动清）。
 * - **不**按 cwd 分桶 cache：用户只看 active cwd，旧 cwd 的状态没意义，refresh
 *   直接整体替换。
 */
interface GitStatusState {
  /** 绝对路径 → 状态。FileTreeRow 用 `useGitStatusStore(s => s.byPath[node.path])` */
  byPath: Record<string, GitStatus>;

  /** 全量替换 byPath（不做 diff，省得 React 选择器拍坏）。 */
  setEntries: (entries: GitFileStatus[]) => void;

  /** 清空（cwd=null / IPC 失败 / 切到非 git 目录都走这里）。 */
  clear: () => void;

  /** 调 git_status IPC + setEntries；失败时静默 clear。 */
  refresh: (cwd: string | null) => Promise<void>;
}

export const useGitStatusStore = create<GitStatusState>((set) => ({
  byPath: {},

  setEntries: (entries) => {
    const next: Record<string, GitStatus> = {};
    for (const e of entries) {
      next[e.path] = e.status;
    }
    set({ byPath: next });
  },

  clear: () => set({ byPath: {} }),

  refresh: async (cwd) => {
    if (!cwd) {
      set({ byPath: {} });
      return;
    }
    try {
      const entries = await gitStatus(cwd);
      const next: Record<string, GitStatus> = {};
      for (const e of entries) {
        next[e.path] = e.status;
      }
      set({ byPath: next });
    } catch (e) {
      // fail-soft：5s 一次的轮询，弹窗会刷屏。打 warn 让开发者看见。
      console.warn("git_status 失败（fail-soft）", cwd, e);
      set({ byPath: {} });
    }
  },
}));

/**
 * HR4-7：path 一致化（lookup 兜底）。
 *
 * 后端 `git_status` 已对 workdir 调 `std::fs::canonicalize`，返出物理路径；
 * 前端 FileTree 的 `node.path` 来自 `fs_tree`，其 root 也 canonicalize 过 →
 * 二者已对齐。但仍可能有边界情况让等值匹配失败，这里再做一层防御性 normalize：
 *
 * - 去尾 `/`（dir path 末尾带 slash 时统一去掉，filter prefix 时另算）
 * - Windows 反斜杠 → 正斜杠（前端 store 永远用 POSIX 形式）
 * - 双斜杠塌缩（极少；保险）
 *
 * 不做大小写归一化：macOS HFS+/APFS 默认大小写不敏感但保留，git 对大小写敏感；
 * 强行 `toLowerCase` 反而引入"不同 case 错误合并"的新 bug。
 */
function normalizePath(p: string): string {
  // 反斜杠 → 正斜杠（兼容性兜底，前端 path 应永远是 POSIX 形式）
  let out = p.replace(/\\/g, "/");
  // 双斜杠塌缩：`/a//b` → `/a/b`（不会动到 URL scheme `//`，路径里不应有）
  out = out.replace(/\/{2,}/g, "/");
  // 去尾 `/`（保留 root `/`）
  if (out.length > 1 && out.endsWith("/")) {
    out = out.slice(0, -1);
  }
  return out;
}

/**
 * HR4-7：容错版 file 状态查询。
 *
 * 直接 `byPath[node.path]` 在 99% 情况能命中（后端已 canonicalize）；
 * 这里再加一道 normalize 后查询，cover 末尾斜杠 / 反斜杠混入 / 双斜杠等
 * 不应该出现但万一出现的边界 case。命中 → 返 GitStatus；否则 undefined。
 *
 * 设计取舍：byPath 表 N 通常 < 50；命中率高时 fast path（直接 indexing）
 * O(1)；fast miss 才进 O(N) 遍历 normalize 比对，整体开销可控。
 */
export function getFileStatus(
  filePath: string,
  byPath: Record<string, GitStatus>,
): GitStatus | undefined {
  // fast path：直接等值（绝大多数情况）
  const direct = byPath[filePath];
  if (direct !== undefined) return direct;

  // slow path：normalize 比对（容错）
  const target = normalizePath(filePath);
  for (const key of Object.keys(byPath)) {
    if (normalizePath(key) === target) return byPath[key];
  }
  return undefined;
}

/**
 * 文件名颜色 className（VS Code 风格 + 项目 zinc 调子）。
 *
 * 调色板（plan §HR3-6）：
 * - modified → amber-400（脏 / 待提交）
 * - added → emerald-400（已 stage 新）
 * - deleted → rose-400 line-through（删了，但还在 tree 里展示）
 * - untracked → zinc-500 italic（新文件未跟踪 → 灰一档）
 * - renamed → sky-400（重命名）
 * - conflict → orange-500 font-bold（冲突最显眼）
 *
 * 未命中（干净文件）返 null，调用方继续用默认 className（不染色）。
 *
 * v0.9.1 HR4-8：所有状态加 `font-bold` 提高对比 —— 单色易跟 file-icon
 * 扩展名色（.env.example 本身就是 amber）撞车，加粗让 git 修改一目了然。
 */
export function gitStatusFileClass(status: GitStatus | undefined): string | null {
  switch (status) {
    case "modified":
      return "text-amber-400 font-semibold";
    case "added":
      return "text-emerald-400 font-semibold";
    case "deleted":
      return "text-rose-400 line-through";
    case "untracked":
      // v0.10.2 #11：从 zinc-500 italic（不显眼）改成 emerald-500 italic（VS Code 风格）。
      // 跟 added（staged）同色但保留 italic 区分两者：italic = 未 stage，正体 = 已 stage。
      // 维护者 反馈"想能识别哪些没被 git 跟踪"，绿色比灰色更易扫到。
      return "text-emerald-500 italic";
    case "ignored":
      // v0.10.2 维护者 反馈：被 .gitignore 命中的文件用最弱的灰 + italic，
      // 仍可见但视觉权重最低（VS Code 风格）。透明度叠加让它"在背景里"。
      return "text-[var(--c-text-faint)] italic opacity-60";
    case "renamed":
      return "text-sky-400 font-semibold";
    case "conflict":
      return "text-orange-500 font-bold";
    default:
      return null;
  }
}

/**
 * 给定 git 状态返回末尾字母标记（M/A/D/U/R/!），仿 VS Code source control 视觉
 * 提示。让用户在 file-icon 颜色撞色时仍能一眼看出修改类型。
 *
 * 未命中（干净文件）返 null。
 */
export function gitStatusBadge(status: GitStatus | undefined): {
  letter: string;
  colorClass: string;
} | null {
  switch (status) {
    case "modified":
      return { letter: "M", colorClass: "text-amber-400" };
    case "added":
      return { letter: "A", colorClass: "text-emerald-400" };
    case "deleted":
      return { letter: "D", colorClass: "text-rose-400" };
    case "untracked":
      return { letter: "U", colorClass: "text-emerald-500" };
    case "ignored":
      return { letter: "I", colorClass: "text-[var(--c-text-faint)]" };
    case "renamed":
      return { letter: "R", colorClass: "text-sky-400" };
    case "conflict":
      return { letter: "!", colorClass: "text-orange-500" };
    default:
      return null;
  }
}

/**
 * 给定目录绝对路径 `dirPath` + 当前完整 byPath 表，判该目录下是否有任意脏文件
 * （用于在文件夹名右侧显示一个 amber 小圆点提示"内含变化"）。
 *
 * 实现：扫 byPath 的 key，看是否有以 `dirPath + sep` 开头的条目。
 * 大 repo 下 byPath 可能上千条，但本函数只在 FileTreeRow render 时调一次 dir，
 * O(N) 可接受（aitm 自身典型 < 50 条 dirty）。
 */
export function dirHasDirty(
  dirPath: string,
  byPath: Record<string, GitStatus>,
): boolean {
  // HR4-7：dir / key 都先 normalize，避免反斜杠 / 双斜杠 / trailing slash
  // 不一致让 prefix 比对 miss。
  const normDir = normalizePath(dirPath);
  const prefix = normDir + "/";
  for (const key of Object.keys(byPath)) {
    if (!normalizePath(key).startsWith(prefix)) continue;
    // v0.10.2：ignored 不算"脏" —— 父目录圆点只为有意义的修改保留
    if (byPath[key] === "ignored") continue;
    return true;
  }
  return false;
}

/**
 * v0.10.2：判一个目录本身是否被 .gitignore 命中（如 `node_modules/` / `target/`）。
 * 用于给目录名也染上 ignored 弱灰样式，跟里面的文件视觉一致。
 */
export function dirIsIgnored(
  dirPath: string,
  byPath: Record<string, GitStatus>,
): boolean {
  const normDir = normalizePath(dirPath);
  // git status include_ignored + recurse_ignored_dirs=false：被 ignore 的整个
  // dir 用其自身路径 key 上报（不带尾 sep）。直接等值查。
  for (const key of Object.keys(byPath)) {
    if (byPath[key] !== "ignored") continue;
    if (normalizePath(key) === normDir) return true;
  }
  return false;
}
