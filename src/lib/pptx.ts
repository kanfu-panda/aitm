/* =============================================================================
 * pptx.ts —— PowerPoint 解析适配层
 * -----------------------------------------------------------------------------
 * parsePptx 把 .pptx（zip + OOXML）解析成可直接绘制的简化模型，单位一律为 pt、颜色为 "#rrggbb"。
 * 支持：幻灯片尺寸与顺序、主题色（含 lumMod / lumOff）、背景继承（幻灯片 → 版式 → 母版）、
 * 文字框、形状纯色填充、占位符位置与字号继承、图片、组合坐标换算。
 * 表格 / 图表（graphicFrame）、SmartArt、渐变与图片填充、连接线等一律不渲染。
 * jszip 按需加载，不进主包。
 * ========================================================================== */

export interface PptxRun {
  text: string;
  sizePt: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color: string | null;
}
export interface PptxParagraph {
  align: "left" | "center" | "right" | "justify";
  runs: PptxRun[];
}
export type PptxElement =
  | {
      type: "shape";
      x: number;
      y: number;
      w: number;
      h: number;
      fill: string | null;
      /** 文字在框内的垂直位置（bodyPr@anchor） */
      anchor: "top" | "middle" | "bottom";
      /** 文本框内边距（pt） */
      inset: { l: number; t: number; r: number; b: number };
      paragraphs: PptxParagraph[];
    }
  | { type: "picture"; x: number; y: number; w: number; h: number; mime: string; data: Uint8Array };
export interface PptxSlide {
  background: string;
  elements: PptxElement[];
}
export interface Presentation {
  width: number;
  height: number;
  slides: PptxSlide[];
}

const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const EMU_PER_PT = 12700;
const DEFAULT_SIZE_PT = 18;

// jszip 实例的最小类型（避免顶层引入 jszip 的类型以外的运行时依赖）
type Zip = import("jszip");

// ---------------------------------------------------------------------------
// XML 小工具
// ---------------------------------------------------------------------------

const children = (el: Element | null | undefined, ns: string, name: string): Element[] =>
  el ? Array.from(el.children).filter((c) => c.namespaceURI === ns && c.localName === name) : [];
const child = (el: Element | null | undefined, ns: string, name: string): Element | null =>
  children(el, ns, name)[0] ?? null;
const descend = (el: Element | null | undefined, ...path: Array<[string, string]>): Element | null => {
  let cur: Element | null | undefined = el;
  for (const [ns, name] of path) cur = child(cur, ns, name);
  return cur ?? null;
};

// 经 window 取 DOMParser（项目 eslint 的 no-undef 全局表里没有它），并由返回值推导文档类型
const parseXml = (text: string) => new window.DOMParser().parseFromString(text, "application/xml");
type XmlDoc = ReturnType<typeof parseXml>;

async function readXml(zip: Zip, path: string): Promise<XmlDoc | null> {
  const file = zip.file(path);
  if (!file) return null;
  const doc = parseXml(await file.async("string"));
  return doc.getElementsByTagName("parsererror").length > 0 ? null : doc;
}

// ---------------------------------------------------------------------------
// 关系（rels）
// ---------------------------------------------------------------------------

interface Rel {
  type: string;
  target: string; // 已解析为 zip 内的绝对路径
}

/** 把 rels 里的相对目标按所属部件所在目录解析成 zip 内路径 */
function resolvePath(partPath: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = partPath.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== "." && seg !== "") parts.push(seg);
  }
  return parts.join("/");
}

async function readRels(zip: Zip, partPath: string): Promise<Map<string, Rel>> {
  const idx = partPath.lastIndexOf("/");
  const relsPath = `${partPath.slice(0, idx + 1)}_rels/${partPath.slice(idx + 1)}.rels`;
  const doc = await readXml(zip, relsPath);
  const map = new Map<string, Rel>();
  if (!doc) return map;
  for (const r of Array.from(doc.getElementsByTagName("Relationship"))) {
    if (r.getAttribute("TargetMode") === "External") continue;
    const id = r.getAttribute("Id");
    const target = r.getAttribute("Target");
    if (id && target) {
      map.set(id, { type: (r.getAttribute("Type") ?? "").split("/").pop() ?? "", target: resolvePath(partPath, target) });
    }
  }
  return map;
}

