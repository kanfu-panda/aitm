/**
 * 终端主题预集。
 *
 * 颜色值用社区主流来源，不自调色：
 * - Dracula: https://draculatheme.com/spec
 * - Solarized: Ethan Schoonover 原版（base0-base3 / accent 8 色）
 * - One Dark: Atom one-dark-syntax 衍生
 * - One Light: Atom one-light-syntax 衍生（与 One Dark 配对）
 * - GitHub Dark/Light: github/primer 系列经典 syntax 色
 * - Monokai: Monokai 经典深色 / 配对的 Monokai Light 取自 Monokai Pro Light Sun
 * - Homebrew: macOS Terminal.app 自带 "Homebrew.terminal" 配色（黑底亮绿，matrix 风）
 * - Warp: warpdotdev/themes 仓库 standard/warp_dark.yaml
 * - Catppuccin Mocha: https://github.com/catppuccin/catppuccin（官方 Mocha 风味色板）
 *
 * xterm.js ITheme 字段除了 fg/bg/cursor，必须配齐 16 个 ANSI 色（black/red/...
 * /white + 8 个 bright-）才能让 LLM / shell 输出的彩色文字（如 git diff、
 * tldr、错误提示）显示为预期颜色。
 *
 * v0.4.1 T5 新增 `mode` + `pairLight` / `pairDark` 字段：
 * - `mode`：标记 theme 自身是 dark 还是 light
 * - `pairLight`：dark theme 切到 light mode 时自动选用的配对 theme id
 * - `pairDark`：light theme 切到 dark mode 时自动选用的配对 theme id
 *
 * 用户在终端 tab 里选的 theme 即为"风格基准"；切换全局 theme_mode 时
 * `getPairedTheme()` 自动找配对，保留风格只换深浅。
 */
import type { ITheme } from "@xterm/xterm";

/** 主题深浅模式标签。dark = 暗色基调（背景偏黑），light = 亮色基调（背景偏白）。 */
export type ThemeColorMode = "dark" | "light";

/** ThemeMode 别名（与 src/lib/theme.ts 同源）：'auto' | 'dark' | 'light'。
 *  这里复制定义避免本文件被 xterm 子模块引用时拉进 theme.ts 的 DOM 依赖。 */
export type XtermThemeMode = "auto" | "dark" | "light";

export interface TerminalTheme {
  id: string;
  display_name: string;
  /** 4 个用于 SettingsModal 主题色卡 mini 预览的代表色（bg / fg / accent1 / accent2） */
  preview: [string, string, string, string];
  xterm: ITheme;
  /** v0.4.1 T5：主题深浅模式。 */
  mode: ThemeColorMode;
  /** v0.4.1 T5：仅 dark theme 有；指向对应 light theme id（切到 light mode 时用）。 */
  pairLight?: string;
  /** v0.4.1 T5：仅 light theme 有；指向对应 dark theme id（切到 dark mode 时用）。 */
  pairDark?: string;
}

const DEFAULT: TerminalTheme = {
  id: "default",
  display_name: "默认",
  preview: ["#09090b", "#e4e4e7", "#10b981", "#f43f5e"],
  xterm: {
    background: "#09090b",
  },
  mode: "dark",
  // 默认走 github-light 作 light pair（最朴素的浅色基调）。
  pairLight: "github-light",
};

const DRACULA: TerminalTheme = {
  id: "dracula",
  display_name: "Dracula",
  preview: ["#282a36", "#f8f8f2", "#bd93f9", "#ff79c6"],
  xterm: {
    foreground: "#f8f8f2",
    background: "#282a36",
    cursor: "#f8f8f2",
    cursorAccent: "#282a36",
    selectionBackground: "#44475a",
    black: "#21222c",
    red: "#ff5555",
    green: "#50fa7b",
    yellow: "#f1fa8c",
    blue: "#bd93f9",
    magenta: "#ff79c6",
    cyan: "#8be9fd",
    white: "#f8f8f2",
    brightBlack: "#6272a4",
    brightRed: "#ff6e6e",
    brightGreen: "#69ff94",
    brightYellow: "#ffffa5",
    brightBlue: "#d6acff",
    brightMagenta: "#ff92df",
    brightCyan: "#a4ffff",
    brightWhite: "#ffffff",
  },
  mode: "dark",
  // Dracula 没官方 light 对子；找不到 pair 时 getPairedTheme 兜底 github-light。
};

