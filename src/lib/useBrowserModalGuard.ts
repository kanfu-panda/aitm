import { useEffect } from "react";
import { useBrowserStore } from "../stores/browser";
import { browserHideAllActive, browserShowAllActive } from "./tauri";

/**
 * v0.4.1 真机 smoke hotfix：modal 弹起时让浏览器 webview 让位。
 *
 * 背景：
 * 浏览器面板的 native WKWebView 在 OS 合成层之上，CSS z-index 无效。任何全屏 Radix
 * Dialog（设置 / 确认 / 关闭 tab / MD 预览 / 项目初始化）只要弹出时浏览器面板有 active
 * webview，webview 就会盖住右半 modal 内容（用户实测截图）。
 *
 * 后端 IPC 早已实现 `browser_hide_all_active` / `browser_show_all_active`（v0.4.0），
 * 但前端没人调。这个 hook 把它们绑到 Dialog 的 `open` prop 上。
 *
 * 用法：
 * ```ts
 * useBrowserModalGuard(open);
 * ```
 *
 * 行为：
 *   open=true  → 调 browserHideAllActive 把所有可见 webview 隐藏
 *   open=false → cleanup 阶段调 browserShowAllActive 恢复
 *
 * IPC 后端是幂等的（重复 hide 不出错），所以两个 modal 同时打开各自调一次没问题。
 * 嵌套场景：最后一个 modal 关闭时 show 恢复 —— 简单方案，靠 effect cleanup 排序。
 * 如果未来真机出现"叠 modal 关闭顺序导致 webview 闪一下"再加 ref-counted store。
 *
 * 失败处理：捕获 IPC 异常（dev 阶段后端没起 / 没有 active webview）只 warn，不抛 —
 * 避免 modal 因为辅助逻辑失败而无法弹出。
 */
export function useBrowserModalGuard(isOpen: boolean): void {
  useEffect(() => {
    if (!isOpen) return;
    browserHideAllActive().catch((e) => {
      console.warn("[modal-guard] browserHideAllActive 失败", e);
    });
    return () => {
      // v1.3.0 P7：恢复显示后**必须**再断言一次 active。
      // 后端 show_all_active 已收紧成"只 show 它认为的 active"，但它认为的可能
      // 是过期值；前端 activeKey 才是"用户看到什么"的真相源，这里补一次同步，
      // 避免 dialog（含 AI 工具审批弹窗）关闭后可见页面与 AI 操作对象错位。
      browserShowAllActive()
        .catch((e) => {
          console.warn("[modal-guard] browserShowAllActive 失败", e);
        })
        .finally(() => {
          void useBrowserStore.getState().reassertActive();
        });
    };
  }, [isOpen]);
}
