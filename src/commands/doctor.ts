import fs from "node:fs";
import { intro as clackIntro, outro as clackOutro } from "@clack/prompts";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import {
  getModelRefStatus,
  resolveConfiguredModelRef,
  resolveHooksGmailModel,
} from "../agents/model-selection.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/config.js";
import { CONFIG_PATH, readConfigFileSnapshot, writeConfigFile } from "../config/config.js";
import { logConfigUpdated } from "../config/logging.js";
import { resolveGatewayService } from "../daemon/service.js";
import { resolveGatewayAuth } from "../gateway/auth.js";
import { buildGatewayConnectionDetails } from "../gateway/call.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { note } from "../terminal/note.js";
import { stylePromptTitle } from "../terminal/prompt-style.js";
import { shortenHomePath } from "../utils.js";
import {
  maybeRemoveDeprecatedCliAuthProfiles,
  maybeRepairAnthropicOAuthProfileId,
  noteAuthProfileHealth,
} from "./doctor-auth.js";
import { noteBootstrapFileSize } from "./doctor-bootstrap-size.js";
import { doctorShellCompletion } from "./doctor-completion.js";
import { loadAndMaybeMigrateDoctorConfig } from "./doctor-config-flow.js";
import { maybeRepairGatewayDaemon } from "./doctor-gateway-daemon-flow.js";
import { checkGatewayHealth, probeGatewayMemoryStatus } from "./doctor-gateway-health.js";
import {
  maybeRepairGatewayServiceConfig,
  maybeScanExtraGatewayServices,
} from "./doctor-gateway-services.js";
import { noteSourceInstallIssues } from "./doctor-install.js";
import { noteMemorySearchHealth } from "./doctor-memory-search.js";
import {
  noteMacLaunchAgentOverrides,
  noteMacLaunchctlGatewayEnvOverrides,
  noteDeprecatedLegacyEnvVars,
  noteStartupOptimizationHints,
} from "./doctor-platform-notes.js";
import { createDoctorPrompter, type DoctorOptions } from "./doctor-prompter.js";
import { maybeRepairSandboxImages, noteSandboxScopeWarnings } from "./doctor-sandbox.js";
import { noteSecurityWarnings } from "./doctor-security.js";
import { noteSessionLockHealth } from "./doctor-session-locks.js";
import { noteStateIntegrity, noteWorkspaceBackupTip } from "./doctor-state-integrity.js";
import {
  detectLegacyStateMigrations,
  runLegacyStateMigrations,
} from "./doctor-state-migrations.js";
import { maybeRepairUiProtocolFreshness } from "./doctor-ui.js";
import { maybeOfferUpdateBeforeDoctor } from "./doctor-update.js";
import { noteWorkspaceStatus } from "./doctor-workspace-status.js";
import { MEMORY_SYSTEM_PROMPT, shouldSuggestMemorySystem } from "./doctor-workspace.js";
import { noteOpenAIOAuthTlsPrerequisites } from "./oauth-tls-preflight.js";
import { applyWizardMetadata, printWizardHeader, randomToken } from "./onboard-helpers.js";
import { ensureSystemdUserLingerInteractive } from "./systemd-linger.js";

const intro = (message: string) => clackIntro(stylePromptTitle(message) ?? message);
const outro = (message: string) => clackOutro(stylePromptTitle(message) ?? message);

function resolveMode(cfg: OpenClawConfig): "local" | "remote" {
  return cfg.gateway?.mode === "remote" ? "remote" : "local";
}

