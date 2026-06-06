import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  collectAllGroups,
  findGroupPath,
  INITIAL_GROUP_ID,
  MAX_PANE_GROUPS,
  type LayoutNode,
  type PaneGroup,
  nodeAtPath,
  usePaneLayoutStore,
} from "./pane-layout";
import { useTabsStore } from "./tabs";

/** 把 store reset 到默认根：单个 terminal group + 空 tabs。 */
function resetStore() {
  usePaneLayoutStore.setState({
    root: {
      kind: "leaf",
      group: {
        id: INITIAL_GROUP_ID,
        type: "terminal",
        tab_ids: [],
        active_tab_id: null,
      },
    },
    active_group_id: INITIAL_GROUP_ID,
  });
}

describe("usePaneLayoutStore — 初始状态", () => {
  beforeEach(resetStore);

  it("初始 root 是单个 leaf，type=terminal，空 tabs", () => {
    const { root, active_group_id } = usePaneLayoutStore.getState();
    expect(root.kind).toBe("leaf");
    if (root.kind === "leaf") {
      expect(root.group.id).toBe(INITIAL_GROUP_ID);
      expect(root.group.type).toBe("terminal");
      expect(root.group.tab_ids).toEqual([]);
      expect(root.group.active_tab_id).toBeNull();
    }
    expect(active_group_id).toBe(INITIAL_GROUP_ID);
  });
});

