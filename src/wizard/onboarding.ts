import { formatCliCommand } from "../cli/command-format.js";
import type {
  GatewayAuthChoice,
  OnboardMode,
  OnboardOptions,
  ResetScope,
} from "../commands/onboard-types.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  DEFAULT_GATEWAY_PORT,
  readConfigFileSnapshot,
  resolveGatewayPort,
  writeConfigFile,
} from "../config/config.js";
import { normalizeSecretInputString } from "../config/types.secrets.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { resolveUserPath } from "../utils.js";
import { resolveOnboardingSecretInputString } from "./onboarding.secret-input.js";
import type { QuickstartGatewayDefaults, WizardFlow } from "./onboarding.types.js";
import { WizardCancelledError, type WizardPrompter } from "./prompts.js";

async function requireRiskAcknowledgement(params: {
  opts: OnboardOptions;
  prompter: WizardPrompter;
}) {
  if (params.opts.acceptRisk === true) {
    return;
  }

  await params.prompter.note(
    [
      "安全警告 — 请仔细阅读。",
      "",
      "OpenClaw 是一个业余项目，仍处于测试阶段。可能会有问题。",
      "默认情况下，OpenClaw 是个人代理：一个可信操作者边界。",
      "如果启用工具，此机器人可以读取文件并运行操作。",
      "一个糟糕的提示可能会欺骗它做不安全的事情。",
      "",
      "默认情况下，OpenClaw 不是一个敌对的多租户边界。",
      "如果多个用户可以向一个启用工具的代理发送消息，他们将共享该委托工具权限。",
      "",
      "如果您不熟悉安全加固和访问控制，请不要运行 OpenClaw。",
      "在启用工具或将其暴露到互联网之前，请有经验的人帮助。",
      "",
      "推荐基准:",
      "- 配对/允许列表 + 提及门控。",
      "- 多用户/共享收件箱：分离信任边界（独立的网关/凭据，理想情况下独立的操作系统用户/主机）。",
      "- 沙箱 + 最小特权工具。",
      "- 共享收件箱：隔离 DM 会话（`session.dmScope: per-channel-peer`）并保持最小的工具访问权限。",
      "- 将机密保存在代理可访问的文件系统之外。",
      "- 对于任何带有工具或不受信任收件箱的机器人，使用最强大的可用模型。",
      "",
      "定期运行:",
      "openclaw security audit --deep",
      "openclaw security audit --fix",
      "",
      "必读: https://docs.openclaw.ai/gateway/security",
    ].join("\n"),
    "安全",
  );

  const ok = await params.prompter.confirm({
    message: "我理解这默认是个人使用的，共享/多用户使用需要加强安全限制。继续？",
    initialValue: false,
  });
  if (!ok) {
    throw new WizardCancelledError("risk not accepted");
  }
}