const relOfType = (rels: Map<string, Rel>, type: string): string | null =>
  Array.from(rels.values()).find((r) => r.type === type)?.target ?? null;

// ---------------------------------------------------------------------------
// 颜色与主题
// ---------------------------------------------------------------------------

type Theme = Map<string, string>; // dk1 / lt1 / accent1 … → "#rrggbb"

const SCHEME_ALIAS: Record<string, string> = { tx1: "dk1", bg1: "lt1", tx2: "dk2", bg2: "lt2" };

function parseTheme(doc: XmlDoc | null): Theme {
  const theme: Theme = new Map();
  const scheme = doc?.getElementsByTagNameNS(NS_A, "clrScheme")[0];
  for (const slot of Array.from(scheme?.children ?? [])) {
    const c = child(slot, NS_A, "srgbClr");
    const sys = child(slot, NS_A, "sysClr");
    const hex = hexColor(c?.getAttribute("val") ?? sys?.getAttribute("lastClr"));
    if (hex) theme.set(slot.localName, hex);
  }
  return theme;
}

const hex2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");

/** 按 HSL 亮度做 lumMod / lumOff 调整 */
function adjustLuminance(hex: string, mod: number, off: number): string {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  l = Math.max(0, Math.min(1, l * mod + off));
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t0: number) => {
    const t = t0 < 0 ? t0 + 1 : t0 > 1 ? t0 - 1 : t0;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  if (s === 0) return `#${hex2(l * 255).repeat(3)}`;
  return `#${hex2(channel(h + 1 / 3) * 255)}${hex2(channel(h) * 255)}${hex2(channel(h - 1 / 3) * 255)}`;
}

/** 6 位十六进制颜色值 → "#rrggbb"；格式不对返回 null */
const hexColor = (v: string | null | undefined): string | null =>
  v && /^[0-9a-f]{6}$/i.test(v) ? `#${v.toLowerCase()}` : null;

/** 解析 el（如 a:solidFill）下的颜色子元素 */
function colorOf(el: Element | null, theme: Theme): string | null {
  const clr = el ? Array.from(el.children).find((c) => c.namespaceURI === NS_A && /Clr$/.test(c.localName)) : null;
  if (!clr) return null;
  let base: string | null = null;
  if (clr.localName === "srgbClr") {
    base = hexColor(clr.getAttribute("val"));
  } else if (clr.localName === "schemeClr") {
    const name = clr.getAttribute("val") ?? "";
    base = theme.get(SCHEME_ALIAS[name] ?? name) ?? null;
  } else if (clr.localName === "sysClr") {
    base = hexColor(clr.getAttribute("lastClr"));
  }
  if (!base) return null;
  const val = (name: string) => {
    const v = child(clr, NS_A, name)?.getAttribute("val");
    return v === null || v === undefined ? null : Number(v) / 100000;
  };
  const mod = val("lumMod");
  const off = val("lumOff");
  return mod === null && off === null ? base : adjustLuminance(base, mod ?? 1, off ?? 0);
}

/** 取 parent 下 a:solidFill 的颜色；无纯色填充返回 null */
const solidFillOf = (parent: Element | null, theme: Theme): string | null =>
  colorOf(child(parent, NS_A, "solidFill"), theme);

// ---------------------------------------------------------------------------
// 背景
// ---------------------------------------------------------------------------

function backgroundOf(doc: XmlDoc | null, theme: Theme): string | null {
  const cSld = doc ? descend(doc.documentElement, [NS_P, "cSld"]) : null;
  return solidFillOf(descend(cSld, [NS_P, "bg"], [NS_P, "bgPr"]), theme);
}