const SOLARIZED_DARK: TerminalTheme = {
  id: "solarized-dark",
  display_name: "Solarized Dark",
  preview: ["#002b36", "#839496", "#268bd2", "#dc322f"],
  xterm: {
    foreground: "#839496",
    background: "#002b36",
    cursor: "#93a1a1",
    cursorAccent: "#002b36",
    selectionBackground: "#073642",
    black: "#073642",
    red: "#dc322f",
    green: "#859900",
    yellow: "#b58900",
    blue: "#268bd2",
    magenta: "#d33682",
    cyan: "#2aa198",
    white: "#eee8d5",
    brightBlack: "#002b36",
    brightRed: "#cb4b16",
    brightGreen: "#586e75",
    brightYellow: "#657b83",
    brightBlue: "#839496",
    brightMagenta: "#6c71c4",
    brightCyan: "#93a1a1",
    brightWhite: "#fdf6e3",
  },
  mode: "dark",
  pairLight: "solarized-light",
};

const SOLARIZED_LIGHT: TerminalTheme = {
  id: "solarized-light",
  display_name: "Solarized Light",
  preview: ["#fdf6e3", "#657b83", "#268bd2", "#dc322f"],
  xterm: {
    foreground: "#657b83",
    background: "#fdf6e3",
    cursor: "#586e75",
    cursorAccent: "#fdf6e3",
    selectionBackground: "#eee8d5",
    black: "#073642",
    red: "#dc322f",
    green: "#859900",
    yellow: "#b58900",
    blue: "#268bd2",
    magenta: "#d33682",
    cyan: "#2aa198",
    white: "#eee8d5",
    brightBlack: "#002b36",
    brightRed: "#cb4b16",
    brightGreen: "#586e75",
    brightYellow: "#657b83",
    brightBlue: "#839496",
    brightMagenta: "#6c71c4",
    brightCyan: "#93a1a1",
    brightWhite: "#fdf6e3",
  },
  mode: "light",
  pairDark: "solarized-dark",
};

const ONE_DARK: TerminalTheme = {
  id: "one-dark",
  display_name: "One Dark",
  preview: ["#282c34", "#abb2bf", "#61afef", "#e06c75"],
  xterm: {
    foreground: "#abb2bf",
    background: "#282c34",
    cursor: "#528bff",
    cursorAccent: "#282c34",
    selectionBackground: "#3e4451",
    black: "#282c34",
    red: "#e06c75",
    green: "#98c379",
    yellow: "#e5c07b",
    blue: "#61afef",
    magenta: "#c678dd",
    cyan: "#56b6c2",
    white: "#abb2bf",
    brightBlack: "#5c6370",
    brightRed: "#e06c75",
    brightGreen: "#98c379",
    brightYellow: "#d19a66",
    brightBlue: "#61afef",
    brightMagenta: "#c678dd",
    brightCyan: "#56b6c2",
    brightWhite: "#ffffff",
  },
  mode: "dark",
  pairLight: "one-light",
};

/**
 * Homebrew —— macOS Terminal.app 自带的经典黑底绿字主题。
 *
 * 色值取自 Apple 官方 `Homebrew.terminal` plist：纯黑背景，亮绿前景 / 光标，
 * matrix 风格。其余 ANSI 16 色采用与 Apple "Basic" 主题接近的标准 xterm 256
 * 色 ANSI 名义值（bright 系列略提亮），保证 git diff / ls --color 等彩色输出
 * 不会糊成一片绿。
 */
