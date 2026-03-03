import type { OpenClawConfig } from "../config/config.js";
import { isSecureWebSocketUrl } from "../gateway/net.js";
import type { GatewayBonjourBeacon } from "../infra/bonjour-discovery.js";
import { discoverGatewayBeacons } from "../infra/bonjour-discovery.js";
import { resolveWideAreaDiscoveryDomain } from "../infra/widearea-dns.js";
import { createI18nContext, type I18nContext } from "../wizard/i18n/index.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { detectBinary } from "./onboard-helpers.js";

const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18789";

function pickHost(beacon: GatewayBonjourBeacon): string | undefined {
  // Security: TXT is unauthenticated. Prefer the resolved service endpoint host.
  return beacon.host || beacon.tailnetDns || beacon.lanHost;
}

function buildLabel(beacon: GatewayBonjourBeacon): string {
  const host = pickHost(beacon);
  // Security: Prefer the resolved service endpoint port.
  const port = beacon.port ?? beacon.gatewayPort ?? 18789;
  const title = beacon.displayName ?? beacon.instanceName;
  const hint = host ? `${host}:${port}` : "host unknown";
  return `${title} (${hint})`;
}

function ensureWsUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return DEFAULT_GATEWAY_URL;
  }
  return trimmed;
}

function validateGatewayWebSocketUrl(value: string, t: Record<string, string>): string | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("ws://") && !trimmed.startsWith("wss://")) {
    return String(t.websocketUrlValidation ?? "URL must start with ws:// or wss://");
  }
  if (!isSecureWebSocketUrl(trimmed)) {
    return String(
      t.websocketSecureValidation ??
        "Use wss:// for remote hosts, or ws://127.0.0.1/localhost via SSH tunnel.",
    );
  }
  return undefined;
}

export async function promptRemoteGatewayConfig(
  cfg: OpenClawConfig,
  prompter: WizardPrompter,
  i18n?: I18nContext,
): Promise<OpenClawConfig> {
  const i18nCtx = i18n ?? createI18nContext("en");
  // Type assertion needed because i18n translations are dynamically typed
  const t = (i18nCtx.t as { gateway?: { remote?: Record<string, string> } }).gateway
    ?.remote as Record<string, string>;
  let selectedBeacon: GatewayBonjourBeacon | null = null;
  let suggestedUrl = cfg.gateway?.remote?.url ?? DEFAULT_GATEWAY_URL;

  const hasBonjourTool = (await detectBinary("dns-sd")) || (await detectBinary("avahi-browse"));
  const wantsDiscover = hasBonjourTool
    ? await prompter.confirm({
        message: String(t?.discoverMessage ?? "Discover gateway on LAN (Bonjour)?"),
        initialValue: true,
      })
    : false;

  if (!hasBonjourTool) {
    const note = Array.isArray(t?.discoveryNote)
      ? (t.discoveryNote as string[]).join("\n")
      : [
          "Bonjour discovery requires dns-sd (macOS) or avahi-browse (Linux).",
          "Docs: https://docs.openclaw.ai/gateway/discovery",
        ].join("\n");
    await prompter.note(note, String(t?.discoveryTitle ?? "Discovery"));
  }

  if (wantsDiscover) {
    const wideAreaDomain = resolveWideAreaDiscoveryDomain({
      configDomain: cfg.discovery?.wideArea?.domain,
    });
    const spin = prompter.progress(String(t?.searchingGateways ?? "Searching for gateways…"));
    const beacons = await discoverGatewayBeacons({ timeoutMs: 2000, wideAreaDomain });
    const foundMsg =
      beacons.length > 0
        ? String(t?.foundGateways ?? "Found {count} gateway(s)").replace(
            "{count}",
            String(beacons.length),
          )
        : String(t?.noGatewaysFound ?? "No gateways found");
    spin.stop(foundMsg);

    if (beacons.length > 0) {
      const selection = await prompter.select({
        message: String(t?.selectGateway ?? "Select gateway"),
        options: [
          ...beacons.map((beacon, index) => ({
            value: String(index),
            label: buildLabel(beacon),
          })),
          { value: "manual", label: String(t?.enterManually ?? "Enter URL manually") },
        ],
      });
      if (selection !== "manual") {
        const idx = Number.parseInt(String(selection), 10);
        selectedBeacon = Number.isFinite(idx) ? (beacons[idx] ?? null) : null;
      }
    }
  }

  if (selectedBeacon) {
    const host = pickHost(selectedBeacon);
    const port = selectedBeacon.port ?? selectedBeacon.gatewayPort ?? 18789;
    if (host) {
      const mode = await prompter.select({
        message: String(t?.connectionMethod ?? "Connection method"),
        options: [
          {
            value: "direct",
            label: String(t?.directGatewayWs ?? "Direct gateway WS ({host}:{port})")
              .replace("{host}", host)
              .replace("{port}", String(port)),
          },
          { value: "ssh", label: String(t?.sshTunnel ?? "SSH tunnel (loopback)") },
        ],
      });
      if (mode === "direct") {
        suggestedUrl = `wss://${host}:${port}`;
        const noteLines = Array.isArray(t?.directRemoteNote)
          ? (t.directRemoteNote as string[])
          : [
              "Direct remote access defaults to TLS.",
              "Using: {url}",
              "If your gateway is loopback-only, choose SSH tunnel and keep ws://127.0.0.1:18789.",
            ];
        await prompter.note(
          noteLines.map((line) => line.replace("{url}", suggestedUrl)).join("\n"),
          String(t?.directRemoteTitle ?? "Direct remote"),
        );
      } else {
        suggestedUrl = DEFAULT_GATEWAY_URL;
        const sshCmd = `ssh -N -L 18789:127.0.0.1:18789 <user>@${host}${
          selectedBeacon.sshPort ? ` -p ${selectedBeacon.sshPort}` : ""
        }`;
        const noteLines = Array.isArray(t?.sshTunnelNote)
          ? (t.sshTunnelNote as string[])
          : [
              "Start a tunnel before using the CLI:",
              "{command}",
              "Docs: https://docs.openclaw.ai/gateway/remote",
            ];
        await prompter.note(
          noteLines.map((line) => line.replace("{command}", sshCmd)).join("\n"),
          String(t?.sshTunnelTitle ?? "SSH tunnel"),
        );
      }
    }
  }

  const urlInput = await prompter.text({
    message: String(t?.websocketUrl ?? "Gateway WebSocket URL"),
    initialValue: suggestedUrl,
    validate: (value) => validateGatewayWebSocketUrl(String(value), t ?? {}),
  });
  const url = ensureWsUrl(String(urlInput));

  const authChoice = await prompter.select({
    message: String(t?.gatewayAuth ?? "Gateway auth"),
    options: [
      { value: "token", label: String(t?.authTokenRecommended ?? "Token (recommended)") },
      { value: "off", label: String(t?.authNoAuth ?? "No auth") },
    ],
  });

  let token = cfg.gateway?.remote?.token ?? "";
  if (authChoice === "token") {
    token = String(
      await prompter.text({
        message: String(t?.gatewayToken ?? "Gateway token"),
        initialValue: token,
        validate: (value) =>
          value?.trim() ? undefined : String(t?.gatewayTokenRequired ?? "Required"),
      }),
    ).trim();
  } else {
    token = "";
  }

  return {
    ...cfg,
    gateway: {
      ...cfg.gateway,
      mode: "remote",
      remote: {
        url,
        token: token || undefined,
      },
    },
  };
}
