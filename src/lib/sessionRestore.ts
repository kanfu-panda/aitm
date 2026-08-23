import type { SessionSnapshot } from "./tauri";
import {
  INITIAL_GROUP_ID,
  collectAllGroups,
  usePaneLayoutStore,
} from "../stores/pane-layout";
import { useTabsStore } from "../stores/tabs";
import { useBrowserStore } from "../stores/browser";

/**
 * 按 snapshot 把上次会话的 tab 重建出来（终端 tab + 分屏归属）。
 *
 * 从 App.tsx 的 `handleRestore` 抽出来：启动流程改成静默恢复后这段逻辑不再
 * 挂在 Dialog 的按钮上，抽成纯函数才好单测（它只碰 zustand store，不碰 React）。
 *
 * **不复用 snapshot 里的旧 tab_id**：`addTab()` 内部生成新 uuid。unread 计数和
 * 通知缓存都是按新 id 重建的，沿用旧 id 反而会串味。
 *
 * 已经有 tab 时直接返回 —— 启动流程被跑两次（StrictMode 双调用、settings
 * 重新加载）时不会把 tab 翻倍。
 */
export function restoreSnapshotTabs(snapshot: SessionSnapshot): void {
  // v1.3.2：浏览器 tab 独立恢复——终端没有 tab 不代表浏览器也没有，两者
  // 谁空谁不恢复，不能互相拖累（老 snapshot 没这个字段时是空数组，no-op）。
  useBrowserStore
    .getState()
    .restoreTabs(
      snapshot.browser_tabs ?? [],
      snapshot.active_browser_index ?? null,
    );

  if (snapshot.tabs.length === 0) return;

  const { tabs: storeTabs, addTab, setActive } = useTabsStore.getState();
  if (storeTabs.length > 0) return;

  const newIds: string[] = [];
  snapshot.tabs.forEach((t) => {
    // title 和 last_cwd 必须在**建 tab 的同一次 setState** 里带上，不能建完再补：
    // zustand 走 useSyncExternalStore，React 事件之外的更新会同步触发重渲染，
    // TerminalView 会在第一帧把 initialCwd 锁进 ref。晚一步写的 cwd 追不上，
    // PTY 就起在家目录而不是上次的目录（v1.3.2 真机 smoke 抓到的回归）。
    newIds.push(addTab({ title: t.title, lastCwd: t.cwd ?? undefined }));
  });

  // 恢复 active tab：按 snapshot.active_tab_id 在 snapshot.tabs 内的索引找
  if (snapshot.active_tab_id) {
    const idx = snapshot.tabs.findIndex(
      (t) => t.tab_id === snapshot.active_tab_id,
    );
    if (idx >= 0 && newIds[idx]) setActive(newIds[idx]);
  }

  // v0.10.0 HR9-5：按 snapshot.tabs[].group_id 把新 tab id 加进对应 group。
  //
  // 为什么这里要重建：
  //   - snapshot（last.json）和 settings.ui.pane_layout 是两份独立持久化，
  //     重启时 layout 已先 restore（resetLayout 灌 root + group 结构），但
  //     group.tab_ids 全部 sanitize 清空了（旧 uuid 全失效）。
  //   - 现在按 snapshot 记录的 group_id 把新 tab id 加进对应 group，
  //     恢复"用户当时的分屏视图"。
  //
  // fallback 链：
  //   group_id 缺省（老 snapshot）→ INITIAL_GROUP_ID
  //   group_id 在 layout 里找不到（用户已通过设置改过 layout / layout
  //     restore 失败 fallback 默认了）→ INITIAL_GROUP_ID
  //   连 INITIAL_GROUP_ID 也没有 → 第一个可用 group
  const layoutStore = usePaneLayoutStore.getState();
  const allGroups = collectAllGroups(layoutStore.root);
  const groupIdSet = new Set(allGroups.map((g) => g.id));
  const fallbackGroupId =
    (groupIdSet.has(INITIAL_GROUP_ID) ? INITIAL_GROUP_ID : allGroups[0]?.id) ??
    null;

  snapshot.tabs.forEach((t, i) => {
    const newId = newIds[i];
    if (!newId) return;
    const targetId =
      t.group_id && groupIdSet.has(t.group_id) ? t.group_id : fallbackGroupId;
    if (!targetId) return;
    layoutStore.addTabToGroup(targetId, newId);
  });
}
