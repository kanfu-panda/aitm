import { create } from "zustand";

import { useSettingsStore } from "./settings";
import { useTabsStore } from "./tabs";

/**
 * v0.10.0 HR9-1：layout tree 简化为 **terminal-only**。
 *
 * 经过 HR6-3 / HR7 / HR8 真机暴露的架构错误：把 browser / editor 也做成
 * PaneGroup type 塞进 layout tree → HR7-4 点文件自动 create editor group →
 * 多个空 editor pane 累积 → 布局乱。HR9-1 收回正确架构：
 *
 *   - **分屏（layout tree）= 仅终端**，max 5
 *   - **文件预览 = 全局唯一**（v0.9.0 上下 split 模式，编辑器在 layout tree
 *     下方）—— 由 App.tsx 直接渲染 `<FilePreviewWorkspace />`，不归 layout tree
 *   - **浏览器 = 全局唯一**（右侧浮动 PanelGroup，Cmd+Shift+B 切换）
 *   - **AI 侧栏 = 全局唯一**
 *
 * 数据层只保留 terminal 一种 PaneGroup type；`GroupType` 仍为 union 形式但
 * 只含 `"terminal"` —— 这样未来若想扩仍能加成员，当前消费方只需关心 terminal。
 *
 * Group 内 tab_ids 引用 useTabsStore 的 `Tab.id`。
 */

/**
 * PaneGroup 的类型。
 *
 * v0.10.0 HR9-1：层级 layout tree 只承载 terminal。`browser` / `editor` 已
 * 从 union 中移除：浏览器是全局浮动面板（BrowserPanel），编辑器是 App.tsx
 * 直接渲染的全局 FilePreviewWorkspace（上下 split 下方）。
 */
export type GroupType = "terminal";

/** Split 方向：`horizontal`=左右并排；`vertical`=上下并排。 */
export type SplitDirection = "horizontal" | "vertical";

/** PaneGroup：一个分屏单元，内部维护一组 terminal tab。 */
export interface PaneGroup {
  /** UUID（默认走 `crypto.randomUUID()`；初始 group 固定 ID `g-initial`）。 */
  id: string;
  /** group 类型：v0.10.0 HR9-1 起仅 "terminal"。 */
  type: GroupType;
  /**
   * group 内的 tab id 列表。引用 useTabsStore 的 Tab.id。
   */
  tab_ids: string[];
  /** group 内当前活跃 tab id；空 group 为 null。 */
  active_tab_id: string | null;
}

/**
 * Layout 树节点：叶子 = PaneGroup；split = 二叉子树。
 *
 * - `kind:"split"` 的 `left` 在 `horizontal` 下表示左侧、`vertical` 下表示
 *   上方；`ratio` 是 left/top 占总宽/高的比例（0..1，默认 0.5）。
 */
export type LayoutNode =
  | { kind: "leaf"; group: PaneGroup }
  | {
      kind: "split";
      direction: SplitDirection;
      /** 0..1：left/top 占比；默认 0.5。 */
      ratio: number;
      left: LayoutNode;
      right: LayoutNode;
    };

/** 路径里走 split 的某一支：left / right。 */
export type PathStep = "left" | "right";

interface PaneLayoutState {
  /** 整棵 layout tree 的根。 */
  root: LayoutNode;
  /**
   * 当前焦点 group（Cmd+\ / Cmd+Shift+W / AI runtime context 的目标）。
   * 初始指向默认 group `g-initial`。
   */
  active_group_id: string | null;

  // === actions ===

  /**
   * 在指定 group 上创建 split：把该叶子换成 split，新 group 同 type（terminal），
   * 空 tabs。
   *
   * 返回新建 group 的 id（调用方可立刻 `setActiveGroup` 给它）；
   * 找不到 group 时返 `null`。
   *
   * 当前 layout 已含 `MAX_PANE_GROUPS` (5) 个 group → 返 `null` 拒绝新建
   * + `console.warn`。
   */
  splitGroup: (groupId: string, direction: SplitDirection) => string | null;

