import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type ImperativePanelGroupHandle,
  Panel,
  PanelGroup,
  PanelResizeHandle,
} from "react-resizable-panels";
import SettingsModal from "./components/SettingsModal";
import AiSidebar from "./components/AiSidebar";
import StatusBar from "./components/StatusBar";
import FileTree from "./components/FileTree";
import FilePreviewWorkspace from "./components/FilePreviewWorkspace";
import QuitConfirmDialog from "./components/QuitConfirmDialog";
import SessionRestoreDialog from "./components/SessionRestoreDialog";
import BrowserPanel from "./components/browser/BrowserPanel";
import SplitDivider from "./components/SplitDivider";
import SidebarWrapper from "./components/SidebarWrapper";
import { ActivityBar } from "./components/ActivityBar";
import { LayoutNodeRenderer } from "./components/panes/LayoutNodeRenderer";
import { PaneDndContext } from "./components/panes/PaneDndContext";
import {
  onAppCloseActiveTab,
  onBrowserHotkey,
  onBrowserUrlChanged,
  onMenuFontAction,
  onNotificationReceived,
  onPtyCwdChanged,
  sessionClose,
  sessionSnapshotClear,
  sessionSnapshotLoad,
  sessionSnapshotSave,
  setAppBadgeCount,
  type SessionSnapshot,
  type ThemeMode,
} from "./lib/tauri";
import { trackEvent } from "./lib/analytics";
import { adjustFontSize } from "./lib/font-size";
import {
  commitSidebarSettings,
  updateAiSidebarWidthLocal,
  updateFileTreeWidthLocal,
} from "./lib/sidebarResize";
import { useShortcuts } from "./lib/shortcuts";
import { useTabsStore } from "./stores/tabs";
import { useSettingsStore } from "./stores/settings";
import { useSidebarStore } from "./stores/sidebar";
import { useBrowserStore } from "./stores/browser";
import { useNotificationsStore } from "./stores/notifications";
import { useFileEditorStore } from "./stores/file-editor";
import { useFocusSurfaceStore } from "./stores/focus-surface";
import {
  usePaneLayoutStore,
  INITIAL_GROUP_ID,
  sanitizeLayout,
  collectAllGroups,
  makeDefaultRoot,
} from "./stores/pane-layout";
import {
  startBrowserSuspendTimer,
  stopBrowserSuspendTimer,
} from "./lib/browserSuspend";