describe("usePaneLayoutStore.splitGroup", () => {
  beforeEach(resetStore);

  it("splitGroup 把叶子换成 split，新建 sibling group", () => {
    const newId = usePaneLayoutStore
      .getState()
      .splitGroup(INITIAL_GROUP_ID, "horizontal");
    expect(newId).toBeTruthy();
    const { root } = usePaneLayoutStore.getState();
    expect(root.kind).toBe("split");
    if (root.kind === "split") {
      expect(root.direction).toBe("horizontal");
      expect(root.ratio).toBe(0.5);
      expect(root.left.kind).toBe("leaf");
      expect(root.right.kind).toBe("leaf");
      if (root.left.kind === "leaf" && root.right.kind === "leaf") {
        // left 保留原 group，right 是新建的同 type 空 group
        expect(root.left.group.id).toBe(INITIAL_GROUP_ID);
        expect(root.right.group.id).toBe(newId);
        expect(root.right.group.type).toBe("terminal");
        expect(root.right.group.tab_ids).toEqual([]);
        expect(root.right.group.active_tab_id).toBeNull();
      }
    }
  });

  it("splitGroup 返新 group id，新 group 是 terminal type", () => {
    // 自定义一个不同的 terminal group id
    usePaneLayoutStore.setState({
      root: {
        kind: "leaf",
        group: {
          id: "g-custom",
          type: "terminal",
          tab_ids: ["t-1"],
          active_tab_id: "t-1",
        },
      },
      active_group_id: "g-custom",
    });
    const newId = usePaneLayoutStore
      .getState()
      .splitGroup("g-custom", "vertical");
    const { root } = usePaneLayoutStore.getState();
    expect(newId).toBeTruthy();
    if (root.kind === "split") {
      expect(root.direction).toBe("vertical");
      if (root.right.kind === "leaf") {
        expect(root.right.group.type).toBe("terminal");
        expect(root.right.group.id).toBe(newId);
      }
    }
  });

  it("splitGroup 找不到目标 group → 返 null，root 不变", () => {
    const before = usePaneLayoutStore.getState().root;
    const r = usePaneLayoutStore.getState().splitGroup("nope", "horizontal");
    expect(r).toBeNull();
    expect(usePaneLayoutStore.getState().root).toBe(before);
  });

  it("嵌套 splitGroup：右边再分一次产出 3 个 leaf", () => {
    const id1 = usePaneLayoutStore
      .getState()
      .splitGroup(INITIAL_GROUP_ID, "horizontal");
    expect(id1).not.toBeNull();
    const id2 = usePaneLayoutStore.getState().splitGroup(id1!, "vertical");
    expect(id2).not.toBeNull();
    const { root } = usePaneLayoutStore.getState();
    const groups = collectAllGroups(root);
    expect(groups.map((g) => g.id)).toEqual([INITIAL_GROUP_ID, id1, id2]);
  });

  // v0.10.0 HR7-2：splitGroup / splitGroupWithNewTab 在已含 5 个 group 时拒绝
  it("splitGroup 已达 MAX_PANE_GROUPS=5 → 返 null + console.warn", () => {
    // 构造一个含 5 个 leaf 的 layout（左 4 个串联 + 右 1 个）
    const mkLeaf = (id: string): LayoutNode => ({
      kind: "leaf",
      group: { id, type: "terminal", tab_ids: [], active_tab_id: null },
    });
    const root: LayoutNode = {
      kind: "split",
      direction: "horizontal",
      ratio: 0.5,
      left: {
        kind: "split",
        direction: "horizontal",
        ratio: 0.5,
        left: {
          kind: "split",
          direction: "horizontal",
          ratio: 0.5,
          left: {
            kind: "split",
            direction: "horizontal",
            ratio: 0.5,
            left: mkLeaf("g1"),
            right: mkLeaf("g2"),
          },
          right: mkLeaf("g3"),
        },
        right: mkLeaf("g4"),
      },
      right: mkLeaf("g5"),
    };
    usePaneLayoutStore.setState({ root, active_group_id: "g1" });
    expect(collectAllGroups(root)).toHaveLength(MAX_PANE_GROUPS);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = usePaneLayoutStore.getState().splitGroup("g1", "horizontal");
      expect(r).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0]?.[0]).toContain("已达分屏上限");
      // root 不变
      expect(usePaneLayoutStore.getState().root).toBe(root);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("splitGroupWithNewTab 已达 MAX_PANE_GROUPS=5 → 返 null + console.warn", () => {
    const mkLeaf = (id: string): LayoutNode => ({
      kind: "leaf",
      group: { id, type: "terminal", tab_ids: [], active_tab_id: null },
    });
    // 5 个 leaf 的退化深度均衡树
    const root: LayoutNode = {
      kind: "split",
      direction: "horizontal",
      ratio: 0.5,
      left: {
        kind: "split",
        direction: "vertical",
        ratio: 0.5,
        left: mkLeaf("g1"),
        right: mkLeaf("g2"),
      },
      right: {
        kind: "split",
        direction: "vertical",
        ratio: 0.5,
        left: mkLeaf("g3"),
        right: {
          kind: "split",
          direction: "horizontal",
          ratio: 0.5,
          left: mkLeaf("g4"),
          right: mkLeaf("g5"),
        },
      },
    };
    usePaneLayoutStore.setState({ root, active_group_id: "g1" });
    expect(collectAllGroups(root)).toHaveLength(MAX_PANE_GROUPS);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = usePaneLayoutStore
        .getState()
        .splitGroupWithNewTab("g1", "horizontal");
      expect(r).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0]?.[0]).toContain("已达分屏上限");
      // root 不变
      expect(usePaneLayoutStore.getState().root).toBe(root);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("usePaneLayoutStore.closeGroup", () => {
  beforeEach(resetStore);

  it("closeGroup 把 sibling 替换 parent split", () => {
    const newId = usePaneLayoutStore
      .getState()
      .splitGroup(INITIAL_GROUP_ID, "horizontal");
    const ok = usePaneLayoutStore.getState().closeGroup(newId!);
    expect(ok).toBe(true);
    const { root } = usePaneLayoutStore.getState();
    expect(root.kind).toBe("leaf");
    if (root.kind === "leaf") {
      expect(root.group.id).toBe(INITIAL_GROUP_ID);
    }
  });

  it("closeGroup 唯一 group（根叶子） → 返 false 不动", () => {
    const before = usePaneLayoutStore.getState().root;
    const ok = usePaneLayoutStore.getState().closeGroup(INITIAL_GROUP_ID);
    expect(ok).toBe(false);
    expect(usePaneLayoutStore.getState().root).toBe(before);
  });

  it("closeGroup 找不到 group → 返 false", () => {
    const ok = usePaneLayoutStore.getState().closeGroup("nope");
    expect(ok).toBe(false);
  });

  it("closeGroup 被关的是 active_group → 自动切到 sibling 的第一个 leaf", () => {
    const newId = usePaneLayoutStore
      .getState()
      .splitGroup(INITIAL_GROUP_ID, "horizontal");
    usePaneLayoutStore.getState().setActiveGroup(newId);
    expect(usePaneLayoutStore.getState().active_group_id).toBe(newId);
    usePaneLayoutStore.getState().closeGroup(newId!);
    expect(usePaneLayoutStore.getState().active_group_id).toBe(
      INITIAL_GROUP_ID,
    );
  });

  it("closeGroup 嵌套：保留 sibling 子树结构", () => {
    // tree:
    //   split{H, left: A, right: split{V, left: B, right: C}}
    // 关 A → 剩 split{V, left: B, right: C}
    const id1 = usePaneLayoutStore
      .getState()
      .splitGroup(INITIAL_GROUP_ID, "horizontal");
    const id2 = usePaneLayoutStore.getState().splitGroup(id1!, "vertical");
    expect(id2).toBeTruthy();
    const ok = usePaneLayoutStore.getState().closeGroup(INITIAL_GROUP_ID);
    expect(ok).toBe(true);
    const { root } = usePaneLayoutStore.getState();
    expect(root.kind).toBe("split");
    if (root.kind === "split") {
      expect(root.direction).toBe("vertical");
      const groups = collectAllGroups(root);
      expect(groups.map((g) => g.id)).toEqual([id1, id2]);
    }
  });
});

describe("usePaneLayoutStore.setActiveGroup", () => {
  beforeEach(resetStore);

  it("setActiveGroup 修改 active_group_id", () => {
    usePaneLayoutStore.getState().setActiveGroup("xyz");
    expect(usePaneLayoutStore.getState().active_group_id).toBe("xyz");
    usePaneLayoutStore.getState().setActiveGroup(null);
    expect(usePaneLayoutStore.getState().active_group_id).toBeNull();
  });
});

describe("usePaneLayoutStore.moveTab", () => {
  /** 自定义一棵 tree：两个 terminal group，各带几个 tab。 */
  function setupTwoTerminalGroups() {
    const root: LayoutNode = {
      kind: "split",
      direction: "horizontal",
      ratio: 0.5,
      left: {
        kind: "leaf",
        group: {
          id: "g-a",
          type: "terminal",
          tab_ids: ["t1", "t2"],
          active_tab_id: "t1",
        },
      },
      right: {
        kind: "leaf",
        group: {
          id: "g-b",
          type: "terminal",
          tab_ids: ["t3"],
          active_tab_id: "t3",
        },
      },
    };
    usePaneLayoutStore.setState({ root, active_group_id: "g-a" });
  }

  it("moveTab 同 type：from 移除 + to 添加 + to.active 切到新 tab", () => {
    setupTwoTerminalGroups();
    const ok = usePaneLayoutStore.getState().moveTab("t1", "g-a", "g-b");
    expect(ok).toBe(true);
    const groups = collectAllGroups(usePaneLayoutStore.getState().root);
    const a = groups.find((g) => g.id === "g-a")!;
    const b = groups.find((g) => g.id === "g-b")!;
    expect(a.tab_ids).toEqual(["t2"]);
    expect(a.active_tab_id).toBe("t2"); // 移走 active 后切到剩下第一个
    expect(b.tab_ids).toEqual(["t3", "t1"]);
    expect(b.active_tab_id).toBe("t1"); // 移入后 active 切到新 tab
  });

  it("moveTab fromGroup 不含该 tabId → 返 false", () => {
    setupTwoTerminalGroups();
    const ok = usePaneLayoutStore.getState().moveTab("not-exist", "g-a", "g-b");
    expect(ok).toBe(false);
  });

  it("moveTab fromGroupId == toGroupId → 返 false", () => {
    setupTwoTerminalGroups();
    const ok = usePaneLayoutStore.getState().moveTab("t1", "g-a", "g-a");
    expect(ok).toBe(false);
  });

  it("moveTab 找不到 group → 返 false", () => {
    setupTwoTerminalGroups();
    expect(usePaneLayoutStore.getState().moveTab("t1", "g-a", "nope")).toBe(
      false,
    );
    expect(usePaneLayoutStore.getState().moveTab("t1", "nope", "g-b")).toBe(
      false,
    );
  });
});

// =============================================================================
// v0.10.6 HR7-6 跨 group 拖拽：reorderTabInGroup + splitGroupWithTab
// =============================================================================

describe("usePaneLayoutStore.reorderTabInGroup", () => {
  /** 单 group 含 3 个 tab 的夹具。 */
  function setupGroupWith3Tabs() {
    usePaneLayoutStore.setState({
      root: {
        kind: "leaf",
        group: {
          id: INITIAL_GROUP_ID,
          type: "terminal",
          tab_ids: ["t1", "t2", "t3"],
          active_tab_id: "t1",
        },
      },
      active_group_id: INITIAL_GROUP_ID,
    });
  }

  beforeEach(setupGroupWith3Tabs);

  it("from < to：把 tab 向后移，顺序更新；active 不变", () => {
    usePaneLayoutStore.getState().reorderTabInGroup(INITIAL_GROUP_ID, 0, 2);
    const { root } = usePaneLayoutStore.getState();
    if (root.kind === "leaf") {
      expect(root.group.tab_ids).toEqual(["t2", "t3", "t1"]);
      expect(root.group.active_tab_id).toBe("t1");
    }
  });

  it("from > to：把 tab 向前移，顺序更新；active 不变", () => {
    usePaneLayoutStore.getState().reorderTabInGroup(INITIAL_GROUP_ID, 2, 0);
    const { root } = usePaneLayoutStore.getState();
    if (root.kind === "leaf") {
      expect(root.group.tab_ids).toEqual(["t3", "t1", "t2"]);
      expect(root.group.active_tab_id).toBe("t1");
    }
  });

  it("from === to → no-op", () => {
    const before = usePaneLayoutStore.getState().root;
    usePaneLayoutStore.getState().reorderTabInGroup(INITIAL_GROUP_ID, 1, 1);
    expect(usePaneLayoutStore.getState().root).toBe(before);
  });

  it("fromIndex 越界 → no-op", () => {
    const before = usePaneLayoutStore.getState().root;
    usePaneLayoutStore.getState().reorderTabInGroup(INITIAL_GROUP_ID, 5, 0);
    expect(usePaneLayoutStore.getState().root).toBe(before);
    usePaneLayoutStore.getState().reorderTabInGroup(INITIAL_GROUP_ID, -1, 0);
    expect(usePaneLayoutStore.getState().root).toBe(before);
  });

  it("toIndex 越界 → no-op", () => {
    const before = usePaneLayoutStore.getState().root;
    usePaneLayoutStore.getState().reorderTabInGroup(INITIAL_GROUP_ID, 0, 9);
    expect(usePaneLayoutStore.getState().root).toBe(before);
  });

  it("找不到 group → no-op", () => {
    const before = usePaneLayoutStore.getState().root;
    usePaneLayoutStore.getState().reorderTabInGroup("nope", 0, 1);
    expect(usePaneLayoutStore.getState().root).toBe(before);
  });
});

describe("usePaneLayoutStore.splitGroupWithTab", () => {
  /** 两个 group 各带 2 tab。 */
  function setupTwoGroups() {
    usePaneLayoutStore.setState({
      root: {
        kind: "split",
        direction: "horizontal",
        ratio: 0.5,
        left: {
          kind: "leaf",
          group: {
            id: "g-a",
            type: "terminal",
            tab_ids: ["t1", "t2"],
            active_tab_id: "t1",
          },
        },
        right: {
          kind: "leaf",
          group: {
            id: "g-b",
            type: "terminal",
            tab_ids: ["t3", "t4"],
            active_tab_id: "t3",
          },
        },
      },
      active_group_id: "g-a",
    });
  }

  it("side=right：源 group 移除 tab + 新 group 在右创建", () => {
    setupTwoGroups();
    const newId = usePaneLayoutStore
      .getState()
      .splitGroupWithTab("g-a", "horizontal", "t1", "right");
    expect(newId).toBeTruthy();
    const groups = collectAllGroups(usePaneLayoutStore.getState().root);
    expect(groups).toHaveLength(3);
    const src = groups.find((g) => g.id === "g-a")!;
    const created = groups.find((g) => g.id === newId)!;
    expect(src.tab_ids).toEqual(["t2"]);
    expect(src.active_tab_id).toBe("t2"); // 移走 active → 切剩下第一个
    expect(created.tab_ids).toEqual(["t1"]);
    expect(created.active_tab_id).toBe("t1");
    expect(usePaneLayoutStore.getState().active_group_id).toBe(newId);
  });

  it("side=left：新 group 占 left 位置", () => {
    setupTwoGroups();
    const newId = usePaneLayoutStore
      .getState()
      .splitGroupWithTab("g-a", "horizontal", "t1", "left");
    expect(newId).toBeTruthy();
    // 找 g-a 的父 split：新建的 splitNode left 应该是 newId
    const { root } = usePaneLayoutStore.getState();
    if (root.kind === "split" && root.left.kind === "split") {
      const inner = root.left;
      expect(inner.left.kind).toBe("leaf");
      if (inner.left.kind === "leaf") {
        expect(inner.left.group.id).toBe(newId);
      }
      if (inner.right.kind === "leaf") {
        expect(inner.right.group.id).toBe("g-a");
      }
    }
  });

  it("side=top：vertical 方向，新 group 在上", () => {
    setupTwoGroups();
    const newId = usePaneLayoutStore
      .getState()
      .splitGroupWithTab("g-a", "vertical", "t1", "top");
    expect(newId).toBeTruthy();
    const { root } = usePaneLayoutStore.getState();
    if (root.kind === "split" && root.left.kind === "split") {
      expect(root.left.direction).toBe("vertical");
      if (root.left.left.kind === "leaf") {
        expect(root.left.left.group.id).toBe(newId);
      }
    }
  });

  it("side=bottom：vertical 方向，新 group 在下", () => {
    setupTwoGroups();
    const newId = usePaneLayoutStore
      .getState()
      .splitGroupWithTab("g-a", "vertical", "t1", "bottom");
    expect(newId).toBeTruthy();
    const { root } = usePaneLayoutStore.getState();
    if (root.kind === "split" && root.left.kind === "split") {
      expect(root.left.direction).toBe("vertical");
      if (root.left.right.kind === "leaf") {
        expect(root.left.right.group.id).toBe(newId);
      }
    }
  });

  it("不创建新 PTY tab（不调 useTabsStore.addTab）", () => {
    setupTwoGroups();
    // 重置 useTabsStore 到已知状态以便统计
    useTabsStore.setState({ tabs: [], activeId: null, unreadByTab: {} });
    const before = useTabsStore.getState().tabs.length;
    usePaneLayoutStore
      .getState()
      .splitGroupWithTab("g-a", "horizontal", "t1", "right");
    expect(useTabsStore.getState().tabs.length).toBe(before);
  });

  it("源 group 不含 tabId → 返 null + 无副作用", () => {
    setupTwoGroups();
    const before = usePaneLayoutStore.getState().root;
    const r = usePaneLayoutStore
      .getState()
      .splitGroupWithTab("g-a", "horizontal", "not-here", "right");
    expect(r).toBeNull();
    expect(usePaneLayoutStore.getState().root).toBe(before);
  });

  it("找不到源 group → 返 null", () => {
    setupTwoGroups();
    const before = usePaneLayoutStore.getState().root;
    const r = usePaneLayoutStore
      .getState()
      .splitGroupWithTab("nope", "horizontal", "t1", "right");
    expect(r).toBeNull();
    expect(usePaneLayoutStore.getState().root).toBe(before);
  });

  it("源是唯一根 group 且只剩 1 tab → 拒绝返 null", () => {
    usePaneLayoutStore.setState({
      root: {
        kind: "leaf",
        group: {
          id: INITIAL_GROUP_ID,
          type: "terminal",
          tab_ids: ["only"],
          active_tab_id: "only",
        },
      },
      active_group_id: INITIAL_GROUP_ID,
    });
    const before = usePaneLayoutStore.getState().root;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = usePaneLayoutStore
        .getState()
        .splitGroupWithTab(INITIAL_GROUP_ID, "horizontal", "only", "right");
      expect(r).toBeNull();
      expect(usePaneLayoutStore.getState().root).toBe(before);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("非根 group 只剩 1 tab → 允许拆（拆完源 group 会空，但非根可由 cascade 处理）", () => {
    // 边界 case：源是 split 子节点 + 只剩 1 tab → 不被根空保护拦截
    usePaneLayoutStore.setState({
      root: {
        kind: "split",
        direction: "horizontal",
        ratio: 0.5,
        left: {
          kind: "leaf",
          group: {
            id: "g-left",
            type: "terminal",
            tab_ids: ["t-only"],
            active_tab_id: "t-only",
          },
        },
        right: {
          kind: "leaf",
          group: {
            id: "g-right",
            type: "terminal",
            tab_ids: ["t-other"],
            active_tab_id: "t-other",
          },
        },
      },
      active_group_id: "g-left",
    });
    const newId = usePaneLayoutStore
      .getState()
      .splitGroupWithTab("g-left", "horizontal", "t-only", "right");
    expect(newId).toBeTruthy();
    const groups = collectAllGroups(usePaneLayoutStore.getState().root);
    expect(groups).toHaveLength(3);
    const src = groups.find((g) => g.id === "g-left")!;
    expect(src.tab_ids).toEqual([]);
  });

  it("已达 MAX_PANE_GROUPS=5 → 返 null + console.warn", () => {
    const mkLeaf = (id: string, tabs: string[] = []): LayoutNode => ({
      kind: "leaf",
      group: {
        id,
        type: "terminal",
        tab_ids: tabs,
        active_tab_id: tabs[0] ?? null,
      },
    });
    const root: LayoutNode = {
      kind: "split",
      direction: "horizontal",
      ratio: 0.5,
      left: {
        kind: "split",
        direction: "vertical",
        ratio: 0.5,
        left: mkLeaf("g1", ["t1", "t2"]),
        right: mkLeaf("g2"),
      },
      right: {
        kind: "split",
        direction: "vertical",
        ratio: 0.5,
        left: mkLeaf("g3"),
        right: {
          kind: "split",
          direction: "horizontal",
          ratio: 0.5,
          left: mkLeaf("g4"),
          right: mkLeaf("g5"),
        },
      },
    };
    usePaneLayoutStore.setState({ root, active_group_id: "g1" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = usePaneLayoutStore
        .getState()
        .splitGroupWithTab("g1", "horizontal", "t1", "right");
      expect(r).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0]?.[0]).toContain("已达分屏上限");
      expect(usePaneLayoutStore.getState().root).toBe(root);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("usePaneLayoutStore.setRatio", () => {
  beforeEach(resetStore);

  it("setRatio 沿空路径修改根 split 的 ratio", () => {
    usePaneLayoutStore.getState().splitGroup(INITIAL_GROUP_ID, "horizontal");
    usePaneLayoutStore.getState().setRatio([], 0.3);
    const { root } = usePaneLayoutStore.getState();
    if (root.kind === "split") {
      expect(root.ratio).toBeCloseTo(0.3);
    }
  });

  it("setRatio 自动夹紧到 [0.05, 0.95]", () => {
    usePaneLayoutStore.getState().splitGroup(INITIAL_GROUP_ID, "horizontal");
    usePaneLayoutStore.getState().setRatio([], -0.5);
    let r = usePaneLayoutStore.getState().root;
    if (r.kind === "split") expect(r.ratio).toBeCloseTo(0.05);

    usePaneLayoutStore.getState().setRatio([], 2);
    r = usePaneLayoutStore.getState().root;
    if (r.kind === "split") expect(r.ratio).toBeCloseTo(0.95);
  });

  it("setRatio 路径走到 leaf（非 split） → no-op", () => {
    usePaneLayoutStore.getState().splitGroup(INITIAL_GROUP_ID, "horizontal");
    const before = usePaneLayoutStore.getState().root;
    usePaneLayoutStore.getState().setRatio(["left"], 0.1); // ["left"] 走到 leaf
    expect(usePaneLayoutStore.getState().root).toBe(before);
  });

  it("setRatio 修改嵌套 split", () => {
    const id1 = usePaneLayoutStore
      .getState()
      .splitGroup(INITIAL_GROUP_ID, "horizontal");
    usePaneLayoutStore.getState().splitGroup(id1!, "vertical");
    // tree: split{H, left:LEAF, right:split{V, left:LEAF, right:LEAF}}
    usePaneLayoutStore.getState().setRatio(["right"], 0.7);
    const { root } = usePaneLayoutStore.getState();
    if (root.kind === "split" && root.right.kind === "split") {
      expect(root.right.ratio).toBeCloseTo(0.7);
    }
  });
});

describe("usePaneLayoutStore.addTabToGroup / removeTabFromGroup", () => {
  beforeEach(resetStore);

  it("addTabToGroup 给空 group 添加 + 自动设 active", () => {
    usePaneLayoutStore.getState().addTabToGroup(INITIAL_GROUP_ID, "tab-1");
    const { root } = usePaneLayoutStore.getState();
    if (root.kind === "leaf") {
      expect(root.group.tab_ids).toEqual(["tab-1"]);
      expect(root.group.active_tab_id).toBe("tab-1");
    }
  });

  it("addTabToGroup 已有 tab：append + 不抢 active", () => {
    usePaneLayoutStore.getState().addTabToGroup(INITIAL_GROUP_ID, "tab-1");
    usePaneLayoutStore.getState().addTabToGroup(INITIAL_GROUP_ID, "tab-2");
    const { root } = usePaneLayoutStore.getState();
    if (root.kind === "leaf") {
      expect(root.group.tab_ids).toEqual(["tab-1", "tab-2"]);
      expect(root.group.active_tab_id).toBe("tab-1"); // 第一个加的还是 active
    }
  });

  it("addTabToGroup 重复 tabId → 不重复添加", () => {
    usePaneLayoutStore.getState().addTabToGroup(INITIAL_GROUP_ID, "tab-1");
    usePaneLayoutStore.getState().addTabToGroup(INITIAL_GROUP_ID, "tab-1");
    const { root } = usePaneLayoutStore.getState();
    if (root.kind === "leaf") {
      expect(root.group.tab_ids).toEqual(["tab-1"]);
    }
  });

  it("removeTabFromGroup 移除非 active → tab_ids 收缩，active 不变", () => {
    usePaneLayoutStore.getState().addTabToGroup(INITIAL_GROUP_ID, "tab-1");
    usePaneLayoutStore.getState().addTabToGroup(INITIAL_GROUP_ID, "tab-2");
    usePaneLayoutStore.getState().removeTabFromGroup(INITIAL_GROUP_ID, "tab-2");
    const { root } = usePaneLayoutStore.getState();
    if (root.kind === "leaf") {
      expect(root.group.tab_ids).toEqual(["tab-1"]);
      expect(root.group.active_tab_id).toBe("tab-1");
    }
  });

  it("removeTabFromGroup 移 active → 切到列表里下一个", () => {
    usePaneLayoutStore.getState().addTabToGroup(INITIAL_GROUP_ID, "t1");
    usePaneLayoutStore.getState().addTabToGroup(INITIAL_GROUP_ID, "t2");
    usePaneLayoutStore.getState().addTabToGroup(INITIAL_GROUP_ID, "t3");
    // active = t1，移走 t1
    usePaneLayoutStore.getState().removeTabFromGroup(INITIAL_GROUP_ID, "t1");
    const { root } = usePaneLayoutStore.getState();
    if (root.kind === "leaf") {
      expect(root.group.tab_ids).toEqual(["t2", "t3"]);
      expect(root.group.active_tab_id).toBe("t2");
    }
  });

  it("removeTabFromGroup 移走最后一个 active → null", () => {
    usePaneLayoutStore.getState().addTabToGroup(INITIAL_GROUP_ID, "t1");
    usePaneLayoutStore.getState().removeTabFromGroup(INITIAL_GROUP_ID, "t1");
    const { root } = usePaneLayoutStore.getState();
    if (root.kind === "leaf") {
      expect(root.group.tab_ids).toEqual([]);
      expect(root.group.active_tab_id).toBeNull();
    }
  });
});

describe("usePaneLayoutStore.setActiveTabInGroup", () => {
  beforeEach(resetStore);

  it("setActiveTabInGroup 把 group.active_tab_id 切到指定 tab", () => {
    usePaneLayoutStore.getState().addTabToGroup(INITIAL_GROUP_ID, "t1");
    usePaneLayoutStore.getState().addTabToGroup(INITIAL_GROUP_ID, "t2");
    usePaneLayoutStore.getState().setActiveTabInGroup(INITIAL_GROUP_ID, "t2");
    const { root } = usePaneLayoutStore.getState();
    if (root.kind === "leaf") {
      expect(root.group.active_tab_id).toBe("t2");
    }
  });

  it("setActiveTabInGroup tabId 不在 group → no-op", () => {
    usePaneLayoutStore.getState().addTabToGroup(INITIAL_GROUP_ID, "t1");
    const before = usePaneLayoutStore.getState().root;
    usePaneLayoutStore
      .getState()
      .setActiveTabInGroup(INITIAL_GROUP_ID, "not-here");
    expect(usePaneLayoutStore.getState().root).toBe(before);
  });
});

describe("usePaneLayoutStore.resetLayout", () => {
  it("resetLayout 替换整棵 tree + 把 active 切到第一个 leaf", () => {
    const initial: LayoutNode = {
      kind: "split",
      direction: "vertical",
      ratio: 0.6,
      left: {
        kind: "leaf",
        group: {
          id: "g-fresh-1",
          type: "terminal",
          tab_ids: [],
          active_tab_id: null,
        },
      },
      right: {
        kind: "leaf",
        group: {
          id: "g-fresh-2",
          type: "terminal",
          tab_ids: [],
          active_tab_id: null,
        },
      },
    };
    usePaneLayoutStore.getState().resetLayout(initial);
    const { root, active_group_id } = usePaneLayoutStore.getState();
    expect(root).toEqual(initial);
    expect(active_group_id).toBe("g-fresh-1");
  });
});

describe("辅助函数 findGroupPath / collectAllGroups / nodeAtPath", () => {
  it("findGroupPath 找根叶子 → path = []", () => {
    const root: LayoutNode = {
      kind: "leaf",
      group: {
        id: "g1",
        type: "terminal",
        tab_ids: [],
        active_tab_id: null,
      },
    };
    const r = findGroupPath(root, "g1");
    expect(r).not.toBeNull();
    expect(r!.path).toEqual([]);
    expect(r!.leaf.group.id).toBe("g1");
  });

  it("findGroupPath 嵌套：返完整 left/right 路径", () => {
    const leafA: LayoutNode = {
      kind: "leaf",
      group: { id: "A", type: "terminal", tab_ids: [], active_tab_id: null },
    };
    const leafB: LayoutNode = {
      kind: "leaf",
      group: { id: "B", type: "terminal", tab_ids: [], active_tab_id: null },
    };
    const leafC: LayoutNode = {
      kind: "leaf",
      group: { id: "C", type: "terminal", tab_ids: [], active_tab_id: null },
    };
    const root: LayoutNode = {
      kind: "split",
      direction: "horizontal",
      ratio: 0.5,
      left: leafA,
      right: {
        kind: "split",
        direction: "vertical",
        ratio: 0.5,
        left: leafB,
        right: leafC,
      },
    };
    expect(findGroupPath(root, "A")!.path).toEqual(["left"]);
    expect(findGroupPath(root, "B")!.path).toEqual(["right", "left"]);
    expect(findGroupPath(root, "C")!.path).toEqual(["right", "right"]);
    expect(findGroupPath(root, "nope")).toBeNull();
  });

  it("collectAllGroups 深度优先收集 leaf", () => {
    const mk = (id: string): PaneGroup => ({
      id,
      type: "terminal",
      tab_ids: [],
      active_tab_id: null,
    });
    const root: LayoutNode = {
      kind: "split",
      direction: "horizontal",
      ratio: 0.5,
      left: { kind: "leaf", group: mk("A") },
      right: {
        kind: "split",
        direction: "vertical",
        ratio: 0.5,
        left: { kind: "leaf", group: mk("B") },
        right: { kind: "leaf", group: mk("C") },
      },
    };
    expect(collectAllGroups(root).map((g) => g.id)).toEqual(["A", "B", "C"]);
  });

  it("nodeAtPath 空路径返根；越界返 null", () => {
    const root: LayoutNode = {
      kind: "leaf",
      group: { id: "X", type: "terminal", tab_ids: [], active_tab_id: null },
    };
    expect(nodeAtPath(root, [])).toBe(root);
    // root 是 leaf 还往下走 → null
    expect(nodeAtPath(root, ["left"])).toBeNull();
  });
});

// =============================================================================
// v0.10.0 HR7-1：真独占 tabs 重构 —— splitGroupWithNewTab seed 新 tab +
// addTabToActiveGroup + closeTabInGroup
// =============================================================================

/** 测试夹具：把 useTabsStore reset 到空状态。v0.10.0 HR9-1 起 layout tree
 *  只承载 terminal，不再需要重置 browser / editor store。 */
function resetGlobalStores() {
  useTabsStore.setState({ tabs: [], activeId: null, unreadByTab: {} });
}

describe("v0.10.0 HR7-1 splitGroupWithNewTab —— seed terminal tab", () => {
  beforeEach(() => {
    resetStore();
    resetGlobalStores();
  });

  it("terminal split → 新 group 自动 seed 一个新 PTY tab（id 写进 group.tab_ids）", () => {
    const beforeTabCount = useTabsStore.getState().tabs.length;
    const newGroupId = usePaneLayoutStore
      .getState()
      .splitGroupWithNewTab(INITIAL_GROUP_ID, "horizontal");
    expect(newGroupId).toBeTruthy();

    // useTabsStore 多了一个 tab
    expect(useTabsStore.getState().tabs.length).toBe(beforeTabCount + 1);
    const newTabId = useTabsStore.getState().tabs.at(-1)!.id;

    // 新 group 的 tab_ids 含这个 tab + 已 active
    const { root, active_group_id } = usePaneLayoutStore.getState();
    expect(root.kind).toBe("split");
    if (root.kind === "split" && root.right.kind === "leaf") {
      expect(root.right.group.id).toBe(newGroupId);
      expect(root.right.group.tab_ids).toEqual([newTabId]);
      expect(root.right.group.active_tab_id).toBe(newTabId);
    }
    // 新 group 即 active
    expect(active_group_id).toBe(newGroupId);
  });

  it("两次 splitGroupWithNewTab → 共 3 个 group，各 seed 一个新 tab", () => {
    const beforeTabCount = useTabsStore.getState().tabs.length;
    const newId1 = usePaneLayoutStore
      .getState()
      .splitGroupWithNewTab(INITIAL_GROUP_ID, "horizontal");
    expect(newId1).toBeTruthy();
    const newId2 = usePaneLayoutStore
      .getState()
      .splitGroupWithNewTab(newId1!, "vertical");
    expect(newId2).toBeTruthy();
    expect(useTabsStore.getState().tabs.length).toBe(beforeTabCount + 2);
  });
});

describe("v0.10.0 HR7-1 addTabToActiveGroup", () => {
  beforeEach(() => {
    resetStore();
    resetGlobalStores();
  });

  it("active group=terminal → 同步开 PTY tab + 加进 group.tab_ids + 切 group.active_tab_id", async () => {
    const newTabId = await usePaneLayoutStore
      .getState()
      .addTabToActiveGroup();
    expect(newTabId).toBeTruthy();
    expect(useTabsStore.getState().tabs.map((t) => t.id)).toContain(newTabId!);
    const { root } = usePaneLayoutStore.getState();
    if (root.kind === "leaf") {
      expect(root.group.tab_ids).toContain(newTabId);
      expect(root.group.active_tab_id).toBe(newTabId);
    }
  });

  it("没 active_group_id → 返 null", async () => {
    usePaneLayoutStore.setState({ active_group_id: null });
    const r = await usePaneLayoutStore.getState().addTabToActiveGroup();
    expect(r).toBeNull();
  });
});

describe("v0.10.0 HR7-1 closeTabInGroup", () => {
  beforeEach(() => {
    resetStore();
    resetGlobalStores();
  });

  it("从 group 关 terminal tab → 调全局 closeTab + 从 group.tab_ids 移除", async () => {
    // 准备：active group 加 2 个 terminal tab
    const t1 = useTabsStore.getState().addTab();
    const t2 = useTabsStore.getState().addTab();
    usePaneLayoutStore.setState({
      root: {
        kind: "leaf",
        group: {
          id: INITIAL_GROUP_ID,
          type: "terminal",
          tab_ids: [t1, t2],
          active_tab_id: t1,
        },
      },
      active_group_id: INITIAL_GROUP_ID,
    });

    await usePaneLayoutStore
      .getState()
      .closeTabInGroup(INITIAL_GROUP_ID, t1);

    // 全局 store t1 已删
    expect(useTabsStore.getState().tabs.map((t) => t.id)).not.toContain(t1);
    expect(useTabsStore.getState().tabs.map((t) => t.id)).toContain(t2);
    // group.tab_ids 也移除 + active 切到 t2
    const { root } = usePaneLayoutStore.getState();
    if (root.kind === "leaf") {
      expect(root.group.tab_ids).toEqual([t2]);
      expect(root.group.active_tab_id).toBe(t2);
    }
  });

  it("非根 group 关到空 → cascade closeGroup（sibling 替换 parent）", async () => {
    // tree:split{H, left:INITIAL_GROUP[t1], right:g-extra[t2]}
    const t1 = useTabsStore.getState().addTab();
    const t2 = useTabsStore.getState().addTab();
    usePaneLayoutStore.setState({
      root: {
        kind: "split",
        direction: "horizontal",
        ratio: 0.5,
        left: {
          kind: "leaf",
          group: {
            id: INITIAL_GROUP_ID,
            type: "terminal",
            tab_ids: [t1],
            active_tab_id: t1,
          },
        },
        right: {
          kind: "leaf",
          group: {
            id: "g-extra",
            type: "terminal",
            tab_ids: [t2],
            active_tab_id: t2,
          },
        },
      },
      active_group_id: "g-extra",
    });

    // 关 g-extra 唯一 tab
    await usePaneLayoutStore.getState().closeTabInGroup("g-extra", t2);

    // g-extra 空 → cascade closeGroup → root 变成单 leaf=INITIAL_GROUP
    const { root, active_group_id } = usePaneLayoutStore.getState();
    expect(root.kind).toBe("leaf");
    if (root.kind === "leaf") {
      expect(root.group.id).toBe(INITIAL_GROUP_ID);
    }
    // active 切到剩余 sibling
    expect(active_group_id).toBe(INITIAL_GROUP_ID);
  });

  it("根 group=terminal 关到空 → 自动 seed 新 PTY tab（不让 root 空白）", async () => {
    const t1 = useTabsStore.getState().addTab();
    usePaneLayoutStore.setState({
      root: {
        kind: "leaf",
        group: {
          id: INITIAL_GROUP_ID,
          type: "terminal",
          tab_ids: [t1],
          active_tab_id: t1,
        },
      },
      active_group_id: INITIAL_GROUP_ID,
    });

    await usePaneLayoutStore
      .getState()
      .closeTabInGroup(INITIAL_GROUP_ID, t1);

    // t1 已关 + 自动开 1 个新 tab
    expect(useTabsStore.getState().tabs.length).toBe(1);
    const newTabId = useTabsStore.getState().tabs[0].id;
    expect(newTabId).not.toBe(t1);
    const { root } = usePaneLayoutStore.getState();
    if (root.kind === "leaf") {
      expect(root.group.tab_ids).toEqual([newTabId]);
      expect(root.group.active_tab_id).toBe(newTabId);
    }
  });

  it("group 不含该 tabId → no-op", async () => {
    const t1 = useTabsStore.getState().addTab();
    usePaneLayoutStore.setState({
      root: {
        kind: "leaf",
        group: {
          id: INITIAL_GROUP_ID,
          type: "terminal",
          tab_ids: [t1],
          active_tab_id: t1,
        },
      },
      active_group_id: INITIAL_GROUP_ID,
    });
    const before = usePaneLayoutStore.getState().root;
    await usePaneLayoutStore
      .getState()
      .closeTabInGroup(INITIAL_GROUP_ID, "not-here");
    expect(usePaneLayoutStore.getState().root).toBe(before);
    expect(useTabsStore.getState().tabs).toHaveLength(1); // 没关任何
  });
});