  /**
   * splitGroup 升级版 —— 拆 group 同时自动给新 group **seed 一个新 terminal
   * tab**，让 pane 立刻可用，避免共享 fallback 时的"两边镜像"bug。
   *
   * - 先 check 已达 `MAX_PANE_GROUPS` → 返 `null`
   * - 找不到 source group → 返 `null`
   * - 同步调 `useTabsStore.addTab()` 拿新 PTY tab id 写进新 group.tab_ids
   * - 新 group 即 active（active_group_id 切到 newId）
   *
   * 返新建 group id；超过 max 或找不到源 group → `null`。
   */
  splitGroupWithNewTab: (
    groupId: string,
    direction: SplitDirection,
  ) => string | null;

  /**
   * 在 active group 加一个新 terminal tab。
   *
   * 同步调 `useTabsStore.addTab()` 开新 PTY tab，把新 tabId 加进 active
   * group.tab_ids + 切 group.active_tab_id。
   * 没 active group / 找不到 group → 返 null。
   *
   * 替代旧 `useShortcuts.newTab` 的 `useTabsStore.getState().addTab()` 直调，
   * 保证 Cmd+T / "+" 按钮新 tab 都进 active group。
   */
  addTabToActiveGroup: () => Promise<string | null>;

  /**
   * 在 group 内关 terminal tab。
   *
   * 行为：
   * 1. 调 `useTabsStore.closeTab(tabId)`（内部 destroy PTY session）
   * 2. 从 group.tab_ids 移除 + 自动切 active_tab_id（剩余下一个）
   * 3. 关掉后 group 空：
   *    - **非根** group → cascade `closeGroup`（sibling 替换 parent split）
   *    - **根** group → 自动开一个新 default terminal tab（不让 root 空白）
   */
  closeTabInGroup: (groupId: string, tabId: string) => Promise<void>;

  /**
   * 关闭指定 group：从 tree 里移除，sibling 替换 parent split。
   *
   * - 根节点（唯一 group） → 返 `false` 不动（保留至少一个 group）。
   * - `active_group_id` 是被关 group → 自动切到 sibling 的第一个 leaf 的
   *   group.id。
   */
  closeGroup: (groupId: string) => boolean;

  /** 设当前焦点 group。 */
  setActiveGroup: (groupId: string | null) => void;

  /**
   * 跨 group 移 tab：从 fromGroup.tab_ids 移除，添加到 toGroup.tab_ids 末尾，
   * 顺手把 toGroup.active_tab_id 切到移入的 tab。
   *
   * 找不到任一 group / fromGroup 不含该 tabId → 返 `false`。
   */
  moveTab: (tabId: string, fromGroupId: string, toGroupId: string) => boolean;

  /**
   * v0.10.6 HR7-6：同 group 内 tab 重排（dnd-kit sortable 拖动结束触发）。
   *
   * tab_ids 顺序更新；active_tab_id 不变。fromIndex/toIndex 越界或相等 → no-op。
   */
  reorderTabInGroup: (
    groupId: string,
    fromIndex: number,
    toIndex: number,
  ) => void;

  /**
   * v0.10.6 HR7-6：拖一个 tab 到 group 边沿区 → split：源 group 移除该 tab，
   * 新建 group 持有该 tab。**不创建新 PTY**（与 splitGroupWithNewTab 区别）。
   *
   * - 触达 `MAX_PANE_GROUPS` → 返 `null` + console.warn
   * - 找不到源 group / 源 group 不含 tabId → 返 `null`
   * - 源 group 是唯一根 group 且只剩这一个 tab → 拒绝（避免根空） → `null`
   * - side 决定新 group 在源哪一边：left/top → 新 group 占 left 位置；
   *   right/bottom → 新 group 占 right 位置
   *
   * 返新建 group id；新 group 即 active。
   */
  splitGroupWithTab: (
    sourceGroupId: string,
    direction: SplitDirection,
    tabId: string,
    side: "left" | "right" | "top" | "bottom",
  ) => string | null;

  /**
   * 调 split ratio。`pathFromRoot` 是从根开始走 left/right 到目标 split 节点
   * 的路径；空数组表示根节点（根必须是 split 否则 no-op）。
   *
   * ratio 自动夹到 [0.05, 0.95] 区间，避免某一边塌缩。
   */
  setRatio: (pathFromRoot: PathStep[], ratio: number) => void;

