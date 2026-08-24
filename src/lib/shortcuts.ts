import { useEffect } from "react";
import { useSettingsStore } from "../stores/settings";

/**
 * v0.10.0 HR7-7：设置面板快捷键配置维护页。
 *
 * 本模块同时承担三件事：
 * 1. **action 注册表** —— [`ActionName`] 联合类型 + [`DEFAULT_KEYBINDINGS`] 默认表，
 *    App.tsx 的 [`useShortcuts`] 和 SettingsModal 的"快捷键"tab 共用。
 * 2. **快捷键字符串解析** —— [`parseKeybinding`] 把 `"Cmd+Shift+W"` 这类字符串
 *    解析成 modifier mask + 主键；[`matchKeybinding`] 配合 `keydown` 事件匹配。
 * 3. **运行时绑定** —— [`useShortcuts`] hook：读 settings store 里的用户覆盖
 *    （`settings.ui.keybindings`），merge 进默认表，按解析后的 binding 触发 handler。
 *
 * **保持 API 不变**：HR3-5 / HR6-3d 的 [`Handlers`] interface 全字段保留，
 * App.tsx 调用方零改动；内部实现从硬编码 if/else 改为 binding map 驱动。
 */

/** v0.10.0 HR7-7：所有可绑定的 action 名（前后端共用 key 字符串）。
 *
 *  增删该联合类型时同步更新：
 *  - [`DEFAULT_KEYBINDINGS`]（默认 binding 表）
 *  - [`ACTION_LABELS`]（中文展示名，在 KeybindingsSection.tsx）
 *  - [`Handlers`] interface（运行时回调注册）
 */
export type ActionName =
  | "newTab"
  | "closeTab"
  | "nextTab"
  | "prevTab"
  | "openSettings"
  | "toggleSidebar"
  | "toggleBrowser"
  | "toggleFilePreview"
  | "splitVertical"
  | "splitHorizontal"
  | "closePane"
  | "openCommandPalette";

/** v0.10.0 HR7-7：默认快捷键表（cross-platform 描述字符串）。
 *
 *  解析约定见 [`parseKeybinding`]：`Cmd` / `Ctrl` / `Shift` / `Alt` 加号分隔，
 *  最后一段是主键（`T` / `,` / `/` / `\\` / `]` 等）。
 *
 *  macOS Cmd ←→ Windows/Linux Ctrl：runtime 同时接受 `Cmd` 和 `Ctrl` 修饰符
 *  （[`matchKeybinding`] 用 `meta || ctrl` 兜底）—— 用户在配置面板里看到的字符串
 *  按 macOS 习惯统一写 `Cmd+...`，跨平台无须改 binding。
 */
export const DEFAULT_KEYBINDINGS: Record<ActionName, string> = {
  newTab: "Cmd+T",
  closeTab: "Cmd+W",
  nextTab: "Cmd+Shift+]",
  prevTab: "Cmd+Shift+[",
  openSettings: "Cmd+,",
  toggleSidebar: "Cmd+/",
  toggleBrowser: "Cmd+Shift+B",
  toggleFilePreview: "Cmd+Shift+E",
  splitVertical: "Cmd+\\",
  splitHorizontal: "Cmd+Shift+\\",
  closePane: "Cmd+Shift+W",
  // 命令面板。终端里 Cmd+K 传统上是"清屏"，但 aitm 目前没有清屏命令，这个键位
  // 空着；用户若更习惯清屏语义，可在 设置 → 快捷键 里改绑（如 Cmd+Shift+P）。
  openCommandPalette: "Cmd+K",
};

/** 解析后的 binding 结构。`key` 已小写化便于 case-insensitive 比对。 */
export interface ParsedKeybinding {
  /** 是否要求 Cmd / Meta；同时也兼容 Ctrl（[`matchKeybinding`] 内 OR）。 */
  meta: boolean;
  /** 是否显式要求 Ctrl（独立于 meta；当 binding 字符串只写 `Ctrl+X` 时为 true）。 */
  ctrl: boolean;
  /** 是否要求 Shift。 */
  shift: boolean;
  /** 是否要求 Alt / Option。 */
  alt: boolean;
  /** 主键，已 `toLowerCase()`。可能是单字母（`"t"`）或符号（`","` / `"/"` / `"\\"` / `"]"`）。 */
  key: string;
}

/** 解析快捷键描述字符串。
 *
 *  支持的修饰符：`Cmd` / `Meta` / `⌘` → meta；`Ctrl` / `Control` / `^` → ctrl；
 *  `Shift` / `⇧` → shift；`Alt` / `Option` / `⌥` → alt。
 *
 *  主键大小写不敏感（统一小写）；空字符串 / 无主键 / 全是修饰符时返回 null。
 *
 *  例：
 *  - `"Cmd+T"` → `{meta: true, ..., key: "t"}`
 *  - `"Cmd+Shift+W"` → `{meta: true, shift: true, ..., key: "w"}`
 *  - `"Cmd+\\"` → `{meta: true, ..., key: "\\"}`
 *  - `"Cmd+,"` → `{meta: true, ..., key: ","}`
 *  - `""` → `null`
 *  - `"Cmd+"` → `null`（无主键）
 */
