import { en } from "./locales/en.js";
import { zh_CN } from "./locales/zh-CN.js";
import type { I18nContext, Locale, OnboardingTranslations } from "./types.js";

const translations: Record<Locale, OnboardingTranslations> = {
  en,
  "zh-CN": zh_CN,
};

export function createI18nContext(locale: Locale = "en"): I18nContext {
  return {
    locale,
    t: translations[locale] ?? translations.en,
  };
}

export function getSupportedLocales(): Locale[] {
  return Object.keys(translations) as Locale[];
}

export { type I18nContext, type Locale, type OnboardingTranslations };