  /** 给指定 group 加 tab；若 group 之前空 active 自动设为新加 tab。 */
  addTabToGroup: (groupId: string, tabId: string) => void;

  /**
   * 给指定 group 移除 tab。
   *
   * 若移除的是 active_tab_id，自动切到列表里下一个 tab（无则切前一个，再无
   * 则 null）。
   */
  removeTabFromGroup: (groupId: string, tabId: string) => void;

  /** group 内设 active tab（tabId 必须在 group.tab_ids 内，否则 no-op）。 */
  setActiveTabInGroup: (groupId: string, tabId: string) => void;

  /**
   * 重置整个 layout（错误恢复 / 设置面板的"恢复默认布局" / 测试夹具）。
   *
   * active_group_id 自动切到 initial 树里第一个 leaf。
   */
  resetLayout: (initial: LayoutNode) => void;
}

// =============================================================================
// 辅助函数（导出供其他模块复用 + 测试断言）
// =============================================================================

/**
 * 递归找含指定 groupId 的叶子，返回路径（["left","right",...]）和叶子节点。
 *
 * 找不到 → null。根节点本身是 leaf 时 path = []。
 */
export function findGroupPath(
  node: LayoutNode,
  groupId: string,
  path: PathStep[] = [],
): { path: PathStep[]; leaf: LayoutNode & { kind: "leaf" } } | null {
  if (node.kind === "leaf") {
    return node.group.id === groupId ? { path, leaf: node } : null;
  }
  return (
    findGroupPath(node.left, groupId, [...path, "left"]) ??
    findGroupPath(node.right, groupId, [...path, "right"])
  );
}

/** 收集 tree 里所有 leaf 的 group。深度优先，左 → 右。 */
export function collectAllGroups(node: LayoutNode): PaneGroup[] {
  if (node.kind === "leaf") return [node.group];
  return [...collectAllGroups(node.left), ...collectAllGroups(node.right)];
}

/**
 * 沿路径找到目标节点；空路径返根。路径越界（中途遇到 leaf 但路径还没走完）
 * → null。
 */
export function nodeAtPath(
  root: LayoutNode,
  path: PathStep[],
): LayoutNode | null {
  let cur: LayoutNode = root;
  for (const step of path) {
    if (cur.kind !== "split") return null;
    cur = step === "left" ? cur.left : cur.right;
  }
  return cur;
}

/** 给定 tree 返第一个 leaf 的 group.id（leftmost）。 */
function getFirstGroupId(node: LayoutNode): string {
  if (node.kind === "leaf") return node.group.id;
  return getFirstGroupId(node.left);
}

/**
 * 按路径把目标节点替换成 `replacement`，返回一棵新 tree。
 *
 * 路径越界 → 返原 root 不动（调用方应先用 findGroupPath / nodeAtPath 校验）。
 */
function replaceAtPath(
  root: LayoutNode,
  path: PathStep[],
  replacement: LayoutNode,
): LayoutNode {
  if (path.length === 0) return replacement;
  if (root.kind !== "split") return root;
  const [head, ...rest] = path;
  if (head === "left") {
    return { ...root, left: replaceAtPath(root.left, rest, replacement) };
  }
  return { ...root, right: replaceAtPath(root.right, rest, replacement) };
}

/**
 * 生成新 group id —— 优先 `crypto.randomUUID()`（vitest jsdom / Node 14+ 都
 * 有），降级到时间戳 + 随机数（极少数没有 crypto 的环境）。
 */
