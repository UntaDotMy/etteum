import { join } from "node:path";
import { homedir } from "node:os";
import type { ProxyConnectionInfo, ClientConfigResult } from "../types";
import {
  readJsonObject,
  writeJsonObject,
  ensureObjectField,
  resolveDefaultModel,
} from "./utils";

function getOpenClawConfigPath(): string {
  return join(homedir(), ".openclaw", "openclaw.json");
}

export async function configureOpenClaw(
  info: ProxyConnectionInfo
): Promise<Omit<ClientConfigResult, "client">> {
  const configPath = getOpenClawConfigPath();
  try {
    const config = info.preview ? {} : await readJsonObject(configPath);

    const models = ensureObjectField(config, "models");
    if (typeof models.mode !== "string") models.mode = "merge";
    const providers = ensureObjectField(models, "providers");
    providers.etteum = {
      base_url: info.openaiBaseUrl,
      api_key: info.apiKey,
      api: "openai-chat",
      models: info.models.map((m) => ({
        id: m.id,
        name: m.name || m.id,
        context_window:
          typeof m.maxInputTokens === "number" && m.maxInputTokens > 0
            ? m.maxInputTokens
            : 200000,
      })),
    };

    const agents = ensureObjectField(config, "agents");
    const defaults = ensureObjectField(agents, "defaults");
    const defaultModel = resolveDefaultModel(info);
    defaults.model = { primary: `etteum/${defaultModel}`, fallbacks: [] };

    const backups = info.preview ? [] : await writeJsonObject(configPath, config);
    return {
      success: true,
      preview: config,
      paths: [configPath],
      backupPaths: backups,
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
