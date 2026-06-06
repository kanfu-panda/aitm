import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// v0.10.0 HR6-3e：pane-layout 持久化 + sanitize 兜底测试。
//
// 跟 pane-layout.test.ts 拆开放：
// - pane-layout.test.ts 测纯 actions / 数据结构（不依赖其他 store）
// - 本文件测跨 store 协作（settings.update 调用 / 三 store 失效 id 过滤）

// mock analytics 避免 trackEvent 噪音
vi.mock("../lib/analytics", () => ({
  trackEvent: vi.fn(),
}));

// mock IPC settings_update 防 debounce timer 真调后端
vi.mock("../lib/tauri", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/tauri")>("../lib/tauri");
  return {
    ...actual,
    settingsGet: vi.fn().mockResolvedValue({}),
    settingsUpdate: vi.fn().mockResolvedValue(undefined),
  };
});

import { useBrowserStore } from "./browser";
import { useFileEditorStore } from "./file-editor";
import {
  collectAllGroups,
  INITIAL_GROUP_ID,
  type LayoutNode,
  PERSIST_DEBOUNCE_MS,
  sanitizeLayout,
  schedulePersistLayout,
  usePaneLayoutStore,
} from "./pane-layout";
import { useSettingsStore } from "./settings";
import { useTabsStore } from "./tabs";

/** 把 pane-layout / 三 store 都 reset 到干净状态。 */
function resetAll() {
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
  useTabsStore.setState({ tabs: [], activeId: null, unreadByTab: {} });
  useBrowserStore.setState({ tabs: [], activeKey: null, panelOpen: false });
  useFileEditorStore.setState({ openFiles: [], activeId: null });
  useSettingsStore.setState({
    settings: {
      terminal: {
        font_family: "Menlo, monospace",
        font_size: 13,
        line_height: 1.2,
        cursor_style: "block",
        theme: "default",
      },
      shell: { default_shell: "" },
      safety: { whitelist: [], show_low_auto_approved: false },
      browser: { max_active_tabs: 3, suspend_timer_minutes: 5 },
      ui: {
        activity_bar_position: "right",
        theme_mode: "dark",
        ai_sidebar_position: "right",
        file_tree_position: "left",
        file_tree_width: 240,
        ai_sidebar_width: 360,
        file_preview_dialog: null,
        confirm_quit: true,
        pane_layout: null,
        keybindings: {},
        language: "en",
      },
      notifications: { sound: true },
      privacy: { analytics_opt_in: true },
      editor: { open_files: [], active_file: null, font_size: 13 },
    },
    loaded: true,
  });
}

