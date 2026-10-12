/* pptx 测试夹具构造器：用 JSZip 在内存里拼出最小合法 pptx，各用例只写关心的 XML 片段。 */
import JSZip from "jszip";

const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const NS_ALL = `xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"`;
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const XML_HEAD = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`;

/** pt 转 EMU */
export const pt = (n: number): number => Math.round(n * 12700);

/** 一段假的 PNG 字节（只需可比对，不需要真能解码） */
export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5]);
export const EMF_BYTES = new Uint8Array([1, 0, 0, 0, 9, 9, 9]);

export interface XfrmBox {
  x: number;
  y: number;
  w: number;
  h: number; // 单位 pt
}

/** `<a:xfrm>`（位置尺寸以 pt 传入） */
export function xfrm(box: XfrmBox, tag = "a:xfrm"): string {
  return `<${tag}><a:off x="${pt(box.x)}" y="${pt(box.y)}"/><a:ext cx="${pt(box.w)}" cy="${pt(box.h)}"/></${tag}>`;
}

export interface RunOpts {
  /** 字号，单位百分之一磅（如 2400 = 24pt）；缺省则不写 sz */
  sz?: number;
  b?: boolean;
  i?: boolean;
  u?: boolean;
  /** 颜色 XML 片段，如 srgbClr("FF0000") / schemeClr("accent1") */
  color?: string;
}

export const srgbClr = (hex: string, children = ""): string =>
  `<a:srgbClr val="${hex}">${children}</a:srgbClr>`;
export const schemeClr = (val: string, children = ""): string =>
  `<a:schemeClr val="${val}">${children}</a:schemeClr>`;
export const solidFill = (clr: string): string => `<a:solidFill>${clr}</a:solidFill>`;

/** 文字 run `<a:r>` */
export function run(text: string, o: RunOpts = {}): string {
  const attrs = [
    "lang=\"en-US\"",
    o.sz !== undefined ? `sz="${o.sz}"` : "",
    o.b ? 'b="1"' : "",
    o.i ? 'i="1"' : "",
    o.u ? 'u="sng"' : "",
  ]
    .filter(Boolean)
    .join(" ");
  const inner = o.color ? solidFill(o.color) : "";
  return `<a:r><a:rPr ${attrs}>${inner}</a:rPr><a:t>${text}</a:t></a:r>`;
}

/** 段落 `<a:p>`；algn 为 OOXML 取值（l / ctr / r / just） */
export function para(runs: string[] | string, algn?: string): string {
  const body = Array.isArray(runs) ? runs.join("") : runs;
  const pPr = algn ? `<a:pPr algn="${algn}"/>` : "";
  return `<a:p>${pPr}${body}</a:p>`;
}

export interface SpOpts {
  box?: XfrmBox;
  /** 形状填充 XML（如 solidFill(srgbClr(..))）；缺省则不写 */
  fill?: string;
  /** 占位符，如 { type: "title" } */
  ph?: { type?: string; idx?: number };
  /** 段落 XML 列表 */
  paras?: string[];
  /** 占位符内的 lstStyle（用于版式 / 母版中的 defRPr 字号） */
  lstStyle?: string;
  /** `<a:bodyPr>` 的属性串（如 `anchor="ctr" lIns="0"`） */
  bodyPr?: string;
  /** `<p:style>` 内容（如 fontRef） */
  style?: string;
}

/** 形状 `<p:sp>` */
export function sp(o: SpOpts = {}): string {
  const ph = o.ph
    ? `<p:ph${o.ph.type ? ` type="${o.ph.type}"` : ""}${o.ph.idx !== undefined ? ` idx="${o.ph.idx}"` : ""}/>`
    : "";
  const spPr = `<p:spPr>${o.box ? xfrm(o.box) : ""}${o.fill ?? ""}</p:spPr>`;
  const paras = (o.paras ?? [para("")]).join("");
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="2" name="形状"/><p:cNvSpPr/><p:nvPr>${ph}</p:nvPr></p:nvSpPr>` +
    `${spPr}${o.style ? `<p:style>${o.style}</p:style>` : ""}` +
    `<p:txBody><a:bodyPr${o.bodyPr ? ` ${o.bodyPr}` : ""}/>${o.lstStyle ?? "<a:lstStyle/>"}${paras}</p:txBody></p:sp>`
  );
}

