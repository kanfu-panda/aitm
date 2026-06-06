import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, useReducedMotion } from "framer-motion";
import { browserSetBounds } from "../../lib/tauri";
import { useBrowserStore } from "../../stores/browser";
import { ChevronDown } from "../icons";
import { m } from "../../lib/motion";
import BrowserNavButtons from "./BrowserNavButtons";
import BrowserTabBar from "./BrowserTabBar";
import BrowserUrlBar from "./BrowserUrlBar";

/**
 * Phase 4A T2 + v0.4.1 T3：内嵌浏览器面板主组件。
 *
 * 布局：
 * - 顶部：[`BrowserTabBar`]
 * - 工具栏：[`BrowserNavButtons`] + [`BrowserUrlBar`] + 收起按钮
 * - 中部：占位 div；real WKWebView 由后端 native overlay 在这个 bounds 上 mount
 *
 * **Native overlay 约束**：webview 是原生层覆盖在 React UI 之上；它不在 DOM
 * 里，所以 React 控制它必须靠 IPC + ResizeObserver 把容器 bounds 同步过去。
 * 60fps 节流（16ms），既不丢帧也不轰炸 IPC。
 *
 * v0.4.1 T3：
 * - 收起按钮 ⤓ → ChevronDown lucide icon
 * - onClick 改调 minimizePanel（保留 tabs，仅 destroy webview）
 * - 整体进出走 framer-motion AnimatePresence + m.div slide 动画
 */

/** 进出动画 token（plan §6.4 / §2.5；250/200ms 取自 --d-base + --d-fast 平均）。 */
const ANIM_ENTER_MS = 0.25;
const ANIM_EXIT_MS = 0.2;

/**
 * 内层主组件：负责所有 WKWebView 同步 + DOM 渲染。
 * 由 [`BrowserPanel`] 通过 AnimatePresence 控制 mount/unmount。
 */
