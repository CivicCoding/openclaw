import {
  confirm as clackConfirm,
  intro as clackIntro,
  outro as clackOutro,
  select as clackSelect,
  text as clackText,
} from "@clack/prompts";
import { stylePromptHint, stylePromptMessage, stylePromptTitle } from "../terminal/prompt-style.js";

export const CONFIGURE_WIZARD_SECTIONS = [
  "workspace",
  "model",
  "web",
  "gateway",
  "daemon",
  "channels",
  "skills",
  "health",
] as const;

export type WizardSection = (typeof CONFIGURE_WIZARD_SECTIONS)[number];

export function parseConfigureWizardSections(raw: unknown): {
  sections: WizardSection[];
  invalid: string[];
} {
  const sectionsRaw: string[] = Array.isArray(raw)
    ? raw.map((value: unknown) => (typeof value === "string" ? value.trim() : "")).filter(Boolean)
    : [];
  if (sectionsRaw.length === 0) {
    return { sections: [], invalid: [] };
  }

  const invalid = sectionsRaw.filter((s) => !CONFIGURE_WIZARD_SECTIONS.includes(s as never));
  const sections = sectionsRaw.filter((s): s is WizardSection =>
    CONFIGURE_WIZARD_SECTIONS.includes(s as never),
  );
  return { sections, invalid };
}

export type ChannelsWizardMode = "configure" | "remove";

export type ConfigureWizardParams = {
  command: "configure" | "update";
  sections?: WizardSection[];
};

export const CONFIGURE_SECTION_OPTIONS: Array<{
  value: WizardSection;
  label: string;
  hint: string;
}> = [
  { value: "workspace", label: "工作空间", hint: "设置工作空间和会话目录" },
  { value: "model", label: "模型", hint: "选择供应商和凭证" },
  { value: "web", label: "网页工具", hint: "配置 Brave 搜索和网页获取" },
  { value: "gateway", label: "网关", hint: "配置端口、绑定地址、认证和 Tailscale" },
  {
    value: "daemon",
    label: "后台服务",
    hint: "安装/管理后台服务",
  },
  {
    value: "channels",
    label: "频道",
    hint: "链接 WhatsApp/Telegram 等和默认设置",
  },
  { value: "skills", label: "技能", hint: "安装/启用工作空间技能" },
  {
    value: "health",
    label: "健康检查",
    hint: "运行网关和频道检查",
  },
];

export const intro = (message: string) => clackIntro(stylePromptTitle(message) ?? message);
export const outro = (message: string) => clackOutro(stylePromptTitle(message) ?? message);
export const text = (params: Parameters<typeof clackText>[0]) =>
  clackText({
    ...params,
    message: stylePromptMessage(params.message),
  });
export const confirm = (params: Parameters<typeof clackConfirm>[0]) =>
  clackConfirm({
    ...params,
    message: stylePromptMessage(params.message),
  });
export const select = <T>(params: Parameters<typeof clackSelect<T>>[0]) =>
  clackSelect({
    ...params,
    message: stylePromptMessage(params.message),
    options: params.options.map((opt) =>
      opt.hint === undefined ? opt : { ...opt, hint: stylePromptHint(opt.hint) },
    ),
  });
