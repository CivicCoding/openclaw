import { resolveEnvApiKey } from "../agents/model-auth.js";
import type { OpenClawConfig } from "../config/types.js";
import { type SecretInput, type SecretRef } from "../config/types.secrets.js";
import { encodeJsonPointerToken } from "../secrets/json-pointer.js";
import { PROVIDER_ENV_VARS } from "../secrets/provider-env-vars.js";
import {
  isValidFileSecretRefId,
  resolveDefaultSecretProviderAlias,
} from "../secrets/ref-contract.js";
import { resolveSecretRefString } from "../secrets/resolve.js";
import { type I18nContext } from "../wizard/i18n/index.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { formatApiKeyPreview } from "./auth-choice.api-key.js";
import type { ApplyAuthChoiceParams } from "./auth-choice.apply.js";
import { applyDefaultModelChoice } from "./auth-choice.default-model.js";
import type { SecretInputMode } from "./onboard-types.js";

const ENV_SOURCE_LABEL_RE = /(?:^|:\s)([A-Z][A-Z0-9_]*)$/;
const ENV_SECRET_REF_ID_RE = /^[A-Z][A-Z0-9_]{0,127}$/;

type SecretRefChoice = "env" | "provider";

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && typeof error.message === "string" && error.message.trim()) {
    return error.message;
  }
  return String(error);
}

function extractEnvVarFromSourceLabel(source: string): string | undefined {
  const match = ENV_SOURCE_LABEL_RE.exec(source.trim());
  return match?.[1];
}

function resolveDefaultProviderEnvVar(provider: string): string | undefined {
  const envVars = PROVIDER_ENV_VARS[provider];
  return envVars?.find((candidate) => candidate.trim().length > 0);
}

function resolveDefaultFilePointerId(provider: string): string {
  return `/providers/${encodeJsonPointerToken(provider)}/apiKey`;
}

function resolveRefFallbackInput(params: {
  config: OpenClawConfig;
  provider: string;
  preferredEnvVar?: string;
  i18n: I18nContext;
}): { ref: SecretRef; resolvedValue: string } {
  const fallbackEnvVar = params.preferredEnvVar ?? resolveDefaultProviderEnvVar(params.provider);
  const t = params.i18n.t.authChoice.errors;
  if (!fallbackEnvVar) {
    throw new Error(t.noDefaultEnvVar.replace("{provider}", params.provider));
  }
  const value = process.env[fallbackEnvVar]?.trim();
  if (!value) {
    throw new Error(t.envVarRequired.replace("{envVar}", fallbackEnvVar));
  }
  return {
    ref: {
      source: "env",
      provider: resolveDefaultSecretProviderAlias(params.config, "env", {
        preferFirstProviderForSource: true,
      }),
      id: fallbackEnvVar,
    },
    resolvedValue: value,
  };
}

