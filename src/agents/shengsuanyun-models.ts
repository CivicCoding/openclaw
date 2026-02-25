import type { ModelApi, ModelDefinitionConfig } from "../config/types.js";
export const SHENGSUANYUN_BASE_URL = "https://router.shengsuanyun.com/api/v1";
export const SHENGSUANYUN_MODALITIES_BASE_URL = "https://api.shengsuanyun.com/modelrouter";

// ShengSuanYun uses credit-based pricing. Set to 0 as costs vary by model.
export const SHENGSUANYUN_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export interface ShengSuanYunModel {
  id: string;
  company: string;
  api?: ModelApi;
  name: string;
  api_name: string;
  description: string;
  max_tokens: number;
  context_window: number;
  supports_prompt_cache: boolean;
  architecture: {
    input: string;
    output: string;
    tokenizer: string;
  };
  pricing: {
    prompt: number;
    completion: number;
    cache: number;
    image: number;
    request: number;
  };
  support_apis: string[];
}

interface ShengSuanYunModelsResponse {
  data: ShengSuanYunModel[];
  object: string;
  success: boolean;
}

interface ShengSuanYunModalitiesResponse {
  code: number;
  data: {
    infos: { id: number }[];
  };
}

export type MModel = {
  id: number;
  api?: ModelApi;
  company_name: string;
  model_name: string;
  api_name: string;
  class_names: Array<string>;
  desc: string;
  input_schema: string;
  output_schema: string;
  example: {
    input: string;
    output: string;
    logs: string;
    predict_time: number;
  };
  pricing: {
    price: number;
    input_price: number;
    output_price: number;
    other_price: string;
    currency: string;
    price_schema: string;
  };
};
export type MMRes = {
  code: number;
  data?: MModel;
  msg: string;
};

export interface TaskRes {
  code?: string;
  message?: string;
  data?: {
    progress?: string;
    request_id?: string;
    status?: string;
    fail_reason?: string;
    data?: {
      image_urls?: string[];
      progress?: number;
      error?: string;
    };
  };
}
/**
 * Determine if a model supports reasoning based on its name and description.
 */
function isReasoningModel(model: ShengSuanYunModel): boolean {
  const lowerName = (model.name ?? "").toLowerCase();
  const lowerId = (model.id ?? "").toLowerCase();
  const lowerDesc = (model.description ?? "").toLowerCase();

  return (
    lowerName.includes("thinking") ||
    lowerName.includes("reasoning") ||
    lowerName.includes("reason") ||
    lowerName.includes("r1") ||
    lowerId.includes("thinking") ||
    lowerId.includes("reasoning") ||
    lowerId.includes("r1") ||
    lowerDesc.includes("reasoning") ||
    lowerDesc.includes("thinking")
  );
}

/**
 * Determine if a model supports vision/image inputs.
 */
function supportsVision(model: ShengSuanYunModel): boolean {
  const modality = (model.architecture?.input ?? "").toLowerCase();
  return (
    modality.includes("image") || modality.includes("vision") || modality === "text+image->text"
  );
}

// Default models shown before API discovery (e.g., during onboarding)
const DEFAULT_SHENGSUANYUN_MODELS: ModelDefinitionConfig[] = [
  {
    id: "google/gemini-3-flash",
    name: "Gemini 3 Flash Preview",
    reasoning: false,
    api: "openai-completions",
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 1048576,
    maxTokens: 65535,
  },
  {
    id: "anthropic/claude-opus-4.5",
    name: "Claude Opus 4.5",
    reasoning: false,
    api: "openai-completions",
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 200000,
    maxTokens: 64000,
  },
  {
    id: "anthropic/claude-sonnet-4.5:thinking",
    name: "Claude Sonnet 4.5 Thinking",
    reasoning: true,
    api: "openai-completions",
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 200000,
    maxTokens: 64000,
  },
  {
    id: "anthropic/claude-haiku-4.5",
    name: "Claude Haiku 4.5",
    reasoning: false,
    api: "openai-completions",
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 200000,
    maxTokens: 64000,
  },
  {
    id: "anthropic/claude-sonnet-4.5",
    name: "Claude Sonnet 4.5",
    reasoning: false,
    api: "openai-completions",
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 200000,
    maxTokens: 64000,
  },
  {
    id: "anthropic/claude-haiku-4.5:thinking",
    name: "Claude Haiku 4.5 Thinking",
    reasoning: true,
    api: "openai-completions",
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 200000,
    maxTokens: 64000,
  },
  {
    id: "anthropic/claude-opus-4.6",
    name: "Claude Opus 4.6",
    reasoning: false,
    api: "openai-completions",
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 1000000,
    maxTokens: 128000,
  },
  {
    id: "anthropic/claude-sonnet-4.6",
    name: "Claude Sonnet 4.6",
    reasoning: false,
    api: "openai-completions",
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 200000,
    maxTokens: 64000,
  },
  {
    id: "openai/gpt-5-nano",
    name: "GPT-5-Nano",
    reasoning: false,
    api: "openai-completions",
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 400000,
    maxTokens: 128000,
  },
  {
    id: "anthropic/claude-opus-4",
    name: "Claude Opus 4",
    reasoning: false,
    api: "openai-completions",
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 200000,
    maxTokens: 32000,
  },
  {
    id: "anthropic/claude-opus-4.1",
    name: "Claude Opus 4.1",
    reasoning: false,
    api: "openai-completions",
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 200000,
    maxTokens: 32000,
  },
];

