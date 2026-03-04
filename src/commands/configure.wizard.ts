import fsPromises from "node:fs/promises";
import nodePath from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/config.js";
import { readConfigFileSnapshot, resolveGatewayPort, writeConfigFile } from "../config/config.js";
import { logConfigUpdated } from "../config/logging.js";
import { normalizeSecretInputString } from "../config/types.secrets.js";
import { ensureControlUiAssetsBuilt } from "../infra/control-ui-assets.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { note } from "../terminal/note.js";
import { resolveUserPath } from "../utils.js";
import { createClackPrompter } from "../wizard/clack-prompter.js";
import { WizardCancelledError } from "../wizard/prompts.js";
import { removeChannelConfigWizard } from "./configure.channels.js";
import { maybeInstallDaemon } from "./configure.daemon.js";
import { promptAuthConfig } from "./configure.gateway-auth.js";
import { promptGatewayConfig } from "./configure.gateway.js";
import type {
  ChannelsWizardMode,
  ConfigureWizardParams,
  WizardSection,
} from "./configure.shared.js";
import {
  CONFIGURE_SECTION_OPTIONS,
  confirm,
  intro,
  outro,
  select,
  text,
} from "./configure.shared.js";
import { formatHealthCheckFailure } from "./health-format.js";
import { healthCommand } from "./health.js";
import { noteChannelStatus, setupChannels } from "./onboard-channels.js";
import {
  applyWizardMetadata,
  DEFAULT_WORKSPACE,
  ensureWorkspaceAndSessions,
  guardCancel,
  printWizardHeader,
  probeGatewayReachable,
  resolveControlUiLinks,
  summarizeExistingConfig,
  waitForGatewayReachable,
} from "./onboard-helpers.js";
import { promptRemoteGatewayConfig } from "./onboard-remote.js";
import { setupSkills } from "./onboard-skills.js";

type ConfigureSectionChoice = WizardSection | "__continue";

async function runGatewayHealthCheck(params: {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  port: number;
}): Promise<void> {
  const localLinks = resolveControlUiLinks({
    bind: params.cfg.gateway?.bind ?? "loopback",
    port: params.port,
    customBindHost: params.cfg.gateway?.customBindHost,
    basePath: undefined,
  });
  const remoteUrl = params.cfg.gateway?.remote?.url?.trim();
  const wsUrl = params.cfg.gateway?.mode === "remote" && remoteUrl ? remoteUrl : localLinks.wsUrl;
  const token = params.cfg.gateway?.auth?.token ?? process.env.OPENCLAW_GATEWAY_TOKEN;
  const password =
    normalizeSecretInputString(params.cfg.gateway?.auth?.password) ??
    process.env.OPENCLAW_GATEWAY_PASSWORD;

  await waitForGatewayReachable({
    url: wsUrl,
    token,
    password,
    deadlineMs: 15_000,
  });

  try {
    await healthCommand({ json: false, timeoutMs: 10_000 }, params.runtime);
  } catch (err) {
    params.runtime.error(formatHealthCheckFailure(err));
    note(
      [
        "文档：",
        "https://docs.openclaw.ai/gateway/health",
        "https://docs.openclaw.ai/gateway/troubleshooting",
      ].join("\n"),
      "健康检查帮助",
    );
  }
}

async function promptConfigureSection(
  runtime: RuntimeEnv,
  hasSelection: boolean,
): Promise<ConfigureSectionChoice> {
  return guardCancel(
    await select<ConfigureSectionChoice>({
      message: "选择要配置的部分",
      options: [
        ...CONFIGURE_SECTION_OPTIONS,
        {
          value: "__continue",
          label: "继续",
          hint: hasSelection ? "完成" : "暂时跳过",
        },
      ],
      initialValue: CONFIGURE_SECTION_OPTIONS[0]?.value,
    }),
    runtime,
  );
}

async function promptChannelMode(runtime: RuntimeEnv): Promise<ChannelsWizardMode> {
  return guardCancel(
    await select({
      message: "频道",
      options: [
        {
          value: "configure",
          label: "配置/链接",
          hint: "添加/更新频道；禁用未选择的账户",
        },
        {
          value: "remove",
          label: "删除频道配置",
          hint: "从 openclaw.json 删除频道令牌/设置",
        },
      ],
      initialValue: "configure",
    }),
    runtime,
  ) as ChannelsWizardMode;
}