// ---------------------------------------------------------------------------
// 占位符继承
// ---------------------------------------------------------------------------

interface Ph {
  type: string;
  idx: string | null;
}
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const phOf = (sp: Element): Ph | null => {
  const ph = descend(sp, [NS_P, "nvSpPr"], [NS_P, "nvPr"], [NS_P, "ph"]);
  if (!ph) return null;
  const type = ph.getAttribute("type") ?? "body";
  return { type: type === "ctrTitle" ? "title" : type, idx: ph.getAttribute("idx") };
};

const treeOf = (doc: XmlDoc | null): Element | null =>
  doc ? descend(doc.documentElement, [NS_P, "cSld"], [NS_P, "spTree"]) : null;

/** 在版式、母版里找与 ph 对应的占位符形状（先按 idx，再按 type） */
function findInherited(ph: Ph, layers: Array<XmlDoc | null>): Element[] {
  const found: Element[] = [];
  for (const doc of layers) {
    const sps = children(treeOf(doc), NS_P, "sp");
    const hit =
      sps.find((sp) => {
        const p = phOf(sp);
        return p !== null && ph.idx !== null && p.idx === ph.idx;
      }) ?? sps.find((sp) => phOf(sp)?.type === ph.type);
    if (hit) found.push(hit);
  }
  return found;
}

const xfrmOf = (spPr: Element | null): Element | null => child(spPr, NS_A, "xfrm");

function boxOf(xfrm: Element | null): Box | null {
  const off = child(xfrm, NS_A, "off");
  const ext = child(xfrm, NS_A, "ext");
  if (!off || !ext) return null;
  const n = (e: Element, a: string) => Number(e.getAttribute(a) ?? 0) / EMU_PER_PT;
  return { x: n(off, "x"), y: n(off, "y"), w: n(ext, "cx"), h: n(ext, "cy") };
}

const ALIGN: Record<string, PptxParagraph["align"]> = { l: "left", ctr: "center", r: "right", just: "justify" };
const ANCHOR: Record<string, "top" | "middle" | "bottom"> = { t: "top", ctr: "middle", b: "bottom" };

/** 取 lstStyle 里 lvl1pPr/defRPr@sz（pt） */
function lstStyleSize(lstStyle: Element | null): number | null {
  const sz = descend(lstStyle, [NS_A, "lvl1pPr"], [NS_A, "defRPr"])?.getAttribute("sz");
  return sz ? Number(sz) / 100 : null;
}

/** 取 lstStyle 里 lvl1pPr@algn */
function lstStyleAlign(lstStyle: Element | null): PptxParagraph["align"] | null {
  return ALIGN[descend(lstStyle, [NS_A, "lvl1pPr"])?.getAttribute("algn") ?? ""] ?? null;
}

/** 母版 txStyles 里与占位符类型对应的样式 */
function masterStyle(master: XmlDoc | null, type: string): Element | null {
  const styleName = type === "title" ? "titleStyle" : type === "body" || type === "subTitle" || type === "obj" ? "bodyStyle" : "otherStyle";
  return descend(master?.documentElement, [NS_P, "txStyles"], [NS_P, styleName]);
}

// ---------------------------------------------------------------------------
// 坐标变换（组合）
// ---------------------------------------------------------------------------

/** 子坐标 → 幻灯片坐标：X = bx + (x - ax) * sx */
interface Transform {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  sx: number;
  sy: number;
}
const IDENTITY: Transform = { ax: 0, ay: 0, bx: 0, by: 0, sx: 1, sy: 1 };

const applyBox = (t: Transform, b: Box): Box => ({
  x: t.bx + (b.x - t.ax) * t.sx,
  y: t.by + (b.y - t.ay) * t.sy,
  w: b.w * t.sx,
  h: b.h * t.sy,
});

