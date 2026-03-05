import { ImageContent, TextContent } from "@mariozechner/pi-ai";
import { Type, type TSchema } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../../config/config.ts";
import { loadConfig } from "../../../config/config.ts";
import { resolveApiKeyForProvider } from "../../model-auth.ts";
import {
  getShengSuanYunModalityModels,
  SHENGSUANYUN_BASE_URL,
  TaskRes,
} from "../../shengsuanyun-models.ts";
import { sanitizeToolResultImages } from "../../tool-images.ts";
import type { AnyAgentTool } from "../common.ts";
import { readStringParam, readStringArrayParam, readNumberParam } from "../common.ts";
import { createGemini3ProImageTool } from "./gemini3pro-image-preview.ts";
import { saveMediaToWorkspace } from "./save-media.ts";
import { createZImageTurboTool } from "./zimage-turbo.ts";

export const APP_HEADERS: Record<string, string> = {
  "HTTP-Referer": "https://openclaw.ai",
  "X-Title": "OpenClaw",
  "Content-Type": "application/json",
};

async function generate(
  params: Record<string, unknown>,
): Promise<{ success: boolean; type?: string; Urls?: string[]; error?: string }> {
  try {
    const { apiKey, ...rest } = params;
    const res = await fetch(`${SHENGSUANYUN_BASE_URL}/tasks/generations`, {
      method: "POST",
      headers: {
        ...APP_HEADERS,
        Authorization: `Bearer ${apiKey as string}`,
      },
      body: JSON.stringify(rest),
    });

    if (!res.ok) {
      return { success: false, error: `API Error: ${res.statusText}` };
    }
    const data = (await res.json()) as TaskRes;
    if (data.code != "success" || !data.data?.request_id) {
      return { success: false, error: data.message || "No image URL returned in response" };
    }
    let errorCount = 0;
    while (true) {
      try {
        const imgs = await fetch(
          `${SHENGSUANYUN_BASE_URL}/tasks/generations/${data.data?.request_id}`,
          {
            method: "GET",
            headers: {
              ...APP_HEADERS,
              Authorization: `Bearer ${String(params.apiKey)}`,
            },
            signal: AbortSignal.timeout(30000),
          },
        );
        if (!imgs.ok) {
          throw new Error("Network error");
        }

        const img_urls = (await imgs.json()) as TaskRes;
        if (img_urls.code != "success") {
          throw img_urls.message;
        }
        if (img_urls.data?.status === "FAILED") {
          return {
            success: false,
            error: img_urls.data?.fail_reason || "Image generation failed",
          };
        }
        const currentProgress = img_urls.data?.data?.progress || 0;
        if (currentProgress >= 100 || img_urls.data?.status === "SUCCEEDED") {
          const data = img_urls.data?.data || {};
          const mediaKeys = ["image_urls", "video_urls", "audio_urls"] as const;
          const foundKey = mediaKeys.find((key) => data[key]);
          return {
            success: true,
            type: foundKey,
            Urls: data.image_urls || data.video_urls || data.audio_urls,
          };
        }
        let waitTime = 10000;

        if (currentProgress >= 90) {
          waitTime = 2000;
        } else if (currentProgress >= 60) {
          waitTime = 5000;
        } else if (currentProgress >= 30) {
          waitTime = 10000;
        } else {
          waitTime = 15000;
        }
        await new Promise((resolve) => setTimeout(resolve, waitTime));
        errorCount = 0;
      } catch (e) {
        if (errorCount > 3) {
          console.log("polling error:", e);
          throw e;
        }
        errorCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_");
}

async function loadShengSuanYunTools(opts?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
}): Promise<AnyAgentTool[]> {
  const models = await getShengSuanYunModalityModels();
  const tools: AnyAgentTool[] = [];
  for (const model of models) {
    const label = `${model.company_name} ${model.model_name} Generate tool`;
    const name = sanitizeToolName(model.api_name);
    const description =
      model.desc +
      "\n\n 注意： 生成成功后我将把它下载保存到工作文件夹的 media_save 目录中。需要向用户返回这个文件链接。";
    let inputSchema: JsonSchema = {};
    try {
      inputSchema = JSON.parse(model.input_schema) as JsonSchema;
    } catch (e) {
      console.log(`[shengsuanyun-generate] Parse input_schema error for ${model.model_name}:`, e);
      continue;
    }
    let parameters: TSchema;
    try {
      parameters = generateTypebox(inputSchema);
    } catch (e) {
      console.error(`[shengsuanyun-generate] generateTypebox error for ${model.model_name}:`, e);
      continue;
    }
    tools.push({
      label,
      name,
      description,
      parameters: parameters,
      execute: async (_toolCallId, args) => {
        const cfg = opts?.config ?? loadConfig();
        const resolved = await resolveApiKeyForProvider({ provider: "shengsuanyun", cfg });
        if (!resolved.apiKey) {
          throw new Error(
            "胜算云 API key 未配置。媒体生成工具需要先配置 API Key, https://console.shengsuanyun.com/user/keys",
          );
        }
        const params = args as Record<string, unknown>;
        const apiParams: Record<string, unknown> = { model: model.api_name };
        const extractParams = (schema: JsonSchema) => {
          if (!schema.properties) {
            return;
          }
          for (const [key, prop] of Object.entries(schema.properties)) {
            const isRequired = schema.required?.includes(key);

            if (prop.type === "array") {
              const value = readStringArrayParam(params, key, { required: isRequired });
              if (value !== undefined) {
                apiParams[key] = value;
              }
            } else if (prop.type === "number" || prop.type === "integer") {
              const value = readNumberParam(params, key, { required: isRequired });
              if (value !== undefined) {
                apiParams[key] = value;
              }
            } else {
              const value = readStringParam(params, key, { required: isRequired });
              if (value !== undefined) {
                apiParams[key] = value;
              }
            }
          }
        };

        if (inputSchema.anyOf && Array.isArray(inputSchema.anyOf)) {
          for (const subSchema of inputSchema.anyOf) {
            extractParams(subSchema);
          }
        } else {
          extractParams(inputSchema);
        }

        const result = await generate({ ...apiParams, apiKey: resolved.apiKey });
        if (result.success && result.Urls) {
          let content: (TextContent | ImageContent)[] = [];
          if (opts?.workspaceDir) {
            for (const url of result.Urls) {
              try {
                const ctt = await saveMediaToWorkspace(
                  url,
                  opts.workspaceDir,
                  sanitizeToolName(model.api_name),
                );
                content.push(ctt);
              } catch (err) {
                content.push({ type: "text", text: url });
                console.log("saveMediaToWorkspace() function error:", err);
              }
            }
          } else {
            content = result.Urls.map((it) => ({ type: "text", text: it }));
          }
          const details = { Url: result.Urls.join(","), provider: "shengsuanyun" };
          return sanitizeToolResultImages({ details, content }, "胜算云多媒体生成工具查询成功！");
        }
        return {
          content: [
            {
              type: "text",
              text: result.error ?? "Content generation failed",
            },
          ],
          details: { error: result.error },
        };
      },
    });
  }
  console.log(`[shengsuanyun-generate] Loaded ${tools.length} dynamic tools`);
  return tools;
}

interface JsonSchema {
  $schema?: string;
  type?: string;
  title?: string;
  description?: string;
  default?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  enum?: Array<string | number>;
  format?: string;
  ssy?: string;
  [key: string]: unknown;
}

export function generateTypebox(schema: JsonSchema): TSchema {
  const getOptions = (s: JsonSchema): Record<string, unknown> => {
    const options: Record<string, unknown> = {};
    if (s.title) {
      options.title = s.title;
    }
    if (s.description) {
      options.description = s.description;
    }
    if (s.default !== undefined) {
      options.default = s.default;
    }
    return options;
  };

  const parse = (node: JsonSchema): TSchema => {
    const options = getOptions(node);

    // Handle anyOf: merge all properties from all schemas (workaround for Union restriction)
    // This makes all fields optional and available
    if (node.anyOf && Array.isArray(node.anyOf)) {
      const allProps: Record<string, TSchema> = {};
      const allRequired = new Set<string>();

      for (const subSchema of node.anyOf) {
        if (subSchema.properties) {
          for (const [key, value] of Object.entries(subSchema.properties)) {
            // If we haven't seen this property yet, or if it's required in any schema
            if (!allProps[key]) {
              allProps[key] = parse(value);
            }
            // Track if this property is required in any of the anyOf schemas
            if (
              subSchema.required &&
              Array.isArray(subSchema.required) &&
              subSchema.required.includes(key)
            ) {
              allRequired.add(key);
            }
          }
        }
      }
      const props: Record<string, TSchema> = {};
      for (const [key, schema] of Object.entries(allProps)) {
        props[key] = Type.Optional(schema);
      }

      return Type.Object(props, Object.keys(options).length > 0 ? options : undefined);
    }

    // Handle enum using Type.Unsafe to create a valid string enum (as per tool schema guardrails)
    if (node.enum && Array.isArray(node.enum)) {
      // Use Type.Unsafe to create a proper enum schema that validators accept
      const enumValues = node.enum;
      return Type.Unsafe<string | number>({
        type: typeof enumValues[0] === "number" ? "number" : "string",
        enum: enumValues,
        ...options,
      });
    }

    // Handle object type
    if (node.type === "object" || node.properties) {
      if (!node.properties) {
        return Type.Object({}, Object.keys(options).length > 0 ? options : undefined);
      }

      const props: Record<string, TSchema> = {};
      for (const [key, value] of Object.entries(node.properties)) {
        const isRequired =
          node.required && Array.isArray(node.required) && node.required.includes(key);
        const propSchema = parse(value);
        props[key] = isRequired ? propSchema : Type.Optional(propSchema);
      }

      return Type.Object(props, Object.keys(options).length > 0 ? options : undefined);
    }

    // Handle array type
    if (node.type === "array") {
      const itemsSchema = node.items ? parse(node.items) : Type.Any();
      return Type.Array(itemsSchema, Object.keys(options).length > 0 ? options : undefined);
    }

    // Handle primitive types
    if (node.type === "string" || (!node.type && !node.anyOf && !node.enum)) {
      return Type.String(Object.keys(options).length > 0 ? options : undefined);
    }
    if (node.type === "number" || node.type === "integer") {
      return Type.Number(Object.keys(options).length > 0 ? options : undefined);
    }
    if (node.type === "boolean") {
      return Type.Boolean(Object.keys(options).length > 0 ? options : undefined);
    }

    return Type.Unknown();
  };
  return parse(schema);
}

let cachedTools: AnyAgentTool[] | null = null;
let loadPromise: Promise<AnyAgentTool[]> | null = null;
let fallbackToolsCache: AnyAgentTool[] | null = null;

function getFallbackTools(opts?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
}): AnyAgentTool[] {
  if (fallbackToolsCache === null) {
    fallbackToolsCache = [createZImageTurboTool(opts), createGemini3ProImageTool(opts)];
  }
  return fallbackToolsCache;
}

export async function preloadShengSuanYunTools(opts?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
}): Promise<void> {
  if (cachedTools !== null) {
    return;
  }

  if (loadPromise !== null) {
    await loadPromise;
    return;
  }
  loadPromise = loadShengSuanYunTools(opts)
    .then((tools) => {
      const fallbackTools = getFallbackTools(opts);
      cachedTools = [...tools, ...fallbackTools];
      return cachedTools;
    })
    .catch((err) => {
      console.error("[shengsuanyun-generate] Failed to load tools, using fallback only:", err);
      cachedTools = getFallbackTools(opts);
      return cachedTools;
    })
    .finally(() => {
      loadPromise = null;
    });
  await loadPromise;
}

export function createGenerateTools(opts?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
}): AnyAgentTool[] {
  console.log(
    `[shengsuanyun-generate] createGenerateTools() called, cachedTools: ${cachedTools ? `${cachedTools.length} tools` : "null"}`,
  );
  if (cachedTools !== null) {
    console.log(`[shengsuanyun-generate] Returning ${cachedTools.length} cached tools`);
    return cachedTools;
  }
  console.log(
    "[shengsuanyun-generate] cachedTools is null, starting background preload and returning fallback tools",
  );
  preloadShengSuanYunTools(opts).catch((err) => {
    console.error("[shengsuanyun-generate] Background preload failed:", err);
  });
  const fallbackTools = getFallbackTools(opts);
  console.log(`[shengsuanyun-generate] Returning ${fallbackTools.length} fallback tools`);
  return fallbackTools;
}
