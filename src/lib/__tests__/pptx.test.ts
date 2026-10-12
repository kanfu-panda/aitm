/* parsePptx 单测：用 JSZip 现场构造 pptx，覆盖尺寸、顺序、文字、主题色、背景、占位符继承、图片、组合。 */
import { describe, expect, it } from "vitest";
import { parsePptx, type PptxElement, type PptxSlide } from "../pptx";
import {
  PNG_BYTES,
  bgSolid,
  buildPptx,
  graphicFrame,
  grp,
  para,
  pic,
  removeEntry,
  run,
  schemeClr,
  solidFill,
  sp,
  srgbClr,
} from "./fixtures/pptx";

type Shape = Extract<PptxElement, { type: "shape" }>;

const BOX = { x: 10, y: 20, w: 300, h: 100 };

/** 取第 n 张幻灯片的第 k 个形状 */
async function firstShape(opts: Parameters<typeof buildPptx>[0], slide = 0, k = 0): Promise<Shape> {
  const pres = await parsePptx(await buildPptx(opts));
  const el = pres.slides[slide].elements[k];
  expect(el.type).toBe("shape");
  return el as Shape;
}

async function slideOf(opts: Parameters<typeof buildPptx>[0], slide = 0): Promise<PptxSlide> {
  return (await parsePptx(await buildPptx(opts))).slides[slide];
}

describe("parsePptx 幻灯片尺寸与顺序", () => {
  it("应该_当尺寸为_12192000_x_6858000_EMU_时_输出_960_x_540_pt", async () => {
    const pres = await parsePptx(await buildPptx({ size: { w: 960, h: 540 } }));
    expect(pres.width).toBe(960);
    expect(pres.height).toBe(540);
  });

  it("应该_当为_4比3_尺寸时_按_EMU_除以_12700_换算", async () => {
    const pres = await parsePptx(await buildPptx({ size: { w: 720, h: 540 } }));
    expect([pres.width, pres.height]).toEqual([720, 540]);
  });

  it("应该_当_sldIdLst_顺序与文件名不一致时_按_sldIdLst_排列", async () => {
    const pres = await parsePptx(
      await buildPptx({
        slides: [
          { shapes: [sp({ box: BOX, paras: [para(run("来自slide1"))] })] },
          { shapes: [sp({ box: BOX, paras: [para(run("来自slide2"))] })] },
        ],
        order: [2, 1],
      }),
    );
    expect(pres.slides).toHaveLength(2);
    const text = (s: PptxSlide) => (s.elements[0] as Shape).paragraphs[0].runs[0].text;
    expect(text(pres.slides[0])).toBe("来自slide2");
    expect(text(pres.slides[1])).toBe("来自slide1");
  });
});

