import { formatCliCommand } from "../cli/command-format.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { assertSupportedRuntime } from "../infra/runtime-guard.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { resolveUserPath } from "../utils.js";
import { isDeprecatedAuthChoice, normalizeLegacyOnboardAuthChoice } from "./auth-choice-legacy.js";
import { DEFAULT_WORKSPACE, handleReset } from "./onboard-helpers.js";
import { runInteractiveOnboarding } from "./onboard-interactive.js";
import { runNonInteractiveOnboarding } from "./onboard-non-interactive.js";
import type { OnboardOptions, ResetScope } from "./onboard-types.js";

const VALID_RESET_SCOPES = new Set<ResetScope>(["config", "config+creds+sessions", "full"]);

export async function onboardCommand(opts: OnboardOptions, runtime: RuntimeEnv = defaultRuntime) {
  assertSupportedRuntime(runtime);
  const originalAuthChoice = opts.authChoice;
  const normalizedAuthChoice = normalizeLegacyOnboardAuthChoice(originalAuthChoice);
  if (opts.nonInteractive && isDeprecatedAuthChoice(originalAuthChoice)) {
    runtime.error(
      [
        `认证选项 "${String(originalAuthChoice)}" 已弃用。`,
        '请使用 "--auth-choice token"（Anthropic setup-token）或 "--auth-choice openai-codex"。',
      ].join("\n"),
    );
    runtime.exit(1);
    return;
  }
  if (originalAuthChoice === "claude-cli") {
    runtime.log('认证选项 "claude-cli" 已弃用；将使用 setup-token 流程。');
  }
  if (originalAuthChoice === "codex-cli") {
    runtime.log('认证选项 "codex-cli" 已弃用；将使用 OpenAI Codex OAuth。');
  }
  const flow = opts.flow === "manual" ? ("advanced" as const) : opts.flow;
  const normalizedOpts =
    normalizedAuthChoice === opts.authChoice && flow === opts.flow
      ? opts
      : { ...opts, authChoice: normalizedAuthChoice, flow };
  if (
    normalizedOpts.secretInputMode &&
    normalizedOpts.secretInputMode !== "plaintext" &&
    normalizedOpts.secretInputMode !== "ref"
  ) {
    runtime.error('无效的 --secret-input-mode。请使用 "plaintext" 或 "ref"。');
    runtime.exit(1);
    return;
  }

  if (normalizedOpts.resetScope && !VALID_RESET_SCOPES.has(normalizedOpts.resetScope)) {
    runtime.error('无效的 --reset-scope。请使用 "config"、"config+creds+sessions" 或 "full"。');
    runtime.exit(1);
    return;
  }

  if (normalizedOpts.nonInteractive && normalizedOpts.acceptRisk !== true) {
    runtime.error(
      [
        "非交互式入门需要明确的风险确认。",
        "请阅读：https://docs.openclaw.ai/security",
        `重新运行命令：${formatCliCommand("openclaw onboard --non-interactive --accept-risk ...")}`,
      ].join("\n"),
    );
    runtime.exit(1);
    return;
  }

  if (normalizedOpts.reset) {
    const snapshot = await readConfigFileSnapshot();
    const baseConfig = snapshot.valid ? snapshot.config : {};
    const workspaceDefault =
      normalizedOpts.workspace ?? baseConfig.agents?.defaults?.workspace ?? DEFAULT_WORKSPACE;
    const resetScope: ResetScope = normalizedOpts.resetScope ?? "config+creds+sessions";
    await handleReset(resetScope, resolveUserPath(workspaceDefault), runtime);
  }

  if (process.platform === "win32") {
    runtime.log(
      [
        "检测到 Windows 系统 — OpenClaw 在 WSL2 上运行良好！",
        "原生 Windows 可能会有些棘手。",
        "快速设置：wsl --install（一条命令，一次重启）",
        "指南：https://docs.openclaw.ai/windows",
      ].join("\n"),
    );
  }

  if (normalizedOpts.nonInteractive) {
    await runNonInteractiveOnboarding(normalizedOpts, runtime);
    return;
  }

  await runInteractiveOnboarding(normalizedOpts, runtime);
}

export type { OnboardOptions } from "./onboard-types.js";