export function parseKeybinding(s: string): ParsedKeybinding | null {
  if (!s || typeof s !== "string") return null;
  const parts = s.split("+").map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length === 0) return null;

  let meta = false;
  let ctrl = false;
  let shift = false;
  let alt = false;
  let key: string | null = null;

  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    const tok = parts[i];
    const lower = tok.toLowerCase();
    // 修饰符识别；最后一段如果同时是修饰符名（如 `"Cmd+Shift"`），不当主键。
    if (lower === "cmd" || lower === "meta" || lower === "command" || tok === "⌘") {
      meta = true;
    } else if (lower === "ctrl" || lower === "control" || tok === "^") {
      ctrl = true;
    } else if (lower === "shift" || tok === "⇧") {
      shift = true;
    } else if (lower === "alt" || lower === "option" || lower === "opt" || tok === "⌥") {
      alt = true;
    } else if (isLast) {
      // 主键：保留原 case 但 toLowerCase 便于跨平台比对。
      key = tok.toLowerCase();
    } else {
      // 中间段出现未知字符串 → 视为非法 binding（如 `"Cmd+Foo+T"`）。
      return null;
    }
  }

  if (key === null) return null;
  return { meta, ctrl, shift, alt, key };
}

/** 用 `keydown` 事件匹配 [`ParsedKeybinding`]。
 *
 *  跨平台兼容：binding 字符串写 `Cmd+X`，在 Windows / Linux 按 Ctrl+X 也能命中
 *  （`meta` 要求时 `metaKey || ctrlKey` 都接受）；反之同理。
 *
 *  主键匹配优先用 `e.key.toLowerCase()`，对反斜杠等特殊键回退到 `e.code`
 *  （部分键盘布局 `e.key` 可能是 "Dead" 之类异常值）。
 */
export function matchKeybinding(
  e: KeyboardEvent,
  kb: ParsedKeybinding | null,
): boolean {
  if (!kb) return false;

  // 修饰符匹配：meta 和 ctrl 允许互通；shift / alt 要求精确。
  if (kb.meta || kb.ctrl) {
    // binding 要求至少一个 meta/ctrl 修饰键
    if (!(e.metaKey || e.ctrlKey)) return false;
  } else {
    // binding 不要求 meta/ctrl 时，事件也不应有（避免误触发）
    if (e.metaKey || e.ctrlKey) return false;
  }
  if (kb.shift !== e.shiftKey) return false;
  if (kb.alt !== e.altKey) return false;

  // 主键匹配
  const eventKey = (e.key || "").toLowerCase();
  if (eventKey === kb.key) return true;

  // 特殊键码兜底：反斜杠等键 e.key 可能异常
  if (kb.key === "\\" && e.code === "Backslash") return true;
  if (kb.key === "]" && e.code === "BracketRight") return true;
  if (kb.key === "[" && e.code === "BracketLeft") return true;

  return false;
}

/** v0.10.0 HR7-7：找出所有有冲突的 action 分组。
 *
 *  返回 `[[action1, action2], ...]`：每个内部数组是绑定同一快捷键的 ≥2 个 action。
 *  无冲突时返回空数组。
 *
 *  解析失败的 binding 不参与冲突检测（前端 UI 单独标"非法 binding"红字）。
 */
export function findConflicts(bindings: Record<ActionName, string>): ActionName[][] {
  const groups = new Map<string, ActionName[]>();
  for (const [action, kb] of Object.entries(bindings) as Array<[ActionName, string]>) {
    const parsed = parseKeybinding(kb);
    if (!parsed) continue;
    // 用规范化字符串当 key：modifier 顺序 + 小写主键，避免 "Cmd+Shift+T" / "Shift+Cmd+T" 误判不冲突
    const norm = [
      parsed.meta ? "M" : "",
      parsed.ctrl ? "C" : "",
      parsed.shift ? "S" : "",
      parsed.alt ? "A" : "",
      "|",
      parsed.key,
    ].join("");
    if (!groups.has(norm)) groups.set(norm, []);
    groups.get(norm)!.push(action);
  }
  return Array.from(groups.values()).filter((g) => g.length > 1);
}

/** v0.10.0 HR7-7：把 [`ParsedKeybinding`] 转回展示用字符串。
 *
 *  规范顺序 `Cmd+Ctrl+Alt+Shift+<Key>` —— 主键大写化（单字母）。
 *  KeybindingCaptureDialog 用户按键时实时调用。
 */
