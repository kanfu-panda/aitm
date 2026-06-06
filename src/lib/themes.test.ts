import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  darkXtermTheme,
  getPairedTheme,
  getTheme,
  lightXtermTheme,
  pickXtermTheme,
  THEMES,
} from "./themes";

describe("themes registry", () => {
  it("含 13 个预置主题（v0.4.1 T5 后：default + 原 7 套 + 新 5 套）", () => {
    // v0.4.1 T5 新增 GITHUB_DARK / GITHUB_LIGHT / MONOKAI_DARK / MONOKAI_LIGHT / ONE_LIGHT
    // 顺序：default, dracula, solarized-dark/light, one-dark/light,
    //       homebrew, warp, catppuccin-mocha, github-dark/light, monokai-dark/light
    expect(THEMES).toHaveLength(13);
    const ids = THEMES.map((t) => t.id);
    expect(ids).toEqual([
      "default",
      "dracula",
      "solarized-dark",
      "solarized-light",
      "one-dark",
      "one-light",
      "homebrew",
      "warp",
      "catppuccin-mocha",
      "github-dark",
      "github-light",
      "monokai-dark",
      "monokai-light",
    ]);
  });

  it("getTheme 命中 ID 返回对应主题", () => {
    expect(getTheme("dracula").display_name).toBe("Dracula");
    expect(getTheme("one-dark").display_name).toBe("One Dark");
    expect(getTheme("homebrew").display_name).toBe("Homebrew");
    expect(getTheme("warp").display_name).toBe("Warp");
    expect(getTheme("catppuccin-mocha").display_name).toBe("Catppuccin Mocha");
    // T5 新增
    expect(getTheme("github-dark").display_name).toBe("GitHub Dark");
    expect(getTheme("github-light").display_name).toBe("GitHub Light");
    expect(getTheme("monokai-dark").display_name).toBe("Monokai");
    expect(getTheme("monokai-light").display_name).toBe("Monokai Light");
    expect(getTheme("one-light").display_name).toBe("One Light");
  });

  it("getTheme 未知 ID fallback 到默认", () => {
    expect(getTheme("unknown-theme").id).toBe("default");
    expect(getTheme("").id).toBe("default");
  });

  it("除默认外所有主题都配齐 16 ANSI + fg/bg/cursor", () => {
    // 每个完整主题应至少含的字段
    const requiredFields = [
      "foreground",
      "background",
      "cursor",
      "black",
      "red",
      "green",
      "yellow",
      "blue",
      "magenta",
      "cyan",
      "white",
      "brightBlack",
      "brightRed",
      "brightGreen",
      "brightYellow",
      "brightBlue",
      "brightMagenta",
      "brightCyan",
      "brightWhite",
    ] as const;

    for (const id of [
      "dracula",
      "solarized-dark",
      "solarized-light",
      "one-dark",
      "one-light",
      "homebrew",
      "warp",
      "catppuccin-mocha",
      "github-dark",
      "github-light",
      "monokai-dark",
      "monokai-light",
    ]) {
      const theme = getTheme(id);
      const xterm = theme.xterm as Record<string, unknown>;
      for (const f of requiredFields) {
        expect(xterm[f], `${id} 缺字段 ${f}`).toBeTruthy();
        // 颜色值必须是 #RRGGBB 格式
        expect(xterm[f]).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
    }
  });

  it("preview 字段含 4 个 hex 色（用于 SettingsModal 色卡）", () => {
    for (const t of THEMES) {
      expect(t.preview).toHaveLength(4);
      for (const c of t.preview) {
        expect(c).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
    }
  });

  it("默认主题 background 是 zinc-950（保持当前体验）", () => {
    expect(getTheme("default").xterm.background).toBe("#09090b");
  });

  // === v0.4.1 T5：mode + pair* 字段 ===

  it("所有 theme 都标注了 mode（dark / light）", () => {
    for (const t of THEMES) {
      expect(["dark", "light"]).toContain(t.mode);
    }
  });

  it("dark theme 的 pairLight 必须指向真实存在的 light theme", () => {
    for (const t of THEMES.filter((t) => t.mode === "dark" && t.pairLight)) {
      const pair = THEMES.find((p) => p.id === t.pairLight);
      expect(pair, `${t.id}.pairLight=${t.pairLight} 应存在`).toBeTruthy();
      expect(pair?.mode).toBe("light");
    }
  });

  it("light theme 的 pairDark 必须指向真实存在的 dark theme", () => {
    for (const t of THEMES.filter((t) => t.mode === "light" && t.pairDark)) {
      const pair = THEMES.find((p) => p.id === t.pairDark);
      expect(pair, `${t.id}.pairDark=${t.pairDark} 应存在`).toBeTruthy();
      expect(pair?.mode).toBe("dark");
    }
  });

  it("至少 3 对完整 dark/light 配对（github / monokai / one）", () => {
    const pairs: Array<[string, string]> = [
      ["github-dark", "github-light"],
      ["monokai-dark", "monokai-light"],
      ["one-dark", "one-light"],
    ];
    for (const [darkId, lightId] of pairs) {
      const dark = THEMES.find((t) => t.id === darkId);
      const light = THEMES.find((t) => t.id === lightId);
      expect(dark, `${darkId} 应存在`).toBeTruthy();
      expect(light, `${lightId} 应存在`).toBeTruthy();
      expect(dark?.pairLight).toBe(lightId);
      expect(light?.pairDark).toBe(darkId);
    }
  });
});

describe("getPairedTheme", () => {
  it("base 已是目标 mode → 返回 base 本身", () => {
    // dark 调 dark 不变
    expect(getPairedTheme("github-dark", "dark").id).toBe("github-dark");
    expect(getPairedTheme("dracula", "dark").id).toBe("dracula");
    // light 调 light 不变
    expect(getPairedTheme("github-light", "light").id).toBe("github-light");
    expect(getPairedTheme("solarized-light", "light").id).toBe("solarized-light");
  });

  it("dark → light 走 pairLight 字段", () => {
    expect(getPairedTheme("github-dark", "light").id).toBe("github-light");
    expect(getPairedTheme("monokai-dark", "light").id).toBe("monokai-light");
    expect(getPairedTheme("one-dark", "light").id).toBe("one-light");
    expect(getPairedTheme("solarized-dark", "light").id).toBe("solarized-light");
  });

  it("light → dark 走 pairDark 字段", () => {
    expect(getPairedTheme("github-light", "dark").id).toBe("github-dark");
    expect(getPairedTheme("monokai-light", "dark").id).toBe("monokai-dark");
    expect(getPairedTheme("one-light", "dark").id).toBe("one-dark");
    expect(getPairedTheme("solarized-light", "dark").id).toBe("solarized-dark");
  });

  it("dark theme 缺 pairLight → fallback github-light", () => {
    // dracula / homebrew / warp / catppuccin-mocha 都没 pairLight
    expect(getPairedTheme("dracula", "light").id).toBe("github-light");
    expect(getPairedTheme("homebrew", "light").id).toBe("github-light");
    expect(getPairedTheme("warp", "light").id).toBe("github-light");
    expect(getPairedTheme("catppuccin-mocha", "light").id).toBe("github-light");
  });

  it("base id 不存在 → fallback github-{mode}", () => {
    expect(getPairedTheme("nonexistent", "dark").id).toBe("github-dark");
    expect(getPairedTheme("nonexistent", "light").id).toBe("github-light");
    // 空字符串也走 fallback
    expect(getPairedTheme("", "dark").id).toBe("github-dark");
    expect(getPairedTheme("", "light").id).toBe("github-light");
  });

  it("default theme 切到 light 走 github-light（pairLight 配置）", () => {
    expect(getPairedTheme("default", "light").id).toBe("github-light");
    // default 自身就是 dark，调 dark 模式直接返回 default
    expect(getPairedTheme("default", "dark").id).toBe("default");
  });
});

// =============================================================================
// v0.6.0-A T12：darkXtermTheme / lightXtermTheme / pickXtermTheme
// =============================================================================

describe("v0.6.0-A T12 — darkXtermTheme / lightXtermTheme", () => {
  const requiredFields = [
    "foreground",
    "background",
    "cursor",
    "black",
    "red",
    "green",
    "yellow",
    "blue",
    "magenta",
    "cyan",
    "white",
    "brightBlack",
    "brightRed",
    "brightGreen",
    "brightYellow",
    "brightBlue",
    "brightMagenta",
    "brightCyan",
    "brightWhite",
  ] as const;

  it("darkXtermTheme 含 fg/bg/cursor + 16 ANSI 色，全部 #RRGGBB", () => {
    const t = darkXtermTheme as Record<string, unknown>;
    for (const f of requiredFields) {
      expect(t[f], `darkXtermTheme 缺字段 ${f}`).toBeTruthy();
      expect(t[f]).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it("lightXtermTheme 含 fg/bg/cursor + 16 ANSI 色，全部 #RRGGBB", () => {
    const t = lightXtermTheme as Record<string, unknown>;
    for (const f of requiredFields) {
      expect(t[f], `lightXtermTheme 缺字段 ${f}`).toBeTruthy();
      expect(t[f]).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it("darkXtermTheme 背景是深色（< 'aaaaaa' 灰度阈值）", () => {
    // GitHub Dark bg=#0d1117，远低于 grayscale 0xaaaaaa
    const bg = (darkXtermTheme.background ?? "").toLowerCase();
    expect(bg).toMatch(/^#[0-3]/);
  });

  it("lightXtermTheme 背景是亮色（> 'eeeeee' 阈值）", () => {
    // GitHub Light bg=#ffffff
    const bg = (lightXtermTheme.background ?? "").toLowerCase();
    expect(bg).toMatch(/^#[ef]/);
  });

  it("dark 和 light 的背景对比明显（不会撞色）", () => {
    expect(darkXtermTheme.background).not.toBe(lightXtermTheme.background);
    expect(darkXtermTheme.foreground).not.toBe(lightXtermTheme.foreground);
  });
});

describe("v0.6.0-A T12 — pickXtermTheme(mode)", () => {
  let originalMatchMedia: typeof window.matchMedia | undefined;

  beforeEach(() => {
    // 保留原 matchMedia，测试结束后还原
    originalMatchMedia =
      typeof window !== "undefined" ? window.matchMedia : undefined;
  });

  afterEach(() => {
    if (typeof window !== "undefined" && originalMatchMedia) {
      window.matchMedia = originalMatchMedia;
    }
    vi.restoreAllMocks();
  });

  it("mode='dark' 返 darkXtermTheme", () => {
    expect(pickXtermTheme("dark")).toBe(darkXtermTheme);
  });

  it("mode='light' 返 lightXtermTheme", () => {
    expect(pickXtermTheme("light")).toBe(lightXtermTheme);
  });

  it("mode='auto' + 系统 light → lightXtermTheme", () => {
    // mock matchMedia 返 matches=true（系统 light）
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === "(prefers-color-scheme: light)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;

    expect(pickXtermTheme("auto")).toBe(lightXtermTheme);
  });

  it("mode='auto' + 系统 dark → darkXtermTheme", () => {
    // mock matchMedia 返 matches=false（系统 dark）
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;

    expect(pickXtermTheme("auto")).toBe(darkXtermTheme);
  });
});
