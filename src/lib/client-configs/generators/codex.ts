import { join } from "node:path";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import type { ProxyConnectionInfo, ClientConfigResult } from "../types";
import {
  readJsonObject,
  writeJsonObject,
  writeText,
  exists,
  upsertRootTomlString,
  removeTomlSection,
  escapeTomlString,
} from "./utils";

function getCodexAuthPath(): string {
  return join(homedir(), ".codex", "auth.json");
}

function getCodexConfigPath(): string {
  return join(homedir(), ".codex", "config.toml");
}

function upsertCodexConfig(content: string, info: ProxyConnectionInfo): string {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const withProvider = upsertRootTomlString(
    upsertRootTomlString(content, "model_provider", "etteum"),
    "model",
    info.modelId
  );
  const withoutEtteum = removeTomlSection(
    removeTomlSection(withProvider, "model_providers.etteum"),
    'model_providers."etteum"'
  );
  const separator = withoutEtteum.trim() ? `${newline}${newline}` : "";
  return `${withoutEtteum.trimEnd()}${separator}[model_providers.etteum]${newline}name = "Etteum Pool"${newline}base_url = "${escapeTomlString(
    info.openaiBaseUrl
  )}"${newline}wire_api = "responses"${newline}`;
}

export async function configureCodex(
  info: ProxyConnectionInfo
): Promise<Omit<ClientConfigResult, "client">> {
  const authPath = getCodexAuthPath();
  const configPath = getCodexConfigPath();
  try {
    // Preview/dry-run: compute the would-be config without touching disk,
    // matching the other generators (opencode.ts) that honor info.preview.
    const auth = info.preview ? {} : await readJsonObject(authPath);
    auth.OPENAI_API_KEY = info.apiKey;
    const authBackups = info.preview ? [] : await writeJsonObject(authPath, auth);

    const config = info.preview
      ? ""
      : (await exists(configPath))
        ? await readFile(configPath, "utf-8")
        : "";
    const configBackups = info.preview ? [] : await writeText(configPath, upsertCodexConfig(config, info));

    return {
      success: true,
      preview: { auth: { OPENAI_API_KEY: "***" }, toml: upsertCodexConfig(config, info) },
      paths: [authPath, configPath],
      backupPaths: [...authBackups, ...configBackups],
    };
  } catch (error) {
    return {
      success: false,
      paths: [authPath, configPath],
      backupPaths: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