function groupTransform(grp: Element, parent: Transform): Transform | null {
  const xf = descend(grp, [NS_P, "grpSpPr"], [NS_A, "xfrm"]);
  const outer = boxOf(xf);
  const chOff = child(xf, NS_A, "chOff");
  const chExt = child(xf, NS_A, "chExt");
  if (!outer || !chOff || !chExt) return null;
  const n = (e: Element, a: string) => Number(e.getAttribute(a) ?? 0) / EMU_PER_PT;
  const slide = applyBox(parent, outer);
  const cw = n(chExt, "cx");
  const ch = n(chExt, "cy");
  return {
    ax: n(chOff, "x"),
    ay: n(chOff, "y"),
    bx: slide.x,
    by: slide.y,
    sx: cw ? slide.w / cw : 1,
    sy: ch ? slide.h / ch : 1,
  };
}

// ---------------------------------------------------------------------------
// 文字与形状
// ---------------------------------------------------------------------------

function parseParagraphs(
  txBody: Element | null,
  theme: Theme,
  inheritedSize: number,
  inheritedAlign: PptxParagraph["align"],
  inheritedColor: string | null,
): PptxParagraph[] {
  return children(txBody, NS_A, "p").map((p) => ({
    align: ALIGN[child(p, NS_A, "pPr")?.getAttribute("algn") ?? ""] ?? inheritedAlign,
    runs: children(p, NS_A, "r").map((r) => {
      const rPr = child(r, NS_A, "rPr");
      const sz = rPr?.getAttribute("sz");
      return {
        text: child(r, NS_A, "t")?.textContent ?? "",
        sizePt: sz ? Number(sz) / 100 : inheritedSize,
        bold: rPr?.getAttribute("b") === "1",
        italic: rPr?.getAttribute("i") === "1",
        underline: !!rPr?.getAttribute("u") && rPr.getAttribute("u") !== "none",
        color: solidFillOf(rPr, theme) ?? inheritedColor,
      };
    }),
  }));
}

interface Context {
  zip: Zip;
  theme: Theme;
  layers: Array<XmlDoc | null>; // [版式, 母版]
  master: XmlDoc | null;
  slideRels: Map<string, Rel>;
}

function parseShape(sp: Element, t: Transform, ctx: Context): PptxElement | null {
  const spPr = child(sp, NS_P, "spPr");
  const ph = phOf(sp);
  const inherited = ph ? findInherited(ph, ctx.layers) : [];
  const box =
    boxOf(xfrmOf(spPr)) ?? inherited.map((i) => boxOf(xfrmOf(child(i, NS_P, "spPr")))).find((b) => b !== null) ?? null;
  if (!box) return null;
  const txBody = child(sp, NS_P, "txBody");
  // 占位符的段落样式按 幻灯片 → 版式 → 母版 txStyles 逐层取第一个写了的值
  const styles = ph
    ? [txBody, ...inherited.map((i) => child(i, NS_P, "txBody"))]
        .map((b) => child(b, NS_A, "lstStyle"))
        .concat(masterStyle(ctx.master, ph.type))
    : [];
  const size = styles.map(lstStyleSize).find((v) => v !== null) ?? DEFAULT_SIZE_PT;
  const align = styles.map(lstStyleAlign).find((v) => v !== null) ?? "left";
  // 形状样式里的字体颜色（插入的形状多为 fontRef → lt1 白字）
  const fontColor = colorOf(descend(sp, [NS_P, "style"], [NS_A, "fontRef"]), ctx.theme);
  const bodyPr = child(txBody, NS_A, "bodyPr");
  const ins = (attr: string, def: number) => {
    const v = bodyPr?.getAttribute(attr);
    return v ? Number(v) / EMU_PER_PT : def;
  };
  const { x, y, w, h } = applyBox(t, box);
  return {
    type: "shape",
    x,
    y,
    w,
    h,
    fill: solidFillOf(spPr, ctx.theme),
    anchor: ANCHOR[bodyPr?.getAttribute("anchor") ?? ""] ?? "top",
    // 默认内边距：左右 0.1 英寸、上下 0.05 英寸
    inset: { l: ins("lIns", 7.2), t: ins("tIns", 3.6), r: ins("rIns", 7.2), b: ins("bIns", 3.6) },
    paragraphs: parseParagraphs(txBody, ctx.theme, size, align, fontColor),
  };
}

