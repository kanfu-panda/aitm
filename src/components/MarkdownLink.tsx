import type { ReactNode } from "react";
import { shellOpen } from "../lib/tauri";

/**
 * Markdown 渲染里的链接组件（预览 / AI 气泡共用）。
 *
 * v1.1.0 R3（真机反馈）：默认 `<a href>` 被点击会**导航当前 webview**——整个
 * React app 被 URL 顶掉、状态尽失，重载后弹"恢复上次会话"。这里改为
 * `preventDefault` + `shellOpen(href)`，用系统默认浏览器打开外部链接，不动 app。
 *
 * 非 http/https/mailto（锚点 `#foo` / 相对路径等）会被 shellOpen 的后端白名单
 * 拒绝，此时 preventDefault 已拦住导航、shellOpen 静默失败，app 不受影响（安全）。
 */
export function MarkdownLink({
  href,
  children,
}: {
  href?: string;
  children?: ReactNode;
}) {
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        if (href) void shellOpen(href);
      }}
      className="cursor-pointer text-[var(--c-info)] underline hover:opacity-80"
    >
      {children}
    </a>
  );
}