describe("schedulePersistLayout — debounce 写 settings.ui.pane_layout", () => {
  beforeEach(() => {
    resetAll();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it(`debounce ${PERSIST_DEBOUNCE_MS}ms 后写 settings.ui.pane_layout`, () => {
    const updateSpy = vi.spyOn(useSettingsStore.getState(), "update");
    schedulePersistLayout(usePaneLayoutStore.getState().root);
    // debounce 窗口内不应触发
    expect(updateSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const arg = updateSpy.mock.calls[0]![0];
    expect(arg).toHaveProperty("ui.pane_layout");
    // ui.pane_layout 是字符串（JSON 序列化结果）
    const ui = (arg as { ui: { pane_layout: string } }).ui;
    expect(typeof ui.pane_layout).toBe("string");
    // 能 JSON.parse 回 LayoutNode 结构
    const parsed = JSON.parse(ui.pane_layout);
    expect(parsed.kind).toBe("leaf");
    expect(parsed.group.id).toBe(INITIAL_GROUP_ID);
  });

  it("连续多次调 schedulePersist 只发一次 update（debounce 合并）", () => {
    const updateSpy = vi.spyOn(useSettingsStore.getState(), "update");
    schedulePersistLayout(usePaneLayoutStore.getState().root);
    vi.advanceTimersByTime(100);
    schedulePersistLayout(usePaneLayoutStore.getState().root);
    vi.advanceTimersByTime(100);
    schedulePersistLayout(usePaneLayoutStore.getState().root);
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS);
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });

  it("splitGroup 后触发 persist", () => {
    const updateSpy = vi.spyOn(useSettingsStore.getState(), "update");
    usePaneLayoutStore
      .getState()
      .splitGroup(INITIAL_GROUP_ID, "horizontal");
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS);
    expect(updateSpy).toHaveBeenCalled();
    const last = updateSpy.mock.calls[updateSpy.mock.calls.length - 1]![0];
    const ui = (last as { ui: { pane_layout: string } }).ui;
    const parsed = JSON.parse(ui.pane_layout);
    expect(parsed.kind).toBe("split");
  });

  it("closeGroup 后触发 persist", () => {
    const newId = usePaneLayoutStore
      .getState()
      .splitGroup(INITIAL_GROUP_ID, "horizontal");
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS);
    const updateSpy = vi.spyOn(useSettingsStore.getState(), "update");
    usePaneLayoutStore.getState().closeGroup(newId!);
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS);
    expect(updateSpy).toHaveBeenCalled();
    const last = updateSpy.mock.calls[updateSpy.mock.calls.length - 1]![0];
    const ui = (last as { ui: { pane_layout: string } }).ui;
    const parsed = JSON.parse(ui.pane_layout);
    expect(parsed.kind).toBe("leaf");
  });

  it("setRatio 后触发 persist", () => {
    usePaneLayoutStore
      .getState()
      .splitGroup(INITIAL_GROUP_ID, "horizontal");
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS);
    const updateSpy = vi.spyOn(useSettingsStore.getState(), "update");
    usePaneLayoutStore.getState().setRatio([], 0.3);
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS);
    expect(updateSpy).toHaveBeenCalled();
    const last = updateSpy.mock.calls[updateSpy.mock.calls.length - 1]![0];
    const ui = (last as { ui: { pane_layout: string } }).ui;
    const parsed = JSON.parse(ui.pane_layout);
    expect(parsed.ratio).toBeCloseTo(0.3);
  });

  it("addTabToGroup 后触发 persist", () => {
    const updateSpy = vi.spyOn(useSettingsStore.getState(), "update");
    usePaneLayoutStore.getState().addTabToGroup(INITIAL_GROUP_ID, "t1");
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS);
    expect(updateSpy).toHaveBeenCalled();
  });

  it("removeTabFromGroup 后触发 persist", () => {
    usePaneLayoutStore.getState().addTabToGroup(INITIAL_GROUP_ID, "t1");
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS);
    const updateSpy = vi.spyOn(useSettingsStore.getState(), "update");
    usePaneLayoutStore.getState().removeTabFromGroup(INITIAL_GROUP_ID, "t1");
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS);
    expect(updateSpy).toHaveBeenCalled();
  });

  it("setActiveTabInGroup 后触发 persist", () => {
    usePaneLayoutStore.getState().addTabToGroup(INITIAL_GROUP_ID, "t1");
    usePaneLayoutStore.getState().addTabToGroup(INITIAL_GROUP_ID, "t2");
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS);
    const updateSpy = vi.spyOn(useSettingsStore.getState(), "update");
    usePaneLayoutStore.getState().setActiveTabInGroup(INITIAL_GROUP_ID, "t2");
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS);
    expect(updateSpy).toHaveBeenCalled();
  });

  it("setActiveGroup 后触发 persist", () => {
    const updateSpy = vi.spyOn(useSettingsStore.getState(), "update");
    usePaneLayoutStore.getState().setActiveGroup("g-other");
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS);
    expect(updateSpy).toHaveBeenCalled();
  });

  it("moveTab 后触发 persist", () => {
    // 自定义 2 个 terminal group
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
            tab_ids: ["t1"],
            active_tab_id: "t1",
          },
        },
        right: {
          kind: "leaf",
          group: {
            id: "g-b",
            type: "terminal",
            tab_ids: [],
            active_tab_id: null,
          },
        },
      },
      active_group_id: "g-a",
    });
    const updateSpy = vi.spyOn(useSettingsStore.getState(), "update");
    usePaneLayoutStore.getState().moveTab("t1", "g-a", "g-b");
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS);
    expect(updateSpy).toHaveBeenCalled();
  });

  it("resetLayout（restore 时调）不触发 persist（避免覆盖刚 restore 的状态）", () => {
    const updateSpy = vi.spyOn(useSettingsStore.getState(), "update");
    const fresh: LayoutNode = {
      kind: "leaf",
      group: {
        id: "g-fresh",
        type: "terminal",
        tab_ids: [],
        active_tab_id: null,
      },
    };
    usePaneLayoutStore.getState().resetLayout(fresh);
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS * 3);
    expect(updateSpy).not.toHaveBeenCalled();
  });
});