async function promptWebToolsConfig(
  nextConfig: OpenClawConfig,
  runtime: RuntimeEnv,
): Promise<OpenClawConfig> {
  const existingSearch = nextConfig.tools?.web?.search;
  const existingFetch = nextConfig.tools?.web?.fetch;
  const hasSearchKey = Boolean(existingSearch?.apiKey);

  note(
    [
      "Web search lets your agent look things up online using the `web_search` tool.",
      "It requires a Brave Search API key (you can store it in the config or set BRAVE_API_KEY in the Gateway environment).",
      "Docs: https://docs.openclaw.ai/tools/web",
    ].join("\n"),
    "Web search",
  );

  const enableSearch = guardCancel(
    await confirm({
      message: "Enable web_search (Brave Search)?",
      initialValue: existingSearch?.enabled ?? hasSearchKey,
    }),
    runtime,
  );

  let nextSearch = {
    ...existingSearch,
    enabled: enableSearch,
  };

  if (enableSearch) {
    const keyInput = guardCancel(
      await text({
        message: hasSearchKey
          ? "Brave Search API key (leave blank to keep current or use BRAVE_API_KEY)"
          : "Brave Search API key (paste it here; leave blank to use BRAVE_API_KEY)",
        placeholder: hasSearchKey ? "Leave blank to keep current" : "BSA...",
      }),
      runtime,
    );
    const key = String(keyInput ?? "").trim();
    if (key) {
      nextSearch = { ...nextSearch, apiKey: key };
    } else if (!hasSearchKey) {
      note(
        [
          "No key stored yet, so web_search will stay unavailable.",
          "Store a key here or set BRAVE_API_KEY in the Gateway environment.",
          "Docs: https://docs.openclaw.ai/tools/web",
        ].join("\n"),
        "Web search",
      );
    }
  }

  const enableFetch = guardCancel(
    await confirm({
      message: "Enable web_fetch (keyless HTTP fetch)?",
      initialValue: existingFetch?.enabled ?? true,
    }),
    runtime,
  );

  const nextFetch = {
    ...existingFetch,
    enabled: enableFetch,
  };

  return {
    ...nextConfig,
    tools: {
      ...nextConfig.tools,
      web: {
        ...nextConfig.tools?.web,
        search: nextSearch,
        fetch: nextFetch,
      },
    },
  };
}

