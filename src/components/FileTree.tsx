import { useCallback, useEffect, useMemo, useState, type ComponentProps } from "react";
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

  // active session 变化 → 立即重拉 cwd → 重拉 fs_tree
  // v0.5.0-C T3：cwd 变化时（终端 cd 后通过 metadata cache 同步）也重拉
  useEffect(() => {
    let alive = true;

    const loadFromCwd = async (cwd: string | null) => {
      if (!alive) return;
      setRootCwd(cwd);
      if (!cwd) {
        setRootNode(null);
        setError(null);
        return;
      }
      try {
        const tree = await fsTree(cwd, 1);
        if (!alive) return;
        setRootNode(tree);
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
  // 的全局单例。这样避免点几次就累积多个空 editor pane 把布局搞乱（真机 bug）。
  //
  // 文件夹仍由 row 展开逻辑处理，不调到这里。
  // 失败：openFile IPC 抛出时 fail-soft —— 控制台 warn 不打断用户。
  const handleFileClick = (path: string) => {
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
  };

  // v0.10.2 #6：右键菜单 + 三种 dialog 状态机。
  //
  // contextMenu：右键 row 触发，记 {node, x, y}；用 fixed 定位渲染浮层。
  //   点空白 / Esc / 选了某 action → 关。
  // inputDialog：新建文件/目录/重命名 共用 InputDialog 组件 + 不同 onSubmit。
  // deletePending：删除二次确认 FsDeleteConfirmDialog。
  //
  // 操作成功后调 `reloadTree` 重拉整个 fs_tree —— 简单可靠（不增量 patch
  // node.children，避免懒加载和 reload 的一致性 bug）。
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

  // v0.10.2 hotfix：reloadTree 用 reloadKey++ 强制重 mount 整棵 FileTreeRow，
  // 让 lazy 加载的 children state 全部清空，下次展开重 fetch。
  // 副作用：所有 dir 的展开状态被 reset；少量 reload 操作可接受。
  const [reloadKey, setReloadKey] = useState(0);
  const reloadTree = useCallback(async () => {
    if (!rootCwd) return;
    try {
      const tree = await fsTree(rootCwd, 1);
      setRootNode(tree);
      setReloadKey((k) => k + 1);
    } catch (e) {
      console.warn("reload tree 失败", e);
    }
  }, [rootCwd]);

  // v1.1.0 F5：目录树 fs 自动刷新 —— rootCwd 确定后启动后端 notify watcher
  // （递归监听、跳过 .git/node_modules/target 等，见 fs.rs SKIP_NAMES），
  // 收到 `fs:changed` 事件后前端再 debounce ~200ms 才刷新（后端已 400ms
  // debounce；这里防止同一操作在极端情况下触发多个批次时前端连续 reload）。
  //
  // TODO(增强项)：当前用 reloadTree() 整树 reload（会 reset 已展开节点的
  // 展开态，见 reloadTree 上方注释同款取舍）。更精细的做法是只刷新受影响
  // 且已展开的子树以保留展开态；因改动复杂度高（需要维护"当前已展开路径
  // 集合"+按路径前缀命中增量重拉），本批次（plan §8 F5 条目）先用保守方案，
  // 增量刷新留作后续版本。
  //
  // cleanup（rootCwd 变化 / 组件卸载）：停旧 watcher + 取消旧事件订阅 +
  // 清掉未触发的 debounce 定时器，避免残留定时器刷新到已切走的 cwd。
  useEffect(() => {
    if (!rootCwd) return;
    let cancelled = false;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let unlisten: (() => void) | null = null;

    fsWatchStart(rootCwd).catch((e) => {
      console.warn("fsWatchStart 失败（fail-soft，目录树退化为仅手动/轮询刷新）", e);
    });

    onFsChanged(() => {
      if (cancelled) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        void reloadTree();
      }, 200);
    }).then((fn) => {
      if (cancelled) {
        fn();
        return;
      }
      unlisten = fn;
    });

    return () => {
      cancelled = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      if (unlisten) unlisten();
      fsWatchStop().catch(() => {
        // 静默：切 cwd 太快 / 组件已卸载时 stop 失败不影响功能
        // （下一次 fsWatchStart 会覆盖后端唯一的 watcher 句柄）。
      });
    };
  }, [rootCwd, reloadTree]);

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
    const sep = parentDir.includes("\\") && !parentDir.includes("/") ? "\\" : "/";
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
  const newTargetParent = (node: TreeNode): string => {
    if (node.kind === "dir") return node.path;
    // file → parent dir
    const sep = node.path.includes("\\") && !node.path.includes("/") ? "\\" : "/";
    const idx = node.path.lastIndexOf(sep);
    return idx > 0 ? node.path.slice(0, idx) : node.path;
  };

  // dir 节点上下文中"父目录"（重命名时拼新路径）
  const parentOf = (path: string): string => {
    const sep = path.includes("\\") && !path.includes("/") ? "\\" : "/";
    const idx = path.lastIndexOf(sep);
    return idx > 0 ? path.slice(0, idx) : path;
  };

  const handleMenuAction = (
    kind: "newFile" | "newDir" | "rename" | "delete" | "reload",
    node: TreeNode,
  ) => {
    setContextMenu(null);
    if (kind === "reload") {
      void reloadTree();
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
        {rootNode && rootNode.children && (
          <ul className="m-0 list-none p-0" key={reloadKey}>
            {rootNode.children.map((c) => (
              <FileTreeRow
                key={c.path}
                node={c}
                depth={0}
                onFileClick={handleFileClick}
                onContextMenuRequested={(node, x, y) =>
                  setContextMenu({ node, x, y })
                }
              />
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
 * 单行 tree 节点；递归渲染。
 *
 * v0.4.1 T4：emoji → lucide-react SVG icons（plan §3.4）
 * - dir：折叠时 Folder + ChevronRight；展开时 FolderOpen + ChevronDown
 * - file：File icon
 * - 点击 dir 切换；展开第一次 lazy 调 fs_tree(path, 1)
 * - 点击 file 触发 onFileClick
 */
function FileTreeRow({
  node,
  depth,
  onFileClick,
  onContextMenuRequested,
}: {
  node: TreeNode;
  depth: number;
  onFileClick: (path: string) => void;
  /** v0.10.2 #6：右键触发，把 node + 屏幕坐标转给 FileTree 顶层 contextMenu state。 */
  onContextMenuRequested: (node: TreeNode, x: number, y: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  /** 懒加载来的子节点；null = 还没拉取过 */
  const [loadedChildren, setLoadedChildren] = useState<TreeNode[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  /** 实际渲染时使用的 children：优先 loaded，回退 node.children */
  const children = useMemo<TreeNode[] | null>(() => {
    if (loadedChildren !== null) return loadedChildren;
    return node.children ?? null;
  }, [loadedChildren, node.children]);

  const handleClick = async () => {
    if (node.kind === "file") {
      onFileClick(node.path);
      return;
    }
    // dir：先 toggle expanded
    const nextExpanded = !expanded;
    setExpanded(nextExpanded);
    if (
      nextExpanded &&
      loadedChildren === null &&
      (node.children === null || node.children === undefined)
    ) {
      // children=null 意味着后端按 max_depth 限制截断 → 懒加载
      try {
        const sub = await fsTree(node.path, 1);
        setLoadedChildren(sub.children ?? []);
        setLoadError(null);
      } catch (e) {
        setLoadError(String(e));
      }
    }
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
          onContextMenuRequested(node, e.clientX, e.clientY);
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
            aria-label="目录内含未提交变更"
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
                <FileTreeRow
                  key={c.path}
                  node={c}
                  depth={depth + 1}
                  onFileClick={onFileClick}
                  onContextMenuRequested={onContextMenuRequested}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </li>
  );
}