/** 图片 `<p:pic>`，embed 为 rels 里的 rId */
export function pic(embed: string, box: XfrmBox): string {
  return (
    `<p:pic><p:nvPicPr><p:cNvPr id="3" name="图片"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
    `<p:blipFill><a:blip r:embed="${embed}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
    `<p:spPr>${xfrm(box)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
  );
}

/** 组合 `<p:grpSp>`；box 为组在幻灯片上的位置，child 为子坐标系范围（均 pt） */
export function grp(box: XfrmBox, child: XfrmBox, children: string[]): string {
  return (
    `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="4" name="组合"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="${pt(box.x)}" y="${pt(box.y)}"/><a:ext cx="${pt(box.w)}" cy="${pt(box.h)}"/>` +
    `<a:chOff x="${pt(child.x)}" y="${pt(child.y)}"/><a:chExt cx="${pt(child.w)}" cy="${pt(child.h)}"/></a:xfrm></p:grpSpPr>` +
    `${children.join("")}</p:grpSp>`
  );
}

/** 表格 / 图表 `<p:graphicFrame>` */
export function graphicFrame(box: XfrmBox): string {
  return (
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="表格"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
    `${xfrm(box, "p:xfrm")}<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">` +
    `<a:tbl><a:tblGrid/></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
  );
}

/** 背景 `<p:bg>`（纯色） */
export const bgSolid = (hex: string): string =>
  `<p:bg><p:bgPr>${solidFill(srgbClr(hex))}<a:effectLst/></p:bgPr></p:bg>`;

export interface SlideSpec {
  /** spTree 里的元素 XML */
  shapes?: string[];
  /** `<p:bg>` XML */
  bg?: string;
  /** 额外 rels：rId → 目标（相对 ppt/slides/），如 { rId2: "../media/image1.png" } */
  rels?: Record<string, string>;
}

export interface PptxOpts {
  /** 幻灯片尺寸（pt），默认 960 × 540 */
  size?: { w: number; h: number };
  /** 幻灯片（文件名为 slide1.xml、slide2.xml …，按数组顺序编号） */
  slides?: SlideSpec[];
  /** sldIdLst 里的顺序，值为 slide 编号（从 1 起）；缺省按 1..N */
  order?: number[];
  /** 版式里的元素 / 背景 */
  layoutShapes?: string[];
  layoutBg?: string;
  /** 母版里的元素 / 背景 */
  masterShapes?: string[];
  masterBg?: string;
  /** 母版 titleStyle / bodyStyle 的 lvl1 字号（百分之一磅）；null 则不写 */
  masterTitleSz?: number | null;
  masterBodySz?: number | null;
  /** 母版 titleStyle 的 lvl1 对齐（如 "ctr"） */
  masterTitleAlgn?: string;
  /** 覆盖主题色（键如 accent1 / dk1，值为十六进制） */
  theme?: Record<string, string>;
  /** 额外媒体文件：文件名（不含目录）→ 字节；默认已含 image1.png 与 image2.emf */
  media?: Record<string, Uint8Array>;
}

const DEFAULT_THEME: Record<string, string> = {
  dk1: "000000",
  lt1: "FFFFFF",
  dk2: "1F497D",
  lt2: "EEECE1",
  accent1: "4F81BD",
  accent2: "C0504D",
  accent3: "9BBB59",
  accent4: "8064A2",
  accent5: "4BACC6",
  accent6: "F79646",
  hlink: "0000FF",
  folHlink: "800080",
};

function rels(items: Array<[string, string, string]>): string {
  const body = items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL_TYPE}/${type}" Target="${target}"/>`).join("");
  return `${XML_HEAD}<Relationships xmlns="${REL_NS}">${body}</Relationships>`;
}

function spTree(shapes: string[]): string {
  return (
    `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr/>${shapes.join("")}</p:spTree>`
  );
}

function lvl1Style(tag: string, sz: number | null | undefined, algn?: string): string {
  if ((sz === null || sz === undefined) && !algn) return `<p:${tag}/>`;
  const a = algn ? ` algn="${algn}"` : "";
  const r = sz === null || sz === undefined ? "" : `<a:defRPr sz="${sz}"/>`;
  return `<p:${tag}><a:lvl1pPr${a}>${r}</a:lvl1pPr></p:${tag}>`;
}