function newGroupId(): string {
  const c =
    typeof globalThis !== "undefined"
      ? (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
      : undefined;
  if (c && typeof c.randomUUID === "function") {
    return `g-${c.randomUUID()}`;
  }
  return `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** ratio 安全夹紧：避免某边塌缩到 0。 */
function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  if (ratio < 0.05) return 0.05;
  if (ratio > 0.95) return 0.95;
  return ratio;
}

// =============================================================================
// store
// =============================================================================

/** 初始 group 的固定 ID：便于测试断言 + 跨重启 restore 时识别。 */
export const INITIAL_GROUP_ID = "g-initial";

/**
 * 分屏数量上限。
 *
 * 拍板理由：
 * - 5 个 group 在 1440×900 屏上已经接近"每块 < 500px 宽"的可用下限，再多
 *   tab 标题都看不全，体验崩塌。
 * - xterm 实例都占可观资源，> 5 个并存会显著影响冷启动 RSS。
 * - 用户真要更多窗口请用"开多个 aitm 实例"。
 *
 * 触达上限时 `splitGroup` / `splitGroupWithNewTab` 返 `null` + 控制台 warn。
 */
export const MAX_PANE_GROUPS = 5;

/**
 * v0.10.5 #1：单 group 内 max tab 软限制。
 *
 * 真机 维护者 几百 tab 触发 PTY 资源耗尽 + RSS 942MB + WebGL context 超限。
 * 30 是 macOS 默认 fd limit (256) / 每 PTY ~5 fd ≈ 50 的安全边界，留
 * 余地给系统 / 其它 fd。触达上限 → addTabToActiveGroup 返 null +
 * console.warn；前端 Cmd+T / "+" 按钮收到 null 时**应该提示用户**
 * （UI 处理留 TerminalPaneGroup tabbar onClick 兜底）。
 */
export const MAX_TABS_PER_GROUP = 30;

/** 默认根 layout：单个 terminal group，空 tabs（App.tsx 启动时根据 tabs store 填）。 */
export function makeDefaultRoot(): LayoutNode {
  return {
    kind: "leaf",
    group: {
      id: INITIAL_GROUP_ID,
      type: "terminal",
      tab_ids: [],
      active_tab_id: null,
    },
  };
}

// =============================================================================
// HR6-3e / HR9-1：layout 跨重启持久化
// =============================================================================

/** 持久化 debounce 窗口（ms）。短一点（300ms）保证用户连续 split 操作落最后状态。 */
export const PERSIST_DEBOUNCE_MS = 300;

let persistTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 把当前 layout tree 序列化成 JSON 字符串 debounced 写到
 * `settings.ui.pane_layout`。所有会改 layout 的 action 后调一次。
 */
export function schedulePersistLayout(root: LayoutNode): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const json = JSON.stringify(root);
      useSettingsStore.getState().update({ ui: { pane_layout: json } });
    } catch (e) {
      console.warn("[pane-layout] schedulePersistLayout 序列化失败（跳过本次持久化）", e);
    }
  }, PERSIST_DEBOUNCE_MS);
}

/**
 * 把 restore 出来的 LayoutNode tree 过滤 tab_ids 失效项。
 *
 * v0.10.0 HR9-1 简化：layout tree 只承载 terminal。旧版本（v0.10.0 阶段 1）
 * 可能持久化过含 browser / editor type 的 group——这种 leaf 直接丢弃；如果
 * 整棵 tree 被丢光（全是非 terminal leaf）→ 返 `null`，外层 fallback 默认 root。
 *
 * 失效判定：
 * - `terminal` group → tab_ids 必须在 `useTabsStore.tabs[].id` 内
 * - 其他 type（browser / editor 老数据）→ 整个 leaf 丢弃
 *
 * 兜底规则：
 * - 失效的 tab_id silently 过滤掉
 * - `active_tab_id` 若不在剩余 tab_ids 内 → fallback 到剩余第一个（或 null）
 * - 整个 group 的 tab_ids 全失效 → **仍保留 group**（用户分屏意图保留，
 *   等开新 tab 自动加进来）
 * - split 子节点其中一个 sanitize 返 null → 把 sibling 提升占位（保留另一边）
 * - tree 结构本身不合法 → 返 `null`（外层 fallback 默认）
 */
export function sanitizeLayout(node: unknown): LayoutNode | null {
  // 一次性快照 useTabsStore 合法 id 集合；递归内反复查这一个 set。
  const terminalIds = new Set(useTabsStore.getState().tabs.map((t) => t.id));
  return sanitizeNode(node, { terminalIds });
}

/** sanitize 内部 helper：递归过滤一层 LayoutNode。 */
function sanitizeNode(
  node: unknown,
  validIds: { terminalIds: Set<string> },
): LayoutNode | null {
  if (!node || typeof node !== "object") return null;
  const n = node as Record<string, unknown>;
  if (n.kind === "leaf") {
    const g = n.group as Record<string, unknown> | undefined;
    if (!g || typeof g !== "object") return null;
    const id = typeof g.id === "string" ? g.id : null;
    const type = g.type;
    if (!id) return null;
    // v0.10.0 HR9-1：仅接受 terminal；老数据中的 browser / editor leaf 整个丢弃。
    if (type !== "terminal") {
      return null;
    }
    const validSet = validIds.terminalIds;
    const rawTabIds = Array.isArray(g.tab_ids) ? g.tab_ids : [];
    const tab_ids = rawTabIds.filter(
      (x): x is string => typeof x === "string" && validSet.has(x),
    );
    const rawActive =
      typeof g.active_tab_id === "string" ? g.active_tab_id : null;
    // active 失效 → 切到剩余第一个；剩余空 → null
    const active_tab_id =
      rawActive && tab_ids.includes(rawActive)
        ? rawActive
        : (tab_ids[0] ?? null);
    return {
      kind: "leaf",
      group: {
        id,
        type: "terminal",
        tab_ids,
        active_tab_id,
      },
    };
  }
  if (n.kind === "split") {
    const direction = n.direction;
    if (direction !== "horizontal" && direction !== "vertical") return null;
    const left = sanitizeNode(n.left, validIds);
    const right = sanitizeNode(n.right, validIds);
    // v0.10.0 HR9-1：兼容旧 layout —— 若 split 一边因 browser / editor 老 leaf
    // 被丢，把另一边提升占位（避免整棵 fallback 让用户感觉分屏意图全丢）。
    // 两边都丢才整棵返 null。
    if (!left && !right) return null;
    if (!left) return right;
    if (!right) return left;
    const ratio =
      typeof n.ratio === "number" && Number.isFinite(n.ratio) ? n.ratio : 0.5;
    return {
      kind: "split",
      direction,
      ratio: clampRatio(ratio),
      left,
      right,
    };
  }
  return null;
}

export const usePaneLayoutStore = create<PaneLayoutState>((set, get) => ({
  root: makeDefaultRoot(),
  active_group_id: INITIAL_GROUP_ID,

  splitGroup: (groupId, direction) => {
    const { root } = get();
    // 触达 max → 拒绝
    if (collectAllGroups(root).length >= MAX_PANE_GROUPS) {
      console.warn(
        `[pane-layout] 已达分屏上限 ${MAX_PANE_GROUPS}，拒绝新建 group`,
      );
      return null;
    }
    const found = findGroupPath(root, groupId);
    if (!found) return null;
    const newId = newGroupId();
    const newGroup: PaneGroup = {
      id: newId,
      type: "terminal",
      tab_ids: [],
      active_tab_id: null,
    };
    const splitNode: LayoutNode = {
      kind: "split",
      direction,
      ratio: 0.5,
      left: found.leaf,
      right: { kind: "leaf", group: newGroup },
    };
    set({ root: replaceAtPath(root, found.path, splitNode) });
    schedulePersistLayout(get().root);
    return newId;
  },

  splitGroupWithNewTab: (groupId, direction) => {
    const { root } = get();
    // 触达 max → 拒绝
    if (collectAllGroups(root).length >= MAX_PANE_GROUPS) {
      console.warn(
        `[pane-layout] 已达分屏上限 ${MAX_PANE_GROUPS}，拒绝新建 group`,
      );
      return null;
    }
    const found = findGroupPath(root, groupId);
    if (!found) return null;
    const newId = newGroupId();

    // 同步开 PTY tab，写进新 group.tab_ids。新 group 立刻独立可用。
    const newTabId = useTabsStore.getState().addTab();

    const newGroup: PaneGroup = {
      id: newId,
      type: "terminal",
      tab_ids: [newTabId],
      active_tab_id: newTabId,
    };
    const splitNode: LayoutNode = {
      kind: "split",
      direction,
      ratio: 0.5,
      left: found.leaf,
      right: { kind: "leaf", group: newGroup },
    };
    set({
      root: replaceAtPath(root, found.path, splitNode),
      active_group_id: newId, // 新 group 立刻 focus
    });
    schedulePersistLayout(get().root);
    return newId;
  },

  addTabToActiveGroup: async () => {
    const { active_group_id, root } = get();
    if (!active_group_id) return null;
    const found = findGroupPath(root, active_group_id);
    if (!found) return null;
    const g = found.leaf.group;

    // v0.10.5 #1：group 内 tab 数量软上限，防 PTY 资源耗尽。
    if (g.tab_ids.length >= MAX_TABS_PER_GROUP) {
      console.warn(
        `[pane-layout] 当前 group 已达 tab 上限 ${MAX_TABS_PER_GROUP}，拒绝新建。请先关一些 tab 或拆到新 group。`,
      );
      return null;
    }

    // 同步开 PTY tab；useTabsStore 内部 set activeId 给该 tab（保 xterm 焦点）
    const newTabId = useTabsStore.getState().addTab();
    // 加进 group.tab_ids + 切 group.active_tab_id
    const nextGroup: PaneGroup = {
      ...g,
      tab_ids: [...g.tab_ids, newTabId],
      active_tab_id: newTabId,
    };
    set({
      root: replaceAtPath(get().root, found.path, {
        kind: "leaf",
        group: nextGroup,
      }),
    });
    schedulePersistLayout(get().root);
    return newTabId;
  },

  closeTabInGroup: async (groupId, tabId) => {
    const found = findGroupPath(get().root, groupId);
    if (!found) return;
    const g = found.leaf.group;
    if (!g.tab_ids.includes(tabId)) return;

    // 1. 调全局 store close（destroy PTY session）
    useTabsStore.getState().closeTab(tabId);

    // 2. 从 group.tab_ids 移除（重新 find；上一步 store close 可能触发 sub 但
    //    pane-layout root 不会被改）
    const found2 = findGroupPath(get().root, groupId);
    if (!found2) return;
    const g2 = found2.leaf.group;
    const idx = g2.tab_ids.indexOf(tabId);
    const nextTabs = g2.tab_ids.filter((id) => id !== tabId);
    let nextActive: string | null = g2.active_tab_id;
    if (g2.active_tab_id === tabId) {
      nextActive = nextTabs[idx] ?? nextTabs[idx - 1] ?? null;
    }
    const nextGroup: PaneGroup = {
      ...g2,
      tab_ids: nextTabs,
      active_tab_id: nextActive,
    };
    set({
      root: replaceAtPath(get().root, found2.path, {
        kind: "leaf",
        group: nextGroup,
      }),
    });
    schedulePersistLayout(get().root);

    // 3. 空 group 后续处理
    if (nextTabs.length === 0) {
      if (found2.path.length === 0) {
        // 根 group：自动 seed 新 default terminal tab，不让 root 空白
        const newTabId = useTabsStore.getState().addTab();
        const reseededGroup: PaneGroup = {
          ...g2,
          tab_ids: [newTabId],
          active_tab_id: newTabId,
        };
        set({
          root: replaceAtPath(get().root, found2.path, {
            kind: "leaf",
            group: reseededGroup,
          }),
        });
        schedulePersistLayout(get().root);
      } else {
        // 非根：cascade closeGroup（sibling 替换 parent）
        get().closeGroup(groupId);
      }
    }
  },

  closeGroup: (groupId) => {
    const { root, active_group_id } = get();
    const found = findGroupPath(root, groupId);
    if (!found) return false;
    // 根节点是叶子 → 唯一 group，不允许关
    if (found.path.length === 0) return false;
    // 父 split 路径 = 去掉最后一步
    const parentPath = found.path.slice(0, -1);
    const lastStep = found.path[found.path.length - 1];
    const parent = nodeAtPath(root, parentPath);
    if (!parent || parent.kind !== "split") return false;
    const sibling = lastStep === "left" ? parent.right : parent.left;
    const nextRoot = replaceAtPath(root, parentPath, sibling);
    // active_group_id 是被关 group → 切到 sibling 的第一个 leaf
    let nextActive = active_group_id;
    if (active_group_id === groupId) {
      nextActive = getFirstGroupId(sibling);
    }
    set({ root: nextRoot, active_group_id: nextActive });
    schedulePersistLayout(get().root);
    return true;
  },

  setActiveGroup: (groupId) => {
    set({ active_group_id: groupId });
    schedulePersistLayout(get().root);
  },

  moveTab: (tabId, fromGroupId, toGroupId) => {
    if (fromGroupId === toGroupId) return false;
    const { root } = get();
    const from = findGroupPath(root, fromGroupId);
    const to = findGroupPath(root, toGroupId);
    if (!from || !to) return false;
    // v0.10.0 HR9-1：layout tree 只剩 terminal，type 校验恒等价 true；保留
    // 防御性比较以防未来扩 GroupType。
    if (from.leaf.group.type !== to.leaf.group.type) return false;
    if (!from.leaf.group.tab_ids.includes(tabId)) return false;

    // 先在 fromGroup 移除该 tab
    const fromGroupNext: PaneGroup = (() => {
      const g = from.leaf.group;
      const tabs = g.tab_ids.filter((id) => id !== tabId);
      let active = g.active_tab_id;
      if (active === tabId) {
        active = tabs[0] ?? null;
      }
      return { ...g, tab_ids: tabs, active_tab_id: active };
    })();
    let nextRoot = replaceAtPath(root, from.path, {
      kind: "leaf",
      group: fromGroupNext,
    });

    // 在新 tree 里找 toGroup（path 可能因为 from 替换而稳定 —— 我们是同位替换，
    // 不改 split 结构，所以原 path 还有效）
    const toAfter = findGroupPath(nextRoot, toGroupId);
    if (!toAfter) return false;
    const toGroupNext: PaneGroup = {
      ...toAfter.leaf.group,
      tab_ids: [...toAfter.leaf.group.tab_ids, tabId],
      active_tab_id: tabId,
    };
    nextRoot = replaceAtPath(nextRoot, toAfter.path, {
      kind: "leaf",
      group: toGroupNext,
    });

    set({ root: nextRoot });
    schedulePersistLayout(get().root);
    return true;
  },

  reorderTabInGroup: (groupId, fromIndex, toIndex) => {
    const { root } = get();
    const found = findGroupPath(root, groupId);
    if (!found) return;
    const g = found.leaf.group;
    const len = g.tab_ids.length;
    if (fromIndex < 0 || fromIndex >= len) return;
    if (toIndex < 0 || toIndex >= len) return;
    if (fromIndex === toIndex) return;
    const next = g.tab_ids.slice();
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    const nextGroup: PaneGroup = { ...g, tab_ids: next };
    set({
      root: replaceAtPath(root, found.path, { kind: "leaf", group: nextGroup }),
    });
    schedulePersistLayout(get().root);
  },

  splitGroupWithTab: (sourceGroupId, direction, tabId, side) => {
    const { root } = get();
    // 触达 max → 拒绝
    if (collectAllGroups(root).length >= MAX_PANE_GROUPS) {
      console.warn(
        `[pane-layout] 已达分屏上限 ${MAX_PANE_GROUPS}，拒绝新建 group`,
      );
      return null;
    }
    const found = findGroupPath(root, sourceGroupId);
    if (!found) return null;
    const g = found.leaf.group;
    if (!g.tab_ids.includes(tabId)) return null;
    // 源是唯一根 group 且只剩这一个 tab → 拒绝（避免根空）
    if (found.path.length === 0 && g.tab_ids.length <= 1) {
      console.warn(
        "[pane-layout] 拒绝拆出根 group 唯一 tab —— 这会让根 group 空白",
      );
      return null;
    }

    // 源 group 移除该 tab
    const remainingTabs = g.tab_ids.filter((id) => id !== tabId);
    let remainingActive: string | null = g.active_tab_id;
    if (remainingActive === tabId) {
      remainingActive = remainingTabs[0] ?? null;
    }
    const sourceGroupNext: PaneGroup = {
      ...g,
      tab_ids: remainingTabs,
      active_tab_id: remainingActive,
    };

    // 新 group 持有该 tab
    const newId = newGroupId();
    const newGroup: PaneGroup = {
      id: newId,
      type: "terminal",
      tab_ids: [tabId],
      active_tab_id: tabId,
    };

    // side 决定 split 顺序：left/top → 新 group 在 left；right/bottom → 新 group 在 right
    const newOnLeft = side === "left" || side === "top";
    const splitNode: LayoutNode = {
      kind: "split",
      direction,
      ratio: 0.5,
      left: newOnLeft
        ? { kind: "leaf", group: newGroup }
        : { kind: "leaf", group: sourceGroupNext },
      right: newOnLeft
        ? { kind: "leaf", group: sourceGroupNext }
        : { kind: "leaf", group: newGroup },
    };
    set({
      root: replaceAtPath(root, found.path, splitNode),
      active_group_id: newId,
    });
    schedulePersistLayout(get().root);
    return newId;
  },

  setRatio: (pathFromRoot, ratio) => {
    const { root } = get();
    const target = nodeAtPath(root, pathFromRoot);
    if (!target || target.kind !== "split") return;
    const nextSplit: LayoutNode = {
      ...target,
      ratio: clampRatio(ratio),
    };
    set({ root: replaceAtPath(root, pathFromRoot, nextSplit) });
    schedulePersistLayout(get().root);
  },

  addTabToGroup: (groupId, tabId) => {
    const { root } = get();
    const found = findGroupPath(root, groupId);
    if (!found) return;
    const g = found.leaf.group;
    if (g.tab_ids.includes(tabId)) return;
    const nextGroup: PaneGroup = {
      ...g,
      tab_ids: [...g.tab_ids, tabId],
      active_tab_id: g.active_tab_id ?? tabId,
    };
    set({
      root: replaceAtPath(root, found.path, { kind: "leaf", group: nextGroup }),
    });
    schedulePersistLayout(get().root);
  },

  removeTabFromGroup: (groupId, tabId) => {
    const { root } = get();
    const found = findGroupPath(root, groupId);
    if (!found) return;
    const g = found.leaf.group;
    const idx = g.tab_ids.indexOf(tabId);
    if (idx < 0) return;
    const nextTabs = g.tab_ids.filter((id) => id !== tabId);
    let nextActive = g.active_tab_id;
    if (g.active_tab_id === tabId) {
      // 切右边；右边没有切左边；都没有 → null
      nextActive = nextTabs[idx] ?? nextTabs[idx - 1] ?? null;
    }
    const nextGroup: PaneGroup = {
      ...g,
      tab_ids: nextTabs,
      active_tab_id: nextActive,
    };
    set({
      root: replaceAtPath(root, found.path, { kind: "leaf", group: nextGroup }),
    });
    schedulePersistLayout(get().root);
  },

  setActiveTabInGroup: (groupId, tabId) => {
    const { root } = get();
    const found = findGroupPath(root, groupId);
    if (!found) return;
    const g = found.leaf.group;
    if (!g.tab_ids.includes(tabId)) return;
    if (g.active_tab_id === tabId) return;
    const nextGroup: PaneGroup = { ...g, active_tab_id: tabId };
    set({
      root: replaceAtPath(root, found.path, { kind: "leaf", group: nextGroup }),
    });
    schedulePersistLayout(get().root);
  },

  resetLayout: (initial) =>
    set({ root: initial, active_group_id: getFirstGroupId(initial) }),
}));

/**
 * v0.10.6 HR7-6：E2E 测试钩子 —— 暴露 store getState/setState 给 Playwright，
 * 让 drag-drop spec 能直接构造预设 layout（多 group + 多 tab）做拖拽断言。
 *
 * 生产构建里这些钩子也保留——只读 / 修改自己的 store state，无副作用。
 */
if (typeof window !== "undefined") {
  (
    window as unknown as {
      __getPaneLayout: () => PaneLayoutState;
      __setPaneLayout: (next: Partial<PaneLayoutState>) => void;
    }
  ).__getPaneLayout = () => usePaneLayoutStore.getState();
  (
    window as unknown as {
      __setPaneLayout: (next: Partial<PaneLayoutState>) => void;
    }
  ).__setPaneLayout = (next) => usePaneLayoutStore.setState(next);
}
