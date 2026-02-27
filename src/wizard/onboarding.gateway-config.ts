import {
  normalizeGatewayTokenInput,
  randomToken,
  validateGatewayPasswordInput,
} from "../commands/onboard-helpers.js";
import type { GatewayAuthChoice } from "../commands/onboard-types.js";
import type { GatewayBindMode, GatewayTailscaleMode, OpenClawConfig } from "../config/config.js";
import {
  TAILSCALE_DOCS_LINES,
  TAILSCALE_EXPOSURE_OPTIONS,
  TAILSCALE_MISSING_BIN_NOTE_LINES,
} from "../gateway/gateway-config-prompts.shared.js";
import { findTailscaleBinary } from "../infra/tailscale.js";
import type { RuntimeEnv } from "../runtime.js";
import { validateIPv4AddressInput } from "../shared/net/ipv4.js";
import { t, type I18nContext } from "./i18n/index.js";
import type {
  GatewayWizardSettings,
  QuickstartGatewayDefaults,
  WizardFlow,
} from "./onboarding.types.js";
import type { WizardPrompter } from "./prompts.js";

// These commands are "high risk" (privacy writes/recording) and should be
// explicitly armed by the user when they want to use them.
//
// This only affects what the gateway will accept via node.invoke; the iOS app
// still prompts for OS permissions (camera/photos/contacts/etc) on first use.
const DEFAULT_DANGEROUS_NODE_DENY_COMMANDS = [
  "camera.snap",
  "camera.clip",
  "screen.record",
  "calendar.add",
  "contacts.add",
  "reminders.add",
];

type ConfigureGatewayOptions = {
  flow: WizardFlow;
  baseConfig: OpenClawConfig;
  nextConfig: OpenClawConfig;
  localPort: number;
  quickstartGateway: QuickstartGatewayDefaults;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  i18n?: I18nContext;
};

type ConfigureGatewayResult = {
  nextConfig: OpenClawConfig;
  settings: GatewayWizardSettings;
};

function buildDefaultControlUiAllowedOrigins(params: {
  port: number;
  bind: GatewayWizardSettings["bind"];
  customBindHost?: string;
}): string[] {
  const origins = new Set<string>([
    `http://localhost:${params.port}`,
    `http://127.0.0.1:${params.port}`,
  ]);
  if (params.bind === "custom" && params.customBindHost) {
    origins.add(`http://${params.customBindHost}:${params.port}`);
  }
  return [...origins];
}

