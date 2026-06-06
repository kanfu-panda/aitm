import { describe, expect, it } from "vitest";
import { basename, disambiguateLabels } from "../file-label";

describe("basename", () => {
  it("从 POSIX path 取最后一段", () => {
    expect(basename("/tmp/.gitignore")).toBe(".gitignore");
    expect(basename("/a/b/c/file.txt")).toBe("file.txt");
  });

  it("从 Windows path 取最后一段", () => {
    expect(basename("C:\\Users\\example\\.gitignore")).toBe(".gitignore");
  });

  it("没有分隔符的纯文件名原样返回", () => {
    expect(basename("file.txt")).toBe("file.txt");
  });

  it("空字符串 fallback 到原 path", () => {
    expect(basename("")).toBe("");
  });
});

describe("disambiguateLabels", () => {
  it("唯一 basename 直接显示 basename", () => {
    const result = disambiguateLabels([
      "/a/b/foo.ts",
      "/x/y/bar.ts",
      "/m/n/baz.ts",
    ]);
    expect(result.get("/a/b/foo.ts")).toBe("foo.ts");
    expect(result.get("/x/y/bar.ts")).toBe("bar.ts");
    expect(result.get("/m/n/baz.ts")).toBe("baz.ts");
  });

  it("两个 .gitignore 在不同父目录 → 加最近 parent disambiguation", () => {
    const result = disambiguateLabels([
      "/tmp/.gitignore",
      "/tmp/aitm/.gitignore",
    ]);
    expect(result.get("/tmp/.gitignore")).toBe(".gitignore — tmp");
    expect(result.get("/tmp/aitm/.gitignore")).toBe(
      ".gitignore — aitm",
    );
  });

  it("三个同名文件在不同深度路径都能 disambiguate", () => {
    const result = disambiguateLabels([
      "/a/foo/index.ts",
      "/b/bar/index.ts",
      "/c/baz/index.ts",
    ]);
    expect(result.get("/a/foo/index.ts")).toBe("index.ts — foo");
    expect(result.get("/b/bar/index.ts")).toBe("index.ts — bar");
    expect(result.get("/c/baz/index.ts")).toBe("index.ts — baz");
  });

  it("同名文件父目录也相同时进一步往上扩展 segs", () => {
    const result = disambiguateLabels([
      "/a/x/foo/index.ts",
      "/b/y/foo/index.ts",
    ]);
    // parent 都是 "foo"，take=2 不 unique → take=3 扩展到 x/foo, y/foo
    expect(result.get("/a/x/foo/index.ts")).toBe("index.ts — x/foo");
    expect(result.get("/b/y/foo/index.ts")).toBe("index.ts — y/foo");
  });

  it("混合：唯一的不动，重名的加 disambiguation", () => {
    const result = disambiguateLabels([
      "/proj/a/.gitignore",
      "/proj/b/.gitignore",
      "/proj/a/README.md",
    ]);
    expect(result.get("/proj/a/README.md")).toBe("README.md");
    expect(result.get("/proj/a/.gitignore")).toBe(".gitignore — a");
    expect(result.get("/proj/b/.gitignore")).toBe(".gitignore — b");
  });

  it("Windows path 同样处理", () => {
    const result = disambiguateLabels([
      "C:\\Users\\example\\.gitignore",
      "C:\\Users\\example\\projects\\.gitignore",
    ]);
    expect(result.get("C:\\Users\\example\\.gitignore")).toBe(
      ".gitignore — example",
    );
    expect(result.get("C:\\Users\\example\\projects\\.gitignore")).toBe(
      ".gitignore — projects",
    );
  });

  it("空列表返回空 Map", () => {
    expect(disambiguateLabels([]).size).toBe(0);
  });

  it("单文件返回 basename", () => {
    const result = disambiguateLabels(["/lone/file.ts"]);
    expect(result.get("/lone/file.ts")).toBe("file.ts");
  });
});