const HOMEBREW: TerminalTheme = {
  id: "homebrew",
  display_name: "Homebrew",
  preview: ["#000000", "#28fe14", "#23c61f", "#ff5555"],
  xterm: {
    foreground: "#28fe14",
    background: "#000000",
    cursor: "#23c61f",
    cursorAccent: "#000000",
    selectionBackground: "#185c0c",
    black: "#000000",
    red: "#a00000",
    green: "#00a000",
    yellow: "#a0a000",
    blue: "#0000a0",
    magenta: "#a000a0",
    cyan: "#00a0a0",
    white: "#a0a0a0",
    brightBlack: "#505050",
    brightRed: "#ff5050",
    brightGreen: "#28fe14",
    brightYellow: "#ffff50",
    brightBlue: "#5050ff",
    brightMagenta: "#ff50ff",
    brightCyan: "#50ffff",
    brightWhite: "#ffffff",
  },
  mode: "dark",
  // Homebrew 是黑底亮绿"matrix 风"经典 dark；无对应官方 light 配色 —— 兜底 github-light。
};

/**
 * Warp —— Warp 终端的官方深色主题。
 *
 * 色值参考 warpdotdev/themes 仓库 `standard/warp_dark.yaml`：深蓝灰底
 * (#1e2335)，柔白前景 (#cdd6f4)，紫粉色调强调 (accent #afafff / pink #ff8b8b)。
 * 现代感深色，配合 zinc UI 主调子。
 */
const WARP: TerminalTheme = {
  id: "warp",
  display_name: "Warp",
  preview: ["#1e2335", "#cdd6f4", "#afafff", "#ff8b8b"],
  xterm: {
    foreground: "#cdd6f4",
    background: "#1e2335",
    cursor: "#afafff",
    cursorAccent: "#1e2335",
    selectionBackground: "#414458",
    black: "#1e2335",
    red: "#ff8b8b",
    green: "#a6f0c6",
    yellow: "#f5e5a6",
    blue: "#7dc4ff",
    magenta: "#d6b3ff",
    cyan: "#9ce0ff",
    white: "#cdd6f4",
    brightBlack: "#5c637a",
    brightRed: "#ffa1a1",
    brightGreen: "#b6ffd6",
    brightYellow: "#fff0b8",
    brightBlue: "#9bd6ff",
    brightMagenta: "#e6c4ff",
    brightCyan: "#b8edff",
    brightWhite: "#ffffff",
  },
  mode: "dark",
  // Warp 没官方 light 对子；兜底 github-light。
};

/**
 * Catppuccin Mocha —— Catppuccin 官方 Mocha 风味，社区最热门的柔和深色主题。
 *
 * 色值取自官方仓库 `catppuccin/catppuccin` 的 Mocha palette（base
 * #1e1e2e、text #cdd6f4、mauve / pink / red / peach / yellow / green / teal /
 * blue 各色），柔和粉紫底色配较高对比度的彩色 ANSI。
 */
const CATPPUCCIN_MOCHA: TerminalTheme = {
  id: "catppuccin-mocha",
  display_name: "Catppuccin Mocha",
  preview: ["#1e1e2e", "#cdd6f4", "#cba6f7", "#f5c2e7"],
  xterm: {
    foreground: "#cdd6f4",
    background: "#1e1e2e",
    cursor: "#f5e0dc",
    cursorAccent: "#1e1e2e",
    selectionBackground: "#585b70",
    black: "#45475a",
    red: "#f38ba8",
    green: "#a6e3a1",
    yellow: "#f9e2af",
    blue: "#89b4fa",
    magenta: "#cba6f7",
    cyan: "#94e2d5",
    white: "#bac2de",
    brightBlack: "#585b70",
    brightRed: "#f38ba8",
    brightGreen: "#a6e3a1",
    brightYellow: "#f9e2af",
    brightBlue: "#89b4fa",
    brightMagenta: "#cba6f7",
    brightCyan: "#94e2d5",
    brightWhite: "#a6adc8",
  },
  mode: "dark",
  // Catppuccin 也有 Latte（light）风味；当前未实现 latte，兜底 github-light。
};

/**
 * GitHub Dark —— GitHub Primer Dark 经典 syntax 配色。
 *
 * 色值参考 github/primer 设计系统 + GitHub web syntax highlighting：
 * 深灰底 (#0d1117)、浅蓝 fg (#c9d1d9)、亮蓝 accent (#58a6ff)、橙红 (#ff7b72)。
 * v0.4.1 T5 新增，配对 GitHub Light，作为通用 fallback dark theme（其它没 light
 * pair 的 dark theme 切到 light mode 时也兜底到 github-light）。
 */
