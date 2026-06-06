import { describe, expect, it } from "vitest";

import {
  disableSystemTextInput,
  isWebKitRuntime,
  shouldFixSwallowedShiftKey,
} from "../xtermTextarea";

describe("disableSystemTextInput", () => {
  it("把 macOS 系统级文本辅助属性全部关掉", () => {
    const textarea = document.createElement("textarea");
    textarea.spellcheck = true;

    disableSystemTextInput(textarea);

    expect(textarea.getAttribute("autocapitalize")).toBe("off");
    expect(textarea.getAttribute("autocorrect")).toBe("off");
    expect(textarea.getAttribute("autocomplete")).toBe("off");
    expect(textarea.spellcheck).toBe(false);
  });

  it("传 null 安全降级（xterm 还没 mount 时不炸）", () => {
    expect(() => disableSystemTextInput(null)).not.toThrow();
    expect(() => disableSystemTextInput(undefined)).not.toThrow();
  });

  it("覆盖既有属性（即便上游被设过相反值也强制关）", () => {
    const textarea = document.createElement("textarea");
    textarea.setAttribute("autocapitalize", "sentences");
    textarea.setAttribute("autocorrect", "on");
    textarea.setAttribute("autocomplete", "on");
    textarea.spellcheck = true;

    disableSystemTextInput(textarea);

    expect(textarea.getAttribute("autocapitalize")).toBe("off");
    expect(textarea.getAttribute("autocorrect")).toBe("off");
    expect(textarea.getAttribute("autocomplete")).toBe("off");
    expect(textarea.spellcheck).toBe(false);
  });
});

describe("isWebKitRuntime", () => {
  it("Tauri macOS WKWebView UA 命中（含 AppleWebKit 不含 Chrome）", () => {
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0";
    expect(isWebKitRuntime(ua)).toBe(true);
  });

  it("Safari UA 命中", () => {
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15";
    expect(isWebKitRuntime(ua)).toBe(true);
  });

  it("Chromium UA 排除（含 AppleWebKit 但也含 Chrome）", () => {
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    expect(isWebKitRuntime(ua)).toBe(false);
  });

  it("Firefox UA 排除（不含 AppleWebKit）", () => {
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0";
    expect(isWebKitRuntime(ua)).toBe(false);
  });
});

