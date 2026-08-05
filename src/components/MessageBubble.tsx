import { isValidElement, type ComponentProps, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { remarkStripComments } from "../lib/remark-strip-comments";
import { MarkdownLink } from "./MarkdownLink";
import { AlertTriangle, RotateCcw } from "./icons";
import type { AssistantMessage, UserMessage } from "../stores/chat";

interface Props {
  message: UserMessage | AssistantMessage;
  streaming?: boolean;
  /** A2：是否为消息列表里最后一条；仅最后一条 assistant 气泡才展示重试按钮
   *  （历史里更早的 assistant 回复不该被重试，会打乱后续已发生的对话）。 */
  isLast?: boolean;
  /** A2：点击重试的回调。不传 → 不渲染按钮（user 消息永不重试）。 */
  onRetry?: () => void;
}

/** 递归从 react-markdown/rehype 渲染出的 children 节点树里提取纯文本。
 * v1.1.0 F7 挂 rehype-highlight 后，代码块 children 是嵌套 hljs-* <span>，
 * 不能再直接 String(children ?? "") 取文本（会拿到 "[object Object]"）。 */
function getNodeText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(getNodeText).join("");
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode };
    return getNodeText(props.children);
  }
  return "";
}

function langFromClassName(cls?: string): string | undefined {
  return /language-(\S+)/.exec(cls ?? "")?.[1];
}

export default function MessageBubble({
  message,
  streaming,
  isLast,
  onRetry,
}: Props) {
  const { t } = useTranslation();
  const isUser = message.kind === "user";
  const isAssistant = message.kind === "assistant";
  // A1：用户点停止后这条回复被标 stopped——保留已生成内容，尾部提示「已停止」。
  const stopped = isAssistant && !!message.stopped;
  // v1.3.0 反幻觉：后端比对"完成声明 × 本轮实际工具调用"后给出的警告。
  const hallucination = isAssistant ? message.hallucination : null;
  // A2：done/stopped/error 态都满足「非 streaming」；只在最后一条 assistant 上给重试入口。
  const showRetry = isAssistant && isLast && !streaming && !!onRetry;

  return (
    <div className={`flex flex-col ${isUser ? "items-end" : "items-start"}`}>
      <div
        className={
          "max-w-[88%] rounded-lg px-3 py-2 text-sm leading-relaxed " +
          (isUser
            ? "whitespace-pre-wrap bg-[var(--c-bg-elev-3)] text-[var(--c-text-base)]"
            : "border border-[var(--c-border)] bg-[var(--c-bg-base)] text-[var(--c-text-base)]")
        }
      >
        {isUser ? (
          <>{message.content}</>
        ) : (
          <AssistantContent
            content={message.content}
            streaming={!!streaming}
          />
        )}
        {stopped && (
          <div className="mt-1 text-[10px] text-[var(--c-text-faint)]">
            {t("messageBubble.stoppedLabel")}
          </div>
        )}
        {hallucination && (
          // v1.3.0 反幻觉：这条回复声称做了某类操作，但本轮一个对应工具都没调。
          // 用 amber 警告色 + 边框，醒目但不打断阅读（不是错误红）。
          <div
            className="mt-2 flex items-start gap-1.5 rounded border border-[var(--c-warn)] bg-[var(--c-warn-bg,rgba(245,158,11,0.08))] px-2 py-1 text-[11px] text-[var(--c-warn)]"
            data-testid="hallucination-warning"
            role="status"
          >
            <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden />
            <span>
              {t("messageBubble.hallucinationWarning", {
                kinds: hallucination.missing
                  .map((k) => t(`messageBubble.claimCategory.${k}`))
                  .join(" / "),
              })}
            </span>
          </div>
        )}
      </div>
      {showRetry && (
        <button
          onClick={onRetry}
          className="mt-1 flex items-center gap-1 rounded px-1 py-0.5 text-[10px] text-[var(--c-text-dim)] hover:bg-[var(--c-bg-elev-2)] hover:text-[var(--c-text-base)]"
          aria-label={t("messageBubble.retryAria")}
        >
          <RotateCcw size={12} />
          {t("messageBubble.retryLabel")}
        </button>
      )}
    </div>
  );
}

