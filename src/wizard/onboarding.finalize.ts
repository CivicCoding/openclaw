import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_BOOTSTRAP_FILENAME } from "../agents/workspace.js";
import { formatCliCommand } from "../cli/command-format.js";
import {
  buildGatewayInstallPlan,
  gatewayInstallErrorHint,
} from "../commands/daemon-install-helpers.js";
import {
  DEFAULT_GATEWAY_DAEMON_RUNTIME,
  GATEWAY_DAEMON_RUNTIME_OPTIONS,
} from "../commands/daemon-runtime.js";
import { formatHealthCheckFailure } from "../commands/health-format.js";
import { healthCommand } from "../commands/health.js";
import {
  detectBrowserOpenSupport,
  formatControlUiSshHint,
  openUrl,
  probeGatewayReachable,
  waitForGatewayReachable,
  resolveControlUiLinks,
} from "../commands/onboard-helpers.js";
import type { OnboardOptions } from "../commands/onboard-types.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveGatewayService } from "../daemon/service.js";
import { isSystemdUserServiceAvailable } from "../daemon/systemd.js";
import { ensureControlUiAssetsBuilt } from "../infra/control-ui-assets.js";
import type { RuntimeEnv } from "../runtime.js";
import { restoreTerminalState } from "../terminal/restore.js";
import { runTui } from "../tui/tui.js";
import { resolveUserPath } from "../utils.js";
import { createI18nContext, type I18nContext } from "./i18n/index.js";
import { setupOnboardingShellCompletion } from "./onboarding.completion.js";
import type { GatewayWizardSettings, WizardFlow } from "./onboarding.types.js";
import type { WizardPrompter } from "./prompts.js";

type FinalizeOnboardingOptions = {
  flow: WizardFlow;
  opts: OnboardOptions;
  baseConfig: OpenClawConfig;
  nextConfig: OpenClawConfig;
  workspaceDir: string;
  settings: GatewayWizardSettings;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  i18n?: I18nContext;
};