describe("shouldFixSwallowedShiftKey", () => {
  const baseEvent = {
    type: "keydown",
    shiftKey: true,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    key: "_",
  };

  it("Shift+_ 第一次按下被吞 case：距离最近 onData > 50ms → 触发兜底", () => {
    expect(shouldFixSwallowedShiftKey(baseEvent, 0, 1000)).toBe(true);
  });

  it("正常 Safari 字符 case：onData 刚触发，差 < 50ms → 跳过", () => {
    expect(shouldFixSwallowedShiftKey(baseEvent, 980, 1000)).toBe(false);
  });

  it("差正好 50ms 不触发（边界严格大于）", () => {
    expect(shouldFixSwallowedShiftKey(baseEvent, 950, 1000)).toBe(false);
  });

  it("非 keydown（keyup/keypress）跳过", () => {
    expect(
      shouldFixSwallowedShiftKey({ ...baseEvent, type: "keyup" }, 0, 1000),
    ).toBe(false);
    expect(
      shouldFixSwallowedShiftKey({ ...baseEvent, type: "keypress" }, 0, 1000),
    ).toBe(false);
  });

  it("没按 Shift 跳过（避免误拦普通字符）", () => {
    expect(
      shouldFixSwallowedShiftKey({ ...baseEvent, shiftKey: false }, 0, 1000),
    ).toBe(false);
  });

  it("带 Cmd/Ctrl/Alt 跳过（不干扰快捷键）", () => {
    expect(
      shouldFixSwallowedShiftKey({ ...baseEvent, metaKey: true }, 0, 1000),
    ).toBe(false);
    expect(
      shouldFixSwallowedShiftKey({ ...baseEvent, ctrlKey: true }, 0, 1000),
    ).toBe(false);
    expect(
      shouldFixSwallowedShiftKey({ ...baseEvent, altKey: true }, 0, 1000),
    ).toBe(false);
  });

  it("key.length > 1（Tab/Enter/Arrow 等控制键）跳过", () => {
    expect(
      shouldFixSwallowedShiftKey({ ...baseEvent, key: "Tab" }, 0, 1000),
    ).toBe(false);
    expect(
      shouldFixSwallowedShiftKey({ ...baseEvent, key: "Enter" }, 0, 1000),
    ).toBe(false);
    expect(
      shouldFixSwallowedShiftKey({ ...baseEvent, key: "ArrowUp" }, 0, 1000),
    ).toBe(false);
    expect(
      shouldFixSwallowedShiftKey({ ...baseEvent, key: "Backspace" }, 0, 1000),
    ).toBe(false);
  });

  it("Shift+ 标点匹配（覆盖 维护者 真机报的 Shift+_ 等）", () => {
    expect(shouldFixSwallowedShiftKey({ ...baseEvent, key: "_" }, 0, 1000)).toBe(true);
    expect(shouldFixSwallowedShiftKey({ ...baseEvent, key: "#" }, 0, 1000)).toBe(true);
    expect(shouldFixSwallowedShiftKey({ ...baseEvent, key: "~" }, 0, 1000)).toBe(true);
    expect(shouldFixSwallowedShiftKey({ ...baseEvent, key: "{" }, 0, 1000)).toBe(true);
    expect(shouldFixSwallowedShiftKey({ ...baseEvent, key: "|" }, 0, 1000)).toBe(true);
    expect(shouldFixSwallowedShiftKey({ ...baseEvent, key: '"' }, 0, 1000)).toBe(true);
    expect(shouldFixSwallowedShiftKey({ ...baseEvent, key: "!" }, 0, 1000)).toBe(true);
    expect(shouldFixSwallowedShiftKey({ ...baseEvent, key: "?" }, 0, 1000)).toBe(true);
  });

  it("v0.5.4：Shift+字母（A-Z / a-z）跳过 workaround 避免双发", () => {
    // v0.5.4 真机反馈：Shift+A 双发为 "AA"，因为 xterm 在 WebKit 上对字母处理 OK，
    // workaround 是多余的；限制范围只对标点 / 数字 shift 字符
    expect(shouldFixSwallowedShiftKey({ ...baseEvent, key: "A" }, 0, 1000)).toBe(false);
    expect(shouldFixSwallowedShiftKey({ ...baseEvent, key: "Z" }, 0, 1000)).toBe(false);
    expect(shouldFixSwallowedShiftKey({ ...baseEvent, key: "a" }, 0, 1000)).toBe(false);
    expect(shouldFixSwallowedShiftKey({ ...baseEvent, key: "z" }, 0, 1000)).toBe(false);
  });

  // H1 hotfix（v0.9.0 真机回归）：诊断测试 — 确认"正常路径上 onData 先于
  // customKeyEvent"时，shouldFixSwallowedShiftKey 不该误判。
  //
  // v0.9.0 真机 bug 现象：Shift+_ 每按一次出现两个 `_`。诊断：v0.9.0 加的两个
  // window 层 keydown listener（FilePreviewWorkspace Cmd+W capture phase +
  // FileEditorPane Cmd+S）扰动 WKWebView keydown 派发时序，让 customKeyEvent
  // 反过来早于 onData 触发，差值 > 50ms 误判被吞 → 主动 sessionWrite 一次 →
  // xterm 自己又 onData 一次 → 双发。
  //
  // 修法是把这两个 listener 改 attach 在 pane 元素而非 window（见
  // FilePreviewWorkspace.tsx / FileEditorPane.tsx 同名 H1 hotfix 注释）。
  // 此处保留**纯函数行为不变**的回归测试：正常时序下不该误触发。
  describe("H1 v0.9.0 正常时序回归（onData 先于 customKeyEvent）", () => {
    it("差值 0ms（onData 刚触发即 customKeyEvent） → false，不重复发送", () => {
      const now = 5_000;
      expect(
        shouldFixSwallowedShiftKey({ ...baseEvent, key: "_" }, now, now),
      ).toBe(false);
    });

    it("差值 10ms（Safari 正常路径典型差） → false", () => {
      const now = 5_000;
      expect(
        shouldFixSwallowedShiftKey({ ...baseEvent, key: "_" }, now - 10, now),
      ).toBe(false);
    });

    it("差值正好 50ms（临界） → false（严格大于才触发）", () => {
      const now = 5_000;
      expect(
        shouldFixSwallowedShiftKey({ ...baseEvent, key: "_" }, now - 50, now),
      ).toBe(false);
    });

    it("差值 51ms / 200ms（v0.9.0 window listener 扰动后症状）→ true 误触发", () => {
      // 这条**不是** workaround 期望行为，而是"如果 customKeyEvent 时序被
      // 改前到 onData 之前，lastOnDataTime 还是上一次的旧值 → 差值变大”的复现。
      // 修法在外层（listener attach point 改 pane scope），纯函数本身仍按
      // "差值 > 50ms = 被吞"语义判定。
      const now = 5_000;
      expect(
        shouldFixSwallowedShiftKey({ ...baseEvent, key: "_" }, now - 51, now),
      ).toBe(true);
      expect(
        shouldFixSwallowedShiftKey({ ...baseEvent, key: "_" }, now - 200, now),
      ).toBe(true);
    });
  });
});
