import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/settings";

/**
 * Phase 4A T5：浏览器设置 section（SettingsModal 的"浏览器" tab 内容）。
 *
 * 两个 number input：
 * - `max_active_tabs`（1-10）：同时可保活的 webview 数；超过 → LRU 自动 suspend
 * - `suspend_timer_minutes`（1-60）：失焦多少分钟后自动 suspend
 *
 * 改值即时调 [`useSettingsStore.update`]（已 debounced 写后端 toml）；
 * App.tsx 的 useEffect 监听 settings.browser.* → 重启 suspend timer 用新值。
 *
 * 内存预算估算：每个 webview 约 +150MB（macOS WKWebView 经验值，含 GPU
 * 共享上下文）。1 = 150MB，3 = 450MB，10 = 1.5GB。文案给用户直观感受
 * 改"上限"对系统占用的影响。
 */

/** 单个 active webview 的内存预算（MB）。macOS WKWebView 经验值，含 GPU。 */
const PER_WEBVIEW_MB = 150;

/** max_active_tabs 边界。1 = 至少能开 1 个；10 = 内存上限保护（1.5GB）。 */
const MAX_ACTIVE_MIN = 1;
const MAX_ACTIVE_MAX = 10;

/** suspend_timer_minutes 边界。1 = 最短 1 分钟；60 = 1 小时上限。 */
const TIMER_MIN = 1;
const TIMER_MAX = 60;

/** 把任意输入夹紧到 [min, max]，NaN 返默认值。 */
function clamp(v: number, min: number, max: number, fallback: number): number {
  if (Number.isNaN(v)) return fallback;
  if (v < min) return min;
  if (v > max) return max;
  return Math.floor(v);
}

export default function BrowserSettingsSection() {
  const { t } = useTranslation();
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);

  const browser = settings.browser;
  const memoryBudgetMb = browser.max_active_tabs * PER_WEBVIEW_MB;

  return (
    <div className="space-y-5">
      <section>
        <h3 className="mb-3 text-sm font-medium text-[var(--c-text-muted)]">
          {t("browser.resourceBudget")}
        </h3>
        <p className="text-[11px] leading-relaxed text-[var(--c-text-dim)]">
          {t("browser.resourceBudgetHelp", { mb: PER_WEBVIEW_MB })}
        </p>
      </section>

      <section>
        <h3 className="mb-3 text-sm font-medium text-[var(--c-text-muted)]">
          {t("browser.activeLimit")}
        </h3>
        <label className="block">
          <div className="mb-1 flex justify-between text-xs text-[var(--c-text-muted)]">
            <span>{t("browser.activeLimitLabel")}</span>
            <span className="font-mono text-[var(--c-text-base)]">
              {browser.max_active_tabs}
            </span>
          </div>
          <input
            type="number"
            min={MAX_ACTIVE_MIN}
            max={MAX_ACTIVE_MAX}
            step={1}
            value={browser.max_active_tabs}
            onChange={(e) => {
              const v = clamp(
                Number(e.target.value),
                MAX_ACTIVE_MIN,
                MAX_ACTIVE_MAX,
                3,
              );
              update({ browser: { max_active_tabs: v } });
            }}
            aria-label={t("browser.activeLimitAria")}
            className="w-24 rounded border border-[var(--c-border-strong)] bg-[var(--c-bg-base)] px-2 py-1 text-sm text-[var(--c-text-base)] focus:border-[var(--c-border-strong)] focus:outline-none"
          />
          <p className="mt-1 text-[10px] text-[var(--c-text-dim)]">
            {t("browser.activeLimitHelp", { min: MAX_ACTIVE_MIN, max: MAX_ACTIVE_MAX })}
          </p>
        </label>
      </section>

      <section>
        <h3 className="mb-3 text-sm font-medium text-[var(--c-text-muted)]">
          {t("browser.suspendTitle")}
        </h3>
        <label className="block">
          <div className="mb-1 flex justify-between text-xs text-[var(--c-text-muted)]">
            <span>{t("browser.suspendLabel")}</span>
            <span className="font-mono text-[var(--c-text-base)]">
              {browser.suspend_timer_minutes}
            </span>
          </div>
          <input
            type="number"
            min={TIMER_MIN}
            max={TIMER_MAX}
            step={1}
            value={browser.suspend_timer_minutes}
            onChange={(e) => {
              const v = clamp(
                Number(e.target.value),
                TIMER_MIN,
                TIMER_MAX,
                5,
              );
              update({ browser: { suspend_timer_minutes: v } });
            }}
            aria-label={t("browser.suspendAria")}
            className="w-24 rounded border border-[var(--c-border-strong)] bg-[var(--c-bg-base)] px-2 py-1 text-sm text-[var(--c-text-base)] focus:border-[var(--c-border-strong)] focus:outline-none"
          />
          <p className="mt-1 text-[10px] text-[var(--c-text-dim)]">
            {t("browser.suspendHelp", { min: TIMER_MIN, max: TIMER_MAX })}
          </p>
        </label>
      </section>

      <section className="rounded border border-[var(--c-border)] bg-[var(--c-bg-base)] p-3">
        <div className="mb-1 text-xs text-[var(--c-text-muted)]">
          {t("browser.currentBudgetLabel")}{" "}
          <span className="font-mono text-[var(--c-success-fg)]">
            +{memoryBudgetMb}&nbsp;MB
          </span>
        </div>
        <p className="text-[10px] leading-relaxed text-[var(--c-text-dim)]">
          {t("browser.currentBudgetHelp")}
        </p>
      </section>
    </div>
  );
}
