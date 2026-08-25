import { describe, expect, it } from "vitest";
import { buildCommandList, filterCommands, moveSelection } from "../commands";
import { DEFAULT_KEYBINDINGS, type ActionName } from "../shortcuts";

const t = (k: string) => k.replace("commands.", "");

describe("buildCommandList", () => {
  it("由 action 注册表派生，不另维护一份清单", () => {
    const list = buildCommandList(DEFAULT_KEYBINDINGS, t);
    const actions = list.map((c) => c.action);
    expect(actions).toContain("newTab");
    expect(actions).toContain("splitVertical");
    // 新增 action 会自动出现，不会漏进面板
    const all = Object.keys(DEFAULT_KEYBINDINGS) as ActionName[];
    expect(actions.length).toBe(all.length - 1); // 减掉隐藏的 openCommandPalette
  });

  it("不把「打开命令面板」自己列进去", () => {
    const list = buildCommandList(DEFAULT_KEYBINDINGS, t);
    expect(list.map((c) => c.action)).not.toContain("openCommandPalette");
  });

  it("显示的是用户自定义后的快捷键，不是默认值", () => {
    const list = buildCommandList({ ...DEFAULT_KEYBINDINGS, newTab: "Cmd+N" }, t);
    expect(list.find((c) => c.action === "newTab")?.shortcut).toBe("Cmd+N");
  });

  it("action 没有绑定时快捷键显示为空串而不是 undefined", () => {
    const list = buildCommandList({}, t);
    expect(list.every((c) => c.shortcut === "")).toBe(true);
  });
});

describe("filterCommands", () => {
  const list = [
    { action: "newTab" as ActionName, title: "New Tab", shortcut: "Cmd+T" },
    { action: "closePane" as ActionName, title: "Close Pane", shortcut: "Cmd+Shift+W" },
    { action: "openSettings" as ActionName, title: "设置", shortcut: "Cmd+," },
  ];

  it("空查询返回全部", () => {
    expect(filterCommands(list, "")).toHaveLength(3);
    expect(filterCommands(list, "   ")).toHaveLength(3);
  });

  it("标题子串命中，不区分大小写", () => {
    expect(filterCommands(list, "tab").map((c) => c.action)).toEqual(["newTab"]);
    expect(filterCommands(list, "CLOSE").map((c) => c.action)).toEqual(["closePane"]);
  });

  it("中文标题同样能子串命中", () => {
    expect(filterCommands(list, "设置").map((c) => c.action)).toEqual(["openSettings"]);
  });

  it("首字母缩写命中", () => {
    expect(filterCommands(list, "nt").map((c) => c.action)).toEqual(["newTab"]);
    expect(filterCommands(list, "cp").map((c) => c.action)).toEqual(["closePane"]);
  });

  it("action 名命中（习惯英文的人直接敲 newtab）", () => {
    expect(filterCommands(list, "newtab").map((c) => c.action)).toEqual(["newTab"]);
  });

  it("无命中返回空列表", () => {
    expect(filterCommands(list, "zzz")).toEqual([]);
  });
});

describe("moveSelection", () => {
  it("上下循环", () => {
    expect(moveSelection(3, 0, 1)).toBe(1);
    expect(moveSelection(3, 2, 1)).toBe(0);
    expect(moveSelection(3, 0, -1)).toBe(2);
  });

  it("空列表恒为 0，不会算出 NaN", () => {
    expect(moveSelection(0, 0, 1)).toBe(0);
    expect(moveSelection(0, 0, -1)).toBe(0);
  });
});
