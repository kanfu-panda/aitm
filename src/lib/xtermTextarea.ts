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

/**
 * v1.1.0 F4（真机诊断数据驱动）：判定一次**空格 keydown 是否被 WKWebView 吞了、
 * 需要主动补发一个空格**。用来修"cd 后快打空格要按两次"（#4）。
 *
 * ## 为什么以前的时间差判定全翻车
 *
 * WKWebView 上空格的 keydown 一律走 IME 处理路径（keyCode=229），无论是否在
 * 合成中。用"距上次 onData 的时间差"猜被吞，分不清三类空格——它们的
 * `isComposing` / `composing` 标志**全是 false**（真机实测 28/28 中文
 * 确认空格标志都为 false）。
 *
 * ## 真机实测数据揭示的干净分界（59 个空格样本）
 *
 * | 类别 | 样本 | 识别信号 |
 * |---|---|---|
 * | 中文**确认候选词**的空格 | 28 | keydown **紧跟在 ≤50ms 内的 compositionend 后**；onData 吐的是汉字不是空格 |
 * | ASCII 空格**成功** | 20 | keydown 前后 ~2ms 内有 `onData===" "` |
 * | ASCII 空格**被吞** | 11 | keydown 后一个窗口内**始终没有** `onData===" "`（到最近空格 onData ≥558ms） |
 *
 * 三类靠"最近有没有 compositionend"+"窗口内有没有空格 onData"**100% 分开**
 * （模拟 59 样本：补发 11、不补 48、误判 0）。
 *
 * ## 用法（时序无关的短定时器，不再赌 onData 与 keydown 谁先谁后）
 *
 * 空格 keydown 触发时记 `spaceDownTime`，延迟 ~35ms（等 onData 有机会到达）后
 * 调用本函数决定是否 `sessionWrite(" ")`。窗口 35ms 远小于"被吞→最近空格 onData"
 * 的最小间隔 558ms，也远大于"成功空格 onData 早于 keydown"的 2ms，两侧都有厚裕量。
 *
 * @param s 三个时间戳（同一时钟，performance.now / Date.now 皆可，单位一致即可）
 * @param nowMs 定时器触发时刻（约 spaceDownTime + 35）
 * @returns true = 被吞、应补发一个空格；false = 已注册 / 中文确认，别动
 */
export interface SpaceSwallowState {
  /** 空格 keydown 触发时刻。 */
  spaceDownTime: number;
  /** 最近一次 xterm 正常吐出空格（onData===" "）的时刻。初值给一个很小的数。 */
  lastSpaceOnDataTime: number;
  /** 最近一次 IME compositionend 的时刻。初值给一个很小的数。 */
  lastCompEndTime: number;
}

export function shouldInjectSwallowedSpace(
  s: SpaceSwallowState,
  nowMs: number,
): boolean {
  // 中文确认候选词的空格：紧跟在 compositionend 后（真机 ≤4ms，留 50ms 裕量）。
  // 该窗口也涵盖"等待期内合成才刚结束"。命中即不补——IME 已把这一下当确认处理，
  // onData 吐的是汉字，补空格就会变成"要 "多一个空格（以前的老 bug）。
  if (
    s.lastCompEndTime >= s.spaceDownTime - 50 &&
    s.lastCompEndTime <= nowMs
  ) {
    return false;
  }
  // 真 ASCII 空格若成功，xterm 会在 keydown 前后 ~2ms 吐出 onData(" ")（真机实测
  // onData 稳定早于 keydown 0~2ms）。等待窗口 [spaceDownTime-5, nowMs] 内出现过
  // 空格 onData → 已注册 → 不补。
  if (
    s.lastSpaceOnDataTime >= s.spaceDownTime - 5 &&
    s.lastSpaceOnDataTime <= nowMs
  ) {
    return false;
  }
  // 否则：等了一个窗口都没等到空格 onData → 被吞 → 补发。
  return true;
}
