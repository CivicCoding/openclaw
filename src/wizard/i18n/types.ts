export type Locale = "en" | "zh-CN";

export type TranslationMap = { [key: string]: string | TranslationMap };

export interface I18nContext {
  locale: Locale;
  t: Record<string, unknown>;
}
