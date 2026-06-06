import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/settings";
import { safetyTestMatch, safetyValidatePattern } from "../../lib/tauri";

/**
 * SettingsModal 内的 Safety 区块。
 *
 * 包含两块：
 *  1. 白名单列表 + 增删 + 自动批准徽章开关
 *  2. PatternTester：实时输入 cmd 看会不会命中白名单
 *
 * PatternTester 作为同文件子组件而非独立文件——它逻辑很小（~25 行）、
 * 跟主区块共享同一份 settings.safety.whitelist，单独拆没有好处。
 */
export default function SafetySection() {
  const { t } = useTranslation();
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const whitelist = settings.safety.whitelist;

  // 添加新模式：null = 未在添加；string = 当前正在编辑的草稿
  const [draft, setDraft] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);

  const removePattern = (pattern: string) => {
    update({
      safety: {
        whitelist: whitelist.filter((p) => p !== pattern),
      },
    });
  };

  const startAdd = () => {
    setDraft("");
    setDraftError(null);
  };

  const cancelAdd = () => {
    setDraft(null);
    setDraftError(null);
  };

  const commitAdd = async () => {
    const pattern = (draft ?? "").trim();
    if (!pattern) {
      cancelAdd();
      return;
    }
    // 重复 → 静默丢弃
    if (whitelist.includes(pattern)) {
      cancelAdd();
      return;
    }
    try {
      await safetyValidatePattern(pattern);
    } catch (e) {
      setDraftError(typeof e === "string" ? e : String(e));
      return;
    }
    update({
      safety: { whitelist: [...whitelist, pattern] },
    });
    setDraft(null);
    setDraftError(null);
  };

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-2 text-[11px] text-[var(--c-text-dim)]">
          {t("safety.descriptionBefore")}
          <code className="text-[var(--c-text-muted)]">run_command</code>
          {t("safety.descriptionAfter")}
        </p>

        {whitelist.length === 0 && draft === null && (
          <p className="mb-2 text-xs italic text-[var(--c-text-dim)]">
            {t("safety.emptyHint")}
          </p>
        )}

        {whitelist.length > 0 && (
          <ul
            aria-label={t("safety.listAriaLabel")}
            className="mb-2 space-y-1 rounded border border-[var(--c-border)] bg-[var(--c-bg-base)] p-2"
          >
            {whitelist.map((pattern) => (
              <li
                key={pattern}
                className="flex items-center justify-between rounded px-2 py-1 hover:bg-[var(--c-bg-elev-1)]"
              >
                <code className="font-mono text-xs text-[var(--c-success-fg)]">
                  {pattern}
                </code>
                <button
                  type="button"
                  onClick={() => removePattern(pattern)}
                  aria-label={t("safety.removePatternAriaLabel", { pattern })}
                  className="rounded px-1.5 py-0.5 text-xs text-[var(--c-text-dim)] hover:bg-[var(--c-bg-elev-2)] hover:text-[var(--c-error)]"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}

        {draft !== null ? (
          <DraftRow
            value={draft}
            error={draftError}
            onChange={(v) => {
              setDraft(v);
              if (draftError) setDraftError(null);
            }}
            onCommit={commitAdd}
            onCancel={cancelAdd}
          />
        ) : (
          <button
            type="button"
            onClick={startAdd}
            className="rounded border border-[var(--c-border-strong)] bg-[var(--c-bg-elev-1)] px-3 py-1 text-xs text-[var(--c-text-muted)] hover:bg-[var(--c-bg-elev-2)]"
          >
            {t("safety.addButton")}
          </button>
        )}
      </div>

      <label className="flex items-center gap-2 text-xs text-[var(--c-text-muted)]">
        <input
          type="checkbox"
          checked={settings.safety.show_low_auto_approved}
          onChange={(e) =>
            update({
              safety: { show_low_auto_approved: e.target.checked },
            })
          }
          className="accent-[var(--c-success)]"
          aria-label={t("safety.showBadgeLabel")}
        />
        <span>{t("safety.showBadgeLabel")}</span>
      </label>

      <div className="border-t border-[var(--c-border)] pt-3">
        <h4 className="mb-2 text-xs font-medium text-[var(--c-text-muted)]">
          {t("safety.patternTesterTitle")}
        </h4>
        <PatternTester patterns={whitelist} />
      </div>
    </div>
  );
}

interface DraftRowProps {
  value: string;
  error: string | null;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}

function DraftRow({
  value,
  error,
  onChange,
  onCommit,
  onCancel,
}: DraftRowProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);

  // 自动聚焦到新输入框
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="space-y-1">
      <div className="flex gap-1">
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => {
            // blur 提交：空值 / 重复 / 失败 都由 commitAdd 处理
            onCommit();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onCommit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
          placeholder={t("safety.draftPlaceholder")}
          aria-label={t("safety.draftAriaLabel")}
          // 命令 / 标识符输入：关掉浏览器自动大小写 / 拼写 / IME 联想，
          // 防止"输 git 自动变 Git"、"_ 第一遍无反应需要按两次"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          className={
            "flex-1 rounded border bg-[var(--c-bg-base)] px-2 py-1 font-mono text-xs text-[var(--c-text-base)] focus:outline-none " +
            (error
              ? "border-[var(--c-error)] focus:border-[var(--c-error)]"
              : "border-[var(--c-border-strong)] focus:border-[var(--c-border-strong)]")
          }
        />
        <button
          type="button"
          // 用 mousedown 阻止 blur 抢先（取消按钮被点时不应触发 commit）
          onMouseDown={(e) => {
            e.preventDefault();
            onCancel();
          }}
          className="rounded border border-[var(--c-border-strong)] px-2 text-xs text-[var(--c-text-muted)] hover:bg-[var(--c-bg-elev-2)]"
        >
          {t("safety.draftCancel")}
        </button>
      </div>
      {error && (
        <p
          aria-label={t("safety.draftErrorAriaLabel")}
          className="text-[11px] text-[var(--c-error)]"
        >
          {error}
        </p>
      )}
    </div>
  );
}