export async function getShengSuanYunModels(): Promise<ModelDefinitionConfig[]> {
  // Skip API network discovery in test environment
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return DEFAULT_SHENGSUANYUN_MODELS;
  }
  try {
    const res = await fetch(`${SHENGSUANYUN_BASE_URL}/models`, {
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      // Return default models if API call fails
      return DEFAULT_SHENGSUANYUN_MODELS;
    }
    const data = (await res.json()) as ShengSuanYunModelsResponse;
    if (!data.success || !Array.isArray(data.data) || data.data.length === 0) {
      // Return default models if response is invalid
      return DEFAULT_SHENGSUANYUN_MODELS;
    }

    const models: ModelDefinitionConfig[] = [];
    for (const apiModel of data.data) {
      const supportApis = apiModel.support_apis;
      if (!Array.isArray(supportApis)) {
        continue;
      }
      if (!supportApis.includes("/v1/chat/completions")) {
        continue;
      }
      const hasVision = supportsVision(apiModel);
      const reasoning = isReasoningModel(apiModel);
      models.push({
        id: apiModel.id,
        name: apiModel.name,
        reasoning,
        api: "openai-completions",
        input: hasVision ? ["text", "image"] : ["text"],
        cost: SHENGSUANYUN_DEFAULT_COST,
        contextWindow: apiModel.context_window || 128000,
        maxTokens: apiModel.max_tokens || 8192,
      });
    }
    // If API returned models, use them; otherwise fallback to defaults
    return models.length > 0 ? models : DEFAULT_SHENGSUANYUN_MODELS;
  } catch (error) {
    console.warn(`[shengsuanyun-models] failed: ${String(error)}`);
    // Return default models if fetch throws
    return DEFAULT_SHENGSUANYUN_MODELS;
  }
}

export async function getShengSuanYunModalityModels(): Promise<MModel[]> {
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return [];
  }
  try {
    const res = await fetch(
      `${SHENGSUANYUN_MODALITIES_BASE_URL}/modalities/list?page=1&page_size=200`,
      {
        signal: AbortSignal.timeout(30000),
      },
    );
    if (!res.ok) {
      console.log(
        `[shengsuanyun-models] Modalities list fetch failed: ${res.status} ${res.statusText}`,
      );
      return [];
    }
    const data = (await res.json()) as ShengSuanYunModalitiesResponse;
    if (data.code !== 0 || !Array.isArray(data.data.infos) || data.data.infos.length === 0) {
      console.log(
        `[shengsuanyun-models] Invalid response: code=${data.code}, infos=${data.data?.infos?.length ?? 0}`,
      );
      return [];
    }
    const batchSize = 10;
    const results: MModel[] = [];

    for (let i = 0; i < data.data.infos.length; i += batchSize) {
      const batch = data.data.infos.slice(i, i + batchSize);
      const batchPromises = batch.map(async (model: { id: number }): Promise<MModel | null> => {
        try {
          const res = await fetch(
            `${SHENGSUANYUN_MODALITIES_BASE_URL}/modalities/info?model_id=${model.id}`,
            {
              signal: AbortSignal.timeout(60000),
            },
          );
          if (!res.ok) {
            return null;
          }
          const data = await res.json();
          if (data.code !== 0 || !data.data) {
            return null;
          }
          return { ...data.data, api: "shengsuanyun-modality" } as MModel;
        } catch (err) {
          console.error(`[shengsuanyun-models] Failed to fetch model ${model.id}:`, err);
          return null;
        }
      });

      const batchResults = await Promise.all(batchPromises);
      const filtered = batchResults.filter((m): m is MModel => m !== null);
      results.push(...filtered);
      if (i + batchSize < data.data.infos.length) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    console.log(`[shengsuanyun-models] Loaded ${results.length} modality models total`);
    return results;
  } catch (err) {
    console.error("[shengsuanyun-models] Error fetching modality models:", err);
    return [];
  }
}
