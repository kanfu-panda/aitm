/**
 * v0.4.1 T1: applyTheme + watchSystemTheme 单测
 *
 * 覆盖：
 * - applyTheme('dark') / 'light' 直接写 dataset.theme
 * - applyTheme('auto') 根据 matchMedia('(prefers-color-scheme: light)') 解析
 * - watchSystemTheme 在 mode='auto' 时跟随系统切换；非 auto 时不动作
 * - watchSystemTheme 返回 unsubscribe 解绑 listener
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyTheme, watchSystemTheme } from "../theme";

// 注：jsdom 不实现 matchMedia；下方 mock 仅暴露 applyTheme/watchSystemTheme
// 用到的最小 API 表面（matches + add/removeEventListener('change', …)）。
// 用结构化类型 + as unknown cast 注入，避免依赖全局 lib.dom MediaQueryList 类型。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ChangeListener = (ev: any) => void;

interface MockMediaQueryList {
  matches: boolean;
  addEventListener: (type: "change", l: ChangeListener) => void;
  removeEventListener: (type: "change", l: ChangeListener) => void;
  // 测试用：手动触发 change
  __fire: (matches: boolean) => void;
}

/** 创建一个可控的 matchMedia mock；matches 为初始状态。 */
function createMockMatchMedia(matches: boolean): MockMediaQueryList {
  const listeners = new Set<ChangeListener>();
  const mql: MockMediaQueryList = {
    matches,
    addEventListener: (type, l) => {
      if (type === "change") listeners.add(l);
    },
    removeEventListener: (type, l) => {
      if (type === "change") listeners.delete(l);
    },
    __fire: (newMatches: boolean) => {
      mql.matches = newMatches;
      for (const l of listeners) {
        l({ matches: newMatches });
      }
    },
  };
  return mql;
}

describe("applyTheme", () => {
  beforeEach(() => {
    delete document.documentElement.dataset.theme;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("'dark' → dataset.theme === 'dark'", () => {
    // 即使 matchMedia 报 light，强制 dark 也应忽略系统态
    vi.spyOn(window, "matchMedia").mockImplementation(
      () => createMockMatchMedia(true) as unknown as ReturnType<typeof window.matchMedia>,
    );
    applyTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("'light' → dataset.theme === 'light'", () => {
    vi.spyOn(window, "matchMedia").mockImplementation(
      () => createMockMatchMedia(false) as unknown as ReturnType<typeof window.matchMedia>,
    );
    applyTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("'auto' + 系统 light → dataset.theme === 'light'", () => {
    vi.spyOn(window, "matchMedia").mockImplementation(
      () => createMockMatchMedia(true) as unknown as ReturnType<typeof window.matchMedia>,
    );
    applyTheme("auto");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("'auto' + 系统 dark → dataset.theme === 'dark'", () => {
    vi.spyOn(window, "matchMedia").mockImplementation(
      () => createMockMatchMedia(false) as unknown as ReturnType<typeof window.matchMedia>,
    );
    applyTheme("auto");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});

describe("watchSystemTheme", () => {
  beforeEach(() => {
    delete document.documentElement.dataset.theme;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("mode='auto' 时系统 dark→light 切换会触发 applyTheme", () => {
    const mql = createMockMatchMedia(false); // 初始系统 dark
    vi.spyOn(window, "matchMedia").mockImplementation(
      () => mql as unknown as ReturnType<typeof window.matchMedia>,
    );

    // 起始 apply 一次
    applyTheme("auto");
    expect(document.documentElement.dataset.theme).toBe("dark");

    // 注册监听器，模式恒为 auto
    const unsubscribe = watchSystemTheme(() => "auto");
    // 系统切到 light
    mql.__fire(true);
    expect(document.documentElement.dataset.theme).toBe("light");

    // 系统切回 dark
    mql.__fire(false);
    expect(document.documentElement.dataset.theme).toBe("dark");

    unsubscribe();
  });

  it("mode='dark' 时系统切换不应改变 dataset.theme", () => {
    const mql = createMockMatchMedia(false);
    vi.spyOn(window, "matchMedia").mockImplementation(
      () => mql as unknown as ReturnType<typeof window.matchMedia>,
    );

    applyTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");

    // mode 始终 dark：系统切 light 也不动
    const unsubscribe = watchSystemTheme(() => "dark");
    mql.__fire(true);
    expect(document.documentElement.dataset.theme).toBe("dark");
    unsubscribe();
  });

  it("unsubscribe 后系统切换不再触发", () => {
    const mql = createMockMatchMedia(false);
    vi.spyOn(window, "matchMedia").mockImplementation(
      () => mql as unknown as ReturnType<typeof window.matchMedia>,
    );

    applyTheme("auto");
    expect(document.documentElement.dataset.theme).toBe("dark");

    const unsubscribe = watchSystemTheme(() => "auto");
    unsubscribe();

    // 解绑后，触发 change 不应再写 dataset
    mql.__fire(true);
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