export async function doctorCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: DoctorOptions = {},
) {
  const prompter = createDoctorPrompter({ runtime, options });
  printWizardHeader(runtime);
  intro("OpenClaw 诊断");

  const root = await resolveOpenClawPackageRoot({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });

  const updateResult = await maybeOfferUpdateBeforeDoctor({
    runtime,
    options,
    root,
    confirm: (p) => prompter.confirm(p),
    outro,
  });
  if (updateResult.handled) {
    return;
  }

  await maybeRepairUiProtocolFreshness(runtime, prompter);
  noteSourceInstallIssues(root);
  noteDeprecatedLegacyEnvVars();
  noteStartupOptimizationHints();

  const configResult = await loadAndMaybeMigrateDoctorConfig({
    options,
    confirm: (p) => prompter.confirm(p),
  });
  let cfg: OpenClawConfig = configResult.cfg;
  const cfgForPersistence = structuredClone(cfg);
  const sourceConfigValid = configResult.sourceConfigValid ?? true;

  const configPath = configResult.path ?? CONFIG_PATH;
  if (!cfg.gateway?.mode) {
    const lines = [
      "gateway.mode 未设置；网关启动将被阻止。",
      `修复：运行 ${formatCliCommand("openclaw configure")} 并设置网关模式（local/remote）。`,
      `或直接设置：${formatCliCommand("openclaw config set gateway.mode local")}`,
    ];
    if (!fs.existsSync(configPath)) {
      lines.push(`缺少配置文件：请先运行 ${formatCliCommand("openclaw setup")}。`);
    }
    note(lines.join("\n"), "网关");
  }

  cfg = await maybeRepairAnthropicOAuthProfileId(cfg, prompter);
  cfg = await maybeRemoveDeprecatedCliAuthProfiles(cfg, prompter);
  await noteAuthProfileHealth({
    cfg,
    prompter,
    allowKeychainPrompt: options.nonInteractive !== true && Boolean(process.stdin.isTTY),
  });
  const gatewayDetails = buildGatewayConnectionDetails({ config: cfg });
  if (gatewayDetails.remoteFallbackNote) {
    note(gatewayDetails.remoteFallbackNote, "网关");
  }
  if (resolveMode(cfg) === "local" && sourceConfigValid) {
    const auth = resolveGatewayAuth({
      authConfig: cfg.gateway?.auth,
      tailscaleMode: cfg.gateway?.tailscale?.mode ?? "off",
    });
    const needsToken = auth.mode !== "password" && (auth.mode !== "token" || !auth.token);
    if (needsToken) {
      note("网关认证已关闭或缺少令牌。现在推荐使用令牌认证作为默认方式（包括回环）。", "网关认证");
      const shouldSetToken =
        options.generateGatewayToken === true
          ? true
          : options.nonInteractive === true
            ? false
            : await prompter.confirmRepair({
                message: "现在生成并配置网关令牌？",
                initialValue: true,
              });
      if (shouldSetToken) {
        const nextToken = randomToken();
        cfg = {
          ...cfg,
          gateway: {
            ...cfg.gateway,
            auth: {
              ...cfg.gateway?.auth,
              mode: "token",
              token: nextToken,
            },
          },
        };
        note("网关令牌已配置。", "网关认证");
      }
    }
  }

  const legacyState = await detectLegacyStateMigrations({ cfg });
  if (legacyState.preview.length > 0) {
    note(legacyState.preview.join("\n"), "检测到旧状态");
    const migrate =
      options.nonInteractive === true
        ? true
        : await prompter.confirm({
            message: "现在迁移旧状态（会话/代理/WhatsApp 认证）？",
            initialValue: true,
          });
    if (migrate) {
      const migrated = await runLegacyStateMigrations({
        detected: legacyState,
      });
      if (migrated.changes.length > 0) {
        note(migrated.changes.join("\n"), "诊断更改");
      }
      if (migrated.warnings.length > 0) {
        note(migrated.warnings.join("\n"), "诊断警告");
      }
    }
  }

  await noteStateIntegrity(cfg, prompter, configResult.path ?? CONFIG_PATH);
  await noteSessionLockHealth({ shouldRepair: prompter.shouldRepair });

  cfg = await maybeRepairSandboxImages(cfg, runtime, prompter);
  noteSandboxScopeWarnings(cfg);

  await maybeScanExtraGatewayServices(options, runtime, prompter);
  await maybeRepairGatewayServiceConfig(cfg, resolveMode(cfg), runtime, prompter);
  await noteMacLaunchAgentOverrides();
  await noteMacLaunchctlGatewayEnvOverrides(cfg);

  await noteSecurityWarnings(cfg);
  await noteOpenAIOAuthTlsPrerequisites({
    cfg,
    deep: options.deep === true,
  });

  if (cfg.hooks?.gmail?.model?.trim()) {
    const hooksModelRef = resolveHooksGmailModel({
      cfg,
      defaultProvider: DEFAULT_PROVIDER,
    });
    if (!hooksModelRef) {
      note(`- hooks.gmail.model "${cfg.hooks.gmail.model}" could not be resolved`, "Hooks");
    } else {
      const { provider: defaultProvider, model: defaultModel } = resolveConfiguredModelRef({
        cfg,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
      });
      const catalog = await loadModelCatalog({ config: cfg });
      const status = getModelRefStatus({
        cfg,
        catalog,
        ref: hooksModelRef,
        defaultProvider,
        defaultModel,
      });
      const warnings: string[] = [];
      if (!status.allowed) {
        warnings.push(
          `- hooks.gmail.model "${status.key}" 不在 agents.defaults.models 白名单中（将使用主模型代替）`,
        );
      }
      if (!status.inCatalog) {
        warnings.push(`- hooks.gmail.model "${status.key}" 不在模型目录中（运行时可能失败）`);
      }
      if (warnings.length > 0) {
        note(warnings.join("\n"), "钩子");
      }
    }
  }

  if (
    options.nonInteractive !== true &&
    process.platform === "linux" &&
    resolveMode(cfg) === "local"
  ) {
    const service = resolveGatewayService();
    let loaded = false;
    try {
      loaded = await service.isLoaded({ env: process.env });
    } catch {
      loaded = false;
    }
    if (loaded) {
      await ensureSystemdUserLingerInteractive({
        runtime,
        prompter: {
          confirm: async (p) => prompter.confirm(p),
          note,
        },
        reason:
          "网关作为 systemd 用户服务运行。如果没有持久化设置，systemd 会在注销/空闲时停止用户会话并终止网关。",
        requireConfirm: true,
      });
    }
  }

  noteWorkspaceStatus(cfg);
  await noteBootstrapFileSize(cfg);

  // Check and fix shell completion
  await doctorShellCompletion(runtime, prompter, {
    nonInteractive: options.nonInteractive,
  });

  const { healthOk } = await checkGatewayHealth({
    runtime,
    cfg,
    timeoutMs: options.nonInteractive === true ? 3000 : 10_000,
  });
  const gatewayMemoryProbe = healthOk
    ? await probeGatewayMemoryStatus({
        cfg,
        timeoutMs: options.nonInteractive === true ? 3000 : 10_000,
      })
    : { checked: false, ready: false };
  await noteMemorySearchHealth(cfg, { gatewayMemoryProbe });
  await maybeRepairGatewayDaemon({
    cfg,
    runtime,
    prompter,
    options,
    gatewayDetailsMessage: gatewayDetails.message,
    healthOk,
  });

  const shouldWriteConfig =
    configResult.shouldWriteConfig || JSON.stringify(cfg) !== JSON.stringify(cfgForPersistence);
  if (shouldWriteConfig) {
    cfg = applyWizardMetadata(cfg, { command: "doctor", mode: resolveMode(cfg) });
    await writeConfigFile(cfg);
    logConfigUpdated(runtime);
    const backupPath = `${CONFIG_PATH}.bak`;
    if (fs.existsSync(backupPath)) {
      runtime.log(`Backup: ${shortenHomePath(backupPath)}`);
    }
  } else if (!prompter.shouldRepair) {
    runtime.log(`运行 "${formatCliCommand("openclaw doctor --fix")}" 以应用更改。`);
  }

  if (options.workspaceSuggestions !== false) {
    const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
    noteWorkspaceBackupTip(workspaceDir);
    if (await shouldSuggestMemorySystem(workspaceDir)) {
      note(MEMORY_SYSTEM_PROMPT, "工作空间");
    }
  }

  const finalSnapshot = await readConfigFileSnapshot();
  if (finalSnapshot.exists && !finalSnapshot.valid) {
    runtime.error("无效的配置：");
    for (const issue of finalSnapshot.issues) {
      const path = issue.path || "<root>";
      runtime.error(`- ${path}: ${issue.message}`);
    }
  }

  outro("诊断完成。");
}
