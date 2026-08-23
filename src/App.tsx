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
import { OPEN_ABOUT_EVENT } from "./components/UpdateBadge";
import FileTree from "./components/FileTree";
import FilePreviewWorkspace from "./components/FilePreviewWorkspace";
import QuitConfirmDialog from "./components/QuitConfirmDialog";
import BrowserPanel from "./components/browser/BrowserPanel";
import SplitDivider from "./components/SplitDivider";
import SidebarWrapper from "./components/SidebarWrapper";
import { ActivityBar } from "./components/ActivityBar";
import { LayoutNodeRenderer } from "./components/panes/LayoutNodeRenderer";
import { PaneDndContext } from "./components/panes/PaneDndContext";
import {
  onAppCloseActiveTab,
  onBrowserHotkey,
  onBrowserOpenRequested,
  onBrowserTitleChanged,
  onBrowserUrlChanged,
  onMenuFontAction,
  onMenuOpenAbout,
  onNotificationReceived,
  onPtyCwdChanged,
  sessionClose,
  onWindowFocusChanged,
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
} from "./stores/pane-layout";
import {
  startBrowserSuspendTimer,
  stopBrowserSuspendTimer,
} from "./lib/browserSuspend";
import { handleBrowserOpenRequested } from "./lib/browserOpenRequest";
import { restoreSnapshotTabs } from "./lib/sessionRestore";