async function resolveApiKeyRefForOnboarding(params: {
  provider: string;
  config: OpenClawConfig;
  prompter: WizardPrompter;
  preferredEnvVar?: string;
  i18n: I18nContext;
}): Promise<{ ref: SecretRef; resolvedValue: string }> {
  const defaultEnvVar =
    params.preferredEnvVar ?? resolveDefaultProviderEnvVar(params.provider) ?? "";
  const defaultFilePointer = resolveDefaultFilePointerId(params.provider);
  let sourceChoice: SecretRefChoice = "env";
  const t = params.i18n.t.authChoice;

  while (true) {
    const sourceRaw: SecretRefChoice = await params.prompter.select<SecretRefChoice>({
      message: t.secretStorage.message,
      initialValue: sourceChoice,
      options: [
        {
          value: "env",
          label: t.secretStorage.envOption.label,
          hint: t.secretStorage.envOption.hint,
        },
        {
          value: "provider",
          label: t.secretStorage.providerOption.label,
          hint: t.secretStorage.providerOption.hint,
        },
      ],
    });
    const source: SecretRefChoice = sourceRaw === "provider" ? "provider" : "env";
    sourceChoice = source;

    if (source === "env") {
      const envVarRaw = await params.prompter.text({
        message: t.envVar.message,
        initialValue: defaultEnvVar || undefined,
        placeholder: t.envVar.placeholder,
        validate: (value) => {
          const candidate = value.trim();
          if (!ENV_SECRET_REF_ID_RE.test(candidate)) {
            return t.envVar.invalidFormat;
          }
          if (!process.env[candidate]?.trim()) {
            return t.envVar.missingOrEmpty.replace("{name}", candidate);
          }
          return undefined;
        },
      });
      const envCandidate = String(envVarRaw ?? "").trim();
      const envVar =
        envCandidate && ENV_SECRET_REF_ID_RE.test(envCandidate) ? envCandidate : defaultEnvVar;
      if (!envVar) {
        throw new Error(t.envVar.noValidName.replace("{provider}", params.provider));
      }
      const ref: SecretRef = {
        source: "env",
        provider: resolveDefaultSecretProviderAlias(params.config, "env", {
          preferFirstProviderForSource: true,
        }),
        id: envVar,
      };
      const resolvedValue = await resolveSecretRefString(ref, {
        config: params.config,
        env: process.env,
      });
      await params.prompter.note(
        t.envVar.validated.replace("{name}", envVar),
        t.envVar.validatedTitle,
      );
      return { ref, resolvedValue };
    }

    const externalProviders = Object.entries(params.config.secrets?.providers ?? {}).filter(
      ([, provider]) => provider?.source === "file" || provider?.source === "exec",
    );
    if (externalProviders.length === 0) {
      await params.prompter.note(
        t.secretProvider.noProvidersConfigured,
        t.secretProvider.noProvidersTitle,
      );
      continue;
    }
    const defaultProvider = resolveDefaultSecretProviderAlias(params.config, "file", {
      preferFirstProviderForSource: true,
    });
    const selectedProvider = await params.prompter.select<string>({
      message: t.secretProvider.selectMessage,
      initialValue:
        externalProviders.find(([providerName]) => providerName === defaultProvider)?.[0] ??
        externalProviders[0]?.[0],
      options: externalProviders.map(([providerName, provider]) => ({
        value: providerName,
        label: providerName,
        hint: provider?.source === "exec" ? t.secretProvider.execHint : t.secretProvider.fileHint,
      })),
    });
    const providerEntry = params.config.secrets?.providers?.[selectedProvider];
    if (!providerEntry || (providerEntry.source !== "file" && providerEntry.source !== "exec")) {
      await params.prompter.note(
        t.secretProvider.invalidProvider.replace("{name}", selectedProvider),
        t.secretProvider.invalidProviderTitle,
      );
      continue;
    }
    const idPrompt =
      providerEntry.source === "file" ? t.secretId.fileMessage : t.secretId.execMessage;
    const idDefault =
      providerEntry.source === "file"
        ? providerEntry.mode === "singleValue"
          ? "value"
          : defaultFilePointer
        : `${params.provider}/apiKey`;
    const idRaw = await params.prompter.text({
      message: idPrompt,
      initialValue: idDefault,
      placeholder:
        providerEntry.source === "file" ? t.secretId.filePlaceholder : t.secretId.execPlaceholder,
      validate: (value) => {
        const candidate = value.trim();
        if (!candidate) {
          return t.secretId.emptyError;
        }
        if (
          providerEntry.source === "file" &&
          providerEntry.mode !== "singleValue" &&
          !isValidFileSecretRefId(candidate)
        ) {
          return t.secretId.invalidJsonPointer;
        }
        if (
          providerEntry.source === "file" &&
          providerEntry.mode === "singleValue" &&
          candidate !== "value"
        ) {
          return t.secretId.invalidSingleValue;
        }
        return undefined;
      },
    });
    const id = String(idRaw ?? "").trim() || idDefault;
    const ref: SecretRef = {
      source: providerEntry.source,
      provider: selectedProvider,
      id,
    };
    try {
      const resolvedValue = await resolveSecretRefString(ref, {
        config: params.config,
        env: process.env,
      });
      await params.prompter.note(
        t.secretId.validated
          .replace("{source}", providerEntry.source)
          .replace("{provider}", selectedProvider)
          .replace("{id}", id),
        t.secretId.validatedTitle,
      );
      return { ref, resolvedValue };
    } catch (error) {
      await params.prompter.note(
        [
          t.secretId.validationFailed.replace("{provider}", selectedProvider).replace("{id}", id),
          formatErrorMessage(error),
          t.secretId.checkConfig,
        ].join("\n"),
        t.secretId.validationFailedTitle,
      );
    }
  }
}

