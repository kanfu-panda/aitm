/**
 * `Cmd+1` … `Cmd+9` 切标签的选取逻辑。
 *
 * **作用域是"当前焦点分屏"**，不是全局标签列表：分屏之后每个 group 有自己的标签栏，
 * 编号就是该 group 从左到右的顺序。这样编号只受该 group 自己的增删影响，不会因为
 * 别的 group 开了标签就整体错位。
 *
 * `Cmd+9` 是"最后一个"而不是"第 9 个" —— Chrome / Safari / iTerm2 / Terminal.app
 * 全都是这个约定，跟着走比自造一套更省用户的记忆。标签少于 9 个时 `Cmd+9` 因此仍然
 * 有效（跳到最后一个），而 `Cmd+4` 在只有 3 个标签时无效。
 */

/** `Cmd+9` 的语义：跳到最后一个标签（而非第 9 个）。 */
export const LAST_TAB_DIGIT = 9;

/**
 * 按数字键解析出目标标签 id。
 *
 * @param tabIds 当前焦点 group 的标签 id，按标签栏从左到右的顺序
 * @param digit  1–9
 * @returns 目标标签 id；越界 / 无标签 / digit 非法时返回 `null`（调用方应当什么都不做，
 *          而不是兜底跳到某个标签——按错数字时静默跳转比没反应更让人困惑）
 */
export function resolveDigitTarget(
  tabIds: readonly string[],
  digit: number,
): string | null {
  if (!Number.isInteger(digit) || digit < 1 || digit > 9) return null;
  if (tabIds.length === 0) return null;
  if (digit === LAST_TAB_DIGIT) return tabIds[tabIds.length - 1];
  return tabIds[digit - 1] ?? null;
}

/**
 * 把 `KeyboardEvent.code` 映射成 1–9；不是数字键返回 `null`。
 *
 * 用 `code`（物理键位）而不是 `key`：`key` 受输入法和键盘布局影响，
 * 法语 AZERTY 上主键区数字要按 Shift 才出数字，而 `code` 恒为 `Digit1`。
 * 同时接受小键盘 `Numpad1`。
 */
export function digitFromCode(code: string): number | null {
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(code);
  return m ? Number(m[1]) : null;
}