export async function runConfigureWizard(
  opts: ConfigureWizardParams,
  runtime: RuntimeEnv = defaultRuntime,
) {
  try {
    printWizardHeader(runtime);
    intro(opts.command === "update" ? "OpenClaw 更新向导" : "OpenClaw 配置");
    const prompter = createClackPrompter();

    const snapshot = await readConfigFileSnapshot();
    const baseConfig: OpenClawConfig = snapshot.valid ? snapshot.config : {};

    if (snapshot.exists) {
      const title = snapshot.valid ? "Existing config detected" : "Invalid config";
      note(summarizeExistingConfig(baseConfig), title);
      if (!snapshot.valid && snapshot.issues.length > 0) {
        note(
          [
            ...snapshot.issues.map((iss) => `- ${iss.path}: ${iss.message}`),
            "",
            "Docs: https://docs.openclaw.ai/gateway/configuration",
          ].join("\n"),
          "Config issues",
        );
      }
      if (!snapshot.valid) {
        outro(
          `Config invalid. Run \`${formatCliCommand("openclaw doctor")}\` to repair it, then re-run configure.`,
        );
        runtime.exit(1);
        return;
      }
    }

    const localUrl = "ws://127.0.0.1:18789";
    const localProbe = await probeGatewayReachable({
      url: localUrl,
      token: baseConfig.gateway?.auth?.token ?? process.env.OPENCLAW_GATEWAY_TOKEN,
      password:
        normalizeSecretInputString(baseConfig.gateway?.auth?.password) ??
        process.env.OPENCLAW_GATEWAY_PASSWORD,
    });
    const remoteUrl = baseConfig.gateway?.remote?.url?.trim() ?? "";
    const remoteProbe = remoteUrl
      ? await probeGatewayReachable({
          url: remoteUrl,
          token: normalizeSecretInputString(baseConfig.gateway?.remote?.token),
        })
      : null;

    const mode = guardCancel(
      await select({
        message: "网关将在哪里运行？",
        options: [
          {
            value: "local",
            label: "本地（此机器）",
            hint: localProbe.ok ? `网关可访问 (${localUrl})` : `未检测到网关 (${localUrl})`,
          },
          {
            value: "remote",
            label: "远程（仅信息）",
            hint: !remoteUrl
              ? "尚未配置远程 URL"
              : remoteProbe?.ok
                ? `网关可访问 (${remoteUrl})`
                : `已配置但无法访问 (${remoteUrl})`,
          },
        ],
      }),
      runtime,
    );

    if (mode === "remote") {
      let remoteConfig = await promptRemoteGatewayConfig(baseConfig, prompter);
      remoteConfig = applyWizardMetadata(remoteConfig, {
        command: opts.command,
        mode,
      });
      await writeConfigFile(remoteConfig);
      logConfigUpdated(runtime);
      outro("远程网关已配置。");
      return;
    }

    let nextConfig = { ...baseConfig };
    let didSetGatewayMode = false;
    if (nextConfig.gateway?.mode !== "local") {
      nextConfig = {
        ...nextConfig,
        gateway: {
          ...nextConfig.gateway,
          mode: "local",
        },
      };
      didSetGatewayMode = true;
    }
    let workspaceDir =
      nextConfig.agents?.defaults?.workspace ??
      baseConfig.agents?.defaults?.workspace ??
      DEFAULT_WORKSPACE;
    let gatewayPort = resolveGatewayPort(baseConfig);
    let gatewayToken: string | undefined =
      normalizeSecretInputString(nextConfig.gateway?.auth?.token) ??
      normalizeSecretInputString(baseConfig.gateway?.auth?.token) ??
      process.env.OPENCLAW_GATEWAY_TOKEN;

    const persistConfig = async () => {
      nextConfig = applyWizardMetadata(nextConfig, {
        command: opts.command,
        mode,
      });
      await writeConfigFile(nextConfig);
      logConfigUpdated(runtime);
    };

    const configureWorkspace = async () => {
      const workspaceInput = guardCancel(
        await text({
          message: "工作空间目录",
          initialValue: workspaceDir,
        }),
        runtime,
      );
      workspaceDir = resolveUserPath(String(workspaceInput ?? "").trim() || DEFAULT_WORKSPACE);
      if (!snapshot.exists) {
        const indicators = ["MEMORY.md", "memory", ".git"].map((name) =>
          nodePath.join(workspaceDir, name),
        );
        const hasExistingContent = (
          await Promise.all(
            indicators.map(async (candidate) => {
              try {
                await fsPromises.access(candidate);
                return true;
              } catch {
                return false;
              }
            }),
          )
        ).some(Boolean);
        if (hasExistingContent) {
          note(
            [
              `在 ${workspaceDir} 检测到现有工作空间`,
              "现有文件将被保留。缺失的模板可能会被创建，但永不会被覆盖。",
            ].join("\n"),
            "现有工作空间",
          );
        }
      }
      nextConfig = {
        ...nextConfig,
        agents: {
          ...nextConfig.agents,
          defaults: {
            ...nextConfig.agents?.defaults,
            workspace: workspaceDir,
          },
        },
      };
      await ensureWorkspaceAndSessions(workspaceDir, runtime);
    };

    const configureChannelsSection = async () => {
      await noteChannelStatus({ cfg: nextConfig, prompter });
      const channelMode = await promptChannelMode(runtime);
      if (channelMode === "configure") {
        nextConfig = await setupChannels(nextConfig, runtime, prompter, {
          allowDisable: true,
          allowSignalInstall: true,
          skipConfirm: true,
          skipStatusNote: true,
        });
      } else {
        nextConfig = await removeChannelConfigWizard(nextConfig, runtime);
      }
    };

    const promptDaemonPort = async () => {
      const portInput = guardCancel(
        await text({
          message: "服务安装的网关端口",
          initialValue: String(gatewayPort),
          validate: (value) => (Number.isFinite(Number(value)) ? undefined : "无效端口"),
        }),
        runtime,
      );
      gatewayPort = Number.parseInt(String(portInput), 10);
    };

    if (opts.sections) {
      const selected = opts.sections;
      if (!selected || selected.length === 0) {
        outro("未选择任何更改。");
        return;
      }

      if (selected.includes("workspace")) {
        await configureWorkspace();
      }

      if (selected.includes("model")) {
        nextConfig = await promptAuthConfig(nextConfig, runtime, prompter);
      }

      if (selected.includes("web")) {
        nextConfig = await promptWebToolsConfig(nextConfig, runtime);
      }

      if (selected.includes("gateway")) {
        const gateway = await promptGatewayConfig(nextConfig, runtime);
        nextConfig = gateway.config;
        gatewayPort = gateway.port;
        gatewayToken = gateway.token;
      }

      if (selected.includes("channels")) {
        await configureChannelsSection();
      }

      if (selected.includes("skills")) {
        const wsDir = resolveUserPath(workspaceDir);
        nextConfig = await setupSkills(nextConfig, wsDir, runtime, prompter);
      }

      await persistConfig();

      if (selected.includes("daemon")) {
        if (!selected.includes("gateway")) {
          await promptDaemonPort();
        }

        await maybeInstallDaemon({ runtime, port: gatewayPort, gatewayToken });
      }

      if (selected.includes("health")) {
        await runGatewayHealthCheck({ cfg: nextConfig, runtime, port: gatewayPort });
      }
    } else {
      let ranSection = false;
      let didConfigureGateway = false;

      while (true) {
        const choice = await promptConfigureSection(runtime, ranSection);
        if (choice === "__continue") {
          break;
        }
        ranSection = true;

        if (choice === "workspace") {
          await configureWorkspace();
          await persistConfig();
        }

        if (choice === "model") {
          nextConfig = await promptAuthConfig(nextConfig, runtime, prompter);
          await persistConfig();
        }

        if (choice === "web") {
          nextConfig = await promptWebToolsConfig(nextConfig, runtime);
          await persistConfig();
        }

        if (choice === "gateway") {
          const gateway = await promptGatewayConfig(nextConfig, runtime);
          nextConfig = gateway.config;
          gatewayPort = gateway.port;
          gatewayToken = gateway.token;
          didConfigureGateway = true;
          await persistConfig();
        }

        if (choice === "channels") {
          await configureChannelsSection();
          await persistConfig();
        }

        if (choice === "skills") {
          const wsDir = resolveUserPath(workspaceDir);
          nextConfig = await setupSkills(nextConfig, wsDir, runtime, prompter);
          await persistConfig();
        }

        if (choice === "daemon") {
          if (!didConfigureGateway) {
            await promptDaemonPort();
          }
          await maybeInstallDaemon({
            runtime,
            port: gatewayPort,
            gatewayToken,
          });
        }

        if (choice === "health") {
          await runGatewayHealthCheck({ cfg: nextConfig, runtime, port: gatewayPort });
        }
      }

      if (!ranSection) {
        if (didSetGatewayMode) {
          await persistConfig();
          outro("网关模式已设置为本地。");
          return;
        }
        outro("未选择任何更改。");
        return;
      }
    }

    const controlUiAssets = await ensureControlUiAssetsBuilt(runtime);
    if (!controlUiAssets.ok && controlUiAssets.message) {
      runtime.error(controlUiAssets.message);
    }

    const bind = nextConfig.gateway?.bind ?? "loopback";
    const links = resolveControlUiLinks({
      bind,
      port: gatewayPort,
      customBindHost: nextConfig.gateway?.customBindHost,
      basePath: nextConfig.gateway?.controlUi?.basePath,
    });
    // Try both new and old passwords since gateway may still have old config.
    const newPassword =
      normalizeSecretInputString(nextConfig.gateway?.auth?.password) ??
      process.env.OPENCLAW_GATEWAY_PASSWORD;
    const oldPassword =
      normalizeSecretInputString(baseConfig.gateway?.auth?.password) ??
      process.env.OPENCLAW_GATEWAY_PASSWORD;
    const token = nextConfig.gateway?.auth?.token ?? process.env.OPENCLAW_GATEWAY_TOKEN;

    let gatewayProbe = await probeGatewayReachable({
      url: links.wsUrl,
      token,
      password: newPassword,
    });
    // If new password failed and it's different from old password, try old too.
    if (!gatewayProbe.ok && newPassword !== oldPassword && oldPassword) {
      gatewayProbe = await probeGatewayReachable({
        url: links.wsUrl,
        token,
        password: oldPassword,
      });
    }
    const gatewayStatusLine = gatewayProbe.ok
      ? "网关：可访问"
      : `网关：未检测到${gatewayProbe.detail ? ` (${gatewayProbe.detail})` : ""}`;

    note(
      [
        `Web UI: ${links.httpUrl}`,
        `网关 WS: ${links.wsUrl}`,
        gatewayStatusLine,
        "文档：https://docs.openclaw.ai/web/control-ui",
      ].join("\n"),
      "控制界面",
    );

    outro("配置完成。");
  } catch (err) {
    if (err instanceof WizardCancelledError) {
      runtime.exit(1);
      return;
    }
    throw err;
  }
}