const GITHUB_DARK: TerminalTheme = {
  id: "github-dark",
  display_name: "GitHub Dark",
  preview: ["#0d1117", "#c9d1d9", "#58a6ff", "#ff7b72"],
  xterm: {
    foreground: "#c9d1d9",
    background: "#0d1117",
    cursor: "#58a6ff",
    cursorAccent: "#0d1117",
    selectionBackground: "#264f78",
    black: "#484f58",
    red: "#ff7b72",
    green: "#3fb950",
    yellow: "#d29922",
    blue: "#58a6ff",
    magenta: "#bc8cff",
    cyan: "#39c5cf",
    white: "#b1bac4",
    brightBlack: "#6e7681",
    brightRed: "#ffa198",
    brightGreen: "#56d364",
    brightYellow: "#e3b341",
    brightBlue: "#79c0ff",
    brightMagenta: "#d2a8ff",
    brightCyan: "#56d4dd",
    brightWhite: "#f0f6fc",
  },
  mode: "dark",
  pairLight: "github-light",
};

/**
 * GitHub Light —— GitHub Primer Light 经典 syntax 配色（v0.4.1 T5 新增）。
 *
 * 纯白底 (#ffffff)、深灰 fg (#24292f)、GitHub 蓝 (#0969da)、红 (#cf222e)。
 * 对比度高，护眼但不刺眼。fallback 给所有缺 pair 的 dark theme。
 */
const GITHUB_LIGHT: TerminalTheme = {
  id: "github-light",
  display_name: "GitHub Light",
  preview: ["#ffffff", "#24292f", "#0969da", "#cf222e"],
  xterm: {
    foreground: "#24292f",
    background: "#ffffff",
    cursor: "#1f2328",
    cursorAccent: "#ffffff",
    selectionBackground: "#0969da33",
    black: "#24292f",
    red: "#cf222e",
    green: "#1a7f37",
    yellow: "#9a6700",
    blue: "#0969da",
    magenta: "#8250df",
    cyan: "#1b7c83",
    white: "#6e7781",
    brightBlack: "#57606a",
    brightRed: "#a40e26",
    brightGreen: "#116329",
    brightYellow: "#4d2d00",
    brightBlue: "#0550ae",
    brightMagenta: "#6639ba",
    brightCyan: "#3192aa",
    brightWhite: "#8c959f",
  },
  mode: "light",
  pairDark: "github-dark",
};

/**
 * Monokai —— 经典 Monokai dark（Sublime Text 默认）。
 *
 * 深灰绿底 (#272822)、暖白 fg (#f8f8f2)、强调 pink (#f92672) + green (#a6e22e)。
 * v0.4.1 T5 与 Monokai Light 配对。
 */
const MONOKAI_DARK: TerminalTheme = {
  id: "monokai-dark",
  display_name: "Monokai",
  preview: ["#272822", "#f8f8f2", "#a6e22e", "#f92672"],
  xterm: {
    foreground: "#f8f8f2",
    background: "#272822",
    cursor: "#f8f8f2",
    cursorAccent: "#272822",
    selectionBackground: "#49483e",
    black: "#272822",
    red: "#f92672",
    green: "#a6e22e",
    yellow: "#f4bf75",
    blue: "#66d9ef",
    magenta: "#ae81ff",
    cyan: "#a1efe4",
    white: "#f8f8f2",
    brightBlack: "#75715e",
    brightRed: "#f92672",
    brightGreen: "#a6e22e",
    brightYellow: "#f4bf75",
    brightBlue: "#66d9ef",
    brightMagenta: "#ae81ff",
    brightCyan: "#a1efe4",
    brightWhite: "#f9f8f5",
  },
  mode: "dark",
  pairLight: "monokai-light",
};

/**
 * Monokai Light —— Monokai 配对的浅色风味（v0.4.1 T5 新增）。
 *
 * 暖白底 (#fafafa)、灰黑 fg (#383a42)、强调 blue (#4078f2) + 暖红 (#e45649)。
 * 取自 atom-one-light 系列调子，配 Monokai 风格的强调色，保留"强对比 + 高饱和度"。
 */
