import { create } from "zustand";

/**
 * v0.10.0 HR9-11：跟踪用户"最后操作的区域"——给 Cmd+W 类 keystroke
 * 路由用。
 *
 * 背景：HR9-9 用 `document.activeElement.closest('[data-testid=...]')`
 * 判断焦点，但 close button / Radix dialog / 编辑器 CodeMirror 切换都会让
 * `activeElement` fall back 到 body，于是"关一个文件 tab 后再按 Cmd+W"
 * 走错路径关了终端 tab。
 *
 * 改用 lastSurface：各 surface 容器在 onMouseDownCapture 时主动 setSurface，
 * 状态稳定到用户下一次主动点别处之前。Cmd+W 来时按 lastSurface 路由。
 *
 * 注意：focus 跟 mouse 不一定同步（键盘 Tab 也能切焦点），但 aitm 当前
 * 没有跨 surface 的 keyboard 切换。如果未来加，再扩展 onFocusCapture。
 */
export type Surface = "terminal" | "editor" | "browser" | "ai-sidebar";

interface FocusSurfaceState {
  /** 用户最后用 mousedown 触达的 surface；初始 "terminal"（终端是默认主区）。 */
  lastSurface: Surface;
  setSurface: (s: Surface) => void;
}

export const useFocusSurfaceStore = create<FocusSurfaceState>((set) => ({
  lastSurface: "terminal",
  setSurface: (lastSurface) => set({ lastSurface }),
}));