export function createAuthChoiceAgentModelNoter(
  params: ApplyAuthChoiceParams,
  i18n: I18nContext,
): (model: string) => Promise<void> {
  return async (model: string) => {
    if (!params.agentId) {
      return;
    }
    const t = i18n.t.authChoice.apiKeyPrompt;
    await params.prompter.note(
      t.modelConfigured.replace("{model}", model).replace("{agentId}", params.agentId),
      t.modelConfiguredTitle,
    );
  };
}

export interface ApplyAuthChoiceModelState {
  config: ApplyAuthChoiceParams["config"];
  agentModelOverride: string | undefined;
}

export function createAuthChoiceModelStateBridge(bindings: {
  getConfig: () => ApplyAuthChoiceParams["config"];
  setConfig: (config: ApplyAuthChoiceParams["config"]) => void;
  getAgentModelOverride: () => string | undefined;
  setAgentModelOverride: (model: string | undefined) => void;
}): ApplyAuthChoiceModelState {
  return {
    get config() {
      return bindings.getConfig();
    },
    set config(config) {
      bindings.setConfig(config);
    },
    get agentModelOverride() {
      return bindings.getAgentModelOverride();
    },
    set agentModelOverride(model) {
      bindings.setAgentModelOverride(model);
    },
  };
}

export function createAuthChoiceDefaultModelApplier(
  params: ApplyAuthChoiceParams,
  state: ApplyAuthChoiceModelState,
  i18n: I18nContext,
): (
  options: Omit<
    Parameters<typeof applyDefaultModelChoice>[0],
    "config" | "setDefaultModel" | "noteAgentModel" | "prompter"
  >,
) => Promise<void> {
  const noteAgentModel = createAuthChoiceAgentModelNoter(params, i18n);

  return async (options) => {
    const applied = await applyDefaultModelChoice({
      config: state.config,
      setDefaultModel: params.setDefaultModel,
      noteAgentModel,
      prompter: params.prompter,
      ...options,
    });
    state.config = applied.config;
    state.agentModelOverride = applied.agentModelOverride ?? state.agentModelOverride;
  };
}

export function normalizeTokenProviderInput(
  tokenProvider: string | null | undefined,
): string | undefined {
  const normalized = String(tokenProvider ?? "")
    .trim()
    .toLowerCase();
  return normalized || undefined;
}

export function normalizeSecretInputModeInput(
  secretInputMode: string | null | undefined,
): SecretInputMode | undefined {
  const normalized = String(secretInputMode ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "plaintext" || normalized === "ref") {
    return normalized;
  }
  return undefined;
}

export async function resolveSecretInputModeForEnvSelection(params: {
  prompter: WizardPrompter;
  explicitMode?: SecretInputMode;
  i18n: I18nContext;
}): Promise<SecretInputMode> {
  if (params.explicitMode) {
    return params.explicitMode;
  }
  // Some tests pass partial prompt harnesses without a select implementation.
  // Preserve backward-compatible behavior by defaulting to plaintext in that case.
  if (typeof params.prompter.select !== "function") {
    return "plaintext";
  }
  const t = params.i18n.t.authChoice.apiKeyPrompt;
  const selected = await params.prompter.select<SecretInputMode>({
    message: t.message,
    initialValue: "plaintext",
    options: [
      {
        value: "plaintext",
        label: t.plaintextLabel,
        hint: t.plaintextHint,
      },
      {
        value: "ref",
        label: t.refLabel,
        hint: t.refHint,
      },
    ],
  });
  return selected === "ref" ? "ref" : "plaintext";
}

export async function maybeApplyApiKeyFromOption(params: {
  token: string | undefined;
  tokenProvider: string | undefined;
  secretInputMode?: SecretInputMode;
  expectedProviders: string[];
  normalize: (value: string) => string;
  setCredential: (apiKey: SecretInput, mode?: SecretInputMode) => Promise<void>;
}): Promise<string | undefined> {
  const tokenProvider = normalizeTokenProviderInput(params.tokenProvider);
  const expectedProviders = params.expectedProviders
    .map((provider) => normalizeTokenProviderInput(provider))
    .filter((provider): provider is string => Boolean(provider));
  if (!params.token || !tokenProvider || !expectedProviders.includes(tokenProvider)) {
    return undefined;
  }
  const apiKey = params.normalize(params.token);
  await params.setCredential(apiKey, params.secretInputMode);
  return apiKey;
}

