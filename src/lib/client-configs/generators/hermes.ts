import { join } from "node:path";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import type { ProxyConnectionInfo, ClientConfigResult } from "../types";
import { writeText, exists } from "./utils";

function getHermesConfigPath(): string {
  return join(homedir(), ".hermes", "config.yaml");
}

export async function configureHermes(
  info: ProxyConnectionInfo
): Promise<Omit<ClientConfigResult, "client">> {
  const configPath = getHermesConfigPath();
  try {
    const existing = (await exists(configPath))
      ? await readFile(configPath, "utf-8")
      : "";
    const newline = existing.includes("\r\n") ? "\r\n" : "\n";

    const modelsYaml = info.models
      .map((m) => {
        const ctx =
          typeof m.maxInputTokens === "number" && m.maxInputTokens > 0
            ? m.maxInputTokens
            : 200000;
        return `      ${m.id}:${newline}        context_length: ${ctx}`;
      })
      .join(newline);

    const providerBlock = [
      `  - name: etteum`,
      `    base_url: ${info.openaiBaseUrl}`,
      `    api_key: ${info.apiKey}`,
      `    model: ${info.modelId}`,
      `    models:`,
      modelsYaml,
    ].join(newline);

    let content = existing;
    const kiroProviderRegex = /^\s*- name:\s*etteum\b[\s\S]*?(?=^\s*- name:|^[a-z]|$)/gm;
    if (kiroProviderRegex.test(content)) {
      content = content.replace(kiroProviderRegex, providerBlock + newline);
    } else if (content.includes("custom_providers:")) {
      content = content.replace(
        /(custom_providers:\s*)/,
        `$1${newline}${providerBlock}${newline}`
      );
    } else {
      content = `${content.trimEnd()}${newline}${newline}custom_providers:${newline}${providerBlock}${newline}`;
    }

    const modelSection = `model:${newline}  default: "etteum/${info.modelId}"${newline}  provider: "etteum"${newline}`;
    if (/^model:/m.test(content)) {
      content = content.replace(/^model:.*(?:\n(?=\s).*)*$/m, modelSection.trimEnd());
    } else {
      content = `${content.trimEnd()}${newline}${newline}${modelSection}`;
    }

    const backups = await writeText(configPath, content);
    return {
      success: true,
      preview: { yaml: content },
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