describe("sanitizeLayout — tab_ids 失效兜底", () => {
  beforeEach(resetAll);

  it("terminal tab_ids 部分失效 → filter 失效项，active 失效 fallback 第一个剩余", () => {
    useTabsStore.setState({
      tabs: [
        { id: "t-alive-1", title: "a", auto_title: true, sessionId: null },
        { id: "t-alive-2", title: "b", auto_title: true, sessionId: null },
      ] as never,
      activeId: "t-alive-1",
    });
    const input: LayoutNode = {
      kind: "leaf",
      group: {
        id: "g1",
        type: "terminal",
        tab_ids: ["t-dead", "t-alive-1", "t-also-dead", "t-alive-2"],
        active_tab_id: "t-dead", // 失效 → fallback 第一个剩余 = "t-alive-1"
      },
    };
    const out = sanitizeLayout(input);
    expect(out).not.toBeNull();
    expect(out!.kind).toBe("leaf");
    if (out!.kind === "leaf") {
      expect(out!.group.tab_ids).toEqual(["t-alive-1", "t-alive-2"]);
      expect(out!.group.active_tab_id).toBe("t-alive-1");
    }
  });

  it("terminal tab_ids 全失效 → group 保留 + tab_ids 空 + active null", () => {
    // 没在 tabs store 里注册任何 tab
    const input: LayoutNode = {
      kind: "leaf",
      group: {
        id: "g-empty",
        type: "terminal",
        tab_ids: ["t-dead-1", "t-dead-2"],
        active_tab_id: "t-dead-1",
      },
    };
    const out = sanitizeLayout(input);
    expect(out).not.toBeNull();
    if (out!.kind === "leaf") {
      // group 保留（用户分屏意图保留）
      expect(out!.group.id).toBe("g-empty");
      expect(out!.group.type).toBe("terminal");
      // tab_ids 空、active null
      expect(out!.group.tab_ids).toEqual([]);
      expect(out!.group.active_tab_id).toBeNull();
    }
  });

  it("active_tab_id 在 tab_ids 内 → 保留原 active（不 fallback）", () => {
    useTabsStore.setState({
      tabs: [
        { id: "t1", title: "a", auto_title: true, sessionId: null },
        { id: "t2", title: "b", auto_title: true, sessionId: null },
      ] as never,
      activeId: "t1",
    });
    const input: LayoutNode = {
      kind: "leaf",
      group: {
        id: "g",
        type: "terminal",
        tab_ids: ["t1", "t2"],
        active_tab_id: "t2", // 仍合法
      },
    };
    const out = sanitizeLayout(input);
    if (out!.kind === "leaf") {
      expect(out!.group.active_tab_id).toBe("t2");
    }
  });

  it("v0.10.0 HR9-1：老 browser leaf 整个丢弃（type 不接受）", () => {
    // 模拟 v0.10.0 阶段 1 持久化过的 browser group
    const input = {
      kind: "leaf",
      group: {
        id: "g-browser",
        type: "browser",
        tab_ids: ["bk-1"],
        active_tab_id: "bk-1",
      },
    };
    const out = sanitizeLayout(input as unknown);
    // 整 leaf 不合法 type → 返 null（外层 fallback 默认 layout）
    expect(out).toBeNull();
  });

  it("v0.10.0 HR9-1：老 editor leaf 整个丢弃（type 不接受）", () => {
    const input = {
      kind: "leaf",
      group: {
        id: "g-editor",
        type: "editor",
        tab_ids: ["/a/foo.ts"],
        active_tab_id: "/a/foo.ts",
      },
    };
    const out = sanitizeLayout(input as unknown);
    expect(out).toBeNull();
  });

  it("v0.10.0 HR9-1：split 一边 editor 老数据 → 另一边提升占位（保留 terminal sibling）", () => {
    useTabsStore.setState({
      tabs: [
        { id: "t-alive", title: "a", auto_title: true, sessionId: null },
      ] as never,
      activeId: "t-alive",
    });
    const input = {
      kind: "split",
      direction: "horizontal",
      ratio: 0.4,
      left: {
        kind: "leaf",
        group: {
          id: "g-editor-old",
          type: "editor",
          tab_ids: ["/x.ts"],
          active_tab_id: "/x.ts",
        },
      },
      right: {
        kind: "leaf",
        group: {
          id: "g-terminal",
          type: "terminal",
          tab_ids: ["t-alive"],
          active_tab_id: "t-alive",
        },
      },
    };
    const out = sanitizeLayout(input as unknown);
    // 左侧 editor 老数据被丢 → 右侧 terminal sibling 提升为根
    expect(out).not.toBeNull();
    expect(out!.kind).toBe("leaf");
    if (out!.kind === "leaf") {
      expect(out!.group.id).toBe("g-terminal");
      expect(out!.group.type).toBe("terminal");
    }
  });

  it("嵌套 split：递归 sanitize 两个子节点", () => {
    useTabsStore.setState({
      tabs: [
        { id: "t-alive", title: "a", auto_title: true, sessionId: null },
      ] as never,
      activeId: "t-alive",
    });
    const input: LayoutNode = {
      kind: "split",
      direction: "horizontal",
      ratio: 0.5,
      left: {
        kind: "leaf",
        group: {
          id: "g-left",
          type: "terminal",
          tab_ids: ["t-dead"],
          active_tab_id: "t-dead",
        },
      },
      right: {
        kind: "leaf",
        group: {
          id: "g-right",
          type: "terminal",
          tab_ids: ["t-alive"],
          active_tab_id: "t-alive",
        },
      },
    };
    const out = sanitizeLayout(input);
    expect(out).not.toBeNull();
    expect(out!.kind).toBe("split");
    if (out!.kind === "split") {
      // 左 group tab_ids 全失效 → 仍保留，tab_ids 空
      if (out!.left.kind === "leaf") {
        expect(out!.left.group.tab_ids).toEqual([]);
        expect(out!.left.group.active_tab_id).toBeNull();
      }
      // 右 group tab_ids 合法 → 保留
      if (out!.right.kind === "leaf") {
        expect(out!.right.group.tab_ids).toEqual(["t-alive"]);
      }
    }
  });

  it("ratio 越界自动 clamp 到 [0.05, 0.95]", () => {
    const input: LayoutNode = {
      kind: "split",
      direction: "horizontal",
      ratio: -1, // 越界
      left: {
        kind: "leaf",
        group: {
          id: "ga",
          type: "terminal",
          tab_ids: [],
          active_tab_id: null,
        },
      },
      right: {
        kind: "leaf",
        group: {
          id: "gb",
          type: "terminal",
          tab_ids: [],
          active_tab_id: null,
        },
      },
    };
    const out = sanitizeLayout(input);
    if (out!.kind === "split") {
      expect(out!.ratio).toBeCloseTo(0.05);
    }
  });

  it("tree 结构无效（kind 既非 leaf 也非 split）→ 返 null", () => {
    expect(sanitizeLayout({ kind: "garbage" } as unknown)).toBeNull();
    expect(sanitizeLayout(null)).toBeNull();
    expect(sanitizeLayout("not an object" as unknown)).toBeNull();
  });

  it("leaf type 字段无效（HR9-1 仅接受 terminal）→ 返 null", () => {
    const input = {
      kind: "leaf",
      group: {
        id: "g",
        type: "unknown",
        tab_ids: [],
        active_tab_id: null,
      },
    };
    expect(sanitizeLayout(input)).toBeNull();
  });

  it("v0.10.0 HR9-1：split 一边无效 → 提升另一边占位（兼容旧 layout）", () => {
    const input = {
      kind: "split",
      direction: "horizontal",
      ratio: 0.5,
      left: { kind: "garbage" },
      right: {
        kind: "leaf",
        group: {
          id: "g",
          type: "terminal",
          tab_ids: [],
          active_tab_id: null,
        },
      },
    };
    const out = sanitizeLayout(input as unknown);
    // 一边失效 → 提升另一边（保留用户终端 sibling），不再整棵丢
    expect(out).not.toBeNull();
    expect(out!.kind).toBe("leaf");
    if (out!.kind === "leaf") {
      expect(out!.group.id).toBe("g");
    }
  });

  it("v0.10.0 HR9-1：split 两边都无效 → 返 null", () => {
    const input = {
      kind: "split",
      direction: "horizontal",
      ratio: 0.5,
      left: { kind: "garbage" },
      right: { kind: "garbage" },
    };
    expect(sanitizeLayout(input as unknown)).toBeNull();
  });

  it("split direction 无效 → 返 null", () => {
    const input = {
      kind: "split",
      direction: "diagonal",
      ratio: 0.5,
      left: {
        kind: "leaf",
        group: {
          id: "ga",
          type: "terminal",
          tab_ids: [],
          active_tab_id: null,
        },
      },
      right: {
        kind: "leaf",
        group: {
          id: "gb",
          type: "terminal",
          tab_ids: [],
          active_tab_id: null,
        },
      },
    };
    expect(sanitizeLayout(input as unknown)).toBeNull();
  });
});

