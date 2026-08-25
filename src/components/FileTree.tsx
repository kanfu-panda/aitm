import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { useTranslation } from "react-i18next";
import {
  fsCreateDir,
  fsCreateFile,
  fsDelete,
  fsRename,
  fsTree,
  fsWatchStart,
  fsWatchStop,
  onFsChanged,
  sessionCurrentCwd,
  shellReveal,
  type TreeNode,
} from "../lib/tauri";
import { useTabsStore } from "../stores/tabs";
import { useFileEditorStore } from "../stores/file-editor";
import { usePaneLayoutStore } from "../stores/pane-layout";
import { useSidebarStore } from "../stores/sidebar";
import {
  dirHasDirty,
  dirIsIgnored,
  getFileStatus,
  gitStatusBadge,
  gitStatusFileClass,
  useGitStatusStore,
} from "../stores/git-status";
import { ChevronDown, ChevronRight, RotateCw } from "./icons";
import { getFileIcon, getFolderIcon } from "../lib/file-icon";
import InputDialog from "./InputDialog";
import FsDeleteConfirmDialog from "./FsDeleteConfirmDialog";

/** v0.9.1 HR3-6：git status 轮询间隔（ms）。
 *  5s 在大 repo 下也 < 50ms 单次开销可接受；调高会让用户感觉"刚改的文件半天没变色"。 */
const GIT_STATUS_POLL_MS = 5_000;

/** v1.3.0 P9：前端合并 `fs:changed` 批次的窗口（ms）。
 *  后端已按 400ms debounce 分批，这里再兜一层：一次 `git checkout` / `pnpm build`
 *  可能连着推来好几批，合并后只跑一轮增量刷新。 */
const FS_CHANGED_MERGE_MS = 150;

