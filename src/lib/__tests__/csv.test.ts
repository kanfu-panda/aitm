/* CSV / TSV 解析单测：RFC 4180 引号、转义、换行与空文本。 */
import { describe, expect, it } from "vitest";
import { parseDelimited } from "../csv";

describe("parseDelimited", () => {
  it("应该_当分隔符为逗号时_按逗号拆分行与列", () => {
    expect(parseDelimited("a,b,c\n1,2,3", ",")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("应该_当分隔符为制表符时_按制表符拆分且保留逗号", () => {
    expect(parseDelimited("a,x\tb\n1\t2,3", "\t")).toEqual([
      ["a,x", "b"],
      ["1", "2,3"],
    ]);
  });

  it("应该_当双引号字段内含分隔符时_视为同一个字段", () => {
    expect(parseDelimited('"a,b",c', ",")).toEqual([["a,b", "c"]]);
    expect(parseDelimited('"a\tb"\tc', "\t")).toEqual([["a\tb", "c"]]);
  });

  it("应该_当字段内出现两个双引号时_还原为一个双引号", () => {
    expect(parseDelimited('"say ""hi""",x', ",")).toEqual([['say "hi"', "x"]]);
  });

  it("应该_当双引号字段内含换行时_换行保留在字段内而不新开一行", () => {
    expect(parseDelimited('"line1\nline2",b\nc,d', ",")).toEqual([
      ["line1\nline2", "b"],
      ["c", "d"],
    ]);
  });

  it("应该_当使用_CRLF_换行时_与_LF_结果一致", () => {
    expect(parseDelimited("a,b\r\n1,2\r\n", ",")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("应该_当文本以换行结尾时_不产生多余的空行", () => {
    expect(parseDelimited("a,b\n1,2\n", ",")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("应该_当文本为空时_返回空数组", () => {
    expect(parseDelimited("", ",")).toEqual([]);
  });

  it("应该_当各行列数不同时_按原样保留不补齐", () => {
    expect(parseDelimited("a,b,c\n1\n2,3", ",")).toEqual([
      ["a", "b", "c"],
      ["1"],
      ["2", "3"],
    ]);
  });

  it("应该_当出现空字段时_保留为空字符串", () => {
    expect(parseDelimited("a,,c\n,,", ",")).toEqual([
      ["a", "", "c"],
      ["", "", ""],
    ]);
  });
});
