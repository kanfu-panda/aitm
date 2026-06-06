import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import {
  onSessionData,
  onSessionExit,
  sessionClose,
  sessionOpen,
  sessionResize,
  sessionWrite,
  type SessionId,
  type BrowserBounds,
} from "../lib/tauri";
import { useSettingsStore } from "../stores/settings";
import { useBrowserStore } from "../stores/browser";
import { getPairedTheme, getTheme, type ThemeColorMode } from "../lib/themes";
import type { ThemeMode } from "../lib/tauri";
import {
  disableSystemTextInput,
  isWebKitRuntime,
  shouldFixSwallowedShiftKey,
} from "../lib/xtermTextarea";

/** v0.4.1 T5：将 settings.ui.theme_mode (auto/dark/light) 解析为实际深浅模式。
 *  auto 时读 matchMedia 当前态；dark/light 直接透传。SSR 安全：window 不在
 *  时（jsdom 早期）直接当 dark。 */
function resolveThemeColorMode(mode: ThemeMode): ThemeColorMode {
  if (mode === "auto") {
    if (typeof window === "undefined") return "dark";
    return window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
  }
  return mode;
}

/** v0.4.1 T5：根据 settings.terminal.theme（用户选的"风格基准"）+ ui.theme_mode
 *  返回最终给 xterm 渲染的 theme。
 *
 *  - mode='auto' 时遵循当前系统主题 → dark/light pair
 *  - mode='dark'/'light' 时强制对应深浅 pair
 *  - 用户选 dark theme + light mode → 用 pairLight；反之亦然
 */
function resolveXtermTheme(baseId: string, mode: ThemeMode) {
  const colorMode = resolveThemeColorMode(mode);
  // 已是目标 mode → 走 getTheme（保留 default theme 的 pure-bg 兜底语义）
  // 不同 mode → 走 getPairedTheme 找配对
  const base = getTheme(baseId);
  if (base.mode === colorMode) return base.xterm;
  return getPairedTheme(baseId, colorMode).xterm;
}

/**
 * v0.9.1 HR3-4：终端 URL 单击回调（导出以便单测，逻辑不依赖 xterm 实例）。
 *
 * 行为：
 * 1. 阻止 addon 默认动作（默认会调 window.open 走系统浏览器）
 * 2. 浏览器面板未开 → 调 [`restorePanel`] 展开（同时若 tabs 为空会兜底 about:blank）
 * 3. 始终调 [`openTab`] 把目标 URL 加为新 tab（即使刚 restorePanel 弹了 about:blank）
 *
 * bounds 用 placeholder 800x600：BrowserPanel 自己挂的 ResizeObserver 会在容器
 * 完成布局后立刻按真实尺寸调 [`browserSetBounds`] 纠正，单击路径不阻塞等真实尺寸。
 */
export const TERMINAL_LINK_FALLBACK_BOUNDS: BrowserBounds = {
  x: 0,
  y: 0,
  w: 800,
  h: 600,
};

export function handleTerminalLinkClick(event: MouseEvent, uri: string): void {
  event.preventDefault();
  const store = useBrowserStore.getState();
  if (!store.panelOpen) {
    void store.restorePanel(TERMINAL_LINK_FALLBACK_BOUNDS);
  }
  void store.openTab(uri, TERMINAL_LINK_FALLBACK_BOUNDS);
}

interface Props {
  /** 已有 session id；为 null 表示首次挂载时打开新 session。 */
  sessionId: SessionId | null;
  /**
   * v0.9.1 HR3-1：首次 [`sessionOpen`] 时传给后端的初始 cwd（PTY 启动目录）。
   *
   * - 跨重启 restore 时由 [`App.tsx`] 从 `SessionSnapshot.cwd` 还原写到
   *   tab.last_cwd，再透传到这里。
   * - 不存在 / 失效路径由后端 [`resolve_initial_cwd`] 兜底到 HOME。
   * - 新开 tab 没有上次 cwd → `null` / `undefined`，PTY 走 HOME。
   *
   * 注意：仅在 [`sessionId === null`] 触发的"首次开 session"路径生效；
   *      sessionId 已存在（rehydrate）则忽略——session 早已起来，不会再 spawn。
   */
  initialCwd?: string | null;
  onSessionOpened?: (id: SessionId) => void;
  onExit?: (id: SessionId) => void;
}