const MONOKAI_LIGHT: TerminalTheme = {
  id: "monokai-light",
  display_name: "Monokai Light",
  preview: ["#fafafa", "#383a42", "#4078f2", "#0184bc"],
  xterm: {
    foreground: "#383a42",
    background: "#fafafa",
    cursor: "#4078f2",
    cursorAccent: "#fafafa",
    selectionBackground: "#0184bc33",
    black: "#383a42",
    red: "#e45649",
    green: "#50a14f",
    yellow: "#c18401",
    blue: "#4078f2",
    magenta: "#a626a4",
    cyan: "#0184bc",
    white: "#a0a1a7",
    brightBlack: "#696c77",
    brightRed: "#ca1243",
    brightGreen: "#50a14f",
    brightYellow: "#986801",
    brightBlue: "#4078f2",
    brightMagenta: "#a626a4",
    brightCyan: "#0184bc",
    brightWhite: "#383a42",
  },
  mode: "light",
  pairDark: "monokai-dark",
};

/**
 * One Light —— Atom One Light（v0.4.1 T5 新增），配对 One Dark。
 *
 * 取自 atom one-light-syntax：灰白底 (#fafafa) + 灰黑 fg (#383a42)，
 * 蓝紫 cursor (#526fff) + teal selection。
 */
const ONE_LIGHT: TerminalTheme = {
  id: "one-light",
  display_name: "One Light",
  preview: ["#fafafa", "#383a42", "#526fff", "#80cbc4"],
  xterm: {
    foreground: "#383a42",
    background: "#fafafa",
    cursor: "#526fff",
    cursorAccent: "#fafafa",
    selectionBackground: "#80cbc433",
    black: "#383a42",
    red: "#e45649",
    green: "#50a14f",
    yellow: "#c18401",
    blue: "#4078f2",
    magenta: "#a626a4",
    cyan: "#0184bc",
    white: "#a0a1a7",
    brightBlack: "#696c77",
    brightRed: "#ca1243",
    brightGreen: "#50a14f",
    brightYellow: "#986801",
    brightBlue: "#4078f2",
    brightMagenta: "#a626a4",
    brightCyan: "#0184bc",
    brightWhite: "#383a42",
  },
  mode: "light",
  pairDark: "one-dark",
};

/** 注册表。顺序即 SettingsModal 色卡渲染顺序。
 *
 * v0.4.1 T5 新增 5 个：github-dark / github-light / monokai-dark / monokai-light / one-light，
 * 至少 3 对完整配对（github / monokai / one），覆盖 plan §9 R11 的"配对至少 3 对"要求。
 */
export const THEMES: TerminalTheme[] = [
  DEFAULT,
  DRACULA,
  SOLARIZED_DARK,
  SOLARIZED_LIGHT,
  ONE_DARK,
  ONE_LIGHT,
  HOMEBREW,
  WARP,
  CATPPUCCIN_MOCHA,
  GITHUB_DARK,
  GITHUB_LIGHT,
  MONOKAI_DARK,
  MONOKAI_LIGHT,
];

/**
 * 按 ID 取主题；未找到（用户手改 toml 配置了未知 ID）fallback 到默认。
 *
 * 这个函数是 settings → terminal 的最后一道防线，绝不应该 throw —
 * xterm.js 启动期任何异常都会让 TerminalView 整个炸掉。
 */
export function getTheme(id: string): TerminalTheme {
  return THEMES.find((t) => t.id === id) ?? DEFAULT;
}

/**
 * v0.4.1 T5：按 base theme + 目标深浅模式取配对 theme。
 *
 * 用法：用户在终端 tab 里选了 "monokai-dark"（基准 theme），切到 light mode
 * 时调 `getPairedTheme("monokai-dark", "light")` 返回 `MONOKAI_LIGHT`，自动
 * 保留"风格"换"深浅"。
 *
 * 决策规则（按优先级）：
 *
 * 1. base.id 找不到 → fallback 到 dark mode `github-dark` / light mode `github-light`
 *    （绝不 throw；GitHub 主题色对比度高，是最稳的兜底）
 * 2. base.mode 已经匹配 targetMode → 直接返回 base（无需切）
 * 3. dark→light：找 base.pairLight；light→dark：找 base.pairDark
 *    - 若 pair* 是合法 id → 返回 pair theme
 *    - 若 pair* 缺失 / 找不到 → fallback github-{targetMode}
 *
 * 这套逻辑保证：任何 theme + 任何 mode 的组合都拿得到一个实际可用 theme，
 * 不会让 xterm 收到 undefined 而崩。
 *
 * @param baseId 用户在 settings 里选的 theme id（任意 mode）
 * @param targetMode 目标深浅模式
 */
