import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import type { ProxyConnectionInfo, ProxyClientModel, ClientConfigResult } from "../types";
import {
  readJsonObject,
  writeJsonObject,
  ensureObjectField,
  inputModalities,
  contextLimit,
  outputLimit,
  resolveDefaultModel,
} from "./utils";

function getOpenCodeConfigPath(): string {
  const dir = join(homedir(), ".config", "opencode");
  const candidates = [join(dir, "opencode.json"), join(dir, "config.json")];
  return candidates.find((p) => existsSync(p)) || candidates[0]!;
}

function openCodeModelConfig(model: ProxyClientModel): Record<string, unknown> {
  const modalities = inputModalities(model);
  const isReasoning =
    model.id.toLowerCase().includes("thinking") ||
    model.id.toLowerCase().includes("reasoning") ||
    model.id.toLowerCase().includes("o1-") ||
    model.id.toLowerCase().includes("o3-");

  return {
    name: model.id,
    attachment: modalities.some((item) => item !== "text"),
    reasoning: isReasoning,
    temperature: !isReasoning,
    tool_call: true,
    limit: {
      context: contextLimit(model),
      output: outputLimit(model),
    },
    modalities: {
      input: modalities,
      output: ["text"],
    },
    ...(isReasoning ? { options: { reasoningEffort: "high" } } : {}),
  };
}

export async function configureOpenCode(
  info: ProxyConnectionInfo
): Promise<Omit<ClientConfigResult, "client">> {
  const configPath = getOpenCodeConfigPath();
  try {
    // Preview mode: generate a clean etteum-only config
    // Apply mode: merge with existing config
    const config = info.preview ? {} : await readJsonObject(configPath);
    const provider = ensureObjectField(config, "provider");
    provider.etteum = {
      npm: "@ai-sdk/openai-compatible",
      name: "Etteum Pool",
      options: {
        baseURL: info.openaiBaseUrl,
        apiKey: info.apiKey,
      },
      models: Object.fromEntries(
        (info.models.length > 0 ? info.models : [{
          id: info.modelId, maxInputTokens: 200000, maxOutputTokens: 64000, inputTypes: ["text"],
        } as any]).map((model: any) => [model.id, openCodeModelConfig(model)])
      ),
    };
    config.$schema =
      typeof config.$schema === "string"
        ? config.$schema
        : "https://opencode.ai/config.json";
    const defaultModel = resolveDefaultModel(info);
    config.model = `etteum/${defaultModel}`;
    if (typeof config.small_model !== "string" || config.small_model.startsWith("etteum/")) {
      config.small_model = `etteum/${defaultModel}`;
    }
    if (
      Array.isArray(config.enabled_providers) &&
      !config.enabled_providers.includes("etteum")
    ) {
      config.enabled_providers = [...(config.enabled_providers as string[]), "etteum"];
    }

    const backupPaths = info.preview ? [] : await writeJsonObject(configPath, config);
    return {
      success: true,
      preview: config,
      paths: [configPath],
      backupPaths,
    };
  } catch (error) {
    return {
      success: false,
      paths: [configPath],
      backupPaths: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