export async function ensureApiKeyFromOptionEnvOrPrompt(params: {
  token: string | undefined;
  tokenProvider: string | undefined;
  secretInputMode?: SecretInputMode;
  config: OpenClawConfig;
  expectedProviders: string[];
  provider: string;
  envLabel: string;
  promptMessage: string;
  normalize: (value: string) => string;
  validate: (value: string) => string | undefined;
  prompter: WizardPrompter;
  setCredential: (apiKey: SecretInput, mode?: SecretInputMode) => Promise<void>;
  noteMessage?: string;
  noteTitle?: string;
  i18n: I18nContext;
}): Promise<string> {
  const optionApiKey = await maybeApplyApiKeyFromOption({
    token: params.token,
    tokenProvider: params.tokenProvider,
    secretInputMode: params.secretInputMode,
    expectedProviders: params.expectedProviders,
    normalize: params.normalize,
    setCredential: params.setCredential,
  });
  if (optionApiKey) {
    return optionApiKey;
  }

  if (params.noteMessage) {
    await params.prompter.note(params.noteMessage, params.noteTitle);
  }

  return await ensureApiKeyFromEnvOrPrompt({
    config: params.config,
    provider: params.provider,
    envLabel: params.envLabel,
    promptMessage: params.promptMessage,
    normalize: params.normalize,
    validate: params.validate,
    prompter: params.prompter,
    secretInputMode: params.secretInputMode,
    setCredential: params.setCredential,
    i18n: params.i18n,
  });
}

export async function ensureApiKeyFromEnvOrPrompt(params: {
  config: OpenClawConfig;
  provider: string;
  envLabel: string;
  promptMessage: string;
  normalize: (value: string) => string;
  validate: (value: string) => string | undefined;
  prompter: WizardPrompter;
  secretInputMode?: SecretInputMode;
  setCredential: (apiKey: SecretInput, mode?: SecretInputMode) => Promise<void>;
  i18n: I18nContext;
}): Promise<string> {
  const selectedMode = await resolveSecretInputModeForEnvSelection({
    prompter: params.prompter,
    explicitMode: params.secretInputMode,
    i18n: params.i18n,
  });
  const envKey = resolveEnvApiKey(params.provider);

  if (selectedMode === "ref") {
    if (typeof params.prompter.select !== "function") {
      const fallback = resolveRefFallbackInput({
        config: params.config,
        provider: params.provider,
        preferredEnvVar: envKey?.source ? extractEnvVarFromSourceLabel(envKey.source) : undefined,
        i18n: params.i18n,
      });
      await params.setCredential(fallback.ref, selectedMode);
      return fallback.resolvedValue;
    }
    const resolved = await resolveApiKeyRefForOnboarding({
      provider: params.provider,
      config: params.config,
      prompter: params.prompter,
      preferredEnvVar: envKey?.source ? extractEnvVarFromSourceLabel(envKey.source) : undefined,
      i18n: params.i18n,
    });
    await params.setCredential(resolved.ref, selectedMode);
    return resolved.resolvedValue;
  }

  if (envKey && selectedMode === "plaintext") {
    const t = params.i18n.t.authChoice.apiKeyPrompt;
    const useExisting = await params.prompter.confirm({
      message: t.useExisting
        .replace("{envLabel}", params.envLabel)
        .replace("{source}", envKey.source)
        .replace("{preview}", formatApiKeyPreview(envKey.apiKey)),
      initialValue: true,
    });
    if (useExisting) {
      await params.setCredential(envKey.apiKey, selectedMode);
      return envKey.apiKey;
    }
  }

  const key = await params.prompter.text({
    message: params.promptMessage,
    validate: params.validate,
  });
  const apiKey = params.normalize(String(key ?? ""));
  await params.setCredential(apiKey, selectedMode);
  return apiKey;
}