// ---------------------------------------------------------------------------
// 图片
// ---------------------------------------------------------------------------

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

async function parsePicture(pic: Element, t: Transform, ctx: Context): Promise<PptxElement | null> {
  const blip = descend(pic, [NS_P, "blipFill"], [NS_A, "blip"]);
  const rel = ctx.slideRels.get(blip?.getAttributeNS(NS_R, "embed") ?? "");
  const box = boxOf(xfrmOf(child(pic, NS_P, "spPr")));
  if (!rel || !box) return null;
  const mime = IMAGE_MIME[rel.target.split(".").pop()?.toLowerCase() ?? ""];
  const file = ctx.zip.file(rel.target);
  if (!mime || !file) return null;
  const { x, y, w, h } = applyBox(t, box);
  return { type: "picture", x, y, w, h, mime, data: await file.async("uint8array") };
}

// ---------------------------------------------------------------------------
// 形状树遍历
// ---------------------------------------------------------------------------

async function walkTree(tree: Element, t: Transform, ctx: Context, out: PptxElement[]): Promise<void> {
  for (const node of Array.from(tree.children)) {
    if (node.namespaceURI !== NS_P) continue;
    let el: PptxElement | null = null;
    if (node.localName === "sp") el = parseShape(node, t, ctx);
    else if (node.localName === "pic") el = await parsePicture(node, t, ctx);
    else if (node.localName === "grpSp") {
      const gt = groupTransform(node, t);
      if (gt) await walkTree(node, gt, ctx, out);
    }
    if (el) out.push(el);
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

async function parseSlide(zip: Zip, slidePath: string, theme: Theme): Promise<PptxSlide> {
  const slideRels = await readRels(zip, slidePath);
  const slideDoc = await readXml(zip, slidePath);
  const layoutPath = relOfType(slideRels, "slideLayout");
  const layoutDoc = layoutPath ? await readXml(zip, layoutPath) : null;
  const masterPath = layoutPath ? relOfType(await readRels(zip, layoutPath), "slideMaster") : null;
  const master = masterPath ? await readXml(zip, masterPath) : null;
  const ctx: Context = { zip, theme, layers: [layoutDoc, master], master, slideRels };

  const elements: PptxElement[] = [];
  const tree = treeOf(slideDoc);
  if (tree) await walkTree(tree, IDENTITY, ctx, elements);
  const background =
    [slideDoc, layoutDoc, master].map((d) => backgroundOf(d, theme)).find((c) => c !== null) ?? "#ffffff";
  return { background, elements };
}

export async function parsePptx(data: ArrayBuffer): Promise<Presentation> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(data);
  const presDoc = await readXml(zip, "ppt/presentation.xml");
  if (!presDoc) throw new Error("缺少 ppt/presentation.xml");

  const sldSz = presDoc.getElementsByTagNameNS(NS_P, "sldSz")[0];
  const rels = await readRels(zip, "ppt/presentation.xml");
  const themePath = relOfType(rels, "theme") ?? "ppt/theme/theme1.xml";
  const theme = parseTheme(await readXml(zip, themePath));

  const ids = Array.from(presDoc.getElementsByTagNameNS(NS_P, "sldId")).map((e) => e.getAttributeNS(NS_R, "id") ?? "");
  const paths = ids.map((id) => rels.get(id)?.target).filter((p): p is string => !!p);
  const slides: PptxSlide[] = [];
  for (const p of paths) slides.push(await parseSlide(zip, p, theme));

  return {
    width: Number(sldSz?.getAttribute("cx") ?? 0) / EMU_PER_PT,
    height: Number(sldSz?.getAttribute("cy") ?? 0) / EMU_PER_PT,
    slides,
  };
}