function AssistantContent({
  content,
  streaming,
}: {
  content: string;
  streaming: boolean;
}) {
  if (!content) {
    return streaming ? <span className="text-[var(--c-text-dim)]">…</span> : null;
  }
  return (
    <>
      <div className="markdown-body space-y-2">
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkStripComments]}
          rehypePlugins={[rehypeHighlight]}
          components={{
            code({ className, children, ...props }: ComponentProps<"code">) {
              // v1.1.0 F7：children 可能被 rehype-highlight 包成嵌套 hljs-* span
              // （有 lang 的 fenced code block），不能再直接 String(children)。
              const text = getNodeText(children).replace(/\n$/, "");
              // v9 无 inline prop：fenced code block 有 language-* class 或含换行。
              // 单行带语言的 ```ts 块内部无换行，只看换行会误判成 inline（回归 T2c），
              // 故 language-* class 也算块级。
              const isBlock =
                /language-/.test(className ?? "") || text.includes("\n");
              if (!isBlock) {
                // T2c：长 inline code（>20 字符，典型为文件路径 / URL）
                // 用 inline-block + break-all 让其能换行到独立一行，
                // 避免中文 label 被拖到 code 中间断行。
                // 阈值 20 选取：真机 case `/Users/someuser/project/AITM`
                // 仅 31 字符即已触发渲染 bug；保守把阈值压低到 20 让中等
                // 长度的相对路径 / 命令行也走 inline-block 兜底，
                // 短 code（如 `ls`、`cd`、字面量）不受影响。
                const isLong = text.length > 20;
                const base =
                  "rounded bg-[var(--c-bg-elev-2)] px-1 py-0.5 font-mono text-[12px] text-[var(--c-text-base)]";
                const longCls = isLong
                  ? " inline-block max-w-full break-all align-bottom"
                  : "";
                return (
                  <code className={base + longCls} {...props}>
                    {text}
                  </code>
                );
              }
              return (
                <CodeBlock
                  text={text}
                  className={className}
                  lang={langFromClassName(className)}
                >
                  {children}
                </CodeBlock>
              );
            },
            p({ children }) {
              return <p className="leading-relaxed">{children}</p>;
            },
            ul({ children }) {
              return <ul className="ml-4 list-disc space-y-1">{children}</ul>;
            },
            ol({ children }) {
              return <ol className="ml-4 list-decimal space-y-1">{children}</ol>;
            },
            // v1.1.0 R3：链接走 MarkdownLink（shellOpen 外部浏览器打开），
            // 不用 target=_blank（Tauri webview 里可能导航/开空 webview）。
            a: MarkdownLink,
            // v0.6.0：表格 cell 不允许自动换行，table 整体可横滚。
            // 真机 case：AI 用 markdown 表格列 key-value（如端口信息），
            // 默认渲染让窄 sidebar 把中文 cell 压成"每行 1 字"竖排（维护者 反馈 #2）。
            table({ children }) {
              return (
                <div className="my-2 overflow-x-auto">
                  <table className="border-collapse text-xs">{children}</table>
                </div>
              );
            },
            th({ children }) {
              return (
                <th className="whitespace-nowrap border border-[var(--c-border-strong)] bg-[var(--c-bg-elev-2)] px-2 py-1 text-left font-medium">
                  {children}
                </th>
              );
            },
            td({ children }) {
              return (
                <td className="whitespace-nowrap border border-[var(--c-border-strong)] px-2 py-1 align-top">
                  {children}
                </td>
              );
            },
          }}
        >
          {content}
        </ReactMarkdown>
      </div>
      {streaming && (
        <span className="ml-1 inline-block h-3 w-1.5 animate-pulse bg-[var(--c-text-muted)] align-middle" />
      )}
    </>
  );
}

interface CodeBlockProps {
  /** 纯文本内容（复制按钮用；从 children 递归提取，非 rehype-highlight 高亮态）。 */
  text: string;
  /** rehype-highlight 打到 <code> 上的 className（如 "language-ts hljs"）。 */
  className?: string;
  /** fenced code 声明的语言（从 className 解析），有则渲染语言标签。 */
  lang?: string;
  /** 高亮后的渲染内容（可能含嵌套 hljs-* span），渲染进 <code> 里保留高亮。 */
  children: ReactNode;
}

/** v1.1.0 F7：代码块加语言标签 + hljs 语法高亮（原先只有纯文本 <pre><code>）。
 * 复制按钮沿用既有实现；高亮配色走 index.css 的 .hljs-* token 映射。 */
function CodeBlock({ text, className, lang, children }: CodeBlockProps) {
  const { t } = useTranslation();
  return (
    <div className="group relative my-1 overflow-hidden rounded border border-[var(--c-border)] bg-[var(--c-bg-base)]">
      {lang && (
        <span className="absolute left-2 top-1.5 text-[10px] uppercase tracking-wide text-[var(--c-text-dim)]">
          {lang}
        </span>
      )}
      <button
        onClick={() => {
          navigator.clipboard.writeText(text).catch(() => {});
        }}
        className="absolute right-1.5 top-1.5 rounded bg-[var(--c-bg-elev-2)] px-1.5 py-0.5 text-[10px] text-[var(--c-text-muted)] opacity-0 hover:bg-[var(--c-bg-elev-3)] hover:text-[var(--c-text-base)] group-hover:opacity-100"
        aria-label={t("messageBubble.copyCodeAria")}
      >
        {t("messageBubble.copyCode")}
      </button>
      <pre className="overflow-x-auto p-2.5 pt-6 text-[12px] font-mono leading-relaxed text-[var(--c-text-base)]">
        <code className={className}>{children}</code>
      </pre>
    </div>
  );
}
