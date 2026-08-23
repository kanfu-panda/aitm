import { beforeEach, describe, expect, it } from "vitest";

import { restoreSnapshotTabs } from "../sessionRestore";
import type { SessionSnapshot } from "../tauri";
import {
  INITIAL_GROUP_ID,
  collectAllGroups,
  usePaneLayoutStore,
} from "../../stores/pane-layout";
import { useTabsStore } from "../../stores/tabs";

/** 把两个 store 恢复到"刚启动、还没有任何 tab"的状态。 */
function resetStores() {
  useTabsStore.setState({ tabs: [], activeId: null });
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
  });
}

function makeSnapshot(
  overrides: Partial<SessionSnapshot> = {},
): SessionSnapshot {
  return {
    schema_version: 1,
    saved_at_ms: 1_700_000_000_000,
    tabs: [
      {
        tab_id: "old-1",
        title: "main",
        cwd: "/proj",
        unread: 0,
        group_id: INITIAL_GROUP_ID,
      },
      {
        tab_id: "old-2",
        title: "logs",
        cwd: "/var/log",
        unread: 3,
        group_id: INITIAL_GROUP_ID,
      },
    ],
    active_tab_id: "old-1",
    browser_tabs: [],
    active_browser_index: null,
    ...overrides,
  };
}

describe("restoreSnapshotTabs（静默恢复上次会话）", () => {
  beforeEach(resetStores);

  it("按 snapshot 顺序重建 tab，标题和 cwd 都回填", () => {
    restoreSnapshotTabs(makeSnapshot());

    const { tabs } = useTabsStore.getState();
    expect(tabs).toHaveLength(2);
    expect(tabs.map((t) => t.title)).toEqual(["main", "logs"]);
    expect(tabs.map((t) => t.last_cwd)).toEqual(["/proj", "/var/log"]);
  });

  it("不复用 snapshot 里的旧 tab_id（unread / 通知缓存已按新 id 重建）", () => {
    restoreSnapshotTabs(makeSnapshot());

    const ids = useTabsStore.getState().tabs.map((t) => t.id);
    expect(ids).not.toContain("old-1");
    expect(ids).not.toContain("old-2");
  });

  it("按 snapshot.active_tab_id 在列表里的位置还原 active", () => {
    restoreSnapshotTabs(makeSnapshot({ active_tab_id: "old-2" }));

    const { tabs, activeId } = useTabsStore.getState();
    expect(activeId).toBe(tabs[1].id);
  });

  it("已经有 tab 时不重复恢复（防止启动流程被跑两次）", () => {
    useTabsStore.getState().addTab();
    const before = useTabsStore.getState().tabs.length;

    restoreSnapshotTabs(makeSnapshot());

    expect(useTabsStore.getState().tabs).toHaveLength(before);
  });

  it("空 snapshot 什么都不做", () => {
    restoreSnapshotTabs(makeSnapshot({ tabs: [] }));

    expect(useTabsStore.getState().tabs).toHaveLength(0);
  });

  it("按 group_id 把 tab 放回对应分屏 group", () => {
    // 造一棵两 group 的树：左 g-initial，右 g-right
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
    });

    const snap = makeSnapshot();
    snap.tabs[1].group_id = "g-right";
    restoreSnapshotTabs(snap);

    const groups = collectAllGroups(usePaneLayoutStore.getState().root);
    const initial = groups.find((g) => g.id === INITIAL_GROUP_ID);
    const right = groups.find((g) => g.id === "g-right");
    expect(initial?.tab_ids).toHaveLength(1);
    expect(right?.tab_ids).toHaveLength(1);
  });

  it("group_id 在当前 layout 里找不到时兜底进 INITIAL_GROUP", () => {
    // 用户改过布局 / layout restore 失败 → snapshot 记的 group 已不存在
    const snap = makeSnapshot();
    snap.tabs.forEach((t) => {
      t.group_id = "g-已经不存在了";
    });

    restoreSnapshotTabs(snap);

    const groups = collectAllGroups(usePaneLayoutStore.getState().root);
    const initial = groups.find((g) => g.id === INITIAL_GROUP_ID);
    expect(initial?.tab_ids).toHaveLength(2);
  });
});

describe("恢复出来的 tab 一进 store 就必须带着 cwd", () => {
  beforeEach(resetStores);

  /**
   * 回归测（真机 smoke 发现）：把恢复流程从 Dialog 的点击回调挪进 async effect
   * 之后，终端起在了家目录而不是上次的目录。
   *
   * 根因是**中间态**：`addTab()` 先把 tab 放进 store，`setLastCwd()` 是紧随其后的
   * 第二次 setState。zustand 走 `useSyncExternalStore`，React 事件之外的更新会同步
   * 触发重渲染——TerminalView 因此可能在 `setLastCwd` 之前就挂载，把 `initialCwd`
   * 锁成 undefined（它用 ref 锁住首帧值，后面再改也不生效），PTY 就起在了默认目录。
   *
   * 所以断言的不是"最终有 cwd"（那样修完之前也可能过），而是**任何一个中间状态里，
   * 只要 tab 出现在 store 里，它就得已经带着 cwd**。
   */
  it("不存在「tab 已进 store 但 cwd 还没写」的中间态", () => {
    const badStates: string[] = [];
    const unsub = useTabsStore.subscribe((state) => {
      state.tabs.forEach((tab, i) => {
        // 快照里第 i 个 tab 应有 cwd；出现无 cwd 的 tab 即为坏中间态
        if (!tab.last_cwd) badStates.push(`第 ${i} 个 tab 缺 cwd`);
      });
    });

    restoreSnapshotTabs(makeSnapshot());
    unsub();

    expect(badStates).toEqual([]);
  });

  it("title 同理，不能有「先默认标题再改名」的闪烁", () => {
    const badStates: string[] = [];
    const unsub = useTabsStore.subscribe((state) => {
      state.tabs.forEach((tab) => {
        if (tab.title !== "main" && tab.title !== "logs") {
          badStates.push(`出现了非快照标题：${tab.title}`);
        }
      });
    });

    restoreSnapshotTabs(makeSnapshot());
    unsub();

    expect(badStates).toEqual([]);
  });
});
