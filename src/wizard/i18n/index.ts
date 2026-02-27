import { en } from "./locales/en.js";
import { zh_CN } from "./locales/zh-CN.js";
import type { I18nContext, Locale } from "./types.js";

const translations: Record<Locale, Record<string, unknown>> = { en, "zh-CN": zh_CN };
export function createI18nContext(locale: Locale = "en"): I18nContext {
  return { locale, t: translations[locale] ?? translations.en };
}

export function getSupportedLocales(): Locale[] {
  return Object.keys(translations) as Locale[];
}

function t(
  i18n: I18nContext | undefined,
  key: string,
  replacements?: Record<string, string>,
): string {
  if (!i18n?.t) {
    return key;
  }
  const keys = key.split(".");
  let value: unknown = i18n.t;
  for (const k of keys) {
    if (typeof value === "object" && value !== null && k in value) {
      value = (value as Record<string, unknown>)[k];
    } else {
      return key;
    }
  }
  let result = JSON.stringify(value ?? key);
  if (replacements) {
    for (const [placeholder, replacement] of Object.entries(replacements)) {
      result = result.replace(new RegExp(`\\{${placeholder}\\}`, "g"), replacement);
    }
  }
  return result;
}

export { type I18nContext, type Locale, t };
