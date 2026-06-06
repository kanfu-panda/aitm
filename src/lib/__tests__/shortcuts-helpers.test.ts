import { describe, expect, it } from "vitest";
import {
  type ActionName,
  DEFAULT_KEYBINDINGS,
  findConflicts,
  formatKeybinding,
  matchKeybinding,
  mergeKeybindings,
  parseKeybinding,
} from "../shortcuts";

/**
 * v0.10.0 HR7-7：快捷键解析 / 匹配 / 冲突检测 / 合并的纯函数单测。
 *
 * useShortcuts hook 的 keydown 触发行为见 shortcuts.test.tsx（保留 17 个回归测）。
 * 这里只覆盖 binding 字符串层面的逻辑（不需要 React / DOM）。
 */

describe("DEFAULT_KEYBINDINGS", () => {
  it("含全部 11 个 action（newTab / closeTab / nextTab / prevTab / openSettings / toggleSidebar / toggleBrowser / toggleFilePreview / splitVertical / splitHorizontal / closePane）", () => {
    const expected: ActionName[] = [
      "newTab",
      "closeTab",
      "nextTab",
      "prevTab",
      "openSettings",
      "toggleSidebar",
      "toggleBrowser",
      "toggleFilePreview",
      "splitVertical",
      "splitHorizontal",
      "closePane",
    ];
    for (const action of expected) {
      expect(DEFAULT_KEYBINDINGS[action]).toBeTruthy();
    }
    expect(Object.keys(DEFAULT_KEYBINDINGS).length).toBe(expected.length);
  });

  it("默认 binding 全部可解析（无 typo）", () => {
    for (const [action, kb] of Object.entries(DEFAULT_KEYBINDINGS)) {
      const parsed = parseKeybinding(kb);
      expect(parsed, `${action} → "${kb}" 应可解析`).not.toBeNull();
    }
  });

  it("默认 binding 之间无冲突", () => {
    const conflicts = findConflicts(DEFAULT_KEYBINDINGS);
    expect(conflicts).toEqual([]);
  });
});

describe("parseKeybinding", () => {
  it("Cmd+T → meta + key=t", () => {
    expect(parseKeybinding("Cmd+T")).toEqual({
      meta: true,
      ctrl: false,
      shift: false,
      alt: false,
      key: "t",
    });
  });

  it("Cmd+Shift+W → meta + shift + key=w", () => {
    expect(parseKeybinding("Cmd+Shift+W")).toEqual({
      meta: true,
      ctrl: false,
      shift: true,
      alt: false,
      key: "w",
    });
  });

  it("Cmd+\\ → meta + key=\\", () => {
    expect(parseKeybinding("Cmd+\\")).toEqual({
      meta: true,
      ctrl: false,
      shift: false,
      alt: false,
      key: "\\",
    });
  });

  it("Cmd+, → meta + key=,", () => {
    expect(parseKeybinding("Cmd+,")).toEqual({
      meta: true,
      ctrl: false,
      shift: false,
      alt: false,
      key: ",",
    });
  });

  it("Ctrl+Alt+Shift+X → ctrl + alt + shift + key=x", () => {
    expect(parseKeybinding("Ctrl+Alt+Shift+X")).toEqual({
      meta: false,
      ctrl: true,
      shift: true,
      alt: true,
      key: "x",
    });
  });

  it("Meta / Command / ⌘ 三种写法都识别为 meta", () => {
    expect(parseKeybinding("Meta+T")?.meta).toBe(true);
    expect(parseKeybinding("Command+T")?.meta).toBe(true);
    expect(parseKeybinding("⌘+T")?.meta).toBe(true);
  });

  it("Option / Opt / ⌥ 都识别为 alt", () => {
    expect(parseKeybinding("Option+X")?.alt).toBe(true);
    expect(parseKeybinding("Opt+X")?.alt).toBe(true);
    expect(parseKeybinding("⌥+X")?.alt).toBe(true);
  });

  it("空字符串 / null / undefined 返回 null", () => {
    expect(parseKeybinding("")).toBeNull();
    // @ts-expect-error 故意传非法值测试鲁棒性
    expect(parseKeybinding(null)).toBeNull();
    // @ts-expect-error 故意传非法值测试鲁棒性
    expect(parseKeybinding(undefined)).toBeNull();
  });

  it("无主键（全是修饰符）返回 null", () => {
    expect(parseKeybinding("Cmd+")).toBeNull();
    expect(parseKeybinding("Cmd+Shift")).toBeNull();
  });

  it("中间段有未知 token 返回 null", () => {
    expect(parseKeybinding("Cmd+Foo+T")).toBeNull();
  });

  it("主键大小写归一（T 和 t 都 → t）", () => {
    expect(parseKeybinding("Cmd+T")?.key).toBe("t");
    expect(parseKeybinding("Cmd+t")?.key).toBe("t");
  });

  it("修饰符两边空白容忍", () => {
    expect(parseKeybinding(" Cmd + T ")).toEqual({
      meta: true,
      ctrl: false,
      shift: false,
      alt: false,
      key: "t",
    });
  });
});

