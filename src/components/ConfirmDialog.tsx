import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useRef, useState } from "react";
import {
  aiToolApprove,
  aiToolReject,
  onAiToolRequest,
  type AiToolRequestEvent,
} from "../lib/tauri";
import { useBrowserModalGuard } from "../lib/useBrowserModalGuard";

interface Props {
  conversationId: string;
}

/**
 * 监听 ai:tool_request 事件，弹出审批对话框。
 * 同一时刻只能有一个待审批 tool（后端 ToolLoopHandle 串行）。
 *
 * 风险等级：
 * - high：默认聚焦"拒绝"按钮，防误点
 * - destructive：必须输入"确认"二字才能解锁批准按钮
 * - low：不会触发本对话框（后端已自动批准）
 */
export default function ConfirmDialog({ conversationId }: Props) {
  const [pending, setPending] = useState<AiToolRequestEvent | null>(null);
  const [confirmInput, setConfirmInput] = useState("");
  const rejectBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let alive = true;
    onAiToolRequest(conversationId, (e) => {
      if (!alive) return;
      setPending(e);
      setConfirmInput("");
    }).then((u) => {
      if (alive) unlisten = u;
      else u();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [conversationId]);

  // HIGH 风险下默认聚焦拒绝按钮（防误点）
  useEffect(() => {
    if (pending && pending.risk === "high") {
      // 等 dialog 渲染完
      const id = requestAnimationFrame(() => rejectBtnRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [pending]);

  // 让浏览器 webview 在 modal 弹起时让位（v0.4.1 真机 smoke：WKWebView native overlay 盖住 React DOM）
  useBrowserModalGuard(!!pending);

  if (!pending) return null;

  const isDestructive = pending.risk === "destructive";
  const approveLocked = isDestructive && confirmInput !== "确认";

  const approve = async () => {
    const callId = pending.call_id;
    setPending(null);
    setConfirmInput("");
    await aiToolApprove(callId);
  };

  const reject = async () => {
    const callId = pending.call_id;
    setPending(null);
    setConfirmInput("");
    await aiToolReject(callId);
  };

  return (
    <Dialog.Root
      open={!!pending}
      onOpenChange={(open) => {
        if (!open) reject();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm" />
        <Dialog.Content
          className={
            "fixed left-1/2 top-1/2 z-[60] w-[520px] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 rounded-lg border p-5 shadow-2xl focus:outline-none " +
            (isDestructive
              ? "border-[var(--c-error)] bg-[var(--c-bg-base)] text-[var(--c-text-base)]"
              : "border-[var(--c-border-strong)] bg-[var(--c-bg-elev-1)] text-[var(--c-text-base)]")
          }
        >
          <Dialog.Title
            className={
              "mb-3 text-base font-medium " +
              (isDestructive ? "text-[var(--c-error)]" : "text-[var(--c-text-base)]")
            }
          >
            {isDestructive ? "⚠ AI 请求执行危险操作" : "AI 请求执行工具"}
          </Dialog.Title>

          <Dialog.Description className="sr-only">
            审批或拒绝 AI 发起的工具调用
          </Dialog.Description>

          <div className="mb-3 text-xs text-[var(--c-text-muted)]">
            工具:{" "}
            <code className="rounded bg-[var(--c-bg-elev-2)] px-1.5 py-0.5 font-mono text-[var(--c-text-base)]">
              {pending.name}
            </code>
          </div>

          {pending.risk_reason && (
            <div
              className="mb-3 rounded border border-[var(--c-border)] bg-[var(--c-bg-base)] px-2 py-1 text-[11px] text-[var(--c-text-muted)]"
              aria-label="风险评分原因"
            >
              <span className="text-[var(--c-text-dim)]">评分原因：</span>
              <span className="text-[var(--c-text-muted)]">{pending.risk_reason}</span>
            </div>
          )}

          <pre className="mb-3 max-h-48 overflow-auto rounded bg-[var(--c-bg-base)] p-2 font-mono text-xs text-[var(--c-text-muted)] whitespace-pre-wrap">
{pending.args_preview}
          </pre>

          {isDestructive && (
            <div className="mb-3">
              <p className="mb-2 text-xs text-[var(--c-error)]">
                此操作不可逆。如需继续，请在下方输入 <strong>确认</strong> 二字。
              </p>
              <input
                type="text"
                value={confirmInput}
                onChange={(e) => setConfirmInput(e.target.value)}
                placeholder="输入 确认 解锁批准"
                aria-label="危险操作确认输入"
                className="w-full rounded border border-[var(--c-error)] bg-[var(--c-bg-elev-1)] px-2 py-1 text-sm text-[var(--c-text-base)] focus:border-[var(--c-error)] focus:outline-none"
              />
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button
              ref={rejectBtnRef}
              onClick={reject}
              className="rounded border border-[var(--c-border-strong)] px-3 py-1 text-sm text-[var(--c-text-base)] hover:bg-[var(--c-bg-elev-2)]"
              aria-label="拒绝"
            >
              拒绝
            </button>
            <button
              onClick={approve}
              disabled={approveLocked}
              className={
                "rounded px-3 py-1 text-sm " +
                (isDestructive
                  ? "bg-[var(--c-error)] text-white hover:opacity-90 disabled:cursor-not-allowed disabled:bg-[var(--c-bg-elev-3)] disabled:text-[var(--c-text-dim)]"
                  : "bg-[var(--c-success)] text-white hover:opacity-90")
              }
              aria-label="批准"
            >
              批准
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