/** 推断路径分隔符：只有"含 `\` 且不含 `/`"才当 Windows 路径。 */
function sepOf(path: string): string {
  return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

/** 取父目录绝对路径；已经是根（没有分隔符或分隔符在 0 位）时返回自身。 */
function parentOf(path: string): string {
  const sep = sepOf(path);
  const idx = path.lastIndexOf(sep);
  return idx > 0 ? path.slice(0, idx) : path;
}

/** `child` 是否落在 `ancestor` 目录之下（严格子孙，不含自身）。 */
function isUnder(child: string, ancestor: string): boolean {
  return child.startsWith(ancestor + sepOf(ancestor));
}

/**
 * 左侧文件树面板（Phase 3A T2）。
 *
 * - 固定宽 260px；可折叠（store.fileTreeOpen 控）
 * - 渲染当前 active tab cwd 的目录树（lazy：root 调 fs_tree depth=1；
 *   用户点 dir 展开时再调 fs_tree(child.path, 1)）
 * - 点 .md / .markdown 文件 → setPreviewPath（T3 MarkdownPreviewDialog 订阅）
 *
 * 设计决议（plan §1.1 G1 G2 G3）：
 * - lazy 遍历不一次扫整树，避免 node_modules 卡死
 * - skip 名单 .git/node_modules/target/dist/... 在后端硬编码（前端不重复 filter）
 * - 固定 260px 宽度（v0.3.x 加 resize handle）
 *
 * 错误处理：fs_tree 失败（路径不存在 / 权限不足）→ 显示一行错误占位文字，
 * 不弹 dialog（避免每次切 tab 都打断用户）。
 */

/**
 * "在文件管理器中显示"的 i18n key —— 按平台给用户熟悉的叫法。
 *
 * macOS 用户认"访达"、Windows 用户认"资源管理器"，统一说"文件管理器"两边都别扭。
 * 判定走 webview 的 userAgent，不额外引 @tauri-apps/plugin-os（军规 §12）。
 */
function revealLabelKey(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (ua.includes("Macintosh") || ua.includes("Mac OS X")) {
    return "fileTree.menu.revealMac";
  }
  if (ua.includes("Windows")) {
    return "fileTree.menu.revealWindows";
  }
  return "fileTree.menu.revealGeneric";
}

export default function FileTree() {
  const { t } = useTranslation();
  // v0.10.0 HR8-1：跟随**active 分屏 group** 的 active terminal tab 的 cwd，
  // 而非全局 useTabsStore.activeId（分屏后全局 activeId 可能不跟当前焦点 group 一致）。
  // 路径：active_group_id → 找该 group（type=terminal） → 拿 group.active_tab_id（这是 tab id）
  //  → 再查 useTabsStore.tabs[id].sessionId（实际 PTY session id）
  const activeTabIdFromLayout = usePaneLayoutStore((s) => {
    const root = s.root;
    const activeGroupId = s.active_group_id;
    if (!activeGroupId) return null;
    const find = (
      n: typeof root,
    ): null | { type: string; active_tab_id: string | null } => {
      if (n.kind === "leaf") {
        return n.group.id === activeGroupId ? n.group : null;
      }
      return find(n.left) ?? find(n.right);
    };
    const grp = find(root);
    if (!grp || grp.type !== "terminal") return null;
    return grp.active_tab_id;
  });
  // fallback 到全局 activeId（兼容初始 mount / 没分屏单 group 场景）
  const globalActiveTabId = useTabsStore((s) => s.activeId);
  const activeTabId = activeTabIdFromLayout ?? globalActiveTabId;
  const activeSessionId = useTabsStore((s) =>
    activeTabId
      ? (s.tabs.find((t) => t.id === activeTabId)?.sessionId ?? null)
      : null,
  );
  const [rootCwd, setRootCwd] = useState<string | null>(null);
  const [rootNode, setRootNode] = useState<TreeNode | null>(null);
  const [error, setError] = useState<string | null>(null);

  // === v1.3.0 P9：树状态上提到 FileTree（原来散在每个 FileTreeRow 的 local state）===
  //
  // 上提的原因：fs watcher 一触发就要能**按路径**定位到受影响的那个目录、只换它的
  // 子项；状态留在 row 里就只能靠 remount 整棵树来刷新（v1.1.0 的做法），代价是
  // 所有展开态全丢 —— 真机上表现为"浏览着目录突然全折回去，没法用"。
  //
  // - expandedPaths：已展开的目录绝对路径集合。**唯一**的展开态来源。
  // - childrenByPath：目录 → 已加载的直接子项。key 用后端 canonicalize 过的绝对
  //   路径（跟 watcher 上报的路径同形，才能直接命中）。根目录也在里面。
  // - loadErrorByPath：单个目录懒加载失败的消息（只影响那一行，不影响整棵树）。
  //
  // 折叠时**保留** children 缓存：这样再展开是瞬时的，且嵌套展开态不丢
  // （对齐 VS Code：折叠父目录再展开，里面原来展开的子目录还是展开的）。
  const [childrenByPath, setChildrenByPath] = useState<
    Record<string, TreeNode[]>
  >({});
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [loadErrorByPath, setLoadErrorByPath] = useState<
    Record<string, string>
  >({});

  // watcher 回调 / 定时器里要读最新状态，但它们不在 render 闭包里 —— 用 ref 镜像。
  const childrenRef = useRef<Record<string, TreeNode[]>>({});
  useEffect(() => {
    childrenRef.current = childrenByPath;
  }, [childrenByPath]);
  const rootNodeRef = useRef<TreeNode | null>(null);
  useEffect(() => {
    rootNodeRef.current = rootNode;
  }, [rootNode]);
  /** 当前根 cwd 的同步镜像：loadFromCwd 要在同一 tick 判断"是不是换目录了"，
   *  不能等 state 提交（否则同一次 effect 里连着两次调用会误判成没换）。 */
  const rootCwdRef = useRef<string | null>(null);

  /**
   * 增量刷新：只重拉 `dirs` 里**当前已加载**的目录，其余节点原样不动。
   *
   * 一次刷新做三件事：
   * 1. 并行 `fs_tree(dir, 1)` 拿各目录最新直接子项
   * 2. 命中的目录换掉子项数组（其它 key 的数组引用不变 → React 按 key 复用 DOM，
   *    无关分支不重建）
   * 3. 剪枝：目录本身读不到了，或它在父目录的新子项里消失了（删除 / 重命名），
   *    把它和它的所有子孙从 children 缓存 + 展开态里一起清掉
   */
  const refreshDirs = useCallback(async (dirs: string[]) => {
    const loaded = childrenRef.current;
    const rootPath = rootNodeRef.current?.path ?? null;
    const targets = Array.from(new Set(dirs)).filter(
      (d) => loaded[d] !== undefined,
    );
    if (targets.length === 0) return;

    const results = await Promise.all(
      targets.map(async (dir) => {
        try {
          const node = await fsTree(dir, 1);
          return { dir, children: node.children ?? [], ok: true as const };
        } catch {
          return { dir, children: [] as TreeNode[], ok: false as const };
        }
      }),
    );

    // --- 剪枝集合：被删掉的目录 + 其所有子孙 ---
    const removed = new Set<string>();
    const markRemoved = (dir: string) => {
      removed.add(dir);
      for (const key of Object.keys(loaded)) {
        if (isUnder(key, dir)) removed.add(key);
      }
    };
    for (const r of results) {
      if (!r.ok) {
        // 根目录读不到（cwd 被删 / 权限）→ 交给整体 error 提示，不剪枝
        if (r.dir === rootPath) continue;
        markRemoved(r.dir);
        continue;
      }
      const aliveDirs = new Set(
        r.children.filter((c) => c.kind === "dir").map((c) => c.path),
      );
      for (const key of Object.keys(loaded)) {
        if (key === r.dir) continue;
        if (parentOf(key) === r.dir && !aliveDirs.has(key)) markRemoved(key);
      }
    }

    setChildrenByPath((prev) => {
      const next = { ...prev };
      for (const key of removed) delete next[key];
      for (const r of results) {
        if (r.ok && !removed.has(r.dir)) next[r.dir] = r.children;
      }
      return next;
    });
    setExpandedPaths((prev) => {
      if (removed.size === 0) return prev;
      const next = new Set(prev);
      let changed = false;
      for (const key of removed) {
        if (next.delete(key)) changed = true;
      }
      return changed ? next : prev;
    });
    setLoadErrorByPath((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const key of removed) {
        if (key in next) {
          delete next[key];
          changed = true;
        }
      }
      for (const r of results) {
        if (r.ok && r.dir in next) {
          delete next[r.dir];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  // active session 变化 → 立即重拉 cwd → 重拉 fs_tree
  // v0.5.0-C T3：cwd 变化时（终端 cd 后通过 metadata cache 同步）也重拉
  useEffect(() => {
    let alive = true;

    // 换根目录 = 换一棵树，展开态 / children 缓存全部作废（这是**唯一**该清空
    // 展开态的场景；fs 变更走 refreshDirs 增量路径，不碰展开态）。
    //
    // cwd **没变**时（切到同目录的另一个终端 tab、轮询重跑一次）只刷新根子项，
    // 展开态原样保留 —— 否则切个 tab 就把用户展开的目录全折回去。
    const loadFromCwd = async (cwd: string | null) => {
      if (!alive) return;
      const switched = rootCwdRef.current !== cwd;
      rootCwdRef.current = cwd;
      setRootCwd(cwd);
      if (switched) {
        setChildrenByPath({});
        setExpandedPaths(new Set<string>());
        setLoadErrorByPath({});
      }
      if (!cwd) {
        setRootNode(null);
        setError(null);
        return;
      }
      try {
        const tree = await fsTree(cwd, 1);
        if (!alive) return;
        setRootNode(tree);
        const rootKids = tree.children ?? [];
        setChildrenByPath((prev) =>
          switched
            ? { [tree.path]: rootKids }
            : { ...prev, [tree.path]: rootKids },
        );
        setError(null);
      } catch (e) {
        if (!alive) return;
        setRootNode(null);
        setError(String(e));
      }
    };

    // 切 active session 立即跑一次
    const fetchAndLoad = async () => {
      if (!activeSessionId) {
        await loadFromCwd(null);
        return;
      }
      let cwd: string | null = null;
      try {
        cwd = await sessionCurrentCwd(activeSessionId);
      } catch {
        cwd = null;
      }
      await loadFromCwd(cwd);
    };
    void fetchAndLoad();

    // v0.5.0-C T3：3s 轮询 active session cwd，终端 cd 后自动切根目录。
    // 用 sessionCurrentCwd 直接查 sysinfo（实时，不走 metadata cache 的 2s 延迟）。
    // FileTree 关闭时 useEffect cleanup 自动停（alive=false + clearInterval）。
    //
    // 用 .then().catch() 链式而非 async/await：测试 teardown 时 invoke mock 可能
    // 已 reset，async 函数内 await reject 会冒泡成 unhandled rejection；显式 .catch
    // 兜底全部 promise reject 避免污染 vitest unhandled warning。
    let lastCwd: string | null = rootCwd;
    const interval = setInterval(() => {
      if (!activeSessionId) return;
      sessionCurrentCwd(activeSessionId)
        .then((cwd) => {
          if (cwd && cwd !== lastCwd) {
            lastCwd = cwd;
            return loadFromCwd(cwd);
          }
        })
        .catch(() => {
          // 静默：sysinfo 查 cwd 失败 / mock teardown / session 已关都视为暂时不刷
        });
    }, 3000);

    return () => {
      alive = false;
      clearInterval(interval);
    };
    // rootCwd 不放依赖（会导致 effect 每次都重建 interval）；setInterval 内闭包 lastCwd
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId]);

  // v0.9.1 HR3-6：rootCwd 变化 → 立刻刷一次 git status；之后每 5s 轮询。
  // 没 cwd 时 refresh(null) 会清空 byPath，FileTreeRow 看到无染色（正常 zinc）。
  useEffect(() => {
    const { refresh } = useGitStatusStore.getState();
    void refresh(rootCwd);
    if (!rootCwd) return;
    const id = setInterval(() => {
      void refresh(rootCwd);
    }, GIT_STATUS_POLL_MS);
    return () => clearInterval(id);
  }, [rootCwd]);

  // v0.10.0 HR9-1：恢复 v0.9.0 简单路径 —— 点文件就 openFile，UI 由全局
  // FilePreviewWorkspace 自动在终端下方上下 split 出现。
  // HR7-4 的"分屏体系下点文件 auto-create editor group + addTabToGroup"
  // 已撤销：editor 不再是 layout tree 的一个 group，而是 App.tsx 直接渲染
  // 的全局单例。这样避免点几次就累积多个空 editor pane 把布局搞乱（实测发现的 bug）。
  //
  // 文件夹仍由 row 展开逻辑处理，不调到这里。
  // 失败：openFile IPC 抛出时 fail-soft —— 控制台 warn 不打断用户。
  const handleFileClick = useCallback((path: string) => {
    // 用户之前把文件预览面板收起（filePreviewVisible=false）时，点文件虽会
    // openFile 但 fileEditorActive=(openFiles>0 && filePreviewVisible) 仍 false，
    // 面板不显示、用户看不到文件。点文件即"想看文件"，强制展开预览面板
    // （对齐 VS Code 等工具：点文件树的文件必然显示内容）。
    useSidebarStore.getState().setFilePreviewVisible(true);
    useFileEditorStore
      .getState()
      .openFile(path)
      .catch((e) => {
        console.warn("openFile 失败（fail-soft）", path, e);
      });
  }, []);

  // v0.10.2 #6：右键菜单 + 三种 dialog 状态机。
  //
  // contextMenu：右键 row 触发，记 {node, x, y}；用 fixed 定位渲染浮层。
  //   点空白 / Esc / 选了某 action → 关。
  // inputDialog：新建文件/目录/重命名 共用 InputDialog 组件 + 不同 onSubmit。
  // deletePending：删除二次确认 FsDeleteConfirmDialog。
  //
  // 操作成功后调 `reloadTree` 重新拉一遍已加载目录（保留展开态）。
  const [contextMenu, setContextMenu] = useState<{
    node: TreeNode;
    x: number;
    y: number;
  } | null>(null);
  const [inputDialog, setInputDialog] = useState<
    ComponentProps<typeof InputDialog>["open"]
  >(null);
  const [deletePending, setDeletePending] = useState<{
    path: string;
    name: string;
    isDir: boolean;
  } | null>(null);

  // v1.3.0 P9：手动刷新（header 按钮 / 右键"刷新"）= 重拉**所有已加载目录**，
  // 展开态原样保留。v1.1.0 那版靠 reloadKey++ remount 整棵树，会把展开态清空，
  // 已废弃。
  const reloadTree = useCallback(async () => {
    const keys = Object.keys(childrenRef.current);
    if (keys.length > 0) {
      await refreshDirs(keys);
      return;
    }
    // 根目录都还没加载成功（首次失败 / 刚切 cwd）→ 退化成重拉一次根
    if (!rootCwd) return;
    try {
      const tree = await fsTree(rootCwd, 1);
      setRootNode(tree);
      setChildrenByPath({ [tree.path]: tree.children ?? [] });
      setError(null);
    } catch (e) {
      console.warn("reload tree 失败", e);
    }
  }, [rootCwd, refreshDirs]);

  // v1.1.0 F5 / v1.3.0 P9：目录树 fs 自动刷新 —— rootCwd 确定后启动后端 notify
  // watcher（递归监听、跳过 .git/node_modules/target 等，见 fs.rs SKIP_NAMES）。
  //
  // 增量策略（P9，对齐 VS Code）：`fs:changed` 事件本来就带**具体变更路径**，
  // 把每个路径映射成"需要重新列目录的父目录"：
  //   - 路径自身是已加载目录（目录被整体替换 / 自身事件）→ 刷它
  //   - 路径的父目录已加载 → 刷父目录（新增 / 删除 / 重命名文件都落这条）
  // 没命中任何已加载目录的变更（用户没展开的分支）**完全不刷**，一次 IPC 都不发。
  //
  // 合并：`FS_CHANGED_MERGE_MS` 内到达的多批事件先攒进 pendingPaths，
  // 定时器到点一次性算受影响目录集合，同一目录只重拉一次。
  //
  // cleanup（rootCwd 变化 / 组件卸载）：停旧 watcher + 取消旧事件订阅 +
  // 清掉未触发的定时器 + 丢弃未处理的路径，避免残留刷新打到已切走的 cwd。
  useEffect(() => {
    if (!rootCwd) return;
    let cancelled = false;
    let mergeTimer: ReturnType<typeof setTimeout> | null = null;
    let unlisten: (() => void) | null = null;
    // 待处理路径缓冲区：跟 watcher 同生命周期（换 cwd / 卸载时随 effect 一起丢弃）
    const pendingPaths = new Set<string>();

    fsWatchStart(rootCwd).catch((e) => {
      console.warn("fsWatchStart 失败（fail-soft，目录树退化为仅手动/轮询刷新）", e);
    });

    const flush = () => {
      const batch = Array.from(pendingPaths);
      pendingPaths.clear();
      const loaded = childrenRef.current;
      const dirs = new Set<string>();
      for (const p of batch) {
        if (loaded[p] !== undefined) dirs.add(p);
        const parent = parentOf(p);
        if (loaded[parent] !== undefined) dirs.add(parent);
      }
      if (dirs.size === 0) return;
      void refreshDirs(Array.from(dirs));
    };

    onFsChanged((e) => {
      if (cancelled) return;
      for (const p of e.paths) pendingPaths.add(p);
      if (mergeTimer) clearTimeout(mergeTimer);
      mergeTimer = setTimeout(flush, FS_CHANGED_MERGE_MS);
    }).then((fn) => {
      if (cancelled) {
        fn();
        return;
      }
      unlisten = fn;
    });

    return () => {
      cancelled = true;
      if (mergeTimer) clearTimeout(mergeTimer);
      pendingPaths.clear();
      if (unlisten) unlisten();
      fsWatchStop().catch(() => {
        // 静默：切 cwd 太快 / 组件已卸载时 stop 失败不影响功能
        // （下一次 fsWatchStart 会覆盖后端唯一的 watcher 句柄）。
      });
    };
  }, [rootCwd, refreshDirs]);

  /**
   * 展开 / 折叠一个目录。展开态是 FileTree 级的（按路径），刷新不会丢。
   *
   * - 折叠：只从 expandedPaths 移除，**保留** children 缓存和子孙展开态
   * - 展开：没缓存过才发一次 `fs_tree(path, 1)`；失败只记这一行的错误
   */
  const toggleDir = useCallback(async (node: TreeNode, expanded: boolean) => {
    const path = node.path;
    if (expanded) {
      setExpandedPaths((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
      return;
    }
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      next.add(path);
      return next;
    });
    if (childrenRef.current[path] !== undefined) return;
    try {
      const sub = await fsTree(path, 1);
      setChildrenByPath((prev) => ({ ...prev, [path]: sub.children ?? [] }));
      setLoadErrorByPath((prev) => {
        if (!(path in prev)) return prev;
        const next = { ...prev };
        delete next[path];
        return next;
      });
    } catch (e) {
      setLoadErrorByPath((prev) => ({ ...prev, [path]: String(e) }));
    }
  }, []);

  // 关右键菜单：全局 click / Escape
  useEffect(() => {
    if (!contextMenu) return;
    const onDocClick = () => setContextMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setContextMenu(null);
    };
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [contextMenu]);

  // 拼绝对路径：parentDir + '/' + name；windows 用 '\\' 也行（后端用 PathBuf 兼容）
  const joinPath = (parentDir: string, name: string): string => {
    const sep = sepOf(parentDir);
    return parentDir.endsWith(sep) ? `${parentDir}${name}` : `${parentDir}${sep}${name}`;
  };

  const validateName = (name: string): string | null => {
    const trimmed = name.trim();
    if (!trimmed) return t("inputDialog.errorEmpty");
    if (trimmed.includes("/") || trimmed.includes("\\"))
      return t("inputDialog.errorSeparator");
    return null;
  };

  // 当前菜单 target node：dir 时新建目标 = 它自己；file 时新建目标 = 它的父目录
  const newTargetParent = (node: TreeNode): string =>
    node.kind === "dir" ? node.path : parentOf(node.path);

  const handleMenuAction = (
    kind: "newFile" | "newDir" | "rename" | "delete" | "reload" | "reveal",
    node: TreeNode,
  ) => {
    setContextMenu(null);
    if (kind === "reload") {
      void reloadTree();
      return;
    }
    if (kind === "reveal") {
      // 后端只接受真实存在的绝对路径；文件刚被外部删掉时会 reject，
      // 这里静默（右键菜单不值得为此弹错误框，下一次刷新树就没这项了）
      void shellReveal(node.path).catch((e) => {
        console.warn("[fileTree] 在文件管理器中显示失败", e);
      });
      return;
    }
    if (kind === "delete") {
      setDeletePending({ path: node.path, name: node.name, isDir: node.kind === "dir" });
      return;
    }
    if (kind === "newFile" || kind === "newDir") {
      const parent = newTargetParent(node);
      const isFile = kind === "newFile";
      setInputDialog({
        title: isFile ? t("inputDialog.newFileTitle") : t("inputDialog.newFolderTitle"),
        label: isFile
          ? t("inputDialog.newFileLabel", { path: parent })
          : t("inputDialog.newFileLabel", { path: parent }),
        initialValue: "",
        placeholder: isFile
          ? t("inputDialog.newFilePlaceholder")
          : t("inputDialog.newFolderPlaceholder"),
        validate: validateName,
        okLabel: t("inputDialog.createOk"),
        onSubmit: async (value) => {
          const newPath = joinPath(parent, value.trim());
          if (isFile) await fsCreateFile(newPath);
          else await fsCreateDir(newPath);
          void reloadTree();
        },
      });
      return;
    }
    // rename
    setInputDialog({
      title: t("inputDialog.renameTitle", {
        kind:
          node.kind === "dir" ? t("fileTree.menu.newFolder") : t("fileTree.menu.newFile"),
      }),
      label: t("inputDialog.renameLabel", { name: node.name }),
      initialValue: node.name,
      validate: (v) => {
        const e = validateName(v);
        if (e) return e;
        if (v.trim() === node.name) return t("inputDialog.errorSameName");
        return null;
      },
      okLabel: t("inputDialog.renameOk"),
      onSubmit: async (value) => {
        const newPath = joinPath(parentOf(node.path), value.trim());
        await fsRename(node.path, newPath);
        void reloadTree();
      },
    });
  };

  const handleDeleteConfirm = async (path: string) => {
    await fsDelete(path);
    setDeletePending(null);
    void reloadTree();
  };

  // v1.3.0 P9：行组件共享的视图上下文（展开态 / children 缓存 / 回调）。
  // useMemo 稳定引用：只有真正影响渲染的三张表变了才重算。
  const handleContextMenuRequested = useCallback(
    (node: TreeNode, x: number, y: number) => setContextMenu({ node, x, y }),
    [],
  );
  const treeCtx = useMemo<TreeViewCtx>(
    () => ({
      expandedPaths,
      childrenByPath,
      loadErrorByPath,
      onToggleDir: toggleDir,
      onFileClick: handleFileClick,
      onContextMenuRequested: handleContextMenuRequested,
    }),
    [
      expandedPaths,
      childrenByPath,
      loadErrorByPath,
      toggleDir,
      handleFileClick,
      handleContextMenuRequested,
    ],
  );
  const rootChildren = rootNode ? childrenByPath[rootNode.path] : undefined;

  // v0.6.0-A T3：宽度由外层 wrapper 控制（读 settings.ui.file_tree_width），
  // 这里只占满 wrapper。border 由 wrapper 提供（避免和 SplitDivider 重叠混乱）。
  return (
    <aside
      className="flex h-full w-full min-w-0 flex-shrink-0 flex-col overflow-hidden bg-[var(--c-bg-elev-1)]"
      aria-label={t("fileTree.title")}
      data-testid="file-tree"
    >
      <header className="flex h-9 flex-shrink-0 items-center gap-2 border-b border-[var(--c-border)] px-3 text-xs font-medium text-[var(--c-text-muted)]">
        <span className="truncate flex-1" title={rootCwd ?? ""}>
          {rootNode ? rootNode.name : rootCwd ? t("common.loading") : t("fileTree.headerNoCwd")}
        </span>
        {/* v0.10.2 hotfix：header 右侧刷新按钮，等同右键菜单"刷新"项 */}
        {rootCwd && (
          <button
            type="button"
            onClick={() => void reloadTree()}
            title={t("fileTree.refreshTitle")}
            aria-label={t("fileTree.refreshTitle")}
            data-testid="file-tree-refresh-btn"
            className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-[var(--c-text-dim)] hover:bg-[var(--c-bg-elev-2)] hover:text-[var(--c-text-base)]"
          >
            <RotateCw size={12} aria-hidden />
          </button>
        )}
      </header>
      <div className="flex-1 overflow-y-auto py-1 text-sm">
        {error && (
          <div className="px-3 py-2 text-xs text-[var(--c-text-dim)]" role="status">
            {t("fileTree.loadFailed", { error })}
          </div>
        )}
        {!error && !rootNode && rootCwd && (
          <div className="px-3 py-2 text-xs text-[var(--c-text-dim)]" role="status">
            {t("common.loading")}
          </div>
        )}
        {!error && !rootCwd && (
          <div className="px-3 py-2 text-xs text-[var(--c-text-dim)]" role="status">
            {t("fileTree.noActiveCwd")}
          </div>
        )}
        {/* v1.3.0 P9：不再用 reloadKey remount —— 刷新走 childrenByPath 增量替换，
         *   React 按 path key 复用 DOM，未受影响的分支既不重建也不折叠。 */}
        {rootChildren && (
          <ul className="m-0 list-none p-0">
            {rootChildren.map((c) => (
              <FileTreeRow key={c.path} node={c} depth={0} ctx={treeCtx} />
            ))}
          </ul>
        )}
      </div>
      {/* v0.10.2 #6 右键菜单浮层（v0.10.2 hotfix：dir/file 统一文本，
       *   不再分"在父目录新建" —— 用户自己知道 file 节点的"新建文件"是在父目录。
       *   后端 newTargetParent 仍按 kind 自动选 dir 自己 / file 的父）*/}
      {contextMenu && (
        <div
          role="menu"
          data-testid="file-tree-context-menu"
          className="fixed z-50 min-w-[160px] rounded border border-[var(--c-border-strong)] bg-[var(--c-bg-elev-1)] py-1 text-xs text-[var(--c-text-base)] shadow-lg"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => handleMenuAction("newFile", contextMenu.node)}
            className="block w-full text-left px-3 py-1.5 hover:bg-[var(--c-bg-elev-2)]"
          >
            {t("fileTree.menu.newFile")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => handleMenuAction("newDir", contextMenu.node)}
            className="block w-full text-left px-3 py-1.5 hover:bg-[var(--c-bg-elev-2)]"
          >
            {t("fileTree.menu.newFolder")}
          </button>
          <div className="my-1 border-t border-[var(--c-border)]" />
          <button
            type="button"
            role="menuitem"
            onClick={() => handleMenuAction("rename", contextMenu.node)}
            className="block w-full text-left px-3 py-1.5 hover:bg-[var(--c-bg-elev-2)]"
          >
            {t("fileTree.menu.rename")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => handleMenuAction("delete", contextMenu.node)}
            className="block w-full text-left px-3 py-1.5 text-[var(--c-error)] hover:bg-[var(--c-bg-elev-2)]"
          >
            {t("fileTree.menu.delete")}
          </button>
          <div className="my-1 border-t border-[var(--c-border)]" />
          <button
            type="button"
            role="menuitem"
            data-testid="file-tree-menu-reveal"
            onClick={() => handleMenuAction("reveal", contextMenu.node)}
            className="block w-full text-left px-3 py-1.5 hover:bg-[var(--c-bg-elev-2)]"
          >
            {t(revealLabelKey())}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => handleMenuAction("reload", contextMenu.node)}
            className="block w-full text-left px-3 py-1.5 hover:bg-[var(--c-bg-elev-2)]"
          >
            {t("fileTree.menu.refresh")}
          </button>
        </div>
      )}
      <InputDialog open={inputDialog} onClose={() => setInputDialog(null)} />
      <FsDeleteConfirmDialog
        pending={deletePending}
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeletePending(null)}
      />
    </aside>
  );
}

/**
 * v1.3.0 P9：行组件共享的视图上下文。
 *
 * 展开态 / children 缓存 / 懒加载错误全部由 FileTree 顶层按**路径**持有，
 * 行组件是纯受控的：这样 fs watcher 才能按路径精准替换某个目录的子项，
 * 而不必 remount 整棵树（remount = 展开态全丢，真机不可用）。
 */
interface TreeViewCtx {
  /** 已展开的目录绝对路径集合 */
  expandedPaths: ReadonlySet<string>;
  /** 目录绝对路径 → 已加载的直接子项 */
  childrenByPath: Record<string, TreeNode[]>;
  /** 目录绝对路径 → 懒加载失败消息 */
  loadErrorByPath: Record<string, string>;
  /** 点目录：展开 / 折叠（`expanded` 是该行当前的展开态） */
  onToggleDir: (node: TreeNode, expanded: boolean) => void;
  onFileClick: (path: string) => void;
  /** v0.10.2 #6：右键触发，把 node + 屏幕坐标转给 FileTree 顶层 contextMenu state。 */
  onContextMenuRequested: (node: TreeNode, x: number, y: number) => void;
}

/**
 * 单行 tree 节点；递归渲染。
 *
 * v0.4.1 T4：emoji → lucide-react SVG icons（plan §3.4）
 * - dir：折叠时 Folder + ChevronRight；展开时 FolderOpen + ChevronDown
 * - file：File icon
 * - 点击 dir 交给 ctx.onToggleDir（含首次懒加载）
 * - 点击 file 触发 ctx.onFileClick
 */
function FileTreeRow({
  node,
  depth,
  ctx,
}: {
  node: TreeNode;
  depth: number;
  ctx: TreeViewCtx;
}) {
  const { t } = useTranslation();
  const { expandedPaths, childrenByPath, loadErrorByPath } = ctx;
  const expanded = node.kind === "dir" && expandedPaths.has(node.path);
  /** 实际渲染用的 children：优先顶层缓存，回退 node 自带（后端一次给多层时） */
  const children = childrenByPath[node.path] ?? node.children ?? null;
  const loadError = loadErrorByPath[node.path] ?? null;

  const handleClick = () => {
    if (node.kind === "file") {
      ctx.onFileClick(node.path);
      return;
    }
    ctx.onToggleDir(node, expanded);
  };

  // 缩进 + icon prefix
  // v0.9.0 HR2-8：按文件名 / 扩展名 / 文件夹名查彩色图标（material-icon-theme 风格）
  const padLeft = 8 + depth * 12;
  const iconSpec =
    node.kind === "dir"
      ? getFolderIcon(node.name, expanded)
      : getFileIcon(node.name);
  const NodeIcon = iconSpec.Icon;
  const nodeIconLabel =
    node.kind === "dir"
      ? expanded
        ? "已展开文件夹"
        : "文件夹"
      : "文件";
  const ArrowIcon =
    node.kind === "dir" ? (expanded ? ChevronDown : ChevronRight) : null;

  // v0.9.1 HR3-6：按当前 git 状态决定文件名颜色 / 文件夹脏圆点。
  // - 订阅 byPath 整对象：FileTree 顶层每 5s setEntries 一次，全树 re-render
  //   不算大；按 path 选 1 个值的 selector 反而引入 Map.get 开销 + 依赖问题
  //   （selector ref 比较）。
  const byPath = useGitStatusStore((s) => s.byPath);
  // HR4-7：用 getFileStatus（normalize 兜底）而非直接 byPath[node.path]。
  // 后端已 canonicalize 通常等值就命中；万一 path 形式有边界差异，
  // normalize 一次再比对避免文件名不染色。
  const fileStatus =
    node.kind === "file" ? getFileStatus(node.path, byPath) : undefined;
  // v0.10.2：dir 也按 git status 染色（被 .gitignore 的目录如 node_modules / target
  // 应该灰显，跟里面的文件视觉一致）。dir 优先走 ignored 判断；非 ignored 再看
  // dirHasDirty 给 amber 圆点提示"内含变化"。
  const dirIgnored =
    node.kind === "dir" ? dirIsIgnored(node.path, byPath) : false;
  const fileColorClass =
    node.kind === "file"
      ? gitStatusFileClass(fileStatus)
      : dirIgnored
        ? gitStatusFileClass("ignored")
        : null;
  const fileBadge =
    node.kind === "file" ? gitStatusBadge(fileStatus) : null;
  const dirDirty =
    node.kind === "dir" && !dirIgnored
      ? dirHasDirty(node.path, byPath)
      : false;

  return (
    <li className="m-0 list-none p-0">
      <button
        type="button"
        onClick={handleClick}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          ctx.onContextMenuRequested(node, e.clientX, e.clientY);
        }}
        className="flex w-full items-center gap-1 truncate py-0.5 pr-2 text-left text-[var(--c-text-muted)] hover:bg-[var(--c-bg-elev-2)]"
        style={{ paddingLeft: padLeft }}
        title={node.path}
      >
        {ArrowIcon && (
          <ArrowIcon
            size={12}
            className="shrink-0 text-[var(--c-text-dim)]"
            aria-hidden
          />
        )}
        {!ArrowIcon && <span className="inline-block w-3 flex-shrink-0" />}
        <NodeIcon
          size={16}
          className={`shrink-0 ${iconSpec.color}`}
          aria-label={nodeIconLabel}
        />
        <span className={`truncate ${fileColorClass ?? ""}`}>{node.name}</span>
        {fileBadge && (
          <span
            className={`ml-auto pl-1 flex-shrink-0 font-mono text-xs font-bold ${fileBadge.colorClass}`}
            aria-label={`git 状态：${fileBadge.letter}`}
            data-testid="git-file-status-badge"
          >
            {fileBadge.letter}
          </span>
        )}
        {dirDirty && !fileBadge && (
          <span
            className="ml-auto inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400"
            aria-label={t("fileTree.dirtyDirAria")}
            data-testid="git-dir-dirty-dot"
          />
        )}
      </button>
      {node.kind === "dir" && expanded && (
        <>
          {loadError && (
            <div
              className="px-3 py-1 text-xs text-[var(--c-text-dim)]"
              style={{ paddingLeft: padLeft + 16 }}
              role="status"
            >
              读取失败：{loadError}
            </div>
          )}
          {!loadError && children && children.length === 0 && (
            <div
              className="py-1 text-xs text-[var(--c-text-faint)]"
              style={{ paddingLeft: padLeft + 16 }}
            >
              (空)
            </div>
          )}
          {!loadError && children && children.length > 0 && (
            <ul className="m-0 list-none p-0">
              {children.map((c) => (
                <FileTreeRow key={c.path} node={c} depth={depth + 1} ctx={ctx} />
              ))}
            </ul>
          )}
        </>
      )}
    </li>
  );
}