export async function runOnboardingWizard(
  opts: OnboardOptions,
  runtime: RuntimeEnv = defaultRuntime,
  prompter: WizardPrompter,
) {
  const onboardHelpers = await import("../commands/onboard-helpers.js");
  onboardHelpers.printWizardHeader(runtime);
  await prompter.intro("OpenClaw 入门向导");
  await requireRiskAcknowledgement({ opts, prompter });

  const snapshot = await readConfigFileSnapshot();
  let baseConfig: OpenClawConfig = snapshot.valid ? snapshot.config : {};

  if (snapshot.exists && !snapshot.valid) {
    await prompter.note(onboardHelpers.summarizeExistingConfig(baseConfig), "配置无效");
    if (snapshot.issues.length > 0) {
      await prompter.note(
        [
          ...snapshot.issues.map((iss) => `- ${iss.path}: ${iss.message}`),
          "",
          "文档: https://docs.openclaw.ai/gateway/configuration",
        ].join("\n"),
        "配置问题",
      );
    }
    await prompter.outro(
      `配置无效。请运行 \`${formatCliCommand("openclaw doctor")}\` 修复后再重新运行入门向导。`,
    );
    runtime.exit(1);
    return;
  }

  const quickstartHint = `稍后通过 ${formatCliCommand("openclaw configure")} 配置详细信息。`;
  const manualHint = "配置端口、网络、Tailscale 和认证选项。";
  const explicitFlowRaw = opts.flow?.trim();
  const normalizedExplicitFlow = explicitFlowRaw === "manual" ? "advanced" : explicitFlowRaw;
  if (
    normalizedExplicitFlow &&
    normalizedExplicitFlow !== "quickstart" &&
    normalizedExplicitFlow !== "advanced"
  ) {
    runtime.error("--flow 参数无效（请使用 quickstart、manual 或 advanced）。");
    runtime.exit(1);
    return;
  }
  const explicitFlow: WizardFlow | undefined =
    normalizedExplicitFlow === "quickstart" || normalizedExplicitFlow === "advanced"
      ? normalizedExplicitFlow
      : undefined;
  let flow: WizardFlow =
    explicitFlow ??
    (await prompter.select({
      message: "入门模式",
      options: [
        { value: "quickstart", label: "快速开始", hint: quickstartHint },
        { value: "advanced", label: "手动配置", hint: manualHint },
      ],
      initialValue: "quickstart",
    }));

  if (opts.mode === "remote" && flow === "quickstart") {
    await prompter.note("快速开始仅支持本地网关。正在切换至手动模式。", "快速开始");
    flow = "advanced";
  }

  if (snapshot.exists) {
    await prompter.note(onboardHelpers.summarizeExistingConfig(baseConfig), "检测到现有配置");

    const action = await prompter.select({
      message: "配置处理方式",
      options: [
        { value: "keep", label: "使用现有值" },
        { value: "modify", label: "更新值" },
        { value: "reset", label: "重置" },
      ],
    });

    if (action === "reset") {
      const workspaceDefault =
        baseConfig.agents?.defaults?.workspace ?? onboardHelpers.DEFAULT_WORKSPACE;
      const resetScope = (await prompter.select({
        message: "重置范围",
        options: [
          { value: "config", label: "仅配置" },
          {
            value: "config+creds+sessions",
            label: "配置 + 凭据 + 会话",
          },
          {
            value: "full",
            label: "完全重置（配置 + 凭据 + 会话 + 工作空间）",
          },
        ],
      })) as ResetScope;
      await onboardHelpers.handleReset(resetScope, resolveUserPath(workspaceDefault), runtime);
      baseConfig = {};
    }
  }

  const quickstartGateway: QuickstartGatewayDefaults = (() => {
    const hasExisting =
      typeof baseConfig.gateway?.port === "number" ||
      baseConfig.gateway?.bind !== undefined ||
      baseConfig.gateway?.auth?.mode !== undefined ||
      baseConfig.gateway?.auth?.token !== undefined ||
      baseConfig.gateway?.auth?.password !== undefined ||
      baseConfig.gateway?.customBindHost !== undefined ||
      baseConfig.gateway?.tailscale?.mode !== undefined;

    const bindRaw = baseConfig.gateway?.bind;
    const bind =
      bindRaw === "loopback" ||
      bindRaw === "lan" ||
      bindRaw === "auto" ||
      bindRaw === "custom" ||
      bindRaw === "tailnet"
        ? bindRaw
        : "loopback";

    let authMode: GatewayAuthChoice = "token";
    if (
      baseConfig.gateway?.auth?.mode === "token" ||
      baseConfig.gateway?.auth?.mode === "password"
    ) {
      authMode = baseConfig.gateway.auth.mode;
    } else if (baseConfig.gateway?.auth?.token) {
      authMode = "token";
    } else if (baseConfig.gateway?.auth?.password) {
      authMode = "password";
    }

    const tailscaleRaw = baseConfig.gateway?.tailscale?.mode;
    const tailscaleMode =
      tailscaleRaw === "off" || tailscaleRaw === "serve" || tailscaleRaw === "funnel"
        ? tailscaleRaw
        : "off";

    return {
      hasExisting,
      port: resolveGatewayPort(baseConfig),
      bind,
      authMode,
      tailscaleMode,
      token: baseConfig.gateway?.auth?.token,
      password: baseConfig.gateway?.auth?.password,
      customBindHost: baseConfig.gateway?.customBindHost,
      tailscaleResetOnExit: baseConfig.gateway?.tailscale?.resetOnExit ?? false,
    };
  })();

  if (flow === "quickstart") {
    const formatBind = (value: "loopback" | "lan" | "auto" | "custom" | "tailnet") => {
      if (value === "loopback") {
        return "本地回环 (127.0.0.1)";
      }
      if (value === "lan") {
        return "局域网";
      }
      if (value === "custom") {
        return "自定义 IP";
      }
      if (value === "tailnet") {
        return "Tailnet (Tailscale IP)";
      }
      return "自动";
    };
    const formatAuth = (value: GatewayAuthChoice) => {
      if (value === "token") {
        return "令牌（默认）";
      }
      return "密码";
    };
    const formatTailscale = (value: "off" | "serve" | "funnel") => {
      if (value === "off") {
        return "关闭";
      }
      if (value === "serve") {
        return "Serve";
      }
      return "Funnel";
    };
    const quickstartLines = quickstartGateway.hasExisting
      ? [
          "保留您当前的网关设置：",
          `网关端口: ${quickstartGateway.port}`,
          `网关绑定: ${formatBind(quickstartGateway.bind)}`,
          ...(quickstartGateway.bind === "custom" && quickstartGateway.customBindHost
            ? [`网关自定义 IP: ${quickstartGateway.customBindHost}`]
            : []),
          `网关认证: ${formatAuth(quickstartGateway.authMode)}`,
          `Tailscale 暴露: ${formatTailscale(quickstartGateway.tailscaleMode)}`,
          "直接连接聊天频道。",
        ]
      : [
          `网关端口: ${DEFAULT_GATEWAY_PORT}`,
          "网关绑定: 本地回环 (127.0.0.1)",
          "网关认证: 令牌（默认）",
          "Tailscale 暴露: 关闭",
          "直接连接聊天频道。",
        ];
    await prompter.note(quickstartLines.join("\n"), "快速开始");
  }

  const localPort = resolveGatewayPort(baseConfig);
  const localUrl = `ws://127.0.0.1:${localPort}`;
  let localGatewayPassword =
    process.env.OPENCLAW_GATEWAY_PASSWORD ??
    normalizeSecretInputString(baseConfig.gateway?.auth?.password);
  try {
    const resolvedGatewayPassword = await resolveOnboardingSecretInputString({
      config: baseConfig,
      value: baseConfig.gateway?.auth?.password,
      path: "gateway.auth.password",
      env: process.env,
    });
    if (resolvedGatewayPassword) {
      localGatewayPassword = resolvedGatewayPassword;
    }
  } catch (error) {
    await prompter.note(
      [
        "无法解析入门探测所需的 gateway.auth.password SecretRef。",
        error instanceof Error ? error.message : String(error),
      ].join("\n"),
      "网关认证",
    );
  }

  const localProbe = await onboardHelpers.probeGatewayReachable({
    url: localUrl,
    token: baseConfig.gateway?.auth?.token ?? process.env.OPENCLAW_GATEWAY_TOKEN,
    password: localGatewayPassword,
  });
  const remoteUrl = baseConfig.gateway?.remote?.url?.trim() ?? "";
  const remoteProbe = remoteUrl
    ? await onboardHelpers.probeGatewayReachable({
        url: remoteUrl,
        token: normalizeSecretInputString(baseConfig.gateway?.remote?.token),
      })
    : null;

  const mode =
    opts.mode ??
    (flow === "quickstart"
      ? "local"
      : ((await prompter.select({
          message: "您想设置什么？",
          options: [
            {
              value: "local",
              label: "本地网关（本机）",
              hint: localProbe.ok ? `网关可访问（${localUrl}）` : `未检测到网关（${localUrl}）`,
            },
            {
              value: "remote",
              label: "远程网关（仅信息）",
              hint: !remoteUrl
                ? "尚未配置远程 URL"
                : remoteProbe?.ok
                  ? `网关可访问（${remoteUrl}）`
                  : `已配置但不可访问（${remoteUrl}）`,
            },
          ],
        })) as OnboardMode));

  if (mode === "remote") {
    const { promptRemoteGatewayConfig } = await import("../commands/onboard-remote.js");
    const { logConfigUpdated } = await import("../config/logging.js");
    let nextConfig = await promptRemoteGatewayConfig(baseConfig, prompter, {
      secretInputMode: opts.secretInputMode,
    });
    nextConfig = onboardHelpers.applyWizardMetadata(nextConfig, { command: "onboard", mode });
    await writeConfigFile(nextConfig);
    logConfigUpdated(runtime);
    await prompter.outro("远程网关已配置。");
    return;
  }

  const workspaceInput =
    opts.workspace ??
    (flow === "quickstart"
      ? (baseConfig.agents?.defaults?.workspace ?? onboardHelpers.DEFAULT_WORKSPACE)
      : await prompter.text({
          message: "工作空间目录",
          initialValue: baseConfig.agents?.defaults?.workspace ?? onboardHelpers.DEFAULT_WORKSPACE,
        }));

  const workspaceDir = resolveUserPath(workspaceInput.trim() || onboardHelpers.DEFAULT_WORKSPACE);

  const { applyOnboardingLocalWorkspaceConfig } = await import("../commands/onboard-config.js");
  let nextConfig: OpenClawConfig = applyOnboardingLocalWorkspaceConfig(baseConfig, workspaceDir);

  const { ensureAuthProfileStore } = await import("../agents/auth-profiles.js");
  const { promptAuthChoiceGrouped } = await import("../commands/auth-choice-prompt.js");
  const { promptCustomApiConfig } = await import("../commands/onboard-custom.js");
  const { applyAuthChoice, resolvePreferredProviderForAuthChoice, warnIfModelConfigLooksOff } =
    await import("../commands/auth-choice.js");
  const { applyPrimaryModel, promptDefaultModel } = await import("../commands/model-picker.js");

  const authStore = ensureAuthProfileStore(undefined, {
    allowKeychainPrompt: false,
  });
  const authChoiceFromPrompt = opts.authChoice === undefined;
  const authChoice =
    opts.authChoice ??
    (await promptAuthChoiceGrouped({
      prompter,
      store: authStore,
      includeSkip: true,
    }));

  if (authChoice === "custom-api-key") {
    const customResult = await promptCustomApiConfig({
      prompter,
      runtime,
      config: nextConfig,
      secretInputMode: opts.secretInputMode,
    });
    nextConfig = customResult.config;
  } else {
    const authResult = await applyAuthChoice({
      authChoice,
      config: nextConfig,
      prompter,
      runtime,
      setDefaultModel: true,
      opts: {
        tokenProvider: opts.tokenProvider,
        token: opts.authChoice === "apiKey" && opts.token ? opts.token : undefined,
      },
    });
    nextConfig = authResult.config;
  }

  if (authChoiceFromPrompt && authChoice !== "custom-api-key") {
    const modelSelection = await promptDefaultModel({
      config: nextConfig,
      prompter,
      allowKeep: true,
      ignoreAllowlist: true,
      includeVllm: true,
      preferredProvider: resolvePreferredProviderForAuthChoice(authChoice),
    });
    if (modelSelection.config) {
      nextConfig = modelSelection.config;
    }
    if (modelSelection.model) {
      nextConfig = applyPrimaryModel(nextConfig, modelSelection.model);
    }
  }

  await warnIfModelConfigLooksOff(nextConfig, prompter);

  const { configureGatewayForOnboarding } = await import("./onboarding.gateway-config.js");
  const gateway = await configureGatewayForOnboarding({
    flow,
    baseConfig,
    nextConfig,
    localPort,
    quickstartGateway,
    secretInputMode: opts.secretInputMode,
    prompter,
    runtime,
  });
  nextConfig = gateway.nextConfig;
  const settings = gateway.settings;

  if (opts.skipChannels ?? opts.skipProviders) {
    await prompter.note("跳过频道设置。", "频道");
  } else {
    const { listChannelPlugins } = await import("../channels/plugins/index.js");
    const { setupChannels } = await import("../commands/onboard-channels.js");
    const quickstartAllowFromChannels =
      flow === "quickstart"
        ? listChannelPlugins()
            .filter((plugin) => plugin.meta.quickstartAllowFrom)
            .map((plugin) => plugin.id)
        : [];
    nextConfig = await setupChannels(nextConfig, runtime, prompter, {
      allowSignalInstall: true,
      forceAllowFromChannels: quickstartAllowFromChannels,
      skipDmPolicyPrompt: flow === "quickstart",
      skipConfirm: flow === "quickstart",
      quickstartDefaults: flow === "quickstart",
      secretInputMode: opts.secretInputMode,
    });
  }

  await writeConfigFile(nextConfig);
  const { logConfigUpdated } = await import("../config/logging.js");
  logConfigUpdated(runtime);
  await onboardHelpers.ensureWorkspaceAndSessions(workspaceDir, runtime, {
    skipBootstrap: Boolean(nextConfig.agents?.defaults?.skipBootstrap),
  });

  if (opts.skipSkills) {
    await prompter.note("跳过技能设置。", "技能");
  } else {
    const { setupSkills } = await import("../commands/onboard-skills.js");
    nextConfig = await setupSkills(nextConfig, workspaceDir, runtime, prompter);
  }

  // Setup hooks (session memory on /new)
  const { setupInternalHooks } = await import("../commands/onboard-hooks.js");
  nextConfig = await setupInternalHooks(nextConfig, runtime, prompter);

  nextConfig = onboardHelpers.applyWizardMetadata(nextConfig, { command: "onboard", mode });
  await writeConfigFile(nextConfig);

  const { finalizeOnboardingWizard } = await import("./onboarding.finalize.js");
  const { launchedTui } = await finalizeOnboardingWizard({
    flow,
    opts,
    baseConfig,
    nextConfig,
    workspaceDir,
    settings,
    prompter,
    runtime,
  });
  if (launchedTui) {
    return;
  }
}
