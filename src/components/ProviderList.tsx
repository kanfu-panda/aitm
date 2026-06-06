import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  providersGetConfig,
  providersSaveConfig,
  providersTestConnection,
  type ProviderConfigDto,
} from "../lib/tauri";

export default function ProviderList() {
  const { t } = useTranslation();
  const [items, setItems] = useState<ProviderConfigDto[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    setLoading(true);
    try {
      setItems(await providersGetConfig());
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  if (loading) return <div className="text-xs text-[var(--c-text-dim)]">{t("providers.loading")}</div>;
  if (items.length === 0)
    return <div className="text-xs text-[var(--c-text-dim)]">{t("providers.empty")}</div>;

  return (
    <div className="space-y-3">
      {items.map((p) => (
        <ProviderRow key={p.id} dto={p} onSaved={refresh} />
      ))}
    </div>
  );
}

interface ProviderRowProps {
  dto: ProviderConfigDto;
  onSaved: () => void;
}

export function ProviderRow({ dto, onSaved }: ProviderRowProps) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(dto.enabled);
  const [keyInput, setKeyInput] = useState(""); // "" = 留空保留原值
  const [showKey, setShowKey] = useState(false);
  const [baseUrl, setBaseUrl] = useState(dto.base_url);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    msg: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  const dirty =
    enabled !== dto.enabled ||
    keyInput.length > 0 ||
    baseUrl !== dto.base_url;

  // dto 刷新后（onSaved 重拉）→ 同步本地受控字段；keyInput 已在保存成功后清空
  useEffect(() => {
    setEnabled(dto.enabled);
    setBaseUrl(dto.base_url);
  }, [dto.enabled, dto.base_url]);

  // 保存成功后 "✓ 已保存" 闪一下（2.5s）让用户有明确反馈
  useEffect(() => {
    if (!savedFlash) return;
    const t = setTimeout(() => setSavedFlash(false), 2500);
    return () => clearTimeout(t);
  }, [savedFlash]);

  const save = async () => {
    setSaving(true);
    try {
      await providersSaveConfig({
        id: dto.id,
        enabled,
        api_key: keyInput, // "" = 后端保留原 key
        base_url: baseUrl,
      });
      setKeyInput("");
      setSavedFlash(true);
      onSaved();
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await providersTestConnection(dto.id);
      setTestResult({ ok: r.ok, msg: r.message });
    } catch (e) {
      setTestResult({ ok: false, msg: String(e) });
    } finally {
      setTesting(false);
    }
  };

  // 既没配过、当前也没输入新 key → 不让测
  const testDisabled = testing || (dto.key_source === "none" && !keyInput);

  return (
    <div className="rounded border border-[var(--c-border)] bg-[var(--c-bg-base)] p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="accent-[var(--c-text-dim)]"
            id={`enable-${dto.id}`}
          />
          <label
            htmlFor={`enable-${dto.id}`}
            className="text-sm text-[var(--c-text-base)]"
          >
            {dto.display_name}
          </label>
          {dto.key_source !== "none" && (
            <span className="rounded bg-[var(--c-bg-elev-2)] px-1.5 py-0.5 text-[10px] text-[var(--c-text-muted)]">
              {dto.key_source === "env" && t("providers.keySourceEnv")}
              {dto.key_source === "dotenv" && t("providers.keySourceDotenv")}
              {dto.key_source === "config" && t("providers.keySourceConfig")}
            </span>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <div>
          <div className="mb-1 text-[10px] text-[var(--c-text-dim)]">
            {t("providers.apiKeyLabel")}
            {dto.api_key_masked &&
              t("providers.apiKeyMaskedSuffix", { masked: dto.api_key_masked })}
          </div>
          <div className="flex gap-1">
            <input
              type={showKey ? "text" : "password"}
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder={dto.api_key_masked || "sk-..."}
              aria-label={t("providers.apiKeyInputAria", { name: dto.display_name })}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              className="flex-1 rounded border border-[var(--c-border-strong)] bg-[var(--c-bg-elev-1)] px-2 py-1 font-mono text-xs text-[var(--c-text-base)] focus:border-[var(--c-border-strong)] focus:outline-none"
            />
            <button
              type="button"
              onClick={() => setShowKey(!showKey)}
              className="rounded border border-[var(--c-border-strong)] px-2 text-xs text-[var(--c-text-muted)] hover:bg-[var(--c-bg-elev-2)]"
              title={showKey ? t("providers.hideKey") : t("providers.showKey")}
              aria-label={showKey ? t("providers.hideKeyAria") : t("providers.showKeyAria")}
            >
              {showKey ? t("providers.hideKey") : t("providers.showKey")}
            </button>
          </div>
        </div>

        <div>
          <div className="mb-1 text-[10px] text-[var(--c-text-dim)]">
            {t("providers.baseUrlLabelPrefix")}
            <code className="text-[var(--c-text-muted)]">{dto.default_base_url}</code>
            {t("providers.baseUrlLabelSuffix")}
          </div>
          <input
            type="text"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={dto.default_base_url}
            aria-label={t("providers.baseUrlInputAria", { name: dto.display_name })}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className="w-full rounded border border-[var(--c-border-strong)] bg-[var(--c-bg-elev-1)] px-2 py-1 font-mono text-xs text-[var(--c-text-base)] focus:border-[var(--c-border-strong)] focus:outline-none"
          />
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={save}
            disabled={!dirty || saving}
            className="rounded bg-[var(--c-bg-elev-3)] px-3 py-1 text-xs text-[var(--c-text-base)] hover:opacity-90 disabled:cursor-not-allowed disabled:bg-[var(--c-bg-elev-2)] disabled:text-[var(--c-text-faint)]"
          >
            {saving
              ? t("providers.saving")
              : dirty
                ? t("providers.save")
                : t("providers.alreadyUpToDate")}
          </button>
          <button
            type="button"
            onClick={test}
            disabled={testDisabled}
            className="rounded border border-[var(--c-border-strong)] px-3 py-1 text-xs text-[var(--c-text-muted)] hover:bg-[var(--c-bg-elev-2)] disabled:cursor-not-allowed disabled:text-[var(--c-text-faint)]"
          >
            {testing ? t("providers.testing") : t("providers.testConnection")}
          </button>
          {savedFlash && (
            <span
              role="status"
              aria-label={t("providers.savedFlashAria")}
              className="text-xs text-[var(--c-success-fg)]"
            >
              {t("providers.savedFlash")}
            </span>
          )}
          {testResult && !savedFlash && (
            <span
              role="status"
              className={
                "text-xs " +
                (testResult.ok ? "text-[var(--c-success-fg)]" : "text-[var(--c-error)]")
              }
            >
              {testResult.ok ? "✓" : "✗"} {testResult.msg}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
