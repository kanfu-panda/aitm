import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/settings";

/**
 * v0.7.0-A：SettingsModal 内的"隐私" section。
 *
 * 单一开关：`settings.privacy.analytics_opt_in`，控制是否上报匿名使用统计
 * 到 Aptabase（默认 ON）。说明文字交代清楚"会上报什么 / 不会上报什么"。
 *
 * 视觉风格对齐 SafetySection / NotificationSection（zinc tokens + 12px 说明文字）。
 */
export default function PrivacySection() {
  const { t } = useTranslation();
  const optIn = useSettingsStore((s) => s.settings.privacy.analytics_opt_in);
  const update = useSettingsStore((s) => s.update);

  return (
    <div className="space-y-4">
      <section>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-[var(--c-text-base)]">
          <input
            type="checkbox"
            checked={optIn}
            onChange={(e) =>
              update({ privacy: { analytics_opt_in: e.target.checked } })
            }
            className="accent-[var(--c-success)]"
            aria-label={t("privacy.optInLabel")}
          />
          <span>{t("privacy.optInLabelRecommended")}</span>
        </label>

        <div className="mt-2 space-y-2 rounded border border-[var(--c-border)] bg-[var(--c-bg-base)] p-3 text-[11px] leading-relaxed text-[var(--c-text-muted)]">
          <p>
            {t("privacy.descLine1Prefix")}
            <strong className="text-[var(--c-text-base)]">
              {t("privacy.descLine1Strong")}
            </strong>
            {t("privacy.descLine1Suffix")}
          </p>
          <p>{t("privacy.descLine2")}</p>
          <p>
            {t("privacy.descLine3Prefix")}
            <a
              href="https://aptabase.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--c-success-fg)] underline-offset-2 hover:underline"
            >
              https://aptabase.com
            </a>
          </p>
        </div>
      </section>
    </div>
  );
}
