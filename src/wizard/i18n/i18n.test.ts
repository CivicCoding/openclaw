import { describe, it, expect } from "vitest";
import { createI18nContext, getSupportedLocales } from "./index.js";

describe("i18n", () => {
  it("should support en and zh-CN locales", () => {
    const locales = getSupportedLocales();
    expect(locales).toContain("en");
    expect(locales).toContain("zh-CN");
  });

  it("should create i18n context with English locale", () => {
    const i18n = createI18nContext("en");
    expect(i18n.locale).toBe("en");
    expect(i18n.t.wizard.intro).toBe("OpenClaw onboarding");
    expect(i18n.t.security.header).toBe("Security");
  });

  it("should create i18n context with Chinese locale", () => {
    const i18n = createI18nContext("zh-CN");
    expect(i18n.locale).toBe("zh-CN");
    expect(i18n.t.wizard.intro).toBe("OpenClaw 引导配置");
    expect(i18n.t.security.header).toBe("安全");
  });

  it("should fallback to English for invalid locale", () => {
    // @ts-expect-error Testing invalid locale
    const i18n = createI18nContext("invalid");
    expect(i18n.locale).toBe("invalid");
    expect(i18n.t.wizard.intro).toBe("OpenClaw onboarding");
  });

  it("should have all required translation keys for English", () => {
    const i18n = createI18nContext("en");
    expect(i18n.t.security).toBeDefined();
    expect(i18n.t.wizard).toBeDefined();
    expect(i18n.t.flow).toBeDefined();
    expect(i18n.t.config).toBeDefined();
    expect(i18n.t.gateway).toBeDefined();
    expect(i18n.t.workspace).toBeDefined();
    expect(i18n.t.channels).toBeDefined();
    expect(i18n.t.skills).toBeDefined();
    expect(i18n.t.common).toBeDefined();
    expect(i18n.t.language).toBeDefined();
  });

  it("should have all required translation keys for Chinese", () => {
    const i18n = createI18nContext("zh-CN");
    expect(i18n.t.security).toBeDefined();
    expect(i18n.t.wizard).toBeDefined();
    expect(i18n.t.flow).toBeDefined();
    expect(i18n.t.config).toBeDefined();
    expect(i18n.t.gateway).toBeDefined();
    expect(i18n.t.workspace).toBeDefined();
    expect(i18n.t.channels).toBeDefined();
    expect(i18n.t.skills).toBeDefined();
    expect(i18n.t.common).toBeDefined();
    expect(i18n.t.language).toBeDefined();
  });

  it("should have matching structure between English and Chinese translations", () => {
    const enCtx = createI18nContext("en");
    const zhCtx = createI18nContext("zh-CN");

    const enKeys = JSON.stringify(getKeys(enCtx.t));
    const zhKeys = JSON.stringify(getKeys(zhCtx.t));

    expect(enKeys).toBe(zhKeys);
  });
});

// Helper function to get all keys from an object recursively
function getKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  const keys: string[] = [];
  for (const key in obj) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof obj[key] === "object" && !Array.isArray(obj[key])) {
      keys.push(...getKeys(obj[key], fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys.toSorted();
}
