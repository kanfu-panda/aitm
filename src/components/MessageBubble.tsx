import type { ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AssistantMessage, UserMessage } from "../stores/chat";

interface Props {
  message: UserMessage | AssistantMessage;
  streaming?: boolean;
}

export default function MessageBubble({ message, streaming }: Props) {
  const isUser = message.kind === "user";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
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
      </div>
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
          remarkPlugins={[remarkGfm]}
          components={{
            code({ children, ...props }: ComponentProps<"code">) {
              const text = String(children ?? "").replace(/\n$/, "");
              // v9 通过有无换行判断 inline vs block
              if (!text.includes("\n")) {
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
              return <CodeBlock text={text} />;
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
            a({ href, children }) {
              return (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--c-info)] underline hover:opacity-80"
                >
                  {children}
                </a>
              );
            },
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

function CodeBlock({ text }: { text: string }) {
  const { t } = useTranslation();
  return (
    <div className="group relative my-1 overflow-hidden rounded border border-[var(--c-border)] bg-[var(--c-bg-base)]">
      <button
        onClick={() => {
          navigator.clipboard.writeText(text).catch(() => {});
        }}
        className="absolute right-1.5 top-1.5 rounded bg-[var(--c-bg-elev-2)] px-1.5 py-0.5 text-[10px] text-[var(--c-text-muted)] opacity-0 hover:bg-[var(--c-bg-elev-3)] hover:text-[var(--c-text-base)] group-hover:opacity-100"
        aria-label={t("messageBubble.copyCodeAria")}
      >
        {t("messageBubble.copyCode")}
      </button>
      <pre className="overflow-x-auto p-2.5 text-[12px] font-mono leading-relaxed text-[var(--c-text-base)]">
        <code>{text}</code>
      </pre>
    </div>
  );
}