describe("matchKeybinding", () => {
  function makeEvent(opts: {
    key?: string;
    code?: string;
    metaKey?: boolean;
    ctrlKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
  }): KeyboardEvent {
    return new KeyboardEvent("keydown", {
      key: opts.key ?? "",
      code: opts.code ?? "",
      metaKey: opts.metaKey ?? false,
      ctrlKey: opts.ctrlKey ?? false,
      shiftKey: opts.shiftKey ?? false,
      altKey: opts.altKey ?? false,
    });
  }

  it("Cmd+T 命中 metaKey+key=t", () => {
    const kb = parseKeybinding("Cmd+T");
    expect(matchKeybinding(makeEvent({ key: "t", metaKey: true }), kb)).toBe(true);
  });

  it("Cmd+T 大写 'T' 也命中", () => {
    const kb = parseKeybinding("Cmd+T");
    expect(matchKeybinding(makeEvent({ key: "T", metaKey: true }), kb)).toBe(true);
  });

  it("Cmd+T 无 meta 不命中", () => {
    const kb = parseKeybinding("Cmd+T");
    expect(matchKeybinding(makeEvent({ key: "t" }), kb)).toBe(false);
  });

  it("Cmd+T 带 shift 不命中（精确 shift 匹配）", () => {
    const kb = parseKeybinding("Cmd+T");
    expect(matchKeybinding(makeEvent({ key: "t", metaKey: true, shiftKey: true }), kb)).toBe(false);
  });

  it("Cmd+Shift+W 命中 metaKey+shiftKey+key=w", () => {
    const kb = parseKeybinding("Cmd+Shift+W");
    expect(matchKeybinding(makeEvent({ key: "W", metaKey: true, shiftKey: true }), kb)).toBe(true);
  });

  it("跨平台：binding Cmd+T 用 Ctrl+T 也命中（Windows/Linux）", () => {
    const kb = parseKeybinding("Cmd+T");
    expect(matchKeybinding(makeEvent({ key: "t", ctrlKey: true }), kb)).toBe(true);
  });

  it("Cmd+\\ 通过 e.code='Backslash' 兜底命中（部分键盘布局 e.key 异常）", () => {
    const kb = parseKeybinding("Cmd+\\");
    expect(
      matchKeybinding(makeEvent({ key: "Dead", code: "Backslash", metaKey: true }), kb),
    ).toBe(true);
  });

  it("null binding 永不命中", () => {
    expect(matchKeybinding(makeEvent({ key: "t", metaKey: true }), null)).toBe(false);
  });

  it("不要求 meta 时事件带 meta 不命中（避免误触发）", () => {
    // 假设有 binding 是裸 "T"（无修饰符）
    const kb = parseKeybinding("T");
    expect(matchKeybinding(makeEvent({ key: "t" }), kb)).toBe(true);
    expect(matchKeybinding(makeEvent({ key: "t", metaKey: true }), kb)).toBe(false);
  });
});

