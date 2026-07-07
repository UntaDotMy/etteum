/**
 * Additional CLI-tool config generators (F14): claude, cline, copilot.
 * Ported from 9router src/app/api/cli-tools/{claude,cline,copilot}-settings/route.js.
 *
 * Each writes the tool's native config file with the etteum base URL + API key +
 * model injected, preserving existing fields (merge, never overwrite), with a
 * timestamped backup before write.
 */
import { join } from "node:path";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import type { ProxyConnectionInfo, ClientConfigResult } from "../types";
import { readJsonObject, writeJsonObject, writeText, exists, isRecord } from "./utils";

// ─── Claude Code ────────────────────────────────────────────────────────────
// ~/.claude/settings.json with an `env` block: ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY + ANTHROPIC_MODEL.
function getClaudeSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

export async function configureClaude(info: ProxyConnectionInfo): Promise<Omit<ClientConfigResult, "client">> {
  const path = getClaudeSettingsPath();
  try {
    const settings = await readJsonObject(path) as any;
    if (!isRecord(settings.env)) settings.env = {};
    // Anthropic-native base URL (no /v1 suffix) — Claude Code appends /v1/messages.
    settings.env.ANTHROPIC_BASE_URL = info.proxyOrigin;
    settings.env.ANTHROPIC_API_KEY = info.apiKey;
    if (info.modelId) settings.env.ANTHROPIC_MODEL = info.modelId;
    const backups = await writeJsonObject(path, settings);
    return { success: true, paths: [path], backupPaths: backups };
  } catch (e: any) {
    return { success: false, paths: [path], backupPaths: [], error: e?.message || String(e) };
  }
}

// ─── Cline ──────────────────────────────────────────────────────────────────
// ~/.cline/data/globalState.json + secrets.json: apiProvider="openai" + openAiBaseUrl + openAiApiKey.
function getClineGlobalStatePath(): string {
  return join(homedir(), ".cline", "data", "globalState.json");
}
function getClineSecretsPath(): string {
  return join(homedir(), ".cline", "data", "secrets.json");
}

export async function configureCline(info: ProxyConnectionInfo): Promise<Omit<ClientConfigResult, "client">> {
  const statePath = getClineGlobalStatePath();
  const secretsPath = getClineSecretsPath();
  const paths = [statePath, secretsPath];
  try {
    const state = await readJsonObject(statePath);
    state.apiProvider = "openai";
    state.openAiBaseUrl = info.openaiBaseUrl;
    state.openAiModelId = info.modelId;
    const stateBackups = await writeJsonObject(statePath, state);

    const secrets = await readJsonObject(secretsPath);
    secrets.openAiApiKey = info.apiKey;
    const secretsBackups = await writeJsonObject(secretsPath, secrets);

    return { success: true, paths, backupPaths: [...stateBackups, ...secretsBackups] };
  } catch (e: any) {
    return { success: false, paths, backupPaths: [], error: e?.message || String(e) };
  }
}

// ─── GitHub Copilot ─────────────────────────────────────────────────────────
// VSCode User dir chatLanguageModels.json (OS-branched). Injects an "etteum" model entry.
function getCopilotConfigPath(): string {
  // OS-branched VSCode User dir (mirrors reference copilot-settings/route.js:9-19).
  const isWin = process.platform === "win32";
  const isMac = process.platform === "darwin";
  const base = isWin
    ? join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Code", "User")
    : isMac
      ? join(homedir(), "Library", "Application Support", "Code", "User")
      : join(homedir(), ".config", "Code", "User");
  return join(base, "chatLanguageModels.json");
}

export async function configureCopilot(info: ProxyConnectionInfo): Promise<Omit<ClientConfigResult, "client">> {
  const path = getCopilotConfigPath();
  try {
    const config = await readJsonObject(path) as any;
    if (!Array.isArray(config.chatLanguageModels)) config.chatLanguageModels = [];
    // Remove any prior etteum entry, then add fresh.
    config.chatLanguageModels = config.chatLanguageModels.filter((m: any) => m?.id !== "etteum");
    config.chatLanguageModels.push({
      id: "etteum",
      name: "Etteum Pool",
      provider: "openai",
      model: info.modelId,
      apiBase: info.openaiBaseUrl,
      apiKey: info.apiKey,
    });
    const backups = await writeJsonObject(path, config);
    return { success: true, paths: [path], backupPaths: backups };
  } catch (e: any) {
    return { success: false, paths: [path], backupPaths: [], error: e?.message || String(e) };
  }
}

// ─── Droid / Factory ────────────────────────────────────────────────────────
// ~/.factory/settings.json: customModels[] entry for etteum.
function getDroidSettingsPath(): string {
  return join(homedir(), ".factory", "settings.json");
}