export default function App() {
  const { t } = useTranslation();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const addTab = useTabsStore((s) => s.addTab);
  const fileTreeOpen = useSidebarStore((s) => s.fileTreeOpen);
  const browserPanelOpen = useBrowserStore((s) => s.panelOpen);
  // v0.4.1 T2：根据 settings.ui.activity_bar_position 切 root layout 方向。
  const activityBarPosition = useSettingsStore(
    (s) => s.settings.ui.activity_bar_position,
  );
  // v0.5.0-B B2：AiSidebar / FileTree 位置可配置（维护者 2026-05-14 提的需求）。
  const aiSidebarPosition = useSettingsStore(
    (s) => s.settings.ui.ai_sidebar_position,
  );
  const fileTreePosition = useSettingsStore(
    (s) => s.settings.ui.file_tree_position,
  );
  // v0.6.0-A T3：FileTree / AiSidebar 宽度从 settings 读，SplitDivider 拖动同步。
  const fileTreeWidth = useSettingsStore(
    (s) => s.settings.ui.file_tree_width,
  );
  const aiSidebarWidth = useSettingsStore(
    (s) => s.settings.ui.ai_sidebar_width,
  );
  const aiSidebarOpen = useSidebarStore((s) => s.open);
  // settings.browser 用于 suspend timer 参数；undefined 时（settings 未 init 完成）
  // useEffect 会用默认值跑，等 settings load 完后再 effect 重启 timer。
  const browserSettings = useSettingsStore((s) => s.settings.browser);
  // v0.10.0 HR9-1：恢复 v0.9.0 上下 split — openFiles > 0 时把终端 layout
  // tree 和 FilePreviewWorkspace 上下分屏（编辑器在下方全宽）；无 open file
  // 时纯终端 layout tree 铺满。
  const fileEditorOpenCount = useFileEditorStore((s) => s.openFiles.length);
  // v0.10.0 HR9-4：文件预览面板可临时收起（ActivityBar 切换）
  const filePreviewVisible = useSidebarStore((s) => s.filePreviewVisible);
  const fileEditorActive = fileEditorOpenCount > 0 && filePreviewVisible;

  // Phase 3A T2：全局 Cmd+B / Ctrl+B 切换左侧 FileTree 面板。
  // 在 React 层 preventDefault 不让事件冒泡传给 PTY（xterm 默认 key handler 会
  // 把 Ctrl+B 写进 stdin，被 readline 解释为光标后退）。
  //
  // v0.4.1 T5：合并 ⌘⇧L (toggleThemeMode dark↔light) 进同一个 effect。
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Cmd+B / Ctrl+B → 切 FileTree
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key === "b") {
        e.preventDefault();
        e.stopPropagation();
        useSidebarStore.getState().toggleFileTree();
        return;
      }
      // v0.4.1 T5：Cmd+Shift+L / Ctrl+Shift+L → 切 theme_mode（dark ↔ light）
      // 注意：matchMedia 在 light/dark 切换时返回的 e.key 一致；用 toLowerCase
      // 兼容 'L'（shift 默认让 e.key = 大写）。
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "l"
      ) {
        e.preventDefault();
        e.stopPropagation();
        const { settings, update } = useSettingsStore.getState();
        const cur = settings.ui.theme_mode;
        // 切换决策：
        // - dark  → light
        // - light → dark
        // - auto  → 看当前 resolved（系统态），切到反面（让用户立刻看到效果，
        //   而不是在 auto 内部"无变化")。这跟 plan §12.5 的"明确双态"对齐。
        let next: ThemeMode;
        if (cur === "dark") next = "light";
        else if (cur === "light") next = "dark";
        else {
          // auto：读 matchMedia 当前态 → 切到对立面
          const sysLight = window.matchMedia(
            "(prefers-color-scheme: light)",
          ).matches;
          next = sysLight ? "dark" : "light";
        }
        update({ ui: { theme_mode: next } });
        // v0.7.0-A：匿名统计——只传 mode 分类（"dark"/"light"/"auto"），无其他数据
        trackEvent("theme_toggled", { mode: next });
        return;
      }
      // v0.5.0-A T7：Cmd+Shift+U / Ctrl+Shift+U → 跳最近未读 tab + 同步展开 AI 侧栏
      // 差异化（vs cmux）：cmux 只跳 pane，aitm 跳 tab + 展开 AI 侧栏定位消息
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "u"
      ) {
        e.preventDefault();
        e.stopPropagation();
        const tabId = useNotificationsStore.getState().jumpToLatestUnread();
        if (tabId) {
          useTabsStore.getState().setActive(tabId);
          useSidebarStore.getState().setOpen(true);
        }
        return;
      }
      // v0.10.6 T4：Cmd++ / Cmd+- / Cmd+0 字号缩放（按 lastSurface 路由到
      // terminal / editor）。用 e.code 判物理键，对 layout 不敏感：
      // - Equal  覆盖 Cmd+= 和 Cmd+Shift+= (即 Cmd++)
      // - Minus  覆盖 Cmd+-
      // - Digit0 覆盖 Cmd+0（reset）
      // alt 必须未按（避免吃掉 Cmd+Alt+= 等其他可能的快捷键）。
      // preventDefault 抢浏览器原生 zoom（webview 默认 Cmd+= / Cmd+- / Cmd+0
      // 是 zoom in/out/reset，不抢的话页面整体缩放，而不是改字号）。
      if ((e.metaKey || e.ctrlKey) && !e.altKey) {
        if (e.code === "Equal") {
          e.preventDefault();
          e.stopPropagation();
          void adjustFontSize(+1);
          return;
        }
        if (e.code === "Minus") {
          e.preventDefault();
          e.stopPropagation();
          void adjustFontSize(-1);
          return;
        }
        if (e.code === "Digit0" && !e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          void adjustFontSize("reset");
          return;
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // v0.10.6 T4：订阅 NSMenu View > Increase/Decrease/Reset Font Size →
  // 共用 adjustFontSize handler，行为与 Cmd++/Cmd+-/Cmd+0 一致。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let alive = true;
    onMenuFontAction((action) => {
      if (!alive) return;
      const delta = action === "increase" ? +1 : action === "decrease" ? -1 : "reset";
      void adjustFontSize(delta);
    })
      .then((fn) => {
        if (alive) unlisten = fn;
        else fn();
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  // v0.10.0 HR9-11：Cmd+W 按 "lastSurface" 路由（替代 HR9-9 的 activeElement
  // 路径——维护者 真机反馈"关一个文件 tab 后再 cmd+w 无响应"）。
  //
  // 根因：document.activeElement 不稳定。close button unmount / Radix dialog
  // close / CodeMirror 切换都会让它 fall back 到 body → closest 返回 null
  // → 走错路径。
  //
  // 改用 useFocusSurfaceStore.lastSurface：各 surface 容器在 onMouseDownCapture
  // 主动 setSurface，状态稳定到用户下一次主动点别处。
  //
  // 拆 v0.9.0 H6 无脑保险丝的两条保护已经够了：
  //   - closeTabInGroup 在根 group 空时自动 seed 新 tab
  //   - HR9-8 macOS NSMenu Window > Close 不再绑 [window performClose:]
  const handleCloseActiveTab = useCallback(() => {
    const surface = useFocusSurfaceStore.getState().lastSurface;
    const editorStore = useFileEditorStore.getState();
    const editorActive = editorStore.activeId;
    const layout = usePaneLayoutStore.getState();
    const gid = layout.active_group_id;
    // v0.10.0 HR9-14：tabId 必须从 **focused group 的 active_tab_id** 取，不是
    // 全局 useTabsStore.activeId。维护者 真机 5 group 分屏每个 1 tab 时：用户切
    // group 焦点是点击 group 容器（mousedown setActiveGroup），但全局 activeId
    // 没跟着切。closeTabInGroup 内的 `g.tab_ids.includes(tabId)` 校验失败 → 直接
    // return → 维护者 看到"无响应"。最后一个 group 巧合 activeId 一致才能关。
    const focusedGroup = collectAllGroups(layout.root).find((g) => g.id === gid);
    const tabId =
      focusedGroup?.active_tab_id ?? useTabsStore.getState().activeId;
    if (surface === "editor" && editorActive) {
      // v0.10.0 HR9-13：直接调 store action，跳过 dispatch event + 中转 listener。
      // 维护者 真机 console 显示连续 6 次 Cmd+W 都 `editorActive=.zcompdump`：
      //   - FilePreviewWorkspace 的 onRequest useEffect 空 deps + 内联 requestClose
      //     闭包捕获首次 render 的 openFiles 快照
      //   - 虽然闭包里 closeFile 是 zustand action（稳定引用），但 dispatch + listener
      //     的事件中转引入了额外 race window
      // 现在直接 store.closeFile()，只在 dirty 时 fall back 到 dispatch 让 workspace
      // 弹 CloseFileConfirmDialog（dialog state 仍在 workspace 内部）。
      const f = editorStore.openFiles.find((x) => x.id === editorActive);
      if (f) {
        if (f.dirty) {
          window.dispatchEvent(
            new CustomEvent("aitm:request-close-editor-tab"),
          );
        } else {
          void editorStore.closeFile(editorActive);
        }
        return;
      }
      // editorActive 在 openFiles 里找不到（异常）→ fall through 关终端
    }
    if (gid && tabId) {
      void layout.closeTabInGroup(gid, tabId);
      return;
    }
    // fallback：没 active group 时降级到全局 closeTab（init 期 / 异常状态兜底）
    const { activeId, closeTab } = useTabsStore.getState();
    if (activeId) closeTab(activeId);
  }, []);

  // v0.10.0 HR9-12：handleCloseActiveTab 用 ref 持有最新引用，
  // listener useEffect 空 deps 只注册一次 listener，防 React StrictMode 双 mount
  // 或者 deps 突变导致 listener 重新注册时的潜在 race。
  const handleCloseActiveTabRef = useRef(handleCloseActiveTab);
  useEffect(() => {
    handleCloseActiveTabRef.current = handleCloseActiveTab;
  }, [handleCloseActiveTab]);

  // v0.10.0 HR9-8：macOS NSMenu Cmd+W 走 on_menu_event → emit "app:close-active-tab"，
  // 这里订阅并走跟 useShortcuts.closeTab 同一 handler。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let alive = true;
    onAppCloseActiveTab(() => {
      // 通过 ref 拿最新 handler；listener 自身只注册一次（空 deps）
      if (alive) handleCloseActiveTabRef.current();
    })
      .then((fn) => {
        if (alive) unlisten = fn;
        else fn();
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
    // 空 deps：listener 只注册一次；通过 ref 拿最新 handler
  }, []);

  // v0.10.3 HR9-2 扩展：所有 tab 未读总数 → macOS Dock icon 红色数字角标。
  // 跟系统 NSDockTile.setBadgeLabel 走 Tauri 2 的 setBadgeCount API。
  // 用 zustand.subscribe 在 store 变化时直接调，不通过 React render（badge
  // 不影响 UI，没必要重渲染）。
  useEffect(() => {
    const sum = (byTab: Record<string, number>): number =>
      Object.values(byTab).reduce((a, b) => a + b, 0);
    // mount 立刻 sync 一次（restore 后可能有持久 unread）
    void setAppBadgeCount(sum(useTabsStore.getState().unreadByTab));
    const unsub = useTabsStore.subscribe((state, prev) => {
      if (state.unreadByTab === prev.unreadByTab) return;
      void setAppBadgeCount(sum(state.unreadByTab));
    });
    return () => unsub();
  }, []);

  useShortcuts({
    // v0.10.0 HR7-1：Cmd+T 新 tab 走 pane-layout 路径 —— 新 tab 加进 active
    // group，而不是直接 useTabsStore.addTab()（后者只灌 useTabsStore 不更
    // group.tab_ids，分屏后会导致新 tab 不归属任何 group）。
    newTab: () => {
      void usePaneLayoutStore.getState().addTabToActiveGroup();
    },
    closeTab: handleCloseActiveTab,
    nextTab: () => {
      const { tabs, activeId, setActive } = useTabsStore.getState();
      if (tabs.length === 0) return;
      const idx = tabs.findIndex((t) => t.id === activeId);
      const next = tabs[(idx + 1) % tabs.length];
      setActive(next.id);
    },
    prevTab: () => {
      const { tabs, activeId, setActive } = useTabsStore.getState();
      if (tabs.length === 0) return;
      const idx = tabs.findIndex((t) => t.id === activeId);
      const prev = tabs[(idx - 1 + tabs.length) % tabs.length];
      setActive(prev.id);
    },
    openSettings: () => setSettingsOpen(true),
    toggleSidebar: () => useSidebarStore.getState().toggle(),
    // v0.10.0 HR9-6：Cmd+Shift+E → 切文件预览面板。
    // 跟浏览器面板 toggle 行为一致；没打开文件时也允许 toggle store 状态
    // （视觉无变化但不报错，下次开文件直接生效）。
    toggleFilePreview: () => useSidebarStore.getState().toggleFilePreview(),
    // v0.9.1 HR3-5：Cmd+Shift+B → 切浏览器面板。
    // panelOpen=true → minimizePanel（保留 tabs，仅 destroy webview）
    // panelOpen=false → restorePanel（placeholder bounds 0,0,800,600；
    //   BrowserPanel mount 后 ResizeObserver 立刻覆盖真值）
    toggleBrowser: () => {
      const store = useBrowserStore.getState();
      if (store.panelOpen) {
        void store.minimizePanel();
      } else {
        void store.restorePanel({ x: 0, y: 0, w: 800, h: 600 });
      }
    },
    // v0.10.0 HR6-3d / HR7-1：Cmd+\\ → 左右分屏。
    // direction="horizontal"：LayoutNode 模型中 `horizontal` 表示 left/right 并排。
    // HR7-1 改用 splitGroupWithNewTab：新 group 自动 seed 一个新 PTY tab（避免
    // HR6-3b 共享 fallback 时"两边镜像同样 tabs"的 bug，符合 VS Code editor
    // groups / iTerm2 / tmux 行为）。
    splitVertical: () => {
      const { active_group_id, splitGroupWithNewTab } =
        usePaneLayoutStore.getState();
      if (active_group_id) splitGroupWithNewTab(active_group_id, "horizontal");
    },
    // v0.10.0 HR6-3d / HR7-1：Cmd+Shift+\\ → 上下分屏。同上 splitGroupWithNewTab。
    splitHorizontal: () => {
      const { active_group_id, splitGroupWithNewTab } =
        usePaneLayoutStore.getState();
      if (active_group_id) splitGroupWithNewTab(active_group_id, "vertical");
    },
    // v0.10.0 HR6-3d：Cmd+Shift+W → 关 active group。
    // 根节点 / 唯一 group 时 closeGroup 返 false，silent no-op（只 warn 不弹 UI）。
    // 与 Cmd+W（无 shift，关 tab）独立，不冲突。
    closePane: () => {
      const { active_group_id, closeGroup } = usePaneLayoutStore.getState();
      if (!active_group_id) return;
      const ok = closeGroup(active_group_id);
      if (!ok) {
        // 唯一 group 不可关；future 任务可加 toast 提示，当前 silent
        console.warn("[HR6-3d] 无法关 active group：唯一 group 不可关");
      }
    },
  });

  // 启动时拉一次后端 settings
  useEffect(() => {
    void (async () => {
      await useSettingsStore.getState().init();
      // v0.9.0 T5b：settings 拉到后按 settings.editor 恢复编辑器 tabs。
      // restoreFromSettings 内部对单个文件 read 失败静默跳过；
      // 不阻塞 App 启动，所以这里 fire-and-forget。
      const { editor } = useSettingsStore.getState().settings;
      if (editor.open_files.length > 0) {
        void useFileEditorStore
          .getState()
          .restoreFromSettings(editor.open_files, editor.active_file);
      }
      // v0.10.0 HR6-3e：settings 拉到后还原 pane-layout tree。
      //
      // 注意：editor.restoreFromSettings 上面是 async fire-and-forget，编辑器
      // tab 的 id 可能还没全部 reopen 到 useFileEditorStore；此时 sanitize
      // 看不到 editor tab，filter 会把 editor group 的 tab_ids 清空。这是
      // **可接受的**：editor group 保留（用户分屏意图保留），等 editor
      // restore 完后 store 里有 tab 时由 useFileEditorStore 自己去 addTab
      // 到对应 group。terminal / browser 启动时还没有任何 tab，restore 出来
      // 的 terminal group tab_ids 自然全是空 — 等下面 syncToInitialGroup
      // 把全局 tabs 灌进 INITIAL_GROUP。
      const persisted = useSettingsStore.getState().settings.ui.pane_layout;
      if (persisted) {
        try {
          const parsed: unknown = JSON.parse(persisted);
          const sanitized = sanitizeLayout(parsed);
          if (sanitized) {
            usePaneLayoutStore.getState().resetLayout(sanitized);
          }
        } catch (e) {
          console.warn(
            "[HR6-3e] pane_layout restore 失败，fallback 默认布局",
            e,
          );
        }
      }
    })();
  }, []);

  // v0.10.0 HR6-3c：把现有 tabs 灌进 layout tree 的 INITIAL_GROUP，单 group
  // 模式 = 视觉等同 v0.9.x 单屏。layout tree 模型未启用 split 时这一步保证
  // TerminalPaneGroup 的 group.tab_ids 跟全局 tabs 同步，active 也跟着切。
  //
  // 订阅 tabs store：
  //   tabs 数组变化时（addTab / closeTab）→ 同步到 initial group 的 tab_ids
  //   activeId 变化时 → 同步到 initial group 的 active_tab_id
  //
  // 阶段 2 拖拽到独立 group 时，这套"全屋同步"策略会改成 per-group 独立 tab 子集。
  useEffect(() => {
    const syncToInitialGroup = () => {
      const { tabs: t, activeId: aid } = useTabsStore.getState();
      const layout = usePaneLayoutStore.getState();
      const found = (() => {
        const root = layout.root;
        if (root.kind === "leaf" && root.group.id === INITIAL_GROUP_ID) {
          return root.group;
        }
        return null;
      })();
      if (!found) return;
      // 一次性 setState：把 root.group 的 tab_ids / active_tab_id 同步
      const tabIds = t.map((x) => x.id);
      const sameTabs =
        tabIds.length === found.tab_ids.length &&
        tabIds.every((id, i) => found.tab_ids[i] === id);
      const sameActive = (found.active_tab_id ?? null) === (aid ?? null);
      if (sameTabs && sameActive) return;
      usePaneLayoutStore.setState({
        root: {
          kind: "leaf",
          group: {
            ...found,
            tab_ids: tabIds,
            active_tab_id: aid ?? null,
          },
        },
      });
    };
    // 首帧同步一次（即使空 tabs 也要让 group.active_tab_id = null 保持一致）
    syncToInitialGroup();
    return useTabsStore.subscribe(syncToInitialGroup);
  }, []);

  // v0.5.0-D：启动 snapshot 流程
  // - 第一阶段：拉 snapshot；snapshot 存在 → 弹 SessionRestoreDialog；不存在 → 直接开 1 空 tab
  // - 用户点"恢复" → 按 snapshot 加 tabs
  // - 用户点"全新" → 清 snapshot + 开 1 空 tab
  // - 用户点"跳过" / 关 dialog → 不清 snapshot + 开 1 空 tab（保留下次再决定）
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [snapshotResolved, setSnapshotResolved] = useState(false);

  useEffect(() => {
    let alive = true;
    sessionSnapshotLoad()
      .then((s) => {
        if (!alive) return;
        if (s && s.tabs.length > 0) {
          setSnapshot(s);
        } else {
          setSnapshotResolved(true); // 无 snapshot → 直接走默认路径
        }
      })
      .catch(() => {
        if (alive) setSnapshotResolved(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  // snapshotResolved 后才开默认 tab（避免还没决定就先开了）
  useEffect(() => {
    if (!snapshotResolved) return;
    if (useTabsStore.getState().tabs.length === 0) {
      addTab();
    }
  }, [snapshotResolved, addTab]);

  const handleRestore = () => {
    if (!snapshot) return;
    const { tabs: storeTabs, addTab: addOne, setTitle, setActive, setLastCwd } =
      useTabsStore.getState();
    if (storeTabs.length === 0) {
      // 按 snapshot 顺序逐个加；每个 addTab 内部生成新 uuid（snapshot 里的旧
      // tab_id 不复用——unread / notification cache 已按新 id 重建）。
      const newIds: string[] = [];
      snapshot.tabs.forEach((t) => {
        const newId = addOne();
        newIds.push(newId);
        setTitle(newId, t.title);
        // v0.9.1 HR3-1：回填 last_cwd，TerminalView 起 PTY 时把它传给后端 cfg.cwd
        if (t.cwd) setLastCwd(newId, t.cwd);
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
      //
      // 触发副作用：每次 addTabToGroup 都会 schedulePersistLayout，会有 N 次
      // debounce → 1 次 settings.update（合并），可接受。
      const layoutStore = usePaneLayoutStore.getState();
      const allGroups = collectAllGroups(layoutStore.root);
      const groupIdSet = new Set(allGroups.map((g) => g.id));
      const fallbackGroupId =
        (groupIdSet.has(INITIAL_GROUP_ID)
          ? INITIAL_GROUP_ID
          : allGroups[0]?.id) ?? null;

      snapshot.tabs.forEach((t, i) => {
        const newId = newIds[i];
        if (!newId) return;
        const targetId =
          t.group_id && groupIdSet.has(t.group_id)
            ? t.group_id
            : fallbackGroupId;
        if (!targetId) return;
        layoutStore.addTabToGroup(targetId, newId);
      });
    }
    setSnapshot(null);
    setSnapshotResolved(true);
  };

  const handleFresh = () => {
    // v0.10.0 HR9-7：真的"从零开始" —— 之前只清 sessionSnapshot，layout 和
    // file-editor 持久化在 settings.toml 里都没动 → 用户重启后看到的是上次
    // 5 group 空骨架 + 上次的文件预览 tab（真机 维护者 反馈过）。
    // Fresh 路径应该同时清三份持久化：sessionSnapshot + pane_layout + editor.
    void sessionSnapshotClear();
    usePaneLayoutStore.getState().resetLayout(makeDefaultRoot());
    useFileEditorStore.setState({
      openFiles: [],
      activeId: null,
      maximized: false,
    });
    // 同步 settings.editor 持久化（store setState 不会自动持久化）
    void useSettingsStore.getState().update({
      editor: { open_files: [], active_file: null },
    });
    setSnapshot(null);
    setSnapshotResolved(true);
  };

  const handleSkip = () => {
    // 不清 snapshot，下次启动还会弹（plan §0.4）
    setSnapshot(null);
    setSnapshotResolved(true);
  };

  // v0.5.0-D T4：tab 变化 → debounced 1s 写 snapshot
  // snapshot 还没决定（用户未点 Dialog）时不写，避免把空 / 默认状态盖掉记录
  useEffect(() => {
    if (!snapshotResolved) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const writeSnapshot = async () => {
      const state = useTabsStore.getState();
      const unread = state.unreadByTab;
      // v0.10.0 HR9-5：建 tab.id → group.id 反查表。
      // 每个 tab 知道自己属于哪个 group 后存进 snapshot.group_id，重启时
      // handleRestore 按 group_id 把新 tab id 加进对应 group，恢复分屏视图。
      const groupByTab = new Map<string, string>();
      collectAllGroups(usePaneLayoutStore.getState().root).forEach((g) => {
        g.tab_ids.forEach((tid) => groupByTab.set(tid, g.id));
      });
      const snap: SessionSnapshot = {
        schema_version: 1,
        saved_at_ms: Date.now(),
        tabs: state.tabs.map((t) => ({
          tab_id: t.id,
          title: t.title,
          // v0.9.1 HR3-1：持久化 last_cwd（OSC 7 实时同步，关 tab 前最后一次值保留）。
          // 回退到当前 cwd 兼容已开但还没收 OSC 7 的极端 case；都没有写 null。
          cwd: t.last_cwd ?? t.cwd ?? null,
          unread: unread[t.id] ?? 0,
          group_id: groupByTab.get(t.id) ?? null,
        })),
        active_tab_id: state.activeId,
      };
      try {
        await sessionSnapshotSave(snap);
      } catch (e) {
        console.warn("saveSnapshot 失败（不阻塞）", e);
      }
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(writeSnapshot, 1000);
    };
    // store 任意变化都 schedule
    const unsub = useTabsStore.subscribe(schedule);
    // 5 min 兜底（防 app 强 kill 没收到 store 变化）
    const interval = setInterval(writeSnapshot, 5 * 60 * 1000);
    // window close 同步写一次
    const onBeforeUnload = () => {
      void writeSnapshot();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
      clearInterval(interval);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [snapshotResolved]);

  // 关 tab 时关 session（订阅 store 变化）
  useEffect(() => {
    return useTabsStore.subscribe((state, prev) => {
      const closed = prev.tabs.filter((p) => !state.tabs.some((t) => t.id === p.id));
      for (const t of closed) {
        if (t.sessionId) {
          sessionClose(t.sessionId).catch(() => {});
        }
      }
    });
  }, []);

  // Phase 4A T4 + T5：浏览器 tab 自动 suspend 定时器。
  // settings.browser 变化（用户在"浏览器"tab 改了 max_active_tabs / 失焦超时）
  // → useEffect 重启 timer 用新参数。settings 未 init 时取默认值 3 / 5。
  useEffect(() => {
    const max = browserSettings?.max_active_tabs ?? 3;
    const minutes = browserSettings?.suspend_timer_minutes ?? 5;
    startBrowserSuspendTimer({
      maxActive: max,
      suspendTimerMs: minutes * 60 * 1000,
    });
    return () => stopBrowserSuspendTimer();
  }, [
    browserSettings?.max_active_tabs,
    browserSettings?.suspend_timer_minutes,
  ]);

  // Phase 4A T5：订阅 browser:hotkey 事件 — 子 webview 内 inject script 捕获到
  // Cmd+B/T/W/P/, 时通过 IPC 转发上来；模拟主 webview 收到这些 hotkey 的行为。
  // 因为 native webview 在原生层覆盖在 React UI 之上，主 webview 的全局
  // keydown 听不到 webview 内的按键（焦点在原生层）。
  // v0.5.0-A T4：订阅后端 notification:received（OSC 解析 + AI 工具循环触发的统一通道）。
  // session_id → tabId 路由通过 useTabsStore 当前快照查 sessionId 等于 payload.session_id 的 tab。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let alive = true;
    onNotificationReceived((payload) => {
      if (!alive) return;
      const tab = useTabsStore
        .getState()
        .tabs.find((t) => t.sessionId === payload.session_id);
      if (!tab) return;
      // active tab 的通知**仍记录**到 store（系统通知由 store 内部判 running 跳过），
      // 但 UI 状态环不会显示（v0.5.0-A 设计：active 已经"被看着"无需提示，
      // setActive 时 clearTab 也会清掉）。
      useNotificationsStore.getState().emitNotification(tab.id, {
        session_id: payload.session_id,
        level: payload.level,
        message: payload.message,
        source: payload.source,
        timestamp_ms: payload.timestamp_ms,
      });
    })
      .then((u) => {
        if (alive) unlisten = u;
        else u();
      })
      .catch(() => {
        // 监听注册失败：fail-soft，通知功能降级（tab ring 不工作，但不影响主功能）
      });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  // v0.5.8：订阅 browser:url_changed 同步 zustand tabs[].url（避免 AI 工具调
  // wv.navigate 后 URL 栏不刷新）
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let alive = true;
    onBrowserUrlChanged((e) => {
      if (!alive) return;
      useBrowserStore.getState().applyUrlChanged(e.tab_id, e.url);
    })
      .then((u) => {
        if (alive) unlisten = u;
        else u();
      })
      .catch(() => {
        // 监听注册失败：fail-soft，AI 工具 navigate 后 URL 栏仍跟旧 URL（不致命）
      });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  // v0.9.0 T3：订阅后端 OSC 7 解析事件 → 更新 tab cwd + auto_title 时同步 title。
  // 路由：按 sessionId 找 tab。tabs store 内部判 auto_title 决定是否覆盖 title。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let alive = true;
    onPtyCwdChanged((e) => {
      if (!alive) return;
      useTabsStore.getState().applyCwdChange(e.session_id, e.cwd);
    })
      .then((u) => {
        if (alive) unlisten = u;
        else u();
      })
      .catch(() => {
        // 注册失败：fail-soft，tab title 不再自动跟 cwd（用户仍可双击重命名）
      });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let alive = true;
    onBrowserHotkey((e) => {
      if (!alive) return;
      if (!e.meta && !e.ctrl) return;
      const key = e.key.toLowerCase();
      if (key === "b") {
        useSidebarStore.getState().toggleFileTree();
      } else if (key === ",") {
        setSettingsOpen(true);
      } else if (key === "t") {
        useTabsStore.getState().addTab();
      } else if (key === "w") {
        const { activeId, closeTab } = useTabsStore.getState();
        if (activeId) closeTab(activeId);
      }
      // Cmd+P 留给 v0.4.x 命令面板；当前不动作
    })
      .then((u) => {
        if (alive) unlisten = u;
        else u();
      })
      .catch(() => {
        // 监听注册失败：fail-soft，主 webview 内的 hotkey 仍然走全局 keydown handler
      });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  // v0.4.1 T2：root layout 按 ActivityBar position 切 row/col。
  // 主轴 = 图标"沿着哪个方向排"——right/left 走纵向（vertical bar），
  // top/bottom 走横向（horizontal bar）。bar 在 left/top 时排在内容区**前**，
  // 在 right/bottom 时排在**后**——保证位置和"用户视觉认知的左/右/上/下"对齐。
  const isVerticalBar =
    activityBarPosition === "left" || activityBarPosition === "right";
  const barFirst =
    activityBarPosition === "left" || activityBarPosition === "top";

  // v0.4.1 T2：原顶部 inline 🌐/⚙ 按钮已移到 ActivityBar；TabBar 自占 main 顶部一行。
  const mainContent = (
    <main className="flex h-full min-w-0 min-h-0 flex-1 flex-col bg-[var(--c-bg-base)] text-[var(--c-text-base)]">
      {/* 上半区：FileTree + 终端 / 浏览器分屏 + AI 侧栏。
          v0.5.0-B B2：FileTree / AiSidebar 位置可配置（左 / 右）；ActivityBar
          仍在 root layout 外层最外侧。AiSidebar 自己判 open 状态决定是否显示宽度，
          FileTree 由 App.tsx 这里条件渲染（fileTreeOpen）。
          v0.6.0-A T3：FileTree↔主区、主区↔AiSidebar 两条 boundary 加 SplitDivider；
          宽度从 settings.ui 读，拖动直接 setState（不 IPC），mouseup 调 settingsUpdate
          持久化 TOML。SidebarWrapper 提供 position: relative 让 SplitDivider 锚定。 */}
      <div className="flex min-h-0 flex-1">
        {fileTreePosition === "left" && fileTreeOpen && (
          <SidebarWrapper
            width={fileTreeWidth}
            borderSide="right"
            data-testid="file-tree-wrapper"
          >
            <FileTree />
            {/* FileTree 在左：分割条贴在它右沿；鼠标向右拖 → FileTree 变宽，
                SplitDivider 公式语义 direction="right"（+delta）。 */}
            <SplitDivider
              value={fileTreeWidth}
              defaultValue={240}
              direction="right"
              min={180}
              max={600}
              ariaLabel={t("splitDivider.fileTreeWidth")}
              className="-right-0.5"
              onChange={(next) => updateFileTreeWidthLocal(next)}
              onCommit={() => commitSidebarSettings()}
            />
          </SidebarWrapper>
        )}
        {aiSidebarPosition === "left" && aiSidebarOpen && (
          <SidebarWrapper
            width={aiSidebarWidth}
            borderSide="right"
            data-testid="ai-sidebar-wrapper"
          >
            <AiSidebar />
            {/* AiSidebar 在左：分割条贴右沿；鼠标向右拖 → AiSidebar 变宽，
                公式 direction="right"。 */}
            <SplitDivider
              value={aiSidebarWidth}
              defaultValue={360}
              direction="right"
              min={180}
              max={600}
              ariaLabel={t("splitDivider.aiSidebarWidth")}
              className="-right-0.5"
              onChange={(next) => updateAiSidebarWidthLocal(next)}
              onCommit={() => commitSidebarSettings()}
            />
          </SidebarWrapper>
        )}
        {/* v0.10.0 HR9-1：中央主区改回 v0.9.0 上下 split 模式。
            - layout tree 只承载 terminal 分屏（max 5）
            - FilePreviewWorkspace 是全局单例，openFiles > 0 时上下 split 出现
              在下方（55/45 默认，最小 15）；无 open file 时纯终端铺满
            - 浏览器面板浮在右侧（Cmd+Shift+B 切换）维持现状
            - tab bar 由 TerminalPaneGroup 内部渲染（VS Code 风格 per-group tab bar） */}
        {/* v0.10.6 HR7-6：主区 PanelGroup 外层包 PaneDndContext，给所有
            TerminalPaneGroup 内的 tab 提供跨 group 拖拽能力。 */}
        <PaneDndContext>
          <PanelGroup
            direction="horizontal"
            autoSaveId="aitm-main-split-v2"
            className="flex flex-1 min-w-0"
          >
            <Panel defaultSize={browserPanelOpen ? 60 : 100} minSize={20}>
              <div className="flex h-full flex-col min-w-0">
                <CentralMainArea fileEditorActive={fileEditorActive} />
              </div>
            </Panel>
            {browserPanelOpen && (
              <PanelResizeHandle
                className="w-1 bg-[var(--c-border)] hover:bg-[var(--c-border-strong)] transition-colors"
                aria-label={t("splitDivider.terminalBrowserRatio")}
              />
            )}
            {browserPanelOpen && (
              <Panel defaultSize={40} minSize={20}>
                <BrowserPanel />
              </Panel>
            )}
          </PanelGroup>
        </PaneDndContext>
        {aiSidebarPosition === "right" && aiSidebarOpen && (
          <SidebarWrapper
            width={aiSidebarWidth}
            borderSide="left"
            data-testid="ai-sidebar-wrapper"
          >
            <AiSidebar />
            {/* AiSidebar 在右：分割条贴左沿；鼠标向右拖 → AiSidebar 变窄，
                公式 direction="left"（-delta）。 */}
            <SplitDivider
              value={aiSidebarWidth}
              defaultValue={360}
              direction="left"
              min={180}
              max={600}
              ariaLabel={t("splitDivider.aiSidebarWidth")}
              className="-left-0.5"
              onChange={(next) => updateAiSidebarWidthLocal(next)}
              onCommit={() => commitSidebarSettings()}
            />
          </SidebarWrapper>
        )}
        {fileTreePosition === "right" && fileTreeOpen && (
          <SidebarWrapper
            width={fileTreeWidth}
            borderSide="left"
            data-testid="file-tree-wrapper"
          >
            <FileTree />
            {/* FileTree 在右：分割条贴左沿；鼠标向右拖 → FileTree 变窄，
                公式 direction="left"。 */}
            <SplitDivider
              value={fileTreeWidth}
              defaultValue={240}
              direction="left"
              min={180}
              max={600}
              ariaLabel={t("splitDivider.fileTreeWidth")}
              className="-left-0.5"
              onChange={(next) => updateFileTreeWidthLocal(next)}
              onCommit={() => commitSidebarSettings()}
            />
          </SidebarWrapper>
        )}
      </div>
      <StatusBar />
    </main>
  );

  const activityBar = (
    <ActivityBar
      position={activityBarPosition}
      onSettingsOpen={() => setSettingsOpen(true)}
    />
  );

  return (
    <div
      className={
        "flex h-screen w-screen bg-[var(--c-bg-base)] text-[var(--c-text-base)] " +
        (isVerticalBar ? "flex-row" : "flex-col")
      }
    >
      {barFirst && activityBar}
      {mainContent}
      {!barFirst && activityBar}
      <SettingsModal open={settingsOpen} onOpenChange={setSettingsOpen} />
      {/* v0.9.0 H5：FilePreviewDialog 不再挂载（被 FilePreviewWorkspace tab 取代）
          组件文件保留待后续清理；移除挂载是为修真机"点文件同时弹旧 dialog + 新 tab"bug */}
      <SessionRestoreDialog
        snapshot={snapshot}
        onRestore={handleRestore}
        onFresh={handleFresh}
        onSkip={handleSkip}
      />
      {/* v0.9.0 T4：监听后端 app:confirm-quit-requested 事件，弹关闭确认 dialog */}
      <QuitConfirmDialog />
    </div>
  );
}

/**
 * v0.10.6 T3：中央主区终端 + 文件编辑器上下 split。
 *
 * 历史：v0.10.0 HR9-1 重构把这块从 layout tree split 模式改回 v0.9.0 的
 * 上下分屏，但**连带删除**了 App.tsx 对 `useFileEditorStore.maximized` 的
 * 消费点 —— store action 和 UI handler 都还在，渲染层却完全没读 maximized。
 * 双击 active tab 调 toggleMaximized 改了 store，PanelGroup 比例却纹丝不动 →
 * 维护者 真机反馈 regression。
 *
 * 修复方案（imperativePanelApi 路线）：
 * - 用 `useRef<ImperativePanelGroupHandle>` 拿到 PanelGroup 实例
 * - useEffect 订阅 maximized：true → setLayout([0, 100])，false → 恢复
 * - 用 `preMaxLayoutRef` 记忆 maximize 之前的比例，restore 时回放
 * - 不能用条件 unmount PanelGroup 来"重建结构"——xterm.js 实例会重建，
 *   PTY 输出 ring buffer 还在但 viewport 会丢已渲染内容。imperativePanelApi
 *   改比例不重建子组件，xterm 保活。
 *
 * fileEditorActive=false 时（openFiles 为空 / FilePreview 收起）切到无
 * PanelGroup 的纯终端分支；file-editor.ts:275 closeFile 时已经把 maximized
 * 同步重置为 false，preMaxLayoutRef 在组件 unmount 自然 GC。
 */
export function CentralMainArea({
  fileEditorActive,
}: {
  fileEditorActive: boolean;
}) {
  const { t } = useTranslation();
  const maximized = useFileEditorStore((s) => s.maximized);
  const panelGroupRef = useRef<ImperativePanelGroupHandle>(null);
  // 用 useRef 而不是 useState：写入 maximize 前比例不应触发重渲染
  const preMaxLayoutRef = useRef<number[] | null>(null);

  useEffect(() => {
    const g = panelGroupRef.current;
    if (!g || !fileEditorActive) return;
    if (maximized) {
      preMaxLayoutRef.current = g.getLayout();
      g.setLayout([0, 100]);
    } else if (preMaxLayoutRef.current) {
      g.setLayout(preMaxLayoutRef.current);
      preMaxLayoutRef.current = null;
    } else {
      // 没记录过 preMax（首次直接退出 max 或反方向：例如外部代码直接置 false）
      // 退回默认 55/45。
      g.setLayout([55, 45]);
    }
  }, [maximized, fileEditorActive]);

  if (!fileEditorActive) {
    return (
      <div className="relative flex-1 min-h-0 flex">
        <LayoutNodeRendererRoot />
      </div>
    );
  }

  return (
    <PanelGroup
      ref={panelGroupRef}
      direction="vertical"
      autoSaveId="aitm-terminal-editor-split-v3"
      className="flex flex-1 min-h-0 flex-col"
    >
      {/* terminal panel：minSize=0 + collapsible 允许 maximize 时完全收起；
          collapsedSize=0 让 react-resizable-panels 把 0 视为 collapse 状态
          而不是被 minSize 弹回，避免 setLayout([0, 100]) 后被库内部纠正。 */}
      <Panel
        id="terminal"
        order={1}
        defaultSize={55}
        minSize={0}
        collapsible
        collapsedSize={0}
      >
        <div className="relative flex h-full w-full min-h-0 min-w-0">
          <LayoutNodeRendererRoot />
        </div>
      </Panel>
      <PanelResizeHandle
        className="h-1 bg-[var(--c-border)] hover:bg-[var(--c-border-strong)] transition-colors"
        aria-label={t("splitDivider.terminalEditorHeight")}
      />
      <Panel id="editor" order={2} defaultSize={45} minSize={15}>
        <FilePreviewWorkspace />
      </Panel>
    </PanelGroup>
  );
}

/**
 * v0.10.0 HR6-3c：从 pane-layout store 订阅 root 并交给 LayoutNodeRenderer。
 * 拆成单独组件让根级 root 更新走自己的 React subscription，主 App 不参与。
 *
 * 容器加 h-full + w-full + flex 让子级（leaf TerminalPaneGroup 的 h-full w-full
 * 或 split PanelGroup）能撑满父高度；最外层父容器已经给了 flex-1 min-h-0。
 */
function LayoutNodeRendererRoot() {
  const root = usePaneLayoutStore((s) => s.root);
  return (
    <div className="flex h-full w-full min-h-0 min-w-0">
      <LayoutNodeRenderer node={root} />
    </div>
  );
}
