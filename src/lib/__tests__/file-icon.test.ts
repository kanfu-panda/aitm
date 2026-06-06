import { describe, it, expect } from "vitest";
import { getFileIcon, getFolderIcon } from "../file-icon";

describe("getFileIcon", () => {
  it("按完整文件名优先匹配（package.json）", () => {
    const spec = getFileIcon("package.json");
    expect(spec.color).toBe("text-emerald-500");
  });

  it("完整文件名大小写不敏感（Package.JSON 仍命中 package.json 规则）", () => {
    const spec = getFileIcon("Package.JSON");
    expect(spec.color).toBe("text-emerald-500");
  });

  it("Cargo.toml 命中 Rust 包配色", () => {
    const spec = getFileIcon("Cargo.toml");
    expect(spec.color).toBe("text-orange-500");
  });

  it("README.md 走文件名特例（蓝色）而非通用 .md", () => {
    const spec = getFileIcon("README.md");
    expect(spec.color).toBe("text-sky-300");
  });

  it("CHANGELOG.md 走文件名特例（amber）", () => {
    const spec = getFileIcon("CHANGELOG.md");
    expect(spec.color).toBe("text-amber-400");
  });

  it("普通 .ts 文件走扩展名映射（sky-400）", () => {
    expect(getFileIcon("foo.ts").color).toBe("text-sky-400");
    expect(getFileIcon("FOO.TSX").color).toBe("text-sky-400");
  });

  it("普通 .js 文件走 amber", () => {
    expect(getFileIcon("bundle.js").color).toBe("text-amber-400");
  });

  it("普通 .rs 文件走 orange", () => {
    expect(getFileIcon("lib.rs").color).toBe("text-orange-500");
  });

  it(".png/.svg 走图片配色", () => {
    expect(getFileIcon("logo.png").color).toBe("text-emerald-400");
    expect(getFileIcon("icon.svg").color).toBe("text-amber-400");
  });

  it("无扩展名走默认 (zinc-400)", () => {
    expect(getFileIcon("Makefile").color).toBe("text-zinc-400");
    expect(getFileIcon("randomfile").color).toBe("text-zinc-400");
  });

  it("未知扩展名走默认", () => {
    expect(getFileIcon("data.xyz").color).toBe("text-zinc-400");
  });

  it("点结尾文件不当扩展名处理", () => {
    expect(getFileIcon("weird.").color).toBe("text-zinc-400");
  });

  it(".gitignore / .env 走文件名映射", () => {
    expect(getFileIcon(".gitignore").color).toBe("text-rose-400");
    expect(getFileIcon(".env").color).toBe("text-amber-300");
  });
});

describe("getFolderIcon", () => {
  it("src 走 sky-400", () => {
    expect(getFolderIcon("src", false).color).toBe("text-sky-400");
    expect(getFolderIcon("src", true).color).toBe("text-sky-400");
  });

  it("src-tauri 走 orange-500（命中名仅按完整名）", () => {
    expect(getFolderIcon("src-tauri", false).color).toBe("text-orange-500");
  });

  it("node_modules / dist 走 Archive + zinc-500", () => {
    expect(getFolderIcon("node_modules", false).color).toBe("text-zinc-500");
    expect(getFolderIcon("dist", true).color).toBe("text-zinc-500");
  });

  it(".git / .github 走 git-folder", () => {
    expect(getFolderIcon(".git", false).color).toBe("text-rose-400");
    expect(getFolderIcon(".github", false).color).toBe("text-zinc-400");
  });

  it("未知文件夹关 → sky-400 (Folder)", () => {
    expect(getFolderIcon("random", false).color).toBe("text-sky-400");
  });

  it("未知文件夹开 → sky-300 (FolderOpen)", () => {
    expect(getFolderIcon("random", true).color).toBe("text-sky-300");
  });

  it("文件夹名匹配大小写不敏感", () => {
    expect(getFolderIcon("SRC", false).color).toBe("text-sky-400");
    expect(getFolderIcon("Node_Modules", false).color).toBe("text-zinc-500");
  });
});