describe("App 启动 restore — settings.ui.pane_layout JSON → store root", () => {
  beforeEach(() => {
    resetAll();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("有合法 persisted layout → JSON.parse + sanitize + resetLayout 灌进 store", () => {
    useTabsStore.setState({
      tabs: [{ id: "t1", title: "a", auto_title: true, sessionId: null }] as never,
      activeId: "t1",
    });
    const persisted = JSON.stringify({
      kind: "split",
      direction: "horizontal",
      ratio: 0.4,
      left: {
        kind: "leaf",
        group: {
          id: "g-left",
          type: "terminal",
          tab_ids: ["t1"],
          active_tab_id: "t1",
        },
      },
      right: {
        kind: "leaf",
        group: {
          id: "g-right",
          type: "terminal",
          tab_ids: [],
          active_tab_id: null,
        },
      },
    });
    // 模拟 App.tsx 启动 restore 流程
    const parsed: unknown = JSON.parse(persisted);
    const sanitized = sanitizeLayout(parsed);
    expect(sanitized).not.toBeNull();
    usePaneLayoutStore.getState().resetLayout(sanitized!);

    const { root, active_group_id } = usePaneLayoutStore.getState();
    expect(root.kind).toBe("split");
    if (root.kind === "split") {
      expect(root.ratio).toBeCloseTo(0.4);
    }
    // active_group_id 自动切到第一个 leaf
    expect(active_group_id).toBe("g-left");
  });

  it("JSON.parse 抛错 → 不动 store（fallback 默认）", () => {
    const before = usePaneLayoutStore.getState().root;
    // 模拟 App.tsx 的 try/catch
    let restored = false;
    try {
      JSON.parse("{not valid json");
      restored = true;
    } catch {
      // swallow
    }
    expect(restored).toBe(false);
    expect(usePaneLayoutStore.getState().root).toBe(before);
  });
});

// =============================================================================
// v0.10.0 HR9-5：snapshot.tabs[].group_id 驱动的 restore 流程
// =============================================================================
//
// 模拟 App.tsx handleRestore 的关键路径：
//   1. layout 先从 settings.ui.pane_layout restore → group 结构保留 + tab_ids
//      全部清空（旧 uuid 都失效）
//   2. snapshot 含 tabs[] + 每个 tab 的 group_id
//   3. handleRestore 给每个 snapshot.tab 调 addTab() 拿新 uuid
//   4. 按 snapshot.group_id 调 addTabToGroup(group_id, new_uuid) 重建 group
//      → tab_ids
//
// 测试这层的目的：保证 group_id 缺省 / group_id 不在 layout 的两种 fallback 路径
// 都不抛 + 仍能让 tab 落到一个合法 group 里。

describe("v0.10.0 HR9-5 — snapshot.group_id 驱动 restore", () => {
  beforeEach(resetAll);

  /**
   * 模拟 App.tsx handleRestore 的 group_id 重建逻辑（不依赖 React 渲染）。
   *
   * 流程：
   *   1. layout 已经被 resetLayout 灌进去（group 结构保留，tab_ids 已被
   *      sanitizeLayout 全部清空）
   *   2. 调 addTab() 给每个 snapshot.tab 生成新 uuid
   *   3. 按 snapshot.group_id 调 addTabToGroup 重建
   *
   * 返回 oldToNewId map 便于断言。
   */
  function simulateHandleRestore(
    snapshotTabs: Array<{ tab_id: string; group_id: string | null }>,
  ): Map<string, string> {
    const tabsStore = useTabsStore.getState();
    const oldToNewId = new Map<string, string>();
    const newIds: string[] = [];
    snapshotTabs.forEach((t) => {
      const newId = tabsStore.addTab();
      oldToNewId.set(t.tab_id, newId);
      newIds.push(newId);
    });
    const layoutStore = usePaneLayoutStore.getState();
    const allGroups = collectAllGroups(layoutStore.root);
    const groupIdSet = new Set(allGroups.map((g) => g.id));
    const fallbackGroupId =
      (groupIdSet.has(INITIAL_GROUP_ID)
        ? INITIAL_GROUP_ID
        : allGroups[0]?.id) ?? null;
    snapshotTabs.forEach((t, i) => {
      const newId = newIds[i]!;
      const targetId =
        t.group_id && groupIdSet.has(t.group_id)
          ? t.group_id
          : fallbackGroupId;
      if (!targetId) return;
      layoutStore.addTabToGroup(targetId, newId);
    });
    return oldToNewId;
  }

  it("split layout + 2 group_id → 每个 tab 按 group_id 加进对应 group", () => {
    // 1. 模拟 layout 已 restore（2 个 group，tab_ids 全空——刚 sanitize 完）
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
            tab_ids: [],
            active_tab_id: null,
          },
        },
        right: {
          kind: "leaf",
          group: {
            id: "g-right",
            type: "terminal",
            tab_ids: [],
            active_tab_id: null,
          },
        },
      },
      active_group_id: "g-left",
    });

    // 2. snapshot：3 个 tab，2 个属左 group，1 个属右 group
    const snap = [
      { tab_id: "old-a", group_id: "g-left" },
      { tab_id: "old-b", group_id: "g-right" },
      { tab_id: "old-c", group_id: "g-left" },
    ];
    const oldToNew = simulateHandleRestore(snap);

    // 3. 断言：每个 group 的 tab_ids 正确
    const groups = collectAllGroups(usePaneLayoutStore.getState().root);
    const leftG = groups.find((g) => g.id === "g-left")!;
    const rightG = groups.find((g) => g.id === "g-right")!;
    expect(leftG.tab_ids).toEqual([
      oldToNew.get("old-a"),
      oldToNew.get("old-c"),
    ]);
    expect(rightG.tab_ids).toEqual([oldToNew.get("old-b")]);
  });

  it("snapshot.tab.group_id=null（老 snapshot）→ fallback 到 INITIAL_GROUP_ID", () => {
    // initial layout：单个 root group (INITIAL_GROUP_ID)，空 tabs
    // 不动 setState，使用 resetAll 后的默认 root
    const snap = [
      { tab_id: "old-x", group_id: null },
      { tab_id: "old-y", group_id: null },
    ];
    const oldToNew = simulateHandleRestore(snap);
    const groups = collectAllGroups(usePaneLayoutStore.getState().root);
    const init = groups.find((g) => g.id === INITIAL_GROUP_ID)!;
    expect(init.tab_ids).toEqual([
      oldToNew.get("old-x"),
      oldToNew.get("old-y"),
    ]);
  });

  it("snapshot.tab.group_id 在 layout 里找不到 → fallback INITIAL_GROUP_ID", () => {
    // layout 里只有 INITIAL_GROUP_ID，snapshot 引用了不存在的 group
    const snap = [
      { tab_id: "old-x", group_id: "g-vanished" },
      { tab_id: "old-y", group_id: "g-also-gone" },
    ];
    const oldToNew = simulateHandleRestore(snap);
    const groups = collectAllGroups(usePaneLayoutStore.getState().root);
    const init = groups.find((g) => g.id === INITIAL_GROUP_ID)!;
    // 两个 tab 都被 fallback 到 INITIAL_GROUP_ID
    expect(init.tab_ids).toEqual([
      oldToNew.get("old-x"),
      oldToNew.get("old-y"),
    ]);
  });

  it("layout 里没有 INITIAL_GROUP_ID（用户自定义） → fallback 第一个 group", () => {
    // 模拟 layout 已被用户改过，没有 g-initial 这个 id
    usePaneLayoutStore.setState({
      root: {
        kind: "split",
        direction: "horizontal",
        ratio: 0.5,
        left: {
          kind: "leaf",
          group: {
            id: "g-custom-1",
            type: "terminal",
            tab_ids: [],
            active_tab_id: null,
          },
        },
        right: {
          kind: "leaf",
          group: {
            id: "g-custom-2",
            type: "terminal",
            tab_ids: [],
            active_tab_id: null,
          },
        },
      },
      active_group_id: "g-custom-1",
    });
    const snap = [
      { tab_id: "old-x", group_id: null },
      { tab_id: "old-y", group_id: "g-vanished" },
    ];
    const oldToNew = simulateHandleRestore(snap);
    // 都 fallback 到 collectAllGroups 第一个 leaf（leftmost）= g-custom-1
    const groups = collectAllGroups(usePaneLayoutStore.getState().root);
    const first = groups.find((g) => g.id === "g-custom-1")!;
    expect(first.tab_ids).toEqual([
      oldToNew.get("old-x"),
      oldToNew.get("old-y"),
    ]);
  });

  it("混合：有 group_id / 无 group_id / 不存在 group_id 三种 tab → 各自 fallback 正确", () => {
    usePaneLayoutStore.setState({
      root: {
        kind: "split",
        direction: "vertical",
        ratio: 0.5,
        left: {
          kind: "leaf",
          group: {
            id: INITIAL_GROUP_ID,
            type: "terminal",
            tab_ids: [],
            active_tab_id: null,
          },
        },
        right: {
          kind: "leaf",
          group: {
            id: "g-right",
            type: "terminal",
            tab_ids: [],
            active_tab_id: null,
          },
        },
      },
      active_group_id: INITIAL_GROUP_ID,
    });
    const snap = [
      { tab_id: "old-a", group_id: "g-right" }, // 有效
      { tab_id: "old-b", group_id: null }, // 老 snapshot → INITIAL
      { tab_id: "old-c", group_id: "g-vanished" }, // 不存在 → INITIAL
      { tab_id: "old-d", group_id: "g-right" }, // 有效
    ];
    const oldToNew = simulateHandleRestore(snap);
    const groups = collectAllGroups(usePaneLayoutStore.getState().root);
    const init = groups.find((g) => g.id === INITIAL_GROUP_ID)!;
    const right = groups.find((g) => g.id === "g-right")!;
    expect(init.tab_ids).toEqual([
      oldToNew.get("old-b"),
      oldToNew.get("old-c"),
    ]);
    expect(right.tab_ids).toEqual([
      oldToNew.get("old-a"),
      oldToNew.get("old-d"),
    ]);
  });

  it("snapshot 含 5 个 tab 跨 3 group → restore 后 tab_ids 跨 group 正确分配", () => {
    // 模拟用户分 3 屏，5 个 tab（重现 维护者 真机 image #68 的 5 group 场景的简化版）
    usePaneLayoutStore.setState({
      root: {
        kind: "split",
        direction: "horizontal",
        ratio: 0.33,
        left: {
          kind: "leaf",
          group: {
            id: "g-a",
            type: "terminal",
            tab_ids: [],
            active_tab_id: null,
          },
        },
        right: {
          kind: "split",
          direction: "horizontal",
          ratio: 0.5,
          left: {
            kind: "leaf",
            group: {
              id: "g-b",
              type: "terminal",
              tab_ids: [],
              active_tab_id: null,
            },
          },
          right: {
            kind: "leaf",
            group: {
              id: "g-c",
              type: "terminal",
              tab_ids: [],
              active_tab_id: null,
            },
          },
        },
      },
      active_group_id: "g-a",
    });
    const snap = [
      { tab_id: "t1", group_id: "g-a" },
      { tab_id: "t2", group_id: "g-a" },
      { tab_id: "t3", group_id: "g-b" },
      { tab_id: "t4", group_id: "g-c" },
      { tab_id: "t5", group_id: "g-c" },
    ];
    simulateHandleRestore(snap);
    const groups = collectAllGroups(usePaneLayoutStore.getState().root);
    const a = groups.find((g) => g.id === "g-a")!;
    const b = groups.find((g) => g.id === "g-b")!;
    const c = groups.find((g) => g.id === "g-c")!;
    expect(a.tab_ids.length).toBe(2);
    expect(b.tab_ids.length).toBe(1);
    expect(c.tab_ids.length).toBe(2);
    // 整体 = useTabsStore.tabs 5 个
    expect(useTabsStore.getState().tabs.length).toBe(5);
  });
});