export function getPairedTheme(
  baseId: string,
  targetMode: ThemeColorMode,
): TerminalTheme {
  const base = THEMES.find((t) => t.id === baseId);

  // 兜底用：dark→github-dark / light→github-light（如果它俩本身找不到，
  // 终极兜底走 DEFAULT 让函数永不 throw）。
  const fallback =
    THEMES.find((t) => t.id === (targetMode === "light" ? "github-light" : "github-dark")) ??
    DEFAULT;

  // 1. base 不存在 → 直接 fallback
  if (!base) return fallback;

  // 2. base 已经是目标 mode → 直接返回
  if (base.mode === targetMode) return base;

  // 3. 跨 mode 找 pair
  const pairId = targetMode === "light" ? base.pairLight : base.pairDark;
  if (pairId) {
    const pair = THEMES.find((t) => t.id === pairId);
    if (pair) return pair;
  }

  // 4. 没 pair 字段 / pair id 不在表里 → fallback
  return fallback;
}

// =============================================================================
// v0.6.0-A T12：light / dark 默认 xterm theme 常量 + pickXtermTheme helper
//
// 背景：T9 把所有 wrapper 容器配色切到 token-based（[data-theme="light"] 真
// 白底），但 xterm.js 是 canvas/WebGL 渲染、不读 CSS 变量，必须显式传 theme。
// 维护者 真机：light mode 下终端区域 wrapper 已白底，xterm 还是黑底 → 视觉冲突。
//
// 设计选择：
// - `darkXtermTheme`：复用 GITHUB_DARK.xterm（成熟 dark palette，对比度达标）
// - `lightXtermTheme`：复用 GITHUB_LIGHT.xterm（GitHub Light 风，护眼）
// - `pickXtermTheme(mode)`：给"不在乎风格、要跟 theme_mode 走"的 caller 用，
//   等价于 `getPairedTheme("github-dark|github-light" 的 mode 解析后版本).xterm`
//
// TerminalView 当前走 `resolveXtermTheme(baseId, mode)` 用 base + 配对体系，
// 保留用户选的"风格"。darkXtermTheme / lightXtermTheme 只在 base 不存在 /
// 上层不关心风格时作为基线兜底（如未来 ai sidebar 内嵌 xterm 预览用例）。
// =============================================================================

/** v0.6.0-A T12：暗色基调默认 xterm theme（GitHub Dark 风）。
 *
 *  不直接 export GITHUB_DARK 对象常量（让外部仅依赖"xterm theme"而不耦合
 *  "TerminalTheme 注册项"语义），通过 getTheme + 类型断言取 xterm 字段。 */
export const darkXtermTheme: ITheme = getTheme("github-dark").xterm;

/** v0.6.0-A T12：亮色基调默认 xterm theme（GitHub Light 风）。 */
export const lightXtermTheme: ITheme = getTheme("github-light").xterm;

/**
 * v0.6.0-A T12：根据 theme_mode 直接挑 xterm theme。
 *
 *  - `dark` → `darkXtermTheme`
 *  - `light` → `lightXtermTheme`
 *  - `auto` → 读 `matchMedia('(prefers-color-scheme: light)')`，
 *    匹配则 light，否则 dark；SSR / 无 window 时兜底 dark
 *
 *  这个函数是"轻量入口"——不查 settings.terminal.theme 用户偏好，
 *  仅按系统 / 用户全局 theme_mode 给一套合理 palette。完整决策走
 *  TerminalView 内 `resolveXtermTheme(baseId, mode)`。
 */
export function pickXtermTheme(mode: XtermThemeMode): ITheme {
  const colorMode: ThemeColorMode =
    mode === "auto"
      ? typeof window !== "undefined" &&
        window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark"
      : mode;
  return colorMode === "light" ? lightXtermTheme : darkXtermTheme;
}
