import { tmuxSessionOfTab } from "./tauri";
import { useTabsStore } from "../stores/tabs";

/**
 * 找出在标签里手敲 `tmux attach` / `tmux new` 接入的会话，记到标签上。
 *
 * 记下之后，这类标签和从面板接入的一样：显示 tmux 图标与会话名，随快照落盘，
 * 重启时会话还在就自动接回。
 *
 * **不做常驻轮询**：每次识别都要 fork 一个 tmux 进程并扫一遍进程表。只在两个
 * 时机调用——tmux 面板刷新时发现有未知客户端接着会话，以及弹退出确认时（此时
 * 快照即将写最后一次）。只查还没记下会话、且 PTY 已起来的标签；单个标签查询
 * 失败按"没接"处理，不影响其它标签。
 */
export async function detectHandTypedTmux(): Promise<void> {
  const pending = useTabsStore
    .getState()
    .tabs.filter((t) => t.sessionId && !t.tmuxSessionId);
  await Promise.all(
    pending.map(async (t) => {
      try {
        const ref = await tmuxSessionOfTab(t.sessionId as string);
        if (ref) useTabsStore.getState().markTmuxSession(t.id, ref);
      } catch (e) {
        console.warn("[tmux] 识别标签里的 tmux 接入失败，按普通标签处理", e);
      }
    }),
  );
}
