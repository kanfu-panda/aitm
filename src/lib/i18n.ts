import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import en from "../locales/en.json";
import zhCN from "../locales/zh-CN.json";
import ja from "../locales/ja.json";

/**
 * v0.10.4 i18n：UI 多语言基础设施。
 *
 * 设计：
 * - **默认 en**（维护者 拍板，aitm 对外推广目标含国际开发者）
 * - 三资源静态 import 进 bundle（每个 ~3KB；不走 backend 加载省得多一次 IO）
 * - 持久化通过 `settings.ui.language` 走 settings store → 后端 toml；
 *   不用 i18next-browser-languagedetector（避免还要 mock localStorage）
 * - `runtime` 改语言：`i18n.changeLanguage(code)`，SettingsModal 切语言时调
 *   + `useSettingsStore.update({ ui: { language } })` 一并持久化
 * - app 启动时由 `App.tsx` settings init 后调 `i18n.changeLanguage(settings.ui.language)`
 *   把语言同步到当前的 store；i18next 自动 re-render 所有用 useTranslation 的组件
 *
 * 命名：locale code 用 BCP 47 标准（en / zh-CN / ja），后端 settings 透传不解析。
 *
 * Fallback：未知 / 不支持的 code → "en"。
 */

export const SUPPORTED_LANGUAGES = [
  { code: "en", label: "English" },
  { code: "zh-CN", label: "简体中文" },
  { code: "ja", label: "日本語" },
] as const;

export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number]["code"];

export function isSupportedLanguage(code: string): code is LanguageCode {
  return SUPPORTED_LANGUAGES.some((l) => l.code === code);
}

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    "zh-CN": { translation: zhCN },
    ja: { translation: ja },
  },
  lng: "en", // 初始；App.tsx 在 settings init 完后用 settings.ui.language 覆盖
  fallbackLng: "en",
  interpolation: {
    escapeValue: false, // React 已转义，i18next 不需要重复
  },
});

export default i18n;
