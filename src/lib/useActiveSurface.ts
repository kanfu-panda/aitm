/* =============================================================================
 * useActiveSurface —— v0.9.0 T5d
 * -----------------------------------------------------------------------------
 * 判定当前键盘焦点所处的 UI surface：
 *   - "editor"   ：焦点落在 FilePreviewWorkspace 容器内（含其内部 CodeMirror）
 *   - "other"    ：其它（终端 / sidebar / dialog / 无焦点）
 *
 * 实现思路：
 *   - mount 时 + focusin / focusout 事件触发重算
 *   - 通过 `document.activeElement?.closest('[data-testid="file-preview-workspace"]')`
 *     做容器锚点判定（FilePreviewWorkspace 已在 T5b 加了 testid 并 tabIndex={-1}）
 *
 * 为什么不引入显式 ui-store `activeSurface` 字段：
 *   - 焦点是 DOM 原生状态，让组件主动 dispatch 容易遗漏/漂移
 *   - 单一事件源（focusin/focusout）冒泡到 document 已经覆盖所有交互
 *   - 不区分 "terminal" 与 "other"：StatusBar 只关心是否在 editor，
 *     非 editor 一律走原有渲染逻辑
 * ========================================================================== */

import { useEffect, useState } from "react";

export type ActiveSurface = "editor" | "other";

/** FilePreviewWorkspace 顶层容器的 testid（与 T5b 保持一致）。 */
const EDITOR_ROOT_SELECTOR = '[data-testid="file-preview-workspace"]';

function computeSurface(): ActiveSurface {
  if (typeof document === "undefined") return "other";
  const ae = document.activeElement as HTMLElement | null;
  if (ae && ae.closest(EDITOR_ROOT_SELECTOR)) {
    return "editor";
  }
  return "other";
}

/**
 * 订阅 document 全局 focusin / focusout，返回当前焦点所在 surface。
 *
 * 用法：
 *   const surface = useActiveSurface();
 *   if (surface === "editor") { ... }
 */
export function useActiveSurface(): ActiveSurface {
  const [surface, setSurface] = useState<ActiveSurface>(() => computeSurface());

  useEffect(() => {
    const update = () => {
      const next = computeSurface();
      setSurface((prev) => (prev === next ? prev : next));
    };
    // 初次 mount 后再算一次（SSR / 测试场景 useState 初值可能 stale）
    update();
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    return () => {
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
    };
  }, []);

  return surface;
}
