import type { OpenClawConfig } from "../config/config.js";
import type { SecretInput } from "../config/types.secrets.js";
import { isSecureWebSocketUrl } from "../gateway/net.js";
import type { GatewayBonjourBeacon } from "../infra/bonjour-discovery.js";
import { discoverGatewayBeacons } from "../infra/bonjour-discovery.js";
import { resolveWideAreaDiscoveryDomain } from "../infra/widearea-dns.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import {
  promptSecretRefForOnboarding,
  resolveSecretInputModeForEnvSelection,
} from "./auth-choice.apply-helpers.js";
import { detectBinary } from "./onboard-helpers.js";
import type { SecretInputMode } from "./onboard-types.js";

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
  const hint = host ? `${host}:${port}` : "未知主机";
  return `${title} (${hint})`;
}

function ensureWsUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return DEFAULT_GATEWAY_URL;
  }
  return trimmed;
}

function validateGatewayWebSocketUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("ws://") && !trimmed.startsWith("wss://")) {
    return "URL 必须以 ws:// or wss:// 开头";
  }
  if (
    !isSecureWebSocketUrl(trimmed, {
      allowPrivateWs: process.env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS === "1",
    })
  ) {
    return (
      "远程主机使用 wss:// , 或 ws://127.0.0.1/localhost 通过 SSH tunnel. " +
      "私有可信任网络使用 Break-glass: OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1."
    );
  }
  return undefined;
}

export async function promptRemoteGatewayConfig(
  cfg: OpenClawConfig,
  prompter: WizardPrompter,
  options?: { secretInputMode?: SecretInputMode },
): Promise<OpenClawConfig> {
  let selectedBeacon: GatewayBonjourBeacon | null = null;
  let suggestedUrl = cfg.gateway?.remote?.url ?? DEFAULT_GATEWAY_URL;

  const hasBonjourTool = (await detectBinary("dns-sd")) || (await detectBinary("avahi-browse"));
  const wantsDiscover = hasBonjourTool
    ? await prompter.confirm({
        message: "搜索本地局域网的 gateway?",
        initialValue: true,
      })
    : false;

  if (!hasBonjourTool) {
    await prompter.note(
      [
        "搜索需要 dns-sd (macOS) 或 avahi-browse (Linux).",
        "文档: https://docs.openclaw.ai/gateway/discovery",
      ].join("\n"),
      "搜索",
    );
  }

  if (wantsDiscover) {
    const wideAreaDomain = resolveWideAreaDiscoveryDomain({
      configDomain: cfg.discovery?.wideArea?.domain,
    });
    const spin = prompter.progress("正在搜索 gateways…");
    const beacons = await discoverGatewayBeacons({ timeoutMs: 2000, wideAreaDomain });
    spin.stop(beacons.length > 0 ? `找到 ${beacons.length} 个gateway(s)` : "未发现 gateways");

    if (beacons.length > 0) {
      const selection = await prompter.select({
        message: "选择 gateway",
        options: [
          ...beacons.map((beacon, index) => ({
            value: String(index),
            label: buildLabel(beacon),
          })),
          { value: "manual", label: "输入 URL" },
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
        message: "链接方式",
        options: [
          {
            value: "direct",
            label: `直连 gateway WS (${host}:${port})`,
          },
          { value: "ssh", label: "SSH tunnel (loopback)" },
        ],
      });
      if (mode === "direct") {
        suggestedUrl = `wss://${host}:${port}`;
        await prompter.note(
          [
            "默认通过 TLS 直连远程服务器",
            `使用: ${suggestedUrl}`,
            "如果 gateway 仅使用回环地址, 选择 SSH tunnel 连接 ws://127.0.0.1:18789.",
          ].join("\n"),
          "远程直连",
        );
      } else {
        suggestedUrl = DEFAULT_GATEWAY_URL;
        await prompter.note(
          [
            "使用 CLI 之前启动 tunnel :",
            `ssh -N -L 18789:127.0.0.1:18789 <user>@${host}${
              selectedBeacon.sshPort ? ` -p ${selectedBeacon.sshPort}` : ""
            }`,
            "文档: https://docs.openclaw.ai/gateway/remote",
          ].join("\n"),
          "SSH tunnel",
        );
      }
    }
  }

  const urlInput = await prompter.text({
    message: "Gateway WebSocket URL",
    initialValue: suggestedUrl,
    validate: (value) => validateGatewayWebSocketUrl(String(value)),
  });
  const url = ensureWsUrl(String(urlInput));

  const authChoice = await prompter.select({
    message: "Gateway 认证",
    options: [
      { value: "token", label: "Token (recommended)" },
      { value: "password", label: "密码" },
      { value: "off", label: "无认证" },
    ],
  });

  let token: SecretInput | undefined = cfg.gateway?.remote?.token;
  let password: SecretInput | undefined = cfg.gateway?.remote?.password;
  if (authChoice === "token") {
    const selectedMode = await resolveSecretInputModeForEnvSelection({
      prompter,
      explicitMode: options?.secretInputMode,
      copy: {
        modeMessage: "您希望如何提供此网关令牌?",
        plaintextLabel: "输入 token ",
        plaintextHint: "保存 token 到 OpenClaw 配置文件",
      },
    });
    if (selectedMode === "ref") {
      const resolved = await promptSecretRefForOnboarding({
        provider: "gateway-remote-token",
        config: cfg,
        prompter,
        preferredEnvVar: "OPENCLAW_GATEWAY_TOKEN",
        copy: {
          sourceMessage: "gateway token 保存在哪里?",
          envVarPlaceholder: "OPENCLAW_GATEWAY_TOKEN",
        },
      });
      token = resolved.ref;
    } else {
      token = String(
        await prompter.text({
          message: "Gateway token",
          initialValue: typeof token === "string" ? token : undefined,
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();
    }
    password = undefined;
  } else if (authChoice === "password") {
    const selectedMode = await resolveSecretInputModeForEnvSelection({
      prompter,
      explicitMode: options?.secretInputMode,
      copy: {
        modeMessage: "您想如何提供此网关密码?",
        plaintextLabel: "输入 password now",
        plaintextHint: "密码保存到 OpenClaw 配置文件中",
      },
    });
    if (selectedMode === "ref") {
      const resolved = await promptSecretRefForOnboarding({
        provider: "gateway-remote-password",
        config: cfg,
        prompter,
        preferredEnvVar: "OPENCLAW_GATEWAY_PASSWORD",
        copy: {
          sourceMessage: "gateway 密码保存在哪里?",
          envVarPlaceholder: "OPENCLAW_GATEWAY_PASSWORD",
        },
      });
      password = resolved.ref;
    } else {
      password = String(
        await prompter.text({
          message: "Gateway 密码",
          initialValue: typeof password === "string" ? password : undefined,
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();
    }
    token = undefined;
  } else {
    token = undefined;
    password = undefined;
  }

  return {
    ...cfg,
    gateway: {
      ...cfg.gateway,
      mode: "remote",
      remote: {
        url,
        ...(token !== undefined ? { token } : {}),
        ...(password !== undefined ? { password } : {}),
      },
    },
  };
}