/** 拼出完整 pptx，返回 ArrayBuffer */
export async function buildPptx(o: PptxOpts = {}): Promise<ArrayBuffer> {
  const zip = new JSZip();
  const size = o.size ?? { w: 960, h: 540 };
  const slides = o.slides ?? [{ shapes: [] }];
  const order = o.order ?? slides.map((_, i) => i + 1);
  const media: Record<string, Uint8Array> = { "image1.png": PNG_BYTES, "image2.emf": EMF_BYTES, ...(o.media ?? {}) };

  const overrides = [
    `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>`,
    `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>`,
    `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>`,
    `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>`,
    ...slides.map(
      (_, i) =>
        `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
    ),
  ].join("");
  zip.file(
    "[Content_Types].xml",
    `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Default Extension="png" ContentType="image/png"/>${overrides}</Types>`,
  );
  zip.file("_rels/.rels", rels([["rId1", "officeDocument", "ppt/presentation.xml"]]));

  // presentation：slide 的 rId 从 rId10 起，避开母版 / 主题
  const idList = order
    .map((n, i) => `<p:sldId id="${256 + i}" r:id="rId${10 + n}"/>`)
    .join("");
  zip.file(
    "ppt/presentation.xml",
    `${XML_HEAD}<p:presentation ${NS_ALL}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
      `<p:sldIdLst>${idList}</p:sldIdLst><p:sldSz cx="${pt(size.w)}" cy="${pt(size.h)}"/></p:presentation>`,
  );
  zip.file(
    "ppt/_rels/presentation.xml.rels",
    rels([
      ["rId1", "slideMaster", "slideMasters/slideMaster1.xml"],
      ["rId2", "theme", "theme/theme1.xml"],
      ...slides.map((_, i): [string, string, string] => [`rId${10 + i + 1}`, "slide", `slides/slide${i + 1}.xml`]),
    ]),
  );

  slides.forEach((s, i) => {
    zip.file(
      `ppt/slides/slide${i + 1}.xml`,
      `${XML_HEAD}<p:sld ${NS_ALL}><p:cSld>${s.bg ?? ""}${spTree(s.shapes ?? [])}</p:cSld></p:sld>`,
    );
    const extra = Object.entries(s.rels ?? {}).map(([id, target]): [string, string, string] => [id, "image", target]);
    zip.file(
      `ppt/slides/_rels/slide${i + 1}.xml.rels`,
      rels([["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"], ...extra]),
    );
  });

  zip.file(
    "ppt/slideLayouts/slideLayout1.xml",
    `${XML_HEAD}<p:sldLayout ${NS_ALL}><p:cSld>${o.layoutBg ?? ""}${spTree(o.layoutShapes ?? [])}</p:cSld></p:sldLayout>`,
  );
  zip.file(
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
    rels([["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"]]),
  );
  zip.file(
    "ppt/slideMasters/slideMaster1.xml",
    `${XML_HEAD}<p:sldMaster ${NS_ALL}><p:cSld>${o.masterBg ?? ""}${spTree(o.masterShapes ?? [])}</p:cSld>` +
      `<p:txStyles>${lvl1Style("titleStyle", o.masterTitleSz, o.masterTitleAlgn)}${lvl1Style("bodyStyle", o.masterBodySz)}<p:otherStyle/></p:txStyles></p:sldMaster>`,
  );
  zip.file(
    "ppt/slideMasters/_rels/slideMaster1.xml.rels",
    rels([
      ["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"],
      ["rId2", "theme", "../theme/theme1.xml"],
    ]),
  );

  const colors = { ...DEFAULT_THEME, ...(o.theme ?? {}) };
  const clrs = Object.entries(colors)
    .map(([k, v]) => `<a:${k}><a:srgbClr val="${v}"/></a:${k}>`)
    .join("");
  zip.file(
    "ppt/theme/theme1.xml",
    `${XML_HEAD}<a:theme xmlns:a="${NS_A}" name="Office"><a:themeElements><a:clrScheme name="Office">${clrs}</a:clrScheme></a:themeElements></a:theme>`,
  );

  for (const [name, bytes] of Object.entries(media)) zip.file(`ppt/media/${name}`, bytes);

  return zip.generateAsync({ type: "arraybuffer" });
}

/** 去掉某个部件后的 zip（用于缺失文件场景） */
export async function removeEntry(data: ArrayBuffer, path: string): Promise<ArrayBuffer> {
  const zip = await JSZip.loadAsync(data);
  zip.remove(path);
  return zip.generateAsync({ type: "arraybuffer" });
}