export function formatKeybinding(kb: ParsedKeybinding): string {
  const parts: string[] = [];
  if (kb.meta) parts.push("Cmd");
  if (kb.ctrl) parts.push("Ctrl");
  if (kb.alt) parts.push("Alt");
  if (kb.shift) parts.push("Shift");
  // 主键 length===1 的字母 → 大写化；其他保留原样（`,` / `/` / `\\` / `]`）。
  const key = kb.key.length === 1 && /[a-z]/.test(kb.key) ? kb.key.toUpperCase() : kb.key;
  parts.push(key);
  return parts.join("+");
}

interface Handlers {
  newTab: () => void;
  closeTab: () => void;
  nextTab: () => void;
  prevTab: () => void;
  openSettings: () => void;
  toggleSidebar: () => void;
  /**
   * v0.9.1 HR3-5：Cmd+Shift+B / Ctrl+Shift+B 切换浏览器面板。
   * Cmd+B 已被 FileTree 占用（App.tsx 内联 effect），所以浏览器用 Shift 组合。
   */
  toggleBrowser: () => void;
  /**
   * v0.10.0 HR9-6：Cmd+Shift+E → 切文件预览面板可见性。
   * 跟浏览器按钮 toggle 行为一致：可见 → 隐藏到 ActivityBar；隐藏 → 恢复显示。
   * 没打开任何文件时按 shortcut 仍 toggle store 状态（无视觉变化但不报错）。
   */
  toggleFilePreview: () => void;
  /**
   * v0.10.0 HR6-3d：Cmd+\\ → 在 active group 上做左右分屏（vertical 切线）。
   * direction 语义跟 LayoutNode 对齐：左右分 = `horizontal`（panel rows）。
   */
  splitVertical: () => void;
  /**
   * v0.10.0 HR6-3d：Cmd+Shift+\\ → 在 active group 上做上下分屏（horizontal 切线）。
   * direction = `vertical`（panel columns 上下排）。
   */
  splitHorizontal: () => void;
  /**
   * v0.10.0 HR6-3d：Cmd+Shift+W → 关 active group（与现有 Cmd+W 关 tab 区分开）。
   * 根节点 / 唯一 group 时 store closeGroup 返 false，调用方 silent no-op。
   */
  closePane: () => void;
}

/** v0.10.0 HR7-7：合并默认 binding + 用户覆盖，返回每个 action 的 binding 字符串。 */
export function mergeKeybindings(
  overrides: Record<string, string>,
): Record<ActionName, string> {
  const out = { ...DEFAULT_KEYBINDINGS };
  for (const key of Object.keys(out) as ActionName[]) {
    const ovr = overrides[key];
    if (typeof ovr === "string" && ovr.length > 0) {
      out[key] = ovr;
    }
  }
  return out;
}

export function useShortcuts(h: Handlers): void {
  // 订阅用户自定义 binding：用户在 SettingsModal 改后 store 变 → effect 重跑 → re-bind。
  const overrides = useSettingsStore((s) => s.settings.ui.keybindings);

  useEffect(() => {
    const merged = mergeKeybindings(overrides);
    // 预解析所有 action 的 binding，避免每次 keydown 重新 parse。
    const parsed: Array<{ action: ActionName; kb: ParsedKeybinding }> = [];
    for (const action of Object.keys(merged) as ActionName[]) {
      const kb = parseKeybinding(merged[action]);
      if (kb) parsed.push({ action, kb });
    }

    const onKey = (e: KeyboardEvent) => {
      for (const { action, kb } of parsed) {
        if (matchKeybinding(e, kb)) {
          e.preventDefault();
          // v0.10.0 HR9-7：stopImmediatePropagation 阻 xterm helper textarea 看到。
          // 真机 维护者 反馈：终端焦点时按 Cmd+W 弹"退出 aitm" dialog。
          // 链路：xterm.js textarea 在 capture phase listen keydown，匹配自身 keymap
          // 后会 stopPropagation —— window 层 bubble listener 收不到 → 没 preventDefault
          // → webview 默认 Cmd+W 行为 = 关窗口 → 后端 WindowEvent::CloseRequested
          // → QuitConfirmDialog 弹。
          // 解决：listener 改 capture phase（早于 xterm 跑）+ stopImmediatePropagation
          // 阻止 xterm 接到。
          e.stopImmediatePropagation();
          // 派发对应 handler；写一个 switch 而非动态索引以保留类型安全。
          switch (action) {
            case "newTab":
              h.newTab();
              break;
            case "closeTab":
              h.closeTab();
              break;
            case "nextTab":
              h.nextTab();
              break;
            case "prevTab":
              h.prevTab();
              break;
            case "openSettings":
              h.openSettings();
              break;
            case "toggleSidebar":
              h.toggleSidebar();
              break;
            case "toggleBrowser":
              h.toggleBrowser();
              break;
            case "toggleFilePreview":
              h.toggleFilePreview();
              break;
            case "splitVertical":
              h.splitVertical();
              break;
            case "splitHorizontal":
              h.splitHorizontal();
              break;
            case "closePane":
              h.closePane();
              break;
          }
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [h, overrides]);
}