export async function configureGatewayForOnboarding(
  opts: ConfigureGatewayOptions,
): Promise<ConfigureGatewayResult> {
  const { flow, localPort, quickstartGateway, prompter, i18n } = opts;
  let { nextConfig } = opts;

  const port =
    flow === "quickstart"
      ? quickstartGateway.port
      : Number.parseInt(
          String(
            await prompter.text({
              message: t(i18n, "gatewayConfig.port"),
              initialValue: String(localPort),
              validate: (value) =>
                Number.isFinite(Number(value)) ? undefined : t(i18n, "gatewayConfig.invalidPort"),
            }),
          ),
          10,
        );

  let bind: GatewayWizardSettings["bind"] =
    flow === "quickstart"
      ? quickstartGateway.bind
      : await prompter.select<GatewayWizardSettings["bind"]>({
          message: t(i18n, "gatewayConfig.bind"),
          options: [
            { value: "loopback", label: t(i18n, "gatewayConfig.bindLoopback") },
            { value: "lan", label: t(i18n, "gatewayConfig.bindLan") },
            { value: "tailnet", label: t(i18n, "gatewayConfig.bindTailnet") },
            { value: "auto", label: t(i18n, "gatewayConfig.bindAuto") },
            { value: "custom", label: t(i18n, "gatewayConfig.bindCustom") },
          ],
        });

  let customBindHost = quickstartGateway.customBindHost;
  if (bind === "custom") {
    const needsPrompt = flow !== "quickstart" || !customBindHost;
    if (needsPrompt) {
      const input = await prompter.text({
        message: t(i18n, "gatewayConfig.customIp"),
        placeholder: t(i18n, "gatewayConfig.customIpPlaceholder"),
        initialValue: customBindHost ?? "",
        validate: validateIPv4AddressInput,
      });
      customBindHost = typeof input === "string" ? input.trim() : undefined;
    }
  }

  let authMode =
    flow === "quickstart"
      ? quickstartGateway.authMode
      : ((await prompter.select({
          message: t(i18n, "gatewayConfig.auth"),
          options: [
            {
              value: "token",
              label: t(i18n, "gatewayConfig.authToken"),
              hint: t(i18n, "gatewayConfig.authTokenHint"),
            },
            { value: "password", label: t(i18n, "gatewayConfig.authPassword") },
          ],
          initialValue: "token",
        })) as GatewayAuthChoice);

  const tailscaleMode: GatewayWizardSettings["tailscaleMode"] =
    flow === "quickstart"
      ? quickstartGateway.tailscaleMode
      : await prompter.select<GatewayWizardSettings["tailscaleMode"]>({
          message: t(i18n, "gatewayConfig.tailscaleExposure"),
          options: [...TAILSCALE_EXPOSURE_OPTIONS],
        });

  // Detect Tailscale binary before proceeding with serve/funnel setup.
  if (tailscaleMode !== "off") {
    const tailscaleBin = await findTailscaleBinary();
    if (!tailscaleBin) {
      await prompter.note(
        TAILSCALE_MISSING_BIN_NOTE_LINES.join("\n"),
        t(i18n, "gatewayConfig.tailscaleWarning"),
      );
    }
  }

  let tailscaleResetOnExit = flow === "quickstart" ? quickstartGateway.tailscaleResetOnExit : false;
  if (tailscaleMode !== "off" && flow !== "quickstart") {
    await prompter.note(TAILSCALE_DOCS_LINES.join("\n"), t(i18n, "gatewayConfig.tailscaleNote"));
    tailscaleResetOnExit = Boolean(
      await prompter.confirm({
        message: t(i18n, "gatewayConfig.resetTailscaleOnExit"),
        initialValue: false,
      }),
    );
  }

  // Safety + constraints:
  // - Tailscale wants bind=loopback so we never expose a non-loopback server + tailscale serve/funnel at once.
  // - Funnel requires password auth.
  if (tailscaleMode !== "off" && bind !== "loopback") {
    await prompter.note(
      t(i18n, "gatewayConfig.tailscaleRequiresLoopback"),
      t(i18n, "gatewayConfig.note"),
    );
    bind = "loopback";
    customBindHost = undefined;
  }

  if (tailscaleMode === "funnel" && authMode !== "password") {
    await prompter.note(
      t(i18n, "gatewayConfig.tailscaleFunnelRequiresPassword"),
      t(i18n, "gatewayConfig.note"),
    );
    authMode = "password";
  }

  let gatewayToken: string | undefined;
  if (authMode === "token") {
    if (flow === "quickstart") {
      gatewayToken = quickstartGateway.token ?? randomToken();
    } else {
      const tokenInput = await prompter.text({
        message: t(i18n, "gatewayConfig.gatewayToken"),
        placeholder: t(i18n, "gatewayConfig.gatewayTokenPlaceholder"),
        initialValue: quickstartGateway.token ?? "",
      });
      gatewayToken = normalizeGatewayTokenInput(tokenInput) || randomToken();
    }
  }

  if (authMode === "password") {
    const password =
      flow === "quickstart" && quickstartGateway.password
        ? quickstartGateway.password
        : await prompter.text({
            message: t(i18n, "gatewayConfig.gatewayPassword"),
            validate: validateGatewayPasswordInput,
          });
    nextConfig = {
      ...nextConfig,
      gateway: {
        ...nextConfig.gateway,
        auth: {
          ...nextConfig.gateway?.auth,
          mode: "password",
          password: String(password ?? "").trim(),
        },
      },
    };
  } else if (authMode === "token") {
    nextConfig = {
      ...nextConfig,
      gateway: {
        ...nextConfig.gateway,
        auth: {
          ...nextConfig.gateway?.auth,
          mode: "token",
          token: gatewayToken,
        },
      },
    };
  }

  nextConfig = {
    ...nextConfig,
    gateway: {
      ...nextConfig.gateway,
      port,
      bind: bind as GatewayBindMode,
      ...(bind === "custom" && customBindHost ? { customBindHost } : {}),
      tailscale: {
        ...nextConfig.gateway?.tailscale,
        mode: tailscaleMode as GatewayTailscaleMode,
        resetOnExit: tailscaleResetOnExit,
      },
    },
  };

  const controlUiEnabled = nextConfig.gateway?.controlUi?.enabled ?? true;
  const hasExplicitControlUiAllowedOrigins =
    (nextConfig.gateway?.controlUi?.allowedOrigins ?? []).some(
      (origin) => origin.trim().length > 0,
    ) || nextConfig.gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback === true;
  if (controlUiEnabled && bind !== "loopback" && !hasExplicitControlUiAllowedOrigins) {
    nextConfig = {
      ...nextConfig,
      gateway: {
        ...nextConfig.gateway,
        controlUi: {
          ...nextConfig.gateway?.controlUi,
          allowedOrigins: buildDefaultControlUiAllowedOrigins({
            port,
            bind,
            customBindHost,
          }),
        },
      },
    };
  }

  // If this is a new gateway setup (no existing gateway settings), start with a
  // denylist for high-risk node commands. Users can arm these temporarily via
  // /phone arm ... (phone-control plugin).
  if (
    !quickstartGateway.hasExisting &&
    nextConfig.gateway?.nodes?.denyCommands === undefined &&
    nextConfig.gateway?.nodes?.allowCommands === undefined &&
    nextConfig.gateway?.nodes?.browser === undefined
  ) {
    nextConfig = {
      ...nextConfig,
      gateway: {
        ...nextConfig.gateway,
        nodes: {
          ...nextConfig.gateway?.nodes,
          denyCommands: [...DEFAULT_DANGEROUS_NODE_DENY_COMMANDS],
        },
      },
    };
  }

  return {
    nextConfig,
    settings: {
      port,
      bind: bind as GatewayBindMode,
      customBindHost: bind === "custom" ? customBindHost : undefined,
      authMode,
      gatewayToken,
      tailscaleMode: tailscaleMode as GatewayTailscaleMode,
      tailscaleResetOnExit,
    },
  };
}