interface PatternTesterProps {
  patterns: string[];
}

function PatternTester({ patterns }: PatternTesterProps) {
  const { t } = useTranslation();
  const [cmd, setCmd] = useState("");
  const [result, setResult] = useState<
    { kind: "hit"; pattern: string } | { kind: "miss" } | null
  >(null);

  // 输入变化 → 异步调后端命中检测
  useEffect(() => {
    const trimmed = cmd.trim();
    if (!trimmed) {
      setResult(null);
      return;
    }
    let cancelled = false;
    safetyTestMatch(trimmed, patterns)
      .then((hit) => {
        if (cancelled) return;
        setResult(hit ? { kind: "hit", pattern: hit } : { kind: "miss" });
      })
      .catch(() => {
        if (cancelled) return;
        setResult({ kind: "miss" });
      });
    return () => {
      cancelled = true;
    };
  }, [cmd, patterns]);

  return (
    <div className="space-y-1">
      <input
        type="text"
        value={cmd}
        onChange={(e) => setCmd(e.target.value)}
        placeholder={t("safety.patternTesterPlaceholder")}
        aria-label={t("safety.patternTesterInputAriaLabel")}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        className="w-full rounded border border-[var(--c-border-strong)] bg-[var(--c-bg-base)] px-2 py-1 font-mono text-xs text-[var(--c-text-base)] focus:border-[var(--c-border-strong)] focus:outline-none"
      />
      {result && (
        <p
          aria-label={t("safety.patternTesterResultAriaLabel")}
          className={
            "text-xs " +
            (result.kind === "hit" ? "text-[var(--c-success-fg)]" : "text-[var(--c-text-dim)]")
          }
        >
          {result.kind === "hit"
            ? t("safety.patternTesterHit", { pattern: result.pattern })
            : t("safety.patternTesterMiss")}
        </p>
      )}
    </div>
  );
}
