import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/config.js";
import { buildWorkspaceHookStatus } from "../hooks/hooks-status.js";
import type { RuntimeEnv } from "../runtime.js";
import { createI18nContext, type I18nContext } from "../wizard/i18n/index.js";
import type { WizardPrompter } from "../wizard/prompts.js";

export async function setupInternalHooks(
  cfg: OpenClawConfig,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
  i18n?: I18nContext,
): Promise<OpenClawConfig> {
  // Get i18n context, defaulting to English if not provided
  const t = i18n?.t.hooks ?? createI18nContext("en").t.hooks;

  await prompter.note(t.intro.join("\n"), t.header);

  // Discover available hooks using the hook discovery system
  const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
  const report = buildWorkspaceHookStatus(workspaceDir, { config: cfg });

  // Show every eligible hook so users can opt in during onboarding.
  const eligibleHooks = report.hooks.filter((h) => h.eligible);

  if (eligibleHooks.length === 0) {
    await prompter.note(t.noHooksAvailable.message, t.noHooksAvailable.title);
    return cfg;
  }

  const toEnable = await prompter.multiselect({
    message: t.enableHooks,
    options: [
      { value: "__skip__", label: t.skipForNow },
      ...eligibleHooks.map((hook) => ({
        value: hook.name,
        label: `${hook.emoji ?? "🔗"} ${hook.name}`,
        hint: hook.description,
      })),
    ],
  });

  const selected = toEnable.filter((name) => name !== "__skip__");
  if (selected.length === 0) {
    return cfg;
  }

  // Enable selected hooks using the new entries config format
  const entries = { ...cfg.hooks?.internal?.entries };
  for (const name of selected) {
    entries[name] = { enabled: true };
  }

  const next: OpenClawConfig = {
    ...cfg,
    hooks: {
      ...cfg.hooks,
      internal: {
        enabled: true,
        entries,
      },
    },
  };

  const hooksWord = selected.length > 1 ? t.configured.hooks : t.configured.hooks;
  await prompter.note(
    [
      `${t.configured.enabled} ${selected.length} ${hooksWord}: ${selected.join(", ")}`,
      "",
      t.configured.manageHooks,
      `  ${formatCliCommand(t.configured.list)}`,
      `  ${formatCliCommand(t.configured.enable)}`,
      `  ${formatCliCommand(t.configured.disable)}`,
    ].join("\n"),
    t.configured.title,
  );

  return next;
}
