import "@testing-library/jest-dom";

// v0.10.4 i18n：测试默认切到 zh-CN，保持现有测试断言中文文案兼容。
// 真实运行时 i18n 默认 en；测试切 zh-CN 不影响 production 行为。
// 单独测 i18n 切换的 spec 自己用 await i18n.changeLanguage(...) 覆盖。
import i18n from "./lib/i18n";
void i18n.changeLanguage("zh-CN");

// jsdom 不实现 ResizeObserver；BrowserPanel 用它监容器 bounds。
// 给最小 mock：observe / unobserve / disconnect 全 noop，让组件挂载通过。
if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === "undefined") {
  class ResizeObserverMock {
    constructor(_cb: ResizeObserverCallback) {
      void _cb;
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    ResizeObserverMock;
}

// v0.7.0-A：jsdom 不挂 Tauri IPC bridge，@aptabase/tauri 加载时会调 `window.__TAURI_IPC__`
// → 没桩就抛 unhandled rejection 让 vitest 报 errors。给个 noop fake 让插桩调用静默通过。
// 单测里要断言 aptabase 行为的（如 analytics.test.ts）用 vi.mock 显式覆盖即可。
if (typeof (globalThis as { window?: { __TAURI_IPC__?: unknown } }).window !== "undefined") {
  const w = (globalThis as unknown as { window: Record<string, unknown> }).window;
  if (typeof w.__TAURI_IPC__ !== "function") {
    w.__TAURI_IPC__ = () => {};
  }
}
