import type { UnlistenFn } from "@tauri-apps/api/event";

import { onAnySessionData, type SessionId } from "./tauri";

/**
 * 打开一个新 PTY，并保证它的**全部**输出都交给 `onBytes`，包括最开头的那一段。
 *
 * 后端 `session_open` 一建好 PTY 就开始把输出以 `session:data` 事件发出来，而
 * Tauri 事件不补发：如果等拿到会话 id 再订阅，shell 启动时打印的提示符可能在订阅
 * 建立之前就发完了，终端从此空着（重启恢复多个标签、主线程忙时最容易出现；尺寸
 * 随后又变了的标签会因 shell 收到窗口变化重画提示符而"碰巧"正常）。
 *
 * 所以先订阅所有会话的输出、再打开 PTY：拿到 id 之前到达的输出先暂存，拿到 id 后
 * 把属于它的按原顺序补交，其余丢弃；之后只转交这个会话的输出。
 */
export async function openSessionWithOutput(
  open: () => Promise<SessionId>,
  onBytes: (bytes: Uint8Array) => void,
  listenAll: typeof onAnySessionData = onAnySessionData,
): Promise<{ id: SessionId; unlisten: UnlistenFn }> {
  let target: SessionId | null = null;
  const early: [SessionId, Uint8Array][] = [];
  const unlisten = await listenAll((sessionId, bytes) => {
    if (target === null) {
      early.push([sessionId, bytes]);
      return;
    }
    if (sessionId === target) onBytes(bytes);
  });

  let id: SessionId;
  try {
    id = await open();
  } catch (e) {
    unlisten();
    throw e;
  }
  // 补交与切换目标在同一段同步代码里完成，中间不会插进新的事件回调，顺序不会乱
  for (const [sessionId, bytes] of early) {
    if (sessionId === id) onBytes(bytes);
  }
  early.length = 0;
  target = id;
  return { id, unlisten };
}
