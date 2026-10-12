/* =============================================================================
 * DocxViewer.tsx —— 文件工作区里的只读 Word（.docx）预览
 * -----------------------------------------------------------------------------
 * 读取字节（useBinaryFile）→ lib/docx 渲染进 docx-body。本组件只管：
 *   - 就绪后先清空旧内容再渲染；卸载 / 重新加载后迟到的结果写不进页面
 *   - 解析失败提示；加载中 / 超限 / 读取失败由 BinaryStatus 负责
 *   - 链接拦截：http(s) / mailto 交给系统，# 书签放行，其它协议一律阻止
 * ========================================================================== */

import { useEffect, useRef, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { renderDocx } from "../../lib/docx";
import { shellOpen } from "../../lib/tauri";
import BinaryStatus from "./BinaryStatus";
import PreviewFallback from "./PreviewFallback";
import { useBinaryFile } from "./useBinaryFile";

interface Props {
  path: string;
  /** 变化即重新加载（传文件的 mtime）。 */
  reloadKey: number | undefined;
}

export default function DocxViewer({ path, reloadKey }: Props) {
  const { t } = useTranslation();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const file = useBinaryFile(path, reloadKey);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    // 任何状态变化都先清掉旧内容
    body.innerHTML = "";
    setInvalid(false);
    if (file.status !== "ready") return;
    // 每轮渲染用独立子容器：撤销时整个摘掉，迟到的旧渲染只会写进已脱离文档的节点
    const host = document.createElement("div");
    body.appendChild(host);
    let cancelled = false;
    renderDocx(host, file.data).catch(() => {
      if (!cancelled) setInvalid(true);
    });
    return () => {
      cancelled = true;
      host.remove();
    };
  }, [file]);

  // 拦截文档内链接：不让 WebView 自己跳转
  const onClickCapture = (e: MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("#")) return;
    e.preventDefault();
    if (/^(https?:|mailto:)/i.test(href)) void shellOpen(href).catch(() => {});
  };

  return (
    <div
      data-testid="docx-viewer"
      className="relative h-full w-full overflow-auto bg-[var(--c-bg-elev-1)]"
    >
      <div
        ref={bodyRef}
        data-testid="docx-body"
        onClickCapture={onClickCapture}
        className={file.status === "ready" && !invalid ? "" : "hidden"}
      />
      {invalid ? (
        <PreviewFallback testId="preview-error" message={t("preview.invalid")} path={path} />
      ) : (
        <BinaryStatus state={file} path={path} />
      )}
    </div>
  );
}