function BrowserPanelInner() {
  const tabs = useBrowserStore((s) => s.tabs);
  const activeKey = useBrowserStore((s) => s.activeKey);
  const minimizePanel = useBrowserStore((s) => s.minimizePanel);
  const containerRef = useRef<HTMLDivElement>(null);
  const urlRowRef = useRef<HTMLDivElement>(null);
  // v0.4.3：webview 容器 top 跟 URL row 底部对齐（不是 header.offsetHeight），
  // 绕开 header inline minHeight: 96 引起的 ~22px 顶部白条。
  // 初值 75 = TabBar (~34) + URL row (40) + 1px buffer；useLayoutEffect 第一帧
  // 测出真实 URL row bottom 后立即覆盖。
  // header 仍保留 minHeight: 96（去掉会在 dev mode 出 webview 上爬 regression，
  // v0.4.2 T2 已验证；保留 minHeight 后 URL row 下方 ~21px 空白被 webview native
  // overlay 覆盖，视觉上消失。
  const [webviewTop, setWebviewTop] = useState(75);

  const activeTab = tabs.find((t) => t.key === activeKey);
  const activeTabId = activeTab?.id ?? null;

  // 测 URL row 底部 y（相对 BrowserPanel root）；webview 紧贴该 y 起渲染。
  // URL row 在 header 内，header 是 absolute（position != static），所以
  // URL row.offsetParent = header（不是 root），offsetTop 是相对 header 顶。
  // 但 header.style.top = 0 (absolute top-0)，header 在 root 内 y=0 起，
  // 所以 URL row 的 offsetTop 跟"相对 root top" 数值相同。
  useLayoutEffect(() => {
    const el = urlRowRef.current;
    if (!el) return;
    const update = () => {
      const bottom = el.offsetTop + el.offsetHeight + 1;
      if (bottom > 0) setWebviewTop(bottom);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // v0.9.0 HR2-1：删除"tabs 为空自动开 about:blank"逻辑（原 v0.5.10 修法）。
  // 跟 H4 的 closeTab → closePanel 级联抢资源，造成 native webview 残留主区黑屏。
  // 现在的行为：关 last tab → closePanel 干净收起；用户从 ActivityBar 重开浏览器 →
  // restorePanel 内已处理 tabs.length === 0 时新开 about:blank（line 192-196 兜底）。
  // 这里不再需要 useEffect 自动开新 tab。

  // 监 webview 容器 bounds，节流 16ms 上报后端 set_bounds。
  // deps 含 webviewTop：URL row 底变化时（如 layout 重测）重 setup
  // 让 webview bounds 立刻跟新 container 位置同步。
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !activeTabId) return;

    let lastReport = 0;
    let pendingHandle: number | null = null;

    const doReport = () => {
      pendingHandle = null;
      lastReport = performance.now();
      const rect = el.getBoundingClientRect();
      // v0.4.3 经验偏移：wry 在 macOS 的 Webview::set_position 的 y 跟 React
      // viewport top 之间有 ~45 px 偏差（empirical：input y=75 → visual y=30）。
      // 偏差来自 macOS NSWindow 含 title bar / chrome 让 wry 的 frame superview
      // != React viewport (= contentView)。**只 +45 y，h 不调**——wry 的 frame
      // 偏移对 origin 和 size 一致作用（visual h = input h），所以 h 保 rect.height
      // 让 visual bottom = visual top + h = 视觉跟 container.bottom 严丝合缝。
      const macosYOffset = 30;
      browserSetBounds(activeTabId, {
        x: rect.left,
        y: rect.top + macosYOffset,
        w: rect.width,
        h: rect.height,
      }).catch(() => {
        // 后端 webview 已 destroy / race 等，忽略
      });
    };

    const report = () => {
      const now = performance.now();
      if (now - lastReport >= 16) {
        doReport();
        return;
      }
      // 离上次不到 16ms：用 rAF 拖到下一帧；防止快速触发漏掉最后一次上报
      if (pendingHandle !== null) return;
      pendingHandle = requestAnimationFrame(doReport);
    };

    const ro = new ResizeObserver(report);
    ro.observe(el);
    // 滚动 / 主 window resize 也要重报（外部容器变化 ResizeObserver 看不见）
    window.addEventListener("scroll", report, true);
    window.addEventListener("resize", report);

    // 多轮兜底：mount 后第 0/1/2 帧 + 250ms 强制 report，覆盖各种时序：
    // - ResizeObserver 第一次 observe 时 container 还没 layout settle（react-resizable-panels
    //   Panel 用 autoSaveId 从 localStorage 恢复比例有延迟）→ 报的 height 偏小
    // - framer-motion m.div opacity 0→1 期间 layout 可能微调
    // - panel 大小切换 / window resize 漏掉时
    // 4 轮 report 都是同步 IPC 调用，开销小（~1ms each），但保证 webview 在
    // mount 后 250ms 内拿到稳定的真实 bounds。
    report(); // 第 0 帧
    const raf1 = requestAnimationFrame(() => {
      doReport(); // 第 1 帧（绕过节流，强报）
      requestAnimationFrame(doReport); // 第 2 帧
    });
    const tid = setTimeout(doReport, 250); // panel auto-save settle 兜底

    return () => {
      ro.disconnect();
      window.removeEventListener("scroll", report, true);
      window.removeEventListener("resize", report);
      cancelAnimationFrame(raf1);
      clearTimeout(tid);
      if (pendingHandle !== null) cancelAnimationFrame(pendingHandle);
    };
  }, [activeTabId, webviewTop]);

  return (
    // 改用 absolute 定位避免 flex 计算误差：webview 是 native overlay 无视
    // z-index，bounds 算偏哪怕一两像素都会让 webview 盖住 URL 栏。
    // header 顶部 absolute（自动撑高度）；container 用 inline style
    // top: headerHeight 精确避开 header 区域。
    <div className="relative h-full bg-[var(--c-bg-elev-1)] text-[var(--c-text-base)]">
      <header
        className="absolute inset-x-0 top-0 z-10 flex flex-col border-b border-[var(--c-border)] bg-[var(--c-bg-elev-1)]"
        // inline style 强制 header 至少 96px (TabBar 56 + URL 栏 row 40)。
        // v0.4.3：保留 minHeight 防 dev mode webview 上爬 regression（v0.4.2 T2 验证）；
        // 但 webview top 现在跟 URL row 底对齐（不是 header 底），URL row 下方
        // ~21px 的 header 空白被 webview native overlay 覆盖，视觉无白条。
        style={{ minHeight: 96 }}
      >
        <BrowserTabBar />
        <div
          ref={urlRowRef}
          className="flex items-center gap-1 px-2 py-1"
          style={{ minHeight: 40 }}
        >
          <BrowserNavButtons />
          <BrowserUrlBar />
          <button
            type="button"
            onClick={() => void minimizePanel()}
            className="rounded p-1 text-[var(--c-text-dim)] hover:bg-[var(--c-bg-elev-2)] hover:text-[var(--c-text-base)]"
            aria-label="收起浏览器"
            title="收起到侧边栏（释放所有 webview 内存，标签状态保留）"
          >
            <ChevronDown size={16} aria-hidden />
          </button>
        </div>
      </header>
      <div
        ref={containerRef}
        className="absolute inset-x-0 bg-[var(--c-bg-base)]"
        // v0.4.3：top = URL row 底 + 1px（绕开 header minHeight: 96 floor
        // 引起的 ~22px 白条）；bottom: 0 让 webview 严丝合缝填到 PanelGroup
        // 底部（status bar 是 main 外的兄弟元素 PanelGroup 下方，不会被盖）。
        style={{ top: webviewTop, bottom: 0 }}
        aria-label="浏览器内容"
      />
    </div>
  );
}

