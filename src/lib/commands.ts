import { DEFAULT_KEYBINDINGS, type ActionName } from "./shortcuts";

/**
 * 命令面板的一条命令。
 *
 * 命令**不是**单独维护的一份清单，而是直接由 [`ActionName`] 注册表派生的——
 * 新增一个 action 就自动出现在面板里，不会出现"加了快捷键忘了加进面板"的漂移。
 */
export interface Command {
  action: ActionName;
  /** 已翻译的标题 */
  title: string;
  /** 当前生效的快捷键描述（含用户自定义覆盖）；无绑定时为空串 */
  shortcut: string;
}

/**
 * 面板里不列出的 action。
 *
 * `openCommandPalette` 自己：在面板里再列一条"打开命令面板"没有意义。
 */
const HIDDEN: ReadonlySet<ActionName> = new Set<ActionName>([
  "openCommandPalette",
]);

/**
 * 由 action 注册表 + 当前生效的快捷键表构建命令列表。
 *
 * @param bindings 已合并用户覆盖的 binding 表（`mergeKeybindings` 的结果）
 * @param t        i18n 取词函数；key 约定 `commands.<action>`
 */
export function buildCommandList(
  bindings: Partial<Record<ActionName, string>>,
  t: (key: string) => string,
): Command[] {
  return (Object.keys(DEFAULT_KEYBINDINGS) as ActionName[])
    .filter((a) => !HIDDEN.has(a))
    .map((action) => ({
      action,
      title: t(`commands.${action}`),
      shortcut: bindings[action] ?? "",
    }));
}

/**
 * 按查询串过滤命令。
 *
 * 匹配规则（都不区分大小写）：
 * 1. 标题**子串**命中
 * 2. 标题**首字母缩写**命中（"新建标签" 里的拼音首字母做不到，但英文 UI 下
 *    "New Tab" → "nt" 可以）
 * 3. action 名子串命中（`newTab` → 输 "newtab" 也能找到，方便习惯英文的人）
 *
 * 不做复杂的模糊打分：命令总数是十几条量级，子串足够；打分函数难调且会让
 * 结果顺序变得不可预测——固定顺序的列表反而更容易形成肌肉记忆。
 */
export function filterCommands(list: Command[], query: string): Command[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((c) => {
    const title = c.title.toLowerCase();
    if (title.includes(q)) return true;
    if (c.action.toLowerCase().includes(q)) return true;
    const initials = title
      .split(/[\s/]+/)
      .map((w) => w[0] ?? "")
      .join("");
    return initials.includes(q);
  });
}

/** 在列表内循环移动选中项；空列表返回 0。 */
export function moveSelection(
  length: number,
  current: number,
  delta: 1 | -1,
): number {
  if (length === 0) return 0;
  return (current + delta + length) % length;
}