describe("parsePptx 文字框", () => {
  it("应该_当形状带_xfrm_时_输出以_pt_为单位的位置与尺寸", async () => {
    const s = await firstShape({ slides: [{ shapes: [sp({ box: BOX, paras: [para(run("hi"))] })] }] });
    expect([s.x, s.y, s.w, s.h]).toEqual([10, 20, 300, 100]);
  });

  it("应该_当段落_algn_为_ctr_时_对齐为_center_缺省为_left", async () => {
    const s = await firstShape({
      slides: [
        {
          shapes: [
            sp({
              box: BOX,
              paras: [
                para(run("a"), "ctr"),
                para(run("b"), "r"),
                para(run("c"), "just"),
                para(run("d")),
              ],
            }),
          ],
        },
      ],
    });
    expect(s.paragraphs.map((p) => p.align)).toEqual(["center", "right", "justify", "left"]);
  });

  it("应该_当_run_带字号粗体斜体下划线颜色时_逐项解析_颜色输出小写_hex", async () => {
    const s = await firstShape({
      slides: [
        {
          shapes: [
            sp({
              box: BOX,
              paras: [
                para([
                  run("样式", { sz: 2400, b: true, i: true, u: true, color: srgbClr("FF8000") }),
                  run("朴素", { sz: 1250 }),
                ]),
              ],
            }),
          ],
        },
      ],
    });
    const [styled, plain] = s.paragraphs[0].runs;
    expect(styled).toEqual({
      text: "样式",
      sizePt: 24,
      bold: true,
      italic: true,
      underline: true,
      color: "#ff8000",
    });
    expect(plain.sizePt).toBe(12.5);
    expect([plain.bold, plain.italic, plain.underline, plain.color]).toEqual([false, false, false, null]);
  });

  it("应该_当非占位符_run_没有字号时_取_18pt", async () => {
    const s = await firstShape({ slides: [{ shapes: [sp({ box: BOX, paras: [para(run("x"))] })] }] });
    expect(s.paragraphs[0].runs[0].sizePt).toBe(18);
  });

  it("应该_当一个形状有多个段落时_按顺序保留", async () => {
    const s = await firstShape({
      slides: [{ shapes: [sp({ box: BOX, paras: [para(run("一")), para(run("二")), para(run("三"))] })] }],
    });
    expect(s.paragraphs.map((p) => p.runs[0].text)).toEqual(["一", "二", "三"]);
  });
});