export default function App() {
  const { t } = useTranslation();
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 从菜单「关于 aitm」进入时强制切到"关于"页；其他入口不指定（保留上次 tab）
  const [settingsTab, setSettingsTab] = useState<"about" | undefined>(undefined);
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
        // 焦点在浏览器面板上时，这三个键的含义是"缩放网页"而不是"改终端字号"。
        //
        // **这段在 macOS 上是死代码**：menu.rs 把这三个键注册成了 NSMenu 加速键，
        // 菜单在任何 webview 之前吃掉按键，keydown 压根不会走到这里。macOS 的实际
        // 路径是上面的 `menu:font-action` handler（那里做同样的 lastSurface 路由）。
        // 保留这段是为了没有这套菜单加速键的平台。
        const inBrowser =
          useFocusSurfaceStore.getState().lastSurface === "browser";
        const applyZoom = (d: 1 | -1 | "reset") => {
          e.preventDefault();
          e.stopPropagation();
          if (inBrowser) void useBrowserStore.getState().adjustZoom(d);
          else void adjustFontSize(d === "reset" ? "reset" : d);
        };
        if (e.code === "Equal") {
          applyZoom(1);
          return;
        }
        if (e.code === "Minus") {
          applyZoom(-1);
          return;
        }
        if (e.code === "Digit0" && !e.shiftKey) {
          applyZoom("reset");
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
      // **macOS 上这里才是 Cmd+= / Cmd+- / Cmd+0 的唯一活路径**。
      //
      // menu.rs 把这三个键注册成了 NSMenu 加速键，而 macOS 的菜单在任何 webview
      // 之前吃掉按键——所以下面那个 window.keydown 分支在 macOS 上根本不会触发，
      // 子 webview 也收不到（wry 的 zoom_hotkeys 在 macOS 明确 Unsupported）。
      // 结果就是不管焦点在哪，按下去永远只改终端字号（多 webview 场景实测）。
      //
      // 所以路由必须放在这里，跟 keydown 分支用同一个 lastSurface 判据。
      if (useFocusSurfaceStore.getState().lastSurface === "browser") {
        void useBrowserStore.getState().adjustZoom(delta);
      } else {
        void adjustFontSize(delta);
      }
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

  // 订阅 NSMenu「关于 aitm」/ 状态栏升级徽标 → 打开设置面板并直达"关于"页。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let alive = true;
    const openAbout = () => {
      if (!alive) return;
      setSettingsTab("about");
      setSettingsOpen(true);
    };
    window.addEventListener(OPEN_ABOUT_EVENT, openAbout);
    onMenuOpenAbout(openAbout)
      .then((fn) => {
        if (alive) unlisten = fn;
        else fn();
      })
      .catch(() => {});
    return () => {
      alive = false;
      window.removeEventListener(OPEN_ABOUT_EVENT, openAbout);
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
  // v1.0.1：走后端原生 set_dock_badge（NSDockTile.setBadgeLabel），不用 Tauri
  // 的 setBadgeCount（macOS 有 bug tauri#13905）。
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

  // v1.1.0 R1：订阅后端主窗口聚焦事件 → 写 tabs store 的 windowFocused。
  // markUnread 用它门控：用户正看着某活跃 tab（窗口聚焦）时，tab 补全响铃等
  // 噪声 BEL 不点角标；切到别的 app（失焦）后台完成才 badge。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void onWindowFocusChanged((focused) => {
      useTabsStore.getState().setWindowFocused(focused);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
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
      // F3：同步目标 tab 所在 group 的 active_tab_id，否则键盘切 tab 后
      // TerminalPaneGroup 算出的 isActive 仍指向旧 tab，自动聚焦会指错目标。
      // tab 不在当前焦点 group 内时 setActiveTabInGroup 内部 no-op，安全。
      const { active_group_id, setActiveTabInGroup } =
        usePaneLayoutStore.getState();
      if (active_group_id) setActiveTabInGroup(active_group_id, next.id);
    },
    prevTab: () => {
      const { tabs, activeId, setActive } = useTabsStore.getState();
      if (tabs.length === 0) return;
      const idx = tabs.findIndex((t) => t.id === activeId);
      const prev = tabs[(idx - 1 + tabs.length) % tabs.length];
      setActive(prev.id);
      const { active_group_id, setActiveTabInGroup } =
        usePaneLayoutStore.getState();
      if (active_group_id) setActiveTabInGroup(active_group_id, prev.id);
    },
    openSettings: () => {
      setSettingsTab(undefined);
      setSettingsOpen(true);
    },
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

  // 启动流程：并行拉 settings + snapshot，再按 ui.restore_session 串行决策。
  //
  // 以前 settings 和 snapshot 分在两个 effect 里各自 setState，谁先落地要看
  // React 调度；恢复 tab 依赖 layout 已经 restore 好（tab 要按 group_id 放回
  // 对应分屏），这个顺序不能靠运气。合成一个 async effect 后顺序是确定的：
  //   1. 两份数据并行拉到手
  //   2. restore_session 开着 → editor tabs → pane_layout → 终端 tab
  //   3. restore_session 关掉 → 三份持久化全部跳过，得到一个干净空窗口
  //      （只跳过"读"，snapshot 照常写盘，重新打开开关就能恢复最近一次）
  const [startupResolved, setStartupResolved] = useState(false);

  useEffect(() => {
    void (async () => {
      const [snapshot] = await Promise.all([
        sessionSnapshotLoad().catch(() => null),
        useSettingsStore.getState().init(),
      ]);
      const { ui, editor } = useSettingsStore.getState().settings;

      if (!ui.restore_session) {
        setStartupResolved(true);
        return;
      }

      // v0.9.0 T5b：settings 拉到后按 settings.editor 恢复编辑器 tabs。
      // restoreFromSettings 内部对单个文件 read 失败静默跳过；
      // 不阻塞 App 启动，所以这里 fire-and-forget。
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
      const persisted = ui.pane_layout;
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

      // 静默恢复上次的终端 tab。必须排在 pane_layout restore 之后：
      // restoreSnapshotTabs 要按 snapshot 记的 group_id 把 tab 放回对应 group，
      // 那些 group 得先存在。
      if (snapshot) restoreSnapshotTabs(snapshot);

      setStartupResolved(true);
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

  // 恢复流程跑完才开默认 tab（避免恢复还没落地就先开了一个空的）；
  // 恢复关掉、snapshot 为空、或恢复失败都会走到这里开 1 个空 tab。
  useEffect(() => {
    if (!startupResolved) return;
    if (useTabsStore.getState().tabs.length === 0) {
      addTab();
    }
  }, [startupResolved, addTab]);

  // v0.5.0-D T4：tab 变化 → debounced 1s 写 snapshot
  // 启动恢复还没跑完时不写，避免把空 / 默认状态盖掉上次的记录
  useEffect(() => {
    if (!startupResolved) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const writeSnapshot = async () => {
      const state = useTabsStore.getState();
      const unread = state.unreadByTab;
      // v1.4.0：浏览器 tab 一起存。about:blank / 空 URL 这类空白页跨重启带着走
      // 没有意义（恢复出来还是空白页），写入端就过滤掉。
      const browserState = useBrowserStore.getState();
      const browserTabs = browserState.tabs.filter(
        (t) => t.url && t.url !== "about:blank" && t.url !== "about:newtab",
      );
      const activeIdx = browserTabs.findIndex(
        (t) => t.key === browserState.activeKey,
      );
      const activeBrowserIndex = activeIdx >= 0 ? activeIdx : null;
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
        // v1.4.0：浏览器 tab 一起存。空白页不值得跨重启带着走，过滤掉。
        browser_tabs: browserTabs.map((t) => ({
          url: t.url,
          title: t.title,
          zoom: t.zoom ?? null,
          mobile: t.mobile ?? false,
        })),
        active_browser_index: activeBrowserIndex,
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
    // store 任意变化都 schedule。浏览器 store 也要订阅——只订终端的话，
    // 用户开完网页就退出，浏览器 tab 一个都存不下来。
    const unsub = useTabsStore.subscribe(schedule);
    const unsubBrowser = useBrowserStore.subscribe(schedule);
    // 5 min 兜底（防 app 强 kill 没收到 store 变化）
    const interval = setInterval(writeSnapshot, 5 * 60 * 1000);
    // window close 同步写一次
    const onBeforeUnload = () => {
      void writeSnapshot();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      unsub();
      unsubBrowser();
      if (timer) clearTimeout(timer);
      clearInterval(interval);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [startupResolved]);

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

  // 订阅 browser:title_changed 同步 zustand tabs[].title。
  // 不订的话标签页永远显示原始 URL —— 又长又占地方，两三个 tab 就把标签栏挤爆。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let alive = true;
    onBrowserTitleChanged((e) => {
      if (!alive) return;
      useBrowserStore.getState().applyTitleChanged(e.tab_id, e.title);
    })
      .then((u) => {
        if (alive) unlisten = u;
        else u();
      })
      .catch(() => {
        // fail-soft：拿不到标题就继续显示 URL，不影响浏览
      });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  // v1.2.0 T-B3：订阅 browser:open_requested —— AI 的 browser_open /
  // browser_navigate 工具请求打开浏览器面板（后端拿不到 bounds 建不了 tab）。
  // **必须挂在 App.tsx 这种常驻组件**：面板收起时 BrowserPanel 根本不渲染，
  // 由它订阅就永远收不到"请打开面板"的事件。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let alive = true;
    onBrowserOpenRequested((e) => {
      if (!alive) return;
      void handleBrowserOpenRequested(e);
    })
      .then((u) => {
        if (alive) unlisten = u;
        else u();
      })
      .catch(() => {
        // 注册失败：fail-soft，AI 工具会在 10s 后超时并如实报告失败
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
        setSettingsTab(undefined);
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
      onSettingsOpen={() => {
        setSettingsTab(undefined);
        setSettingsOpen(true);
      }}
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
      <SettingsModal
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        initialTab={settingsTab}
      />
      {/* v0.9.0 H5：FilePreviewDialog 不再挂载（被 FilePreviewWorkspace tab 取代）
          组件文件保留待后续清理；移除挂载是为修真机"点文件同时弹旧 dialog + 新 tab"bug */}
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
 * ---------------------------------------------------------------------------
 * v1.3.0 P10（终端关掉文件预览后滚不动）：**PanelGroup 必须常驻**。
 *
 * 上面 T3 那条"不能条件 unmount PanelGroup"的结论只落实了一半 —— 之前
 * `fileEditorActive=false` 时会 `return` 一个裸 div 分支，React 在这个位置
 * 看到元素类型从 `PanelGroup` 变成 `div`，照样把**整棵终端子树 unmount 重建**：
 * `TerminalView` cleanup 调 `term.dispose()`，remount 时 `new Terminal()`。
 * 后果不只是丢 scrollback，更要命的是**终端模式全部复位**：
 *   - `ESC[?1049h`（进备用屏）、鼠标追踪、DECCKM 都是**旧实例**消费掉的，
 *     PTY 不会重发；Claude Code 这类全屏 TUI 只在 SIGWINCH 时重绘内容。
 *   - 于是新 xterm 自认为在普通屏 → `altScroll.shouldAltScroll` 判 false →
 *     滚轮不再转方向键交给 CC，只能滚新实例那点空 scrollback
 *     = 维护者真机反馈的"关掉文件预览后终端上滚不了太多"。
 *   - 完整退出 CC 再进来，新实例这次真收到了 `ESC[?1049h` → 又能滚了。
 *
 * 修法：PanelGroup 常驻，只把「分割条 + 编辑器 Panel」按 fileEditorActive
 * 条件渲染。react-resizable-panels 对条件 Panel 的要求（稳定 `id` + `order`）
 * 本来就已满足；只剩一个 Panel 时库会把它归一到 100%，视觉与旧的纯终端分支
 * 等价，而终端子树在同一位置原地保活（xterm 实例、备用屏状态、scrollback 全留）。
 *
 * file-editor.ts:275 closeFile 时已经把 maximized 同步重置为 false；
 * preMaxLayoutRef 不再靠 unmount GC，改为 fileEditorActive 转 false 时显式清空。
 */
/**
 * 终端 Panel 被视为"异常塌陷"的百分比阈值。
 *
 * 非 maximize 态下终端不该只剩这么点——只可能是 autoSave 把上次 maximize 的
 * [0, 100] 存下来了。低于此值就当作残留布局纠正回默认分屏。
 */
const TERMINAL_COLLAPSED_THRESHOLD = 10;

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
    if (!g) return;
    if (!fileEditorActive) {
      // 预览收起：编辑器 Panel 已卸载，比例交给库自动归一到 100%，这里不 setLayout
      // （对单 Panel 布局调 setLayout([...2 项]) 会被库判非法）。同时清掉 maximize
      // 前的比例快照 —— 等价于 P10 之前"整个组件 unmount 自然 GC"的语义。
      preMaxLayoutRef.current = null;
      return;
    }
    // 只有终端 + 编辑器两个 Panel 都注册好了才动比例。预览刚展开的那一帧
    // 编辑器 Panel 可能还没 register 完，此时 setLayout 会被库判"panel 数与
    // layout 长度不符"直接 throw（`Invalid 0 panel layout: 55%, 45%`）。
    //
    // 🔴 不能像最初那样"这一帧不管它"就 return：effect 依赖只有
    // [maximized, fileEditorActive]，Panel 注册完并不会让它重跑，于是比例**永远
    // 不会被修正**（真机回归：打开预览直接占满全屏）。改为 rAF 重试到注册完成。
    let raf = 0;
    const apply = () => {
      raf = 0;
      const current = g.getLayout();
      if (current.length !== 2) {
        raf = requestAnimationFrame(apply);
        return;
      }
      if (maximized) {
        preMaxLayoutRef.current = current;
        g.setLayout([0, 100]);
      } else if (preMaxLayoutRef.current) {
        g.setLayout(preMaxLayoutRef.current);
        preMaxLayoutRef.current = null;
      } else if (current[0] < TERMINAL_COLLAPSED_THRESHOLD) {
        // 🔴 自愈 autoSave 残留的 maximize 布局。
        //
        // P10 让 PanelGroup 常驻后，`autoSaveId` 会把 maximize 时的 [0, 100] 持久化，
        // 下次打开预览就恢复成"终端 0% / 编辑器 100%"——用户看到的是"一打开预览
        // 就占满全屏"，双击 maximize 反而把它掰回分屏（真机反馈）。
        // 非 maximize 态下终端不该被压到近 0，这里强制回默认分屏。
        //
        // 注意只在**异常**时纠正：正常比例（含用户自己拖过的）一律保留，
        // 这样 P10 带来的"分屏比例跨开关预览保留"仍然成立。
        g.setLayout([55, 45]);
      }
    };
    apply();
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  }, [maximized, fileEditorActive]);

  /**
   * 🔴 布局守卫：非 maximize 态下终端被压到近 0，一律纠正回默认分屏。
   *
   * **为什么光靠上面那个 effect 不够**（真机回归两次才定位）：
   * react-resizable-panels 从 `autoSaveId` 恢复布局发生在 **effect 之后**——
   * effect 里 `getLayout()` 读到的还是正常值，检查完库才把上次 maximize 存下来的
   * `[0, 100]` 恢复上去，于是自愈逻辑根本没机会触发，用户看到的就是"一打开预览
   * 终端就没了"。
   *
   * `onLayout` 会在**每一次**布局变化后触发（含 autoSave 恢复那一次），是唯一能
   * 兜住这个时序的钩子。setLayout 会再触发一次 onLayout，但那时 layout[0]=55
   * 不再满足条件，不会自激。
   */
  const handleLayout = useCallback(
    (layout: number[]) => {
      if (!fileEditorActive || maximized) return;
      if (layout.length !== 2) return;
      if (layout[0] >= TERMINAL_COLLAPSED_THRESHOLD) return;
      panelGroupRef.current?.setLayout([55, 45]);
    },
    [fileEditorActive, maximized],
  );

  // P10：PanelGroup 无条件渲染 —— 终端子树必须始终待在**同一个位置的同一种元素**
  // 下，React 才不会重建它（连带重建 xterm 实例）。
  return (
    <PanelGroup
      ref={panelGroupRef}
      direction="vertical"
      autoSaveId="aitm-terminal-editor-split-v3"
      className="flex flex-1 min-h-0 flex-col"
      onLayout={handleLayout}
    >
      {/* terminal panel：minSize=0 + collapsible 允许 maximize 时完全收起；
          collapsedSize=0 让 react-resizable-panels 把 0 视为 collapse 状态
          而不是被 minSize 弹回，避免 setLayout([0, 100]) 后被库内部纠正。
          终端 Panel **故意不写 defaultSize**：react-resizable-panels 会把"剩下的"
          尺寸分给没写 defaultSize 的 Panel —— 有编辑器时 = 100-45 = 55（跟以前一样），
          预览收起只剩它自己时 = 100。若写死 55，单 Panel 布局合计只有 55%，库会
          走 validatePanelGroupLayout 的归一化分支并打 "Invalid layout total size" 警告。 */}
      <Panel id="terminal" order={1} minSize={0} collapsible collapsedSize={0}>
        <div className="relative flex h-full w-full min-h-0 min-w-0">
          <LayoutNodeRendererRoot />
        </div>
      </Panel>
      {/* 分割条与编辑器 Panel 成对条件渲染。两处都写成 `cond && ...` 而不是合并
          成一个 fragment：保持 children 槽位数固定，React 按索引 diff 时终端
          Panel 永远是 index 0，不会被挪位。 */}
      {fileEditorActive && (
        <PanelResizeHandle
          className="h-1 bg-[var(--c-border)] hover:bg-[var(--c-border-strong)] transition-colors"
          aria-label={t("splitDivider.terminalEditorHeight")}
        />
      )}
      {fileEditorActive && (
        <Panel id="editor" order={2} defaultSize={45} minSize={15}>
          <FilePreviewWorkspace />
        </Panel>
      )}
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
