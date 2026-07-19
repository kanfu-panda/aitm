/**
 * 终端"用户滚上去后不被输出拽回底部"的滚动锁定逻辑（纯函数，便于单测）。
 *
 * 背景（v1.1.0 R8，真机反馈 + xterm.js issue #216）：xterm.js 判断"新输出是否
 * 把视口拽到底部"的内部开关 `isUserScrolling` 只由**异步的原生 `scroll` DOM 事件**
 * 置真，滞后约 1 帧。像 Claude Code 忙时那样高频 `write()` 时，每笔写入触发的行滚动
 * 都在异步标记生效前先执行 `ydisp = ybase`（拽回底部），用户几乎永远滚不上去。
 * Terminal.app / iTerm 没有这条跨事件循环的竞态，所以能正常滚。
 *
 * 解法（社区对 #216 的公认 workaround）：在应用层用 public API 自己记住"写入前
 * 用户在哪一行"，写完（`write` callback）后若用户本来滚离底部，就 `scrollToLine`
 * 强制拉回写入前的位置——用编程方式赢下竞态，而不指望原生 scroll 事件够快。
 */

/** 缓冲区快照（对应 xterm `term.buffer.active` 的 viewportY / baseY / type）。 */
export interface BufSnapshot {
  /** 'normal' | 'alternate'。备用屏(vim/less)无 scrollback，不介入。 */
  type: "normal" | "alternate";
  /** 视口顶行在整个 buffer 里的行号（xterm ydisp）。 */
  viewportY: number;
  /** 底部（跟随位置）行号（xterm ybase）。 */
  baseY: number;
}

/**
 * 写入**前**判断用户是否已滚离底部（需要锁位置）。
 * 仅普通缓冲区 + 视口不在底部才为真；备用屏 baseY 恒 0，天然为假（双保险）。
 */
export function isScrolledUp(buf: BufSnapshot): boolean {
  return buf.type === "normal" && buf.viewportY < buf.baseY;
}

/**
 * 写入**后**算出要恢复到的目标行；返回 null 表示不需要动（避免多余 scrollToLine）。
 * @param wasScrolledUp 写入前 isScrolledUp 的结果
 * @param savedViewportY 写入前的 viewportY
 * @param post 写入后的缓冲区快照
 */
export function computeScrollRestore(
  wasScrolledUp: boolean,
  savedViewportY: number,
  post: BufSnapshot,
): number | null {
  if (!wasScrolledUp) return null;
  // clamp：这批写入若触发 scrollback 裁剪(10_000 行上限)或 ESC[3J 清 scrollback，
  // baseY 会变小，避免恢复到越界行。
  const target = Math.min(savedViewportY, post.baseY);
  // xterm 内部这次恰好没拽底（用户赢了竞态）时不重复 scroll，防视觉抖动。
  return post.viewportY !== target ? target : null;
}
