/**
 * 禁用 xterm.js helper textarea 的 macOS 系统级文本辅助行为。
 *
 * 关掉 HTML textarea 上 autocapitalize / autocorrect / autocomplete / spellcheck
 * 4 个 attribute。它**不是** Shift 组合键卡顿的根因（根因是 WKWebView 的 IME
 * 事件路径 bug，见 shouldFixSwallowedShiftKey），但关掉仍能消除大写自动纠正 /
 * 拼写下划线红线干扰，保留无害。
 *
 * xterm.js 5.x 不提供构造选项关，只能 mount 后直接改 DOM。
 */
export function disableSystemTextInput(
  textarea: HTMLTextAreaElement | null | undefined,
): void {
  if (!textarea) return;
  textarea.setAttribute("autocapitalize", "off");
  textarea.setAttribute("autocorrect", "off");
  textarea.setAttribute("autocomplete", "off");
  textarea.spellcheck = false;
}

/**
 * 当前 runtime 是否是 WebKit/WKWebView（包括 Safari）。
 *
 * Tauri macOS 用 WKWebView，UA 含 `AppleWebKit` 且不含 `Chrome`。Chromium 系
 * 浏览器 UA 也含 AppleWebKit，要排除。
 */
export function isWebKitRuntime(ua: string = navigator.userAgent): boolean {
  return /AppleWebKit/.test(ua) && !/Chrome/.test(ua);
}

interface ShiftKeyEvent {
  type: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  key: string;
}

/**
 * 判定当前 keydown 是否触发了 xterm.js issue #5374 描述的"WKWebView 上 Shift+
 * 某些字符第一次按下被吞"bug，需要主动写 PTY 兜底。
 *
 * 根因：Safari/WKWebView 内部 IME 事件路径对 Shift+**标点**（如 `_`/`~`/`#`/`"`/`$`
 * 等）第一次 keydown 不触发 onData，第二次才触发。Chrome 不复现。
 * https://github.com/xtermjs/xterm.js/issues/5374
 *
 * **Shift+字母（产生大写 A-Z）不在 bug 范围**——xterm.js 在 WebKit 上能正常
 * 处理。v0.5.4 真机反馈 维护者 用 Shift+字母时 workaround 把字母重复发了一次
 * 导致双发（如 Shift+a 出现 "AA"）。修：限制 workaround 仅作用于**非字母**
 * 的单字符（标点 / 数字 shift 出来的字符；大写字母不应被这个 workaround 处理）。
 *
 * 检测策略（issue 评论 route250 的 workaround 思路）：keydown 触发瞬间，如果
 * 距离最近一次 onData 触发时间 > 50ms，说明本次 keydown 没及时让 onData 触发
 * → 被吞 case → 应主动 sessionWrite 兜底。
 *
 * 限制范围（v0.5.4 收紧）：
 * - Shift + 单字符 + 没其他修饰键
 * - `e.key` 必须**不是字母**（不是 a-z / A-Z）
 * - keydown 时距离最近 onData > 50ms
 *
 * 调用方应只在 isWebKitRuntime() 为 true 时启用，其他浏览器不需要兜底。
 */
export function shouldFixSwallowedShiftKey(
  event: ShiftKeyEvent,
  lastOnDataTimeMs: number,
  nowMs: number = Date.now(),
): boolean {
  if (event.type !== "keydown") return false;
  if (!event.shiftKey) return false;
  if (event.altKey || event.ctrlKey || event.metaKey) return false;
  if (event.key.length !== 1) return false;
  // v0.5.4：字母（Shift 出来是大写）不应用 workaround，xterm 处理 OK
  if (/^[a-zA-Z]$/.test(event.key)) return false;
  return nowMs - lastOnDataTimeMs > 50;
}