// =============================================================================
// v0.10.0 HR9-5 集成：snapshot save 路径写 group_id
// =============================================================================
//
// 验证 App.tsx writeSnapshot 的关键逻辑：每个 tab 写入 snapshot 时，按当前
// pane-layout 反查它属于哪个 group 写到 tab.group_id。

describe("v0.10.0 HR9-5 — save 时按 layout 反查 tab.group_id", () => {
  beforeEach(resetAll);

  /**
   * 模拟 App.tsx writeSnapshot 里建 groupByTab 映射的逻辑。
   */
  function buildGroupByTab(): Map<string, string> {
    const map = new Map<string, string>();
    collectAllGroups(usePaneLayoutStore.getState().root).forEach((g) => {
      g.tab_ids.forEach((tid) => map.set(tid, g.id));
    });
    return map;
  }

  it("layout 里 tab 属哪个 group → groupByTab 反查正确", () => {
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
            tab_ids: ["t3"],
            active_tab_id: "t3",
          },
        },
      },
      active_group_id: "g-a",
    });
    const m = buildGroupByTab();
    expect(m.get("t1")).toBe("g-a");
    expect(m.get("t2")).toBe("g-a");
    expect(m.get("t3")).toBe("g-b");
    expect(m.size).toBe(3);
  });

  it("layout 里没有的 tab（孤儿 tab） → groupByTab 不含，writeSnapshot 写 null", () => {
    usePaneLayoutStore.setState({
      root: {
        kind: "leaf",
        group: {
          id: INITIAL_GROUP_ID,
          type: "terminal",
          tab_ids: ["t1"],
          active_tab_id: "t1",
        },
      },
      active_group_id: INITIAL_GROUP_ID,
    });
    const m = buildGroupByTab();
    expect(m.get("t1")).toBe(INITIAL_GROUP_ID);
    expect(m.get("t-orphan")).toBeUndefined();
    // 模拟 App.tsx 里的 `?? null`
    const groupIdForOrphan = m.get("t-orphan") ?? null;
    expect(groupIdForOrphan).toBeNull();
  });
});