export async function finalizeOnboardingWizard(
  options: FinalizeOnboardingOptions,
): Promise<{ launchedTui: boolean }> {
  const { flow, opts, baseConfig, nextConfig, settings, prompter, runtime } = options;
  const t = options.i18n?.t.finalize ?? createI18nContext("en").t.finalize;

  const withWizardProgress = async <T>(
    label: string,
    options: { doneMessage?: string },
    work: (progress: { update: (message: string) => void }) => Promise<T>,
  ): Promise<T> => {
    const progress = prompter.progress(label);
    try {
      return await work(progress);
    } finally {
      progress.stop(options.doneMessage);
    }
  };

  const systemdAvailable =
    process.platform === "linux" ? await isSystemdUserServiceAvailable() : true;
  if (process.platform === "linux" && !systemdAvailable) {
    await prompter.note(t.systemd.unavailable, t.systemd.title);
  }

  if (process.platform === "linux" && systemdAvailable) {
    const { ensureSystemdUserLingerInteractive } = await import("../commands/systemd-linger.js");
    await ensureSystemdUserLingerInteractive({
      runtime,
      prompter: {
        confirm: prompter.confirm,
        note: prompter.note,
      },
      reason: t.systemd.lingerReason,
      requireConfirm: false,
    });
  }

  const explicitInstallDaemon =
    typeof opts.installDaemon === "boolean" ? opts.installDaemon : undefined;
  let installDaemon: boolean;
  if (explicitInstallDaemon !== undefined) {
    installDaemon = explicitInstallDaemon;
  } else if (process.platform === "linux" && !systemdAvailable) {
    installDaemon = false;
  } else if (flow === "quickstart") {
    installDaemon = true;
  } else {
    installDaemon = await prompter.confirm({
      message: t.gateway.installService,
      initialValue: true,
    });
  }

  if (process.platform === "linux" && !systemdAvailable && installDaemon) {
    await prompter.note(t.gateway.unavailableNote, t.gateway.title);
    installDaemon = false;
  }

  if (installDaemon) {
    const daemonRuntime =
      flow === "quickstart"
        ? DEFAULT_GATEWAY_DAEMON_RUNTIME
        : await prompter.select({
            message: t.gateway.serviceRuntime,
            options: GATEWAY_DAEMON_RUNTIME_OPTIONS,
            initialValue: opts.daemonRuntime ?? DEFAULT_GATEWAY_DAEMON_RUNTIME,
          });
    if (flow === "quickstart") {
      await prompter.note(t.gateway.quickstartNote, t.gateway.serviceRuntime);
    }
    const service = resolveGatewayService();
    const loaded = await service.isLoaded({ env: process.env });
    if (loaded) {
      const action = await prompter.select({
        message: t.gateway.alreadyInstalled,
        options: [
          { value: "restart", label: t.gateway.restart },
          { value: "reinstall", label: t.gateway.reinstall },
          { value: "skip", label: t.gateway.skip },
        ],
      });
      if (action === "restart") {
        await withWizardProgress(
          t.gateway.title,
          { doneMessage: t.gateway.restarted },
          async (progress) => {
            progress.update(t.gateway.restarting);
            await service.restart({
              env: process.env,
              stdout: process.stdout,
            });
          },
        );
      } else if (action === "reinstall") {
        await withWizardProgress(
          t.gateway.title,
          { doneMessage: t.gateway.uninstalled },
          async (progress) => {
            progress.update(t.gateway.uninstalling);
            await service.uninstall({ env: process.env, stdout: process.stdout });
          },
        );
      }
    }

    if (!loaded || (loaded && !(await service.isLoaded({ env: process.env })))) {
      const progress = prompter.progress(t.gateway.title);
      let installError: string | null = null;
      try {
        progress.update(t.gateway.preparing);
        const { programArguments, workingDirectory, environment } = await buildGatewayInstallPlan({
          env: process.env,
          port: settings.port,
          token: settings.gatewayToken,
          runtime: daemonRuntime,
          warn: (message, title) => prompter.note(message, title),
          config: nextConfig,
        });

        progress.update(t.gateway.installing);
        await service.install({
          env: process.env,
          stdout: process.stdout,
          programArguments,
          workingDirectory,
          environment,
        });
      } catch (err) {
        installError = err instanceof Error ? err.message : String(err);
      } finally {
        progress.stop(installError ? t.gateway.installFailed : t.gateway.installed);
      }
      if (installError) {
        await prompter.note(`${t.gateway.installFailed}: ${installError}`, t.gateway.title);
        await prompter.note(gatewayInstallErrorHint(), t.gateway.title);
      }
    }
  }

  if (!opts.skipHealth) {
    const probeLinks = resolveControlUiLinks({
      bind: nextConfig.gateway?.bind ?? "loopback",
      port: settings.port,
      customBindHost: nextConfig.gateway?.customBindHost,
      basePath: undefined,
    });
    // Daemon install/restart can briefly flap the WS; wait a bit so health check doesn't false-fail.
    await waitForGatewayReachable({
      url: probeLinks.wsUrl,
      token: settings.gatewayToken,
      deadlineMs: 15_000,
    });
    try {
      await healthCommand({ json: false, timeoutMs: 10_000 }, runtime);
    } catch (err) {
      runtime.error(formatHealthCheckFailure(err));
      await prompter.note(t.health.docs.join("\n"), t.health.title);
    }
  }

  const controlUiEnabled =
    nextConfig.gateway?.controlUi?.enabled ?? baseConfig.gateway?.controlUi?.enabled ?? true;
  if (!opts.skipUi && controlUiEnabled) {
    const controlUiAssets = await ensureControlUiAssetsBuilt(runtime);
    if (!controlUiAssets.ok && controlUiAssets.message) {
      runtime.error(controlUiAssets.message);
    }
  }

  await prompter.note(t.apps.message.join("\n"), t.apps.title);

  const controlUiBasePath =
    nextConfig.gateway?.controlUi?.basePath ?? baseConfig.gateway?.controlUi?.basePath;
  const links = resolveControlUiLinks({
    bind: settings.bind,
    port: settings.port,
    customBindHost: settings.customBindHost,
    basePath: controlUiBasePath,
  });
  const authedUrl =
    settings.authMode === "token" && settings.gatewayToken
      ? `${links.httpUrl}#token=${encodeURIComponent(settings.gatewayToken)}`
      : links.httpUrl;
  const gatewayProbe = await probeGatewayReachable({
    url: links.wsUrl,
    token: settings.authMode === "token" ? settings.gatewayToken : undefined,
    password: settings.authMode === "password" ? nextConfig.gateway?.auth?.password : "",
  });
  const gatewayStatusLine = gatewayProbe.ok
    ? "Gateway: reachable"
    : `Gateway: not detected${gatewayProbe.detail ? ` (${gatewayProbe.detail})` : ""}`;
  const bootstrapPath = path.join(
    resolveUserPath(options.workspaceDir),
    DEFAULT_BOOTSTRAP_FILENAME,
  );
  const hasBootstrap = await fs
    .access(bootstrapPath)
    .then(() => true)
    .catch(() => false);

  await prompter.note(
    [
      `${t.controlUi.webUi}: ${links.httpUrl}`,
      settings.authMode === "token" && settings.gatewayToken
        ? `${t.controlUi.webUiWithToken}: ${authedUrl}`
        : undefined,
      `${t.controlUi.gatewayWs}: ${links.wsUrl}`,
      gatewayStatusLine,
      t.controlUi.docs,
    ]
      .filter(Boolean)
      .join("\n"),
    t.controlUi.title,
  );

  let controlUiOpened = false;
  let controlUiOpenHint: string | undefined;
  let seededInBackground = false;
  let hatchChoice: "tui" | "web" | "later" | null = null;
  let launchedTui = false;

  if (!opts.skipUi && gatewayProbe.ok) {
    if (hasBootstrap) {
      await prompter.note(t.hatch.note.join("\n"), t.hatch.title);
    }

    await prompter.note(
      [
        t.token.message[0],
        t.token.message[1],
        `${t.token.message[2]}: ${formatCliCommand("openclaw config get gateway.auth.token")}`,
        `${t.token.message[3]}: ${formatCliCommand("openclaw doctor --generate-gateway-token")}`,
        t.token.message[4],
        `${t.token.message[5]}: ${formatCliCommand("openclaw dashboard --no-open")}`,
        t.token.message[6],
      ].join("\n"),
      t.token.title,
    );

    hatchChoice = await prompter.select({
      message: t.hatch.message,
      options: [
        { value: "tui", label: t.hatch.tui },
        { value: "web", label: t.hatch.web },
        { value: "later", label: t.hatch.later },
      ],
      initialValue: "tui",
    });

    if (hatchChoice === "tui") {
      restoreTerminalState("pre-onboarding tui", { resumeStdinIfPaused: true });
      await runTui({
        url: links.wsUrl,
        token: settings.authMode === "token" ? settings.gatewayToken : undefined,
        password: settings.authMode === "password" ? nextConfig.gateway?.auth?.password : "",
        // Safety: onboarding TUI should not auto-deliver to lastProvider/lastTo.
        deliver: false,
        message: hasBootstrap ? t.hatch.wakeMessage : undefined,
      });
      launchedTui = true;
    } else if (hatchChoice === "web") {
      const browserSupport = await detectBrowserOpenSupport();
      if (browserSupport.ok) {
        controlUiOpened = await openUrl(authedUrl);
        if (!controlUiOpened) {
          controlUiOpenHint = formatControlUiSshHint({
            port: settings.port,
            basePath: controlUiBasePath,
            token: settings.authMode === "token" ? settings.gatewayToken : undefined,
          });
        }
      } else {
        controlUiOpenHint = formatControlUiSshHint({
          port: settings.port,
          basePath: controlUiBasePath,
          token: settings.authMode === "token" ? settings.gatewayToken : undefined,
        });
      }
      await prompter.note(
        [
          `${t.dashboard.linkWithToken}: ${authedUrl}`,
          controlUiOpened ? t.dashboard.opened : t.dashboard.copyPaste,
          controlUiOpenHint,
        ]
          .filter(Boolean)
          .join("\n"),
        t.dashboard.ready,
      );
    } else {
      await prompter.note(
        `${t.dashboard.later}: ${formatCliCommand("openclaw dashboard --no-open")}`,
        t.dashboard.later,
      );
    }
  } else if (opts.skipUi) {
    await prompter.note("Skipping Control UI/TUI prompts.", t.controlUi.title);
  }

  await prompter.note(t.workspace.message.join("\n"), t.workspace.title);

  await prompter.note(t.security.message, t.security.title);

  await setupOnboardingShellCompletion({ flow, prompter });

  const shouldOpenControlUi =
    !opts.skipUi &&
    settings.authMode === "token" &&
    Boolean(settings.gatewayToken) &&
    hatchChoice === null;
  if (shouldOpenControlUi) {
    const browserSupport = await detectBrowserOpenSupport();
    if (browserSupport.ok) {
      controlUiOpened = await openUrl(authedUrl);
      if (!controlUiOpened) {
        controlUiOpenHint = formatControlUiSshHint({
          port: settings.port,
          basePath: controlUiBasePath,
          token: settings.gatewayToken,
        });
      }
    } else {
      controlUiOpenHint = formatControlUiSshHint({
        port: settings.port,
        basePath: controlUiBasePath,
        token: settings.gatewayToken,
      });
    }

    await prompter.note(
      [
        `${t.dashboard.linkWithToken}: ${authedUrl}`,
        controlUiOpened ? t.dashboard.opened : t.dashboard.copyPaste,
        controlUiOpenHint,
      ]
        .filter(Boolean)
        .join("\n"),
      t.dashboard.ready,
    );
  }

  const webSearchKey = (nextConfig.tools?.web?.search?.apiKey ?? "").trim();
  const webSearchEnv = (process.env.BRAVE_API_KEY ?? "").trim();
  const hasWebSearchKey = Boolean(webSearchKey || webSearchEnv);
  await prompter.note(
    hasWebSearchKey
      ? [
          t.webSearch.enabled[0],
          t.webSearch.enabled[1],
          webSearchKey
            ? `${t.webSearch.enabled[2]}: stored in config (tools.web.search.apiKey).`
            : `${t.webSearch.enabled[2]}: provided via BRAVE_API_KEY env var (Gateway environment).`,
          t.webSearch.enabled[3],
        ].join("\n")
      : [
          t.webSearch.disabled[0],
          t.webSearch.disabled[1],
          t.webSearch.disabled[2],
          t.webSearch.disabled[3],
          t.webSearch.disabled[4],
          `- ${t.webSearch.disabled[5]}: ${formatCliCommand("openclaw configure --section web")}`,
          `- ${t.webSearch.disabled[6]}`,
          t.webSearch.disabled[7],
          t.webSearch.disabled[8],
          t.webSearch.disabled[9],
        ].join("\n"),
    t.webSearch.title,
  );

  await prompter.note(t.whatNow.message, t.whatNow.title);

  await prompter.outro(
    controlUiOpened
      ? t.outro.dashboardOpened
      : seededInBackground
        ? t.outro.seededInBackground
        : t.outro.complete,
  );

  return { launchedTui };
}