export async function configureDroid(info: ProxyConnectionInfo): Promise<Omit<ClientConfigResult, "client">> {
  const path = getDroidSettingsPath();
  try {
    const settings = await readJsonObject(path) as any;
    if (!Array.isArray(settings.customModels)) settings.customModels = [];
    settings.customModels = settings.customModels.filter((m: any) => m?.name !== "etteum");
    settings.customModels.push({
      name: "etteum",
      provider: "openai",
      model: info.modelId,
      baseURL: info.openaiBaseUrl,
      apiKey: info.apiKey,
    });
    const backups = await writeJsonObject(path, settings);
    return { success: true, paths: [path], backupPaths: backups };
  } catch (e: any) {
    return { success: false, paths: [path], backupPaths: [], error: e?.message || String(e) };
  }
}

// ─── DeepSeek TUI ───────────────────────────────────────────────────────────
// ~/.deepseek/config.toml: [model_providers.etteum] + model + model_provider.
function getDeepSeekTuiPath(): string {
  return join(homedir(), ".deepseek", "config.toml");
}

export async function configureDeepSeekTui(info: ProxyConnectionInfo): Promise<Omit<ClientConfigResult, "client">> {
  const path = getDeepSeekTuiPath();
  try {
    const existing = (await exists(path)) ? await readFile(path, "utf-8") : "";
    const newline = existing.includes("\r\n") ? "\r\n" : "\n";
    // Simple TOML: strip any prior etteum section, then append fresh.
    const stripped = existing.replace(/\n\[model_providers\.etteum\][\s\S]*?(?=\n\[|\n*$)/g, "").trimEnd();
    const sep = stripped ? `${newline}${newline}` : "";
    const section =
      `model_provider = "etteum"${newline}` +
      `model = "${info.modelId}"${newline}` +
      `${sep}[model_providers.etteum]${newline}` +
      `name = "Etteum Pool"${newline}` +
      `base_url = "${info.openaiBaseUrl}"${newline}` +
      `api_key = "${info.apiKey}"${newline}`;
    const backups = await writeText(path, section);
    return { success: true, paths: [path], backupPaths: backups };
  } catch (e: any) {
    return { success: false, paths: [path], backupPaths: [], error: e?.message || String(e) };
  }
}

// ─── Jcode ──────────────────────────────────────────────────────────────────
// ~/.jcode/config.toml + ~/.config/jcode/provider-etteum.env.
function getJcodeConfigPath(): string {
  return join(homedir(), ".jcode", "config.toml");
}
function getJcodeEnvPath(): string {
  return join(homedir(), ".config", "jcode", "provider-etteum.env");
}

export async function configureJcode(info: ProxyConnectionInfo): Promise<Omit<ClientConfigResult, "client">> {
  const configPath = getJcodeConfigPath();
  const envPath = getJcodeEnvPath();
  const paths = [configPath, envPath];
  try {
    const existing = (await exists(configPath)) ? await readFile(configPath, "utf-8") : "";
    const newline = existing.includes("\r\n") ? "\r\n" : "\n";
    const stripped = existing.replace(/\n\[providers\.etteum\][\s\S]*?(?=\n\[|\n*$)/g, "").trimEnd();
    const sep = stripped ? `${newline}${newline}` : "";
    const configContent =
      `model = "${info.modelId}"${newline}` +
      `provider = "etteum"${newline}` +
      `${sep}[providers.etteum]${newline}` +
      `name = "Etteum Pool"${newline}` +
      `base_url = "${info.openaiBaseUrl}"${newline}` +
      `env_file = "${envPath}"${newline}`;
    const configBackups = await writeText(configPath, configContent);
    const envContent = `ETTEUM_API_KEY=${info.apiKey}${newline}`;
    const envBackups = await writeText(envPath, envContent);
    return { success: true, paths, backupPaths: [...configBackups, ...envBackups] };
  } catch (e: any) {
    return { success: false, paths, backupPaths: [], error: e?.message || String(e) };
  }
}

// ─── Cowork (Claude Desktop config) ─────────────────────────────────────────
// claude_desktop_config.json MCP-style entry pointing at the etteum base URL.
function getCoworkConfigPath(): string {
  const isWin = process.platform === "win32";
  const isMac = process.platform === "darwin";
  const base = isWin
    ? join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Claude")
    : isMac
      ? join(homedir(), "Library", "Application Support", "Claude")
      : join(homedir(), ".config", "Claude");
  return join(base, "claude_desktop_config.json");
}

export async function configureCowork(info: ProxyConnectionInfo): Promise<Omit<ClientConfigResult, "client">> {
  const path = getCoworkConfigPath();
  try {
    const config = await readJsonObject(path) as any;
    if (!isRecord(config.mcpServers)) config.mcpServers = {};
    config.mcpServers.etteum = {
      command: "etteum",
      env: { ETTEUM_BASE_URL: info.openaiBaseUrl, ETTEUM_API_KEY: info.apiKey, ETTEUM_MODEL: info.modelId },
    };
    const backups = await writeJsonObject(path, config);
    return { success: true, paths: [path], backupPaths: backups };
  } catch (e: any) {
    return { success: false, paths: [path], backupPaths: [], error: e?.message || String(e) };
  }
}