/**
 * 顶层包装：用 AnimatePresence + m.div 控制 BrowserPanelInner 的 enter/exit fade 动画。
 *
 * **关键设计：只用 opacity 渐变，不用 transform y/scale**
 *
 * 原因：BrowserPanelInner 内的 webview 是 native overlay，bounds 通过
 * `containerRef.getBoundingClientRect()` 上报。`getBoundingClientRect` 返回值
 * **包含 CSS transform 偏移**——initial 状态 y=+20 时 rect.top 也偏 +20，
 * 上报给 webview 错位；动画结束后 ResizeObserver 不会重触发（容器 size 没变），
 * webview 永远停在 mount 第一帧 transform 后的错位上。真机看到 webview 底部
 * 留空白（v0.4.1 真机 smoke #2）。
 *
 * 用纯 opacity 渐变：opacity 不影响 rect，bounds 始终准确；视觉上有 enter/exit
 * 过渡感（slide 退化为 fade，可接受）。同时加 onAnimationComplete 触发
 * window resize 当兜底，让 ResizeObserver 在动画完成后强制重报一次（防 panel
 * mount + react-resizable-panels Panel 高度初始化时序导致第一帧 rect 不准）。
 */
export default function BrowserPanel() {
  const panelOpen = useBrowserStore((s) => s.panelOpen);
  // 尊重用户系统级"减少动画"偏好（G3）：reduce 时把动画收为 0，瞬间显隐。
  const reduce = useReducedMotion();
  const enterDuration = reduce ? 0 : ANIM_ENTER_MS;
  const exitDuration = reduce ? 0 : ANIM_EXIT_MS;
  return (
    <AnimatePresence initial={false}>
      {panelOpen && (
        <m.div
          key="browser-panel"
          initial={{ opacity: 0 }}
          animate={{
            opacity: 1,
            transition: {
              duration: enterDuration,
              ease: [0.16, 1, 0.3, 1], // --e-out spring-like
            },
          }}
          exit={{
            opacity: 0,
            transition: {
              duration: exitDuration,
              ease: [0.4, 0, 0.2, 1], // --e-in-out
            },
          }}
          onAnimationComplete={() => {
            // 兜底：动画完成后让 BrowserPanelInner 的 ResizeObserver 重报一次 bounds
            window.dispatchEvent(new Event("resize"));
          }}
          // panel 容器要占满父级（react-resizable-panels 子内容）；
          // m.div 默认 inline-block，给 h-full + w-full 维持原 layout
          className="h-full w-full"
        >
          <BrowserPanelInner />
        </m.div>
      )}
    </AnimatePresence>
  );
}