export default function TerminalView({
  sessionId,
  initialCwd,
  onSessionOpened,
  onExit,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  /** v0.10.5 #1：sessionOpen 失败时的错误消息（PTY 资源耗尽 / shell 路径
   *  无效等）；非 null 时渲染 banner 提示用户关 tab 重试。 */
  const [spawnError, setSpawnError] = useState<string | null>(null);
  // 把当前 session id 存到 ref 给 closure 读取（避免 stale closure）
  const idRef = useRef<SessionId | null>(sessionId);
  // v0.9.1 HR3-1：把 initialCwd 锁到 ref，避免父组件后续改它触发"useEffect 重跑→
  // 重 spawn PTY"的灾难（首次 effect 已经走过 sessionOpen 后，cwd 不再生效）。
  const initialCwdRef = useRef<string | null | undefined>(initialCwd);
  // 把回调存到 ref，避免它们的引用变化导致 effect 重跑
  const onOpenedRef = useRef(onSessionOpened);
  const onExitRef = useRef(onExit);

  useEffect(() => {
    onOpenedRef.current = onSessionOpened;
  }, [onSessionOpened]);
  useEffect(() => {
    onExitRef.current = onExit;
  }, [onExit]);

  useEffect(() => {
    if (!containerRef.current) return;

    // WebKit workaround 用：onData 每次触发更新，customKeyEvent 据此判断
    // "本次 keydown 是否被吞了"（issue #5374，见 xtermTextarea.ts）
    let lastOnDataTime = 0;

    const initialState = useSettingsStore.getState().settings;
    const initial = initialState.terminal;
    // v0.4.1 T5：启动时根据 ui.theme_mode 选 dark/light 配对 theme，
    // 让"用户选 monokai-dark + theme_mode=light"启动即看到 monokai-light。
    const initialThemeMode = initialState.ui.theme_mode;
    const term = new Terminal({
      fontFamily: initial.font_family,
      fontSize: initial.font_size,
      lineHeight: initial.line_height,
      cursorBlink: true,
      cursorStyle: initial.cursor_style,
      theme: resolveXtermTheme(initial.theme, initialThemeMode),
      scrollback: 10_000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // v0.10.1：禁用 WebglAddon —— 维护者 真机 11+ tab 触发：
    //   "There are too many active WebGL contexts on this page, oldest will be lost"
    //   随后 `_renderer.value.dimensions` undefined → 终端 crash 黑屏。
    // WebKit/Chromium 每页 hard cap ~16 个 WebGL context，xterm 多 tab 必然撞。
    // xterm.js 5.x 默认 canvas renderer 对终端文本渲染性能足够（用户感知不到差别，
    // 除非长 scrollback 千行/秒高速滚屏）；正式 lazy mount（仅 active tab 走 WebGL）
    // 留 v0.10.5 资源极限专项做。这里直接关 WebGL 让 console 干净 + 多 tab 不 crash。

    // v0.9.1 HR3-4：终端 URL 单击 → 拉起内置浏览器（不走系统浏览器）
    // - hover 链接：addon 默认出手型 + 下划线
    // - 单击：自动展开浏览器面板（如未展开）+ 新 tab 加载该 URL
    // - 内嵌 webview 在原生层覆盖到 BrowserPanel 容器 bounds；首次 placeholder
    //   800x600，BrowserPanel 的 ResizeObserver 会立刻按真实容器 bounds 兜底
    //   纠正（参考 v0.5.0-D / v0.6.0 风格，避免阻塞拿不到真实容器尺寸的 race）
    const webLinks = new WebLinksAddon(handleTerminalLinkClick);
    term.loadAddon(webLinks);

    termRef.current = term;
    fitRef.current = fit;

    term.open(containerRef.current);

    // 禁用 helper textarea 的 macOS 系统级文本辅助；详见 disableSystemTextInput 注释。
    // 5.x 仍保留 `term.textarea` 字段（标 deprecated 但未删），优先用它；
    // 兜底走 `.xterm-helper-textarea` 选择器。
    disableSystemTextInput(
      term.textarea ??
        (containerRef.current.querySelector(
          ".xterm-helper-textarea",
        ) as HTMLTextAreaElement | null),
    );

    // attachCustomKeyEventHandler 处理两件事：
    //
    // 1. **Cmd+C 选区复制**（无选区让 ^C 走默认中断命令）。
    //    **不**自定义 Cmd+V：xterm.js 5.x 内置 helper textarea 监听 browser
    //    paste 事件，Cmd+V 默认会被 xterm 自己处理写入 PTY。v0.3.1 之前的
    //    自定义 keydown handler 走 clipboard.readText → sessionWrite 跟 xterm
    //    默认路径并行，导致粘贴内容**双发**（keydown 的 return false 只拦
    //    xterm 的 key 路径，无法阻止 browser 派发 paste 事件）。
    //
    // 2. **WKWebView Shift+键第一次被吞 workaround**（xterm.js issue #5374）。
    //    详见 shouldFixSwallowedShiftKey 注释；只在 WebKit runtime 启用。
    const webKitWorkaroundActive = isWebKitRuntime();
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;

      // Cmd+C / Ctrl+C 选区复制（Mac 用 Cmd，Win/Linux 用 Ctrl）。
      // 无选区时让 ^C 走默认路径中断子进程命令。
      if (e.metaKey || e.ctrlKey) {
        if (e.key.toLowerCase() === "c") {
          const sel = term.getSelection();
          if (sel && sel.length > 0) {
            navigator.clipboard.writeText(sel).catch(() => {});
            return false;
          }
        }
        return true;
      }

      // WKWebView Shift+键吞掉第一次 keydown 兜底（issue #5374）
      if (
        webKitWorkaroundActive &&
        shouldFixSwallowedShiftKey(e, lastOnDataTime)
      ) {
        const id = idRef.current;
        if (id) {
          lastOnDataTime = Date.now();
          sessionWrite(id, new TextEncoder().encode(e.key)).catch((err) =>
            console.error("WebKit workaround sessionWrite 失败", err),
          );
          return false; // 阻 xterm 内部走默认避免双发（Safari case 下其实 onData 不来）
        }
      }
      return true;
    });

    fit.fit();

    let alive = true;
    let unlistenData: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;
    let resizeObs: ResizeObserver | null = null;

    (async () => {
      let id = idRef.current;
      if (!id) {
        // v0.9.1 HR3-1：把上次会话 last_cwd 传给后端 PTY 启动目录。
        // null / undefined / 不存在的目录都由后端 [`resolve_initial_cwd`] 兜底到 HOME。
        try {
          id = await sessionOpen({
            cols: term.cols,
            rows: term.rows,
            cwd: initialCwdRef.current ?? null,
          });
        } catch (e) {
          // v0.10.5 #1：spawn 失败（PTY 资源耗尽 / macOS open file 限制 /
          // shell 路径无效 / fork 失败等）→ 渲染错误 banner，**不**留空 tab
          // 让用户黑屏没头绪。用户右键关 tab / Cmd+W 后从 store 移除。
          if (!alive) return;
          const msg = e instanceof Error ? e.message : String(e);
          setSpawnError(msg);
          return;
        }
        if (!alive) {
          // v0.10.0 HR9-6：StrictMode dev 双 mount race fix。
          // 第一遍 effect 的 sessionOpen 在飞行中被 cleanup（alive=false）。
          // 不 close 的话 PTY 被创建但 idRef 没写，第二遍 effect 又 sessionOpen
          // → 每个 tab leak 1 个 PTY，status bar "sessions" 翻倍。
          // 真机 维护者 反馈 6 tab 显示 12 sessions 就是这条 path。
          void sessionClose(id);
          return;
        }
        idRef.current = id;
        onOpenedRef.current?.(id);
      }

      unlistenData = await onSessionData(id, (bytes) => {
        term.write(bytes);
        // v0.10.5 hotfix：删 PTY 输出触发 markUnread 那行。
        // 之前 维护者 真机所有 tab 都涨红色数字 badge（"2"/"4"/...）+ Dock 14。
        // 根因：背景 tab 任何 PTY 输出（build / tail -f 等）都 +1，跟 macOS
        // Terminal 的"BEL/通知触发" 语义不一致。
        // 现在 unread 计数只由 notifications.ts emitNotification 触发 →
        // 数字 badge 仅在真有 OSC 9/777 通知或 AI tool 完成时显示。
      });
      unlistenExit = await onSessionExit(id, () => onExitRef.current?.(id!));

      term.onData((d) => {
        // WebKit workaround 用：onData 触发瞬间标记时间。customKeyEvent 后续
        // 收到 keydown 时如果距离最近 onData > 50ms 就判定"被吞"（issue #5374）。
        lastOnDataTime = Date.now();
        const enc = new TextEncoder().encode(d);
        sessionWrite(id!, enc).catch((e) => console.error("写入失败", e));
      });

      resizeObs = new ResizeObserver(() => {
        if (!alive) return;
        fit.fit();
        sessionResize(id!, term.cols, term.rows).catch(() => {});
      });
      if (containerRef.current) resizeObs.observe(containerRef.current);
    })();

    return () => {
      alive = false;
      unlistenData?.();
      unlistenExit?.();
      resizeObs?.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // 注意：sessionId 变化时不重建组件——由父组件用 key={tabId} 控制重建
  }, []);

  // 订阅 settings 变化 → 更新已存在的 xterm（不重建）
  //
  // v0.4.1 T5 新增：
  // - settings.ui.theme_mode 改了（用户切 light/dark/auto）→ 通过
  //   getPairedTheme 自动切配对的 xterm theme（保留用户选的"风格"换深浅）
  // - 启动期 main.tsx 还会注册 watchSystemTheme 监听 prefers-color-scheme
  //   变化，那条路径也会改 settings 间接走这里（auto 模式跟系统切）
  useEffect(() => {
    return useSettingsStore.subscribe((state) => {
      const t = termRef.current;
      const f = fitRef.current;
      if (!t) return;
      const ts = state.settings.terminal;
      const mode = state.settings.ui.theme_mode;
      t.options.fontFamily = ts.font_family;
      t.options.fontSize = ts.font_size;
      t.options.lineHeight = ts.line_height;
      t.options.cursorStyle = ts.cursor_style;
      // xterm 5.5 支持 theme 热替换；切主题不需重建 Terminal
      // v0.4.1 T5：用 resolveXtermTheme 自动配对（dark base + light mode → light pair）
      t.options.theme = resolveXtermTheme(ts.theme, mode);
      // v0.6.0：xterm 5.5 在 WKWebView 上 theme 热替换不自动重绘已渲染 cells（维护者
      // 真机 light mode 切换后终端仍 dark 配色）。强制清字符 texture atlas + refresh
      // 全屏让 ANSI 色立刻按新 theme 重画。
      try {
        (t as unknown as { clearTextureAtlas?: () => void }).clearTextureAtlas?.();
      } catch {
        /* noop（旧版 xterm 没这个 API） */
      }
      try {
        t.refresh(0, t.rows - 1);
      } catch {
        /* noop */
      }
      // 字体改了 → cell 尺寸变 → 重算行列数
      try {
        f?.fit();
      } catch {
        /* noop */
      }
    });
  }, []);

  // v0.4.1 T5：theme_mode='auto' 时跟随系统 prefers-color-scheme 切换。
  //
  // settings store 的 theme_mode 不会因系统切换而改（仍保持 'auto'），所以
  // store subscription 监听不到这个事件 —— 必须独立监听 matchMedia。
  // 触发后用 store getState() 读"当前模式"，即时算 resolveXtermTheme
  // 把 xterm 切到新配对（自然走 dark↔light）。
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const handler = () => {
      const t = termRef.current;
      if (!t) return;
      const s = useSettingsStore.getState().settings;
      // 只有 auto 模式才跟随系统切；强制 dark/light 时忽略系统切换
      if (s.ui.theme_mode !== "auto") return;
      t.options.theme = resolveXtermTheme(s.terminal.theme, s.ui.theme_mode);
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  return (
    <div className="relative h-full w-full bg-[var(--c-bg-base)]">
      <div ref={containerRef} className="h-full w-full" style={{ padding: 4 }} />
      {/* v0.10.5 #1：sessionOpen 失败 → 半透明 overlay 提示 + 关 tab 引导 */}
      {spawnError && (
        <div
          role="alert"
          data-testid="terminal-spawn-error"
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[var(--c-bg-base)]/95 p-6 text-center"
        >
          <div className="text-sm font-medium text-[var(--c-error)]">
            Failed to start terminal
          </div>
          <div className="max-w-md text-xs font-mono text-[var(--c-text-muted)] break-words">
            {spawnError}
          </div>
          <div className="text-[10px] text-[var(--c-text-dim)]">
            Close this tab (right-click ×) and try again. Too many open tabs may
            exhaust system resources (PTY fd / open file limit).
          </div>
        </div>
      )}
    </div>
  );
}