describe("parsePptx 主题色", () => {
  const withColor = (clr: string) => ({
    slides: [{ shapes: [sp({ box: BOX, paras: [para(run("c", { color: clr }))] })] }],
  });
  const colorOf = async (clr: string, theme?: Record<string, string>) =>
    (await firstShape({ ...withColor(clr), theme })).paragraphs[0].runs[0].color;

  it("应该_当_srgbClr_不是_6_位十六进制时_颜色视为未设置", async () => {
    const s = await firstShape({
      slides: [
        {
          shapes: [
            sp({
              box: BOX,
              paras: [para([run("坏色", { sz: 1800, color: srgbClr("red;x") }), run("短色", { sz: 1800, color: srgbClr("FFF") })])],
            }),
          ],
        },
      ],
    });
    expect(s.paragraphs[0].runs.map((r) => r.color)).toEqual([null, null]);
  });

  it("应该_当颜色为_schemeClr_accent1_时_解析为主题里的_accent1", async () => {
    expect(await colorOf(schemeClr("accent1"), { accent1: "AABBCC" })).toBe("#aabbcc");
  });

  it("应该_当颜色为_tx1_bg1_tx2_bg2_时_分别映射到_dk1_lt1_dk2_lt2", async () => {
    const theme = { dk1: "111111", lt1: "EEEEEE", dk2: "222222", lt2: "DDDDDD" };
    expect(await colorOf(schemeClr("tx1"), theme)).toBe("#111111");
    expect(await colorOf(schemeClr("bg1"), theme)).toBe("#eeeeee");
    expect(await colorOf(schemeClr("tx2"), theme)).toBe("#222222");
    expect(await colorOf(schemeClr("bg2"), theme)).toBe("#dddddd");
  });

  it("应该_当带_lumMod_80%_时_红色_ff0000_变为_cc0000", async () => {
    const c = await colorOf(schemeClr("accent2", `<a:lumMod val="80000"/>`), { accent2: "FF0000" });
    expect(c).toBe("#cc0000");
  });

  it("应该_当带_lumMod_40%_与_lumOff_60%_时_红色_ff0000_变为_ff9999", async () => {
    const c = await colorOf(
      schemeClr("accent2", `<a:lumMod val="40000"/><a:lumOff val="60000"/>`),
      { accent2: "FF0000" },
    );
    expect(c).toBe("#ff9999");
  });

  it("应该_当带_lumMod_时_颜色与基色不同且仍是合法_hex", async () => {
    const base = await colorOf(schemeClr("accent1"));
    const dark = await colorOf(schemeClr("accent1", `<a:lumMod val="50000"/>`));
    expect(dark).toMatch(/^#[0-9a-f]{6}$/);
    expect(dark).not.toBe(base);
  });
});

describe("parsePptx 形状填充", () => {
  it("应该_当形状有_spPr_纯色填充时_输出_fill", async () => {
    const s = await firstShape({
      slides: [{ shapes: [sp({ box: BOX, fill: solidFill(srgbClr("00FF7F")), paras: [para(run("f"))] })] }],
    });
    expect(s.fill).toBe("#00ff7f");
  });

  it("应该_当形状填充使用主题色时_解析为主题颜色", async () => {
    const s = await firstShape({
      theme: { accent3: "123456" },
      slides: [{ shapes: [sp({ box: BOX, fill: solidFill(schemeClr("accent3")), paras: [para(run("f"))] })] }],
    });
    expect(s.fill).toBe("#123456");
  });

  it("应该_当形状没有填充时_fill_为_null", async () => {
    const s = await firstShape({ slides: [{ shapes: [sp({ box: BOX, paras: [para(run("f"))] })] }] });
    expect(s.fill).toBeNull();
  });
});

describe("parsePptx 背景继承", () => {
  it("应该_当幻灯片自身有纯色背景时_优先于版式与母版", async () => {
    const slide = await slideOf({
      slides: [{ bg: bgSolid("112233") }],
      layoutBg: bgSolid("445566"),
      masterBg: bgSolid("778899"),
    });
    expect(slide.background).toBe("#112233");
  });

  it("应该_当幻灯片没有背景时_取版式的背景", async () => {
    const slide = await slideOf({ layoutBg: bgSolid("445566"), masterBg: bgSolid("778899") });
    expect(slide.background).toBe("#445566");
  });

  it("应该_当幻灯片与版式都没有背景时_取母版的背景", async () => {
    const slide = await slideOf({ masterBg: bgSolid("778899") });
    expect(slide.background).toBe("#778899");
  });

  it("应该_当三层都没有背景时_默认白色", async () => {
    const slide = await slideOf({});
    expect(slide.background).toBe("#ffffff");
  });

  it("应该_当背景使用主题色时_解析为主题颜色", async () => {
    const slide = await slideOf({
      theme: { lt2: "ABCDEF" },
      slides: [{ bg: `<p:bg><p:bgPr>${solidFill(schemeClr("bg2"))}<a:effectLst/></p:bgPr></p:bg>` }],
    });
    expect(slide.background).toBe("#abcdef");
  });
});

describe("parsePptx 占位符继承", () => {
  const LAYOUT_BOX = { x: 50, y: 30, w: 860, h: 90 };

  it("应该_当幻灯片占位符没有_xfrm_时_位置取版式中同类型占位符", async () => {
    const s = await firstShape({
      layoutShapes: [sp({ ph: { type: "title" }, box: LAYOUT_BOX })],
      slides: [{ shapes: [sp({ ph: { type: "title" }, paras: [para(run("标题"))] })] }],
    });
    expect([s.x, s.y, s.w, s.h]).toEqual([50, 30, 860, 90]);
  });

  it("应该_当版式也没有该占位符的位置时_回落到母版", async () => {
    const s = await firstShape({
      masterShapes: [sp({ ph: { type: "title" }, box: { x: 5, y: 6, w: 700, h: 80 } })],
      slides: [{ shapes: [sp({ ph: { type: "title" }, paras: [para(run("标题"))] })] }],
    });
    expect([s.x, s.y, s.w, s.h]).toEqual([5, 6, 700, 80]);
  });

  it("应该_当幻灯片自己写了_xfrm_时_不被版式覆盖", async () => {
    const s = await firstShape({
      layoutShapes: [sp({ ph: { type: "title" }, box: LAYOUT_BOX })],
      slides: [{ shapes: [sp({ ph: { type: "title" }, box: BOX, paras: [para(run("标题"))] })] }],
    });
    expect([s.x, s.y, s.w, s.h]).toEqual([10, 20, 300, 100]);
  });

  it("应该_当占位符按_type_匹配时_不同类型各取各自的版式位置", async () => {
    const pres = await parsePptx(
      await buildPptx({
        layoutShapes: [
          sp({ ph: { type: "title" }, box: LAYOUT_BOX }),
          sp({ ph: { type: "body", idx: 1 }, box: { x: 60, y: 140, w: 840, h: 360 } }),
        ],
        slides: [
          {
            shapes: [
              sp({ ph: { type: "body", idx: 1 }, paras: [para(run("正文"))] }),
              sp({ ph: { type: "title" }, paras: [para(run("标题"))] }),
            ],
          },
        ],
      }),
    );
    const [body, title] = pres.slides[0].elements as Shape[];
    expect([body.x, body.y, body.w, body.h]).toEqual([60, 140, 840, 360]);
    expect([title.x, title.y, title.w, title.h]).toEqual([50, 30, 860, 90]);
  });

  it("应该_当标题_run_没有字号时_取母版_titleStyle_的_lvl1_defRPr_sz", async () => {
    const s = await firstShape({
      masterTitleSz: 4400,
      layoutShapes: [sp({ ph: { type: "title" }, box: LAYOUT_BOX })],
      slides: [{ shapes: [sp({ ph: { type: "title" }, paras: [para(run("标题"))] })] }],
    });
    expect(s.paragraphs[0].runs[0].sizePt).toBe(44);
  });

  it("应该_当正文占位符_run_没有字号时_取母版_bodyStyle_的字号", async () => {
    const s = await firstShape({
      masterBodySz: 2800,
      layoutShapes: [sp({ ph: { type: "body", idx: 1 }, box: LAYOUT_BOX })],
      slides: [{ shapes: [sp({ ph: { type: "body", idx: 1 }, paras: [para(run("正文"))] })] }],
    });
    expect(s.paragraphs[0].runs[0].sizePt).toBe(28);
  });

  it("应该_当版式占位符自带_lvl1_defRPr_字号时_优先于母版_txStyles", async () => {
    const s = await firstShape({
      masterTitleSz: 4400,
      layoutShapes: [
        sp({
          ph: { type: "title" },
          box: LAYOUT_BOX,
          lstStyle: `<a:lstStyle><a:lvl1pPr><a:defRPr sz="3200"/></a:lvl1pPr></a:lstStyle>`,
        }),
      ],
      slides: [{ shapes: [sp({ ph: { type: "title" }, paras: [para(run("标题"))] })] }],
    });
    expect(s.paragraphs[0].runs[0].sizePt).toBe(32);
  });

  it("应该_当标题页标题_ctrTitle_没有字号时_同样取母版_titleStyle", async () => {
    const s = await firstShape({
      masterTitleSz: 4400,
      layoutShapes: [sp({ ph: { type: "ctrTitle" }, box: LAYOUT_BOX })],
      slides: [{ shapes: [sp({ ph: { type: "ctrTitle" }, paras: [para(run("标题"))] })] }],
    });
    expect(s.paragraphs[0].runs[0].sizePt).toBe(44);
  });

  it("应该_当段落没写对齐时_继承版式占位符_lvl1pPr_的对齐", async () => {
    const s = await firstShape({
      layoutShapes: [
        sp({
          ph: { type: "subTitle", idx: 1 },
          box: LAYOUT_BOX,
          lstStyle: `<a:lstStyle><a:lvl1pPr algn="ctr"/></a:lstStyle>`,
        }),
      ],
      slides: [{ shapes: [sp({ ph: { type: "subTitle", idx: 1 }, paras: [para(run("副标题"))] })] }],
    });
    expect(s.paragraphs[0].align).toBe("center");
  });

  it("应该_当版式也没写对齐时_继承母版_titleStyle_的对齐", async () => {
    const s = await firstShape({
      masterTitleAlgn: "ctr",
      layoutShapes: [sp({ ph: { type: "ctrTitle" }, box: LAYOUT_BOX })],
      slides: [{ shapes: [sp({ ph: { type: "ctrTitle" }, paras: [para(run("标题"))] })] }],
    });
    expect(s.paragraphs[0].align).toBe("center");
  });

  it("应该_当段落自带对齐时_不被继承值覆盖", async () => {
    const s = await firstShape({
      masterTitleAlgn: "ctr",
      layoutShapes: [sp({ ph: { type: "title" }, box: LAYOUT_BOX })],
      slides: [{ shapes: [sp({ ph: { type: "title" }, paras: [para(run("标题"), "r")] })] }],
    });
    expect(s.paragraphs[0].align).toBe("right");
  });

  it("应该_当_run_自带字号时_不被继承值覆盖", async () => {
    const s = await firstShape({
      masterTitleSz: 4400,
      layoutShapes: [sp({ ph: { type: "title" }, box: LAYOUT_BOX })],
      slides: [{ shapes: [sp({ ph: { type: "title" }, paras: [para(run("标题", { sz: 2000 }))] })] }],
    });
    expect(s.paragraphs[0].runs[0].sizePt).toBe(20);
  });

  it("应该_当版式与母版都没有字号时_占位符文字取_18pt", async () => {
    const s = await firstShape({
      masterTitleSz: null,
      layoutShapes: [sp({ ph: { type: "title" }, box: LAYOUT_BOX })],
      slides: [{ shapes: [sp({ ph: { type: "title" }, paras: [para(run("标题"))] })] }],
    });
    expect(s.paragraphs[0].runs[0].sizePt).toBe(18);
  });
});

describe("parsePptx 图片", () => {
  it("应该_当_pic_指向_png_媒体时_输出_picture_元素_mime_与字节一致", async () => {
    const slide = await slideOf({
      slides: [{ rels: { rId2: "../media/image1.png" }, shapes: [pic("rId2", { x: 100, y: 50, w: 200, h: 120 })] }],
    });
    expect(slide.elements).toHaveLength(1);
    const el = slide.elements[0];
    expect(el.type).toBe("picture");
    if (el.type !== "picture") return;
    expect([el.x, el.y, el.w, el.h]).toEqual([100, 50, 200, 120]);
    expect(el.mime).toBe("image/png");
    expect(Array.from(el.data)).toEqual(Array.from(PNG_BYTES));
  });

  it("应该_当_pic_指向_emf_时_跳过该元素", async () => {
    const slide = await slideOf({
      slides: [{ rels: { rId2: "../media/image2.emf" }, shapes: [pic("rId2", { x: 0, y: 0, w: 10, h: 10 })] }],
    });
    expect(slide.elements).toEqual([]);
  });

  it("应该_当_pic_的_embed_在_rels_里找不到时_跳过且不抛错", async () => {
    const slide = await slideOf({ slides: [{ shapes: [pic("rId99", { x: 0, y: 0, w: 10, h: 10 })] }] });
    expect(slide.elements).toEqual([]);
  });
});

describe("parsePptx 组合与不渲染的元素", () => {
  it("应该_当形状在组合里时_按_off_ext_与_chOff_chExt_换算到幻灯片坐标", async () => {
    // 组在 (100,100) 大小 200x100；子坐标系 (100,100)-(500,300) 即 400x200，缩放 0.5
    // 子形状在子坐标 (300,200) 大小 100x50 → 幻灯片 (100+(300-100)*0.5, 100+(200-100)*0.5) = (200,150)，大小 50x25
    const s = await firstShape({
      slides: [
        {
          shapes: [
            grp({ x: 100, y: 100, w: 200, h: 100 }, { x: 100, y: 100, w: 400, h: 200 }, [
              sp({ box: { x: 300, y: 200, w: 100, h: 50 }, paras: [para(run("组内"))] }),
            ]),
          ],
        },
      ],
    });
    expect([s.x, s.y, s.w, s.h]).toEqual([200, 150, 50, 25]);
    expect(s.paragraphs[0].runs[0].text).toBe("组内");
  });

  it("应该_当组合内含图片时_图片坐标同样被换算", async () => {
    const slide = await slideOf({
      slides: [
        {
          rels: { rId2: "../media/image1.png" },
          shapes: [
            grp({ x: 100, y: 100, w: 200, h: 100 }, { x: 100, y: 100, w: 400, h: 200 }, [
              pic("rId2", { x: 300, y: 200, w: 100, h: 50 }),
            ]),
          ],
        },
      ],
    });
    const el = slide.elements[0];
    expect(el.type).toBe("picture");
    expect([el.x, el.y, el.w, el.h]).toEqual([200, 150, 50, 25]);
  });

  it("应该_当幻灯片含_graphicFrame_表格时_不输出任何元素_其余元素照常输出", async () => {
    const slide = await slideOf({
      slides: [
        {
          shapes: [
            graphicFrame({ x: 0, y: 0, w: 400, h: 200 }),
            sp({ box: BOX, paras: [para(run("保留"))] }),
          ],
        },
      ],
    });
    expect(slide.elements).toHaveLength(1);
    expect((slide.elements[0] as Shape).paragraphs[0].runs[0].text).toBe("保留");
  });
});

describe("parsePptx 非法输入", () => {
  it("应该_当字节不是_zip_时_reject", async () => {
    const bytes = new TextEncoder().encode("this is not a zip file").buffer as ArrayBuffer;
    await expect(parsePptx(bytes)).rejects.toThrow();
  });

  it("应该_当_zip_缺少_ppt/presentation.xml_时_reject", async () => {
    const data = await removeEntry(await buildPptx({}), "ppt/presentation.xml");
    await expect(parsePptx(data)).rejects.toThrow();
  });
});

describe("parsePptx 文本框排版", () => {
  const shapeWith = (o: Parameters<typeof sp>[0]) =>
    firstShape({ slides: [{ shapes: [sp({ box: BOX, paras: [para(run("字"))], ...o })] }] });

  it("应该_当_bodyPr_没写_anchor_时_文字靠上_内边距取默认_0.1_与_0.05_英寸", async () => {
    const s = await shapeWith({});
    expect(s.anchor).toBe("top");
    expect(s.inset).toEqual({ l: 7.2, t: 3.6, r: 7.2, b: 3.6 });
  });

  it("应该_当_anchor_为_ctr_或_b_时_分别垂直居中与靠下", async () => {
    expect((await shapeWith({ bodyPr: 'anchor="ctr"' })).anchor).toBe("middle");
    expect((await shapeWith({ bodyPr: 'anchor="b"' })).anchor).toBe("bottom");
  });

  it("应该_当_bodyPr_写了内边距时_按_EMU_换算为_pt", async () => {
    const s = await shapeWith({ bodyPr: 'lIns="0" tIns="12700" rIns="25400" bIns="0"' });
    expect(s.inset).toEqual({ l: 0, t: 1, r: 2, b: 0 });
  });

  it("应该_当_run_没有颜色时_取形状_style_fontRef_的颜色", async () => {
    const s = await shapeWith({ style: `<a:fontRef idx="minor">${schemeClr("lt1")}</a:fontRef>` });
    expect(s.paragraphs[0].runs[0].color).toBe("#ffffff");
  });

  it("应该_当_run_自带颜色时_不被_fontRef_覆盖", async () => {
    const s = await firstShape({
      slides: [
        {
          shapes: [
            sp({
              box: BOX,
              style: `<a:fontRef idx="minor">${schemeClr("lt1")}</a:fontRef>`,
              paras: [para(run("字", { color: srgbClr("112233") }))],
            }),
          ],
        },
      ],
    });
    expect(s.paragraphs[0].runs[0].color).toBe("#112233");
  });
});