describe("findConflicts", () => {
  it("无冲突时返回空数组", () => {
    expect(findConflicts(DEFAULT_KEYBINDINGS)).toEqual([]);
  });

  it("两个 action 同 binding → 返该组", () => {
    const bindings: Record<ActionName, string> = {
      ...DEFAULT_KEYBINDINGS,
      // 故意让 newTab 和 closeTab 都绑 Cmd+T
      closeTab: "Cmd+T",
    };
    const conflicts = findConflicts(bindings);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].sort()).toEqual(["closeTab", "newTab"].sort());
  });

  it("三个 action 同 binding → 返一组含三个", () => {
    const bindings: Record<ActionName, string> = {
      ...DEFAULT_KEYBINDINGS,
      newTab: "Cmd+X",
      closeTab: "Cmd+X",
      nextTab: "Cmd+X",
    };
    const conflicts = findConflicts(bindings);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].length).toBe(3);
  });

  it("修饰符顺序不同视为同 binding（Cmd+Shift+T vs Shift+Cmd+T）", () => {
    const bindings: Record<ActionName, string> = {
      ...DEFAULT_KEYBINDINGS,
      newTab: "Cmd+Shift+T",
      closeTab: "Shift+Cmd+T",
    };
    const conflicts = findConflicts(bindings);
    expect(conflicts.length).toBe(1);
  });

  it("非法 binding 不参与冲突检测", () => {
    const bindings: Record<ActionName, string> = {
      ...DEFAULT_KEYBINDINGS,
      newTab: "Cmd+", // 非法
      closeTab: "Cmd+", // 非法
    };
    // 两条都解析失败 → 不算冲突
    const conflicts = findConflicts(bindings);
    expect(conflicts).toEqual([]);
  });
});

describe("formatKeybinding", () => {
  it("Cmd+T 反向 → 'Cmd+T'", () => {
    const kb = parseKeybinding("Cmd+T")!;
    expect(formatKeybinding(kb)).toBe("Cmd+T");
  });

  it("修饰符顺序规范化为 Cmd+Ctrl+Alt+Shift+Key", () => {
    const kb = parseKeybinding("Shift+Alt+Ctrl+Cmd+X")!;
    expect(formatKeybinding(kb)).toBe("Cmd+Ctrl+Alt+Shift+X");
  });

  it("符号主键保留原样（不大写化）", () => {
    expect(formatKeybinding(parseKeybinding("Cmd+,")!)).toBe("Cmd+,");
    expect(formatKeybinding(parseKeybinding("Cmd+\\")!)).toBe("Cmd+\\");
    expect(formatKeybinding(parseKeybinding("Cmd+Shift+]")!)).toBe("Cmd+Shift+]");
  });
});

describe("mergeKeybindings", () => {
  it("空覆盖 → 返默认表副本", () => {
    const merged = mergeKeybindings({});
    expect(merged).toEqual(DEFAULT_KEYBINDINGS);
    // 必须是副本，不能是同一引用
    expect(merged).not.toBe(DEFAULT_KEYBINDINGS);
  });

  it("单条覆盖 → 该 action 用覆盖值，其他保持默认", () => {
    const merged = mergeKeybindings({ newTab: "Cmd+N" });
    expect(merged.newTab).toBe("Cmd+N");
    expect(merged.closeTab).toBe(DEFAULT_KEYBINDINGS.closeTab);
  });

  it("空字符串覆盖被忽略（保留默认）", () => {
    const merged = mergeKeybindings({ newTab: "" });
    expect(merged.newTab).toBe(DEFAULT_KEYBINDINGS.newTab);
  });

  it("未知 action key 被忽略（不污染输出）", () => {
    const merged = mergeKeybindings({ fooBar: "Cmd+F" } as Record<string, string>);
    // 输出只含 DEFAULT_KEYBINDINGS 的 10 个 key
    expect(Object.keys(merged).sort()).toEqual(
      Object.keys(DEFAULT_KEYBINDINGS).sort(),
    );
  });
});
