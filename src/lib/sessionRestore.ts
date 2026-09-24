import {
  tmuxAttachCommand,
  tmuxListSessions,
  type SessionSnapshot,
} from "./tauri";
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
/**
 * 找出快照里哪些标签要在恢复时接回 tmux：记着会话 id、且该会话此刻仍然存在的。
 *
 * 返回 旧 tab_id → 接入命令（不含换行）。会话已被结束的不在结果里，由
 * [`restoreSnapshotTabs`] 恢复成普通标签。查询 tmux 失败（没装、服务端没起）时
 * 返回空表——恢复流程不能因为 tmux 出问题而中断。
 */
export async function resolveTmuxReattach(
  snapshot: SessionSnapshot,
): Promise<Map<string, string>> {
  const wanted = snapshot.tabs.filter((t) => t.tmux_session_id);
  const reattach = new Map<string, string>();
  if (wanted.length === 0) return reattach;
  try {
    const alive = new Set((await tmuxListSessions()).map((s) => s.id));
    for (const t of wanted) {
      const id = t.tmux_session_id as string;
      if (!alive.has(id)) continue;
      // 共享接入：不踢掉别处正连着的客户端
      reattach.set(t.tab_id, await tmuxAttachCommand(id, false));
    }
  } catch (e) {
    console.warn("[restore] 查询 tmux 会话失败，tmux 标签按普通标签恢复", e);
    return new Map();
  }
  return reattach;
}

export function restoreSnapshotTabs(
  snapshot: SessionSnapshot,
  /** [`resolveTmuxReattach`] 的结果；不传则全部按普通标签恢复。 */
  tmuxReattach: Map<string, string> = new Map(),
): void {
  // v1.4.0：浏览器 tab 独立恢复——终端没有 tab 不代表浏览器也没有，两者
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
    // PTY 就起在家目录而不是上次的目录（实测抓到的回归）。
    const lastCwd = t.cwd ?? undefined;
    const attachCmd = tmuxReattach.get(t.tab_id);
    if (attachCmd !== undefined && t.tmux_session_id) {
      // 会话还在：和面板接入走同一条路，PTY 起来后写入接入命令
      newIds.push(
        addTab({
          title: t.title,
          lastCwd,
          initialInput: `${attachCmd}\n`,
          tmuxSessionId: t.tmux_session_id,
        }),
      );
    } else if (t.tmux_session_id) {
      // 会话已经没了：恢复成普通标签，不留"tmux: xxx"这种名不副实的标题，
      // 让标题重新跟随目录
      newIds.push(addTab({ lastCwd }));
    } else {
      newIds.push(addTab({ title: t.title, lastCwd }));
    }
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
