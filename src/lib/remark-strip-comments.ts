/**
 * remark 插件：剥掉 Markdown 里的 HTML 注释节点（`<!-- ... -->`）。
 *
 * 背景（v1.1.0 R4，真机反馈）：react-markdown 未启用 rehype-raw 时，会把原始
 * HTML（含注释）当作**转义文本**渲染出来（预览里看到 `&lt;!-- ... --&gt;`）。
 * 这里在 mdast 阶段直接删掉 `html` 类型且内容是注释的节点，让预览干净。
 *
 * 只删 HTML 注释节点，不碰 `code` / `inlineCode`——所以代码块里当作示例的
 * `<!-- -->` 文本不会被误删。零外部依赖，手写递归遍历（不引 unist-util-visit）。
 */
interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
}

/** 判断节点是否为 HTML 注释（整段 trim 后形如 `<!-- ... -->`）。 */
function isHtmlComment(node: MdastNode): boolean {
  return (
    node.type === "html" &&
    typeof node.value === "string" &&
    /^<!--[\s\S]*-->$/.test(node.value.trim())
  );
}

export function remarkStripComments() {
  return (tree: MdastNode): void => {
    const walk = (node: MdastNode): void => {
      if (!node.children) return;
      node.children = node.children.filter((child) => !isHtmlComment(child));
      node.children.forEach(walk);
    };
    walk(tree);
  };
}
