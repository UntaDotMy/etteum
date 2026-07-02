/**
 * Shared utilities for client config generators.
 * Adapted from kiro-unified frontend/src/main/proxy/clients/utils.ts.
 */
import { constants } from "node:fs";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ProxyClientModel, ProxyConnectionInfo } from "../types";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strip JSONC comments (line-style and block-style) and trailing commas. */
export function stripJsonc(content: string): string {
  let output = "";
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let index = 0; index < content.length; index++) {
    const current = content[index] as string;
    const next = content[index + 1] as string | undefined;

    if (inString) {
      output += current;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (current === "\\") {
        escaped = true;
        continue;
      }
      if (current === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }

    if (current === '"' || current === "'") {
      inString = true;
      quote = current;
      output += current;
      continue;
    }

    if (current === "/" && next === "/") {
      while (index < content.length && content[index] !== "\n") index++;
      output += "\n";
      continue;
    }

    if (current === "/" && next === "*") {
      index += 2;
      while (index < content.length && !(content[index] === "*" && content[index + 1] === "/")) index++;
      index++;
      continue;
    }

    output += current;
  }

  return removeTrailingJsonCommas(output);
}

function removeTrailingJsonCommas(content: string): string {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < content.length; index++) {
    const current = content[index] as string;

    if (inString) {
      output += current;
      if (escaped) { escaped = false; continue; }
      if (current === "\\") { escaped = true; continue; }
      if (current === '"') inString = false;
      continue;
    }

    if (current === '"') { inString = true; output += current; continue; }

    if (current === ",") {
      let nextIndex = index + 1;
      while (nextIndex < content.length && /\s/.test(content[nextIndex]!)) nextIndex++;
      if (content[nextIndex] === "}" || content[nextIndex] === "]") continue;
    }

    output += current;
  }
  return output;
}

export function parseJsonObject(content: string, path: string): Record<string, unknown> {
  const parsed = JSON.parse(stripJsonc(content));
  if (!isRecord(parsed)) throw new Error(`${path} root must be a JSON object`);
  return parsed;
}

export function escapeTomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function outputLimit(model: ProxyClientModel): number {
  if (typeof model.maxOutputTokens === "number" && model.maxOutputTokens > 0) return model.maxOutputTokens;
  if (model.id.toLowerCase().includes("haiku")) return 8192;
  return 32000;
}

export function contextLimit(model: ProxyClientModel): number {
  if (typeof model.maxInputTokens === "number" && model.maxInputTokens > 0) return model.maxInputTokens;
  return 200000;
}

export function inputModalities(model: ProxyClientModel): string[] {
  const values = new Set<string>(["text"]);
  for (const item of model.inputTypes ?? []) {
    const lower = item.toLowerCase();
    if (lower.includes("image")) values.add("image");
    if (lower.includes("pdf") || lower.includes("document") || lower.includes("file")) values.add("pdf");
  }
  return Array.from(values);
}

export async function exists(path: string): Promise<boolean> {
  return access(path, constants.F_OK).then(() => true, () => false);
}

export async function backupIfExists(path: string): Promise<string[]> {
  if (!(await exists(path))) return [];
  const backupPath = `${path}.etteum-backup-${Date.now()}`;
  await copyFile(path, backupPath);
  return [backupPath];
}

export async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  if (!(await exists(path))) return {};
  return parseJsonObject(await readFile(path, "utf-8"), path);
}

export async function writeJsonObject(path: string, value: Record<string, unknown>): Promise<string[]> {
  await mkdir(dirname(path), { recursive: true });
  const backupPaths = await backupIfExists(path);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  return backupPaths;
}

export async function writeText(path: string, value: string): Promise<string[]> {
  await mkdir(dirname(path), { recursive: true });
  const backupPaths = await backupIfExists(path);
  await writeFile(path, value.endsWith("\n") ? value : `${value}\n`, "utf-8");
  return backupPaths;
}

export function ensureObjectField(target: Record<string, unknown>, key: string): Record<string, unknown> {
  if (!isRecord(target[key])) target[key] = {};
  return target[key] as Record<string, unknown>;
}

export function upsertRootTomlString(content: string, key: string, value: string): string {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.length === 0 ? [] : content.split(/\r?\n/);
  const sectionIndex = lines.findIndex((line) => /^\s*\[/.test(line));
  const rootEnd = sectionIndex === -1 ? lines.length : sectionIndex;
  const nextLines: string[] = [];
  let written = false;

  for (let index = 0; index < lines.length; index++) {
    if (index < rootEnd && new RegExp(`^\\s*${key}\\s*=`).test(lines[index]!)) {
      if (!written) {
        nextLines.push(`${key} = "${escapeTomlString(value)}"`);
        written = true;
      }
      continue;
    }
    if (!written && index === rootEnd) {
      nextLines.push(`${key} = "${escapeTomlString(value)}"`);
      written = true;
    }
    nextLines.push(lines[index]!);
  }

  if (!written) nextLines.push(`${key} = "${escapeTomlString(value)}"`);
  return nextLines.join(newline);
}

export function removeTomlSection(content: string, section: string): string {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.length === 0 ? [] : content.split(/\r?\n/);
  const nextLines: string[] = [];
  let skipping = false;
  const escapedSection = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  for (const line of lines) {
    if (new RegExp(`^\\s*\\[${escapedSection}\\]\\s*$`).test(line)) {
      skipping = true;
      continue;
    }
    if (skipping && /^\s*\[/.test(line)) skipping = false;
    if (!skipping) nextLines.push(line);
  }

  return nextLines.join(newline).trimEnd();
}

export function resolveDefaultModel(info: ProxyConnectionInfo): string {
  if (info.modelId?.trim()) return info.modelId.trim();
  const models = info.models;
  return (
    models.find((m) => m.id.toLowerCase().includes("sonnet-4.6"))?.id ||
    models.find((m) => m.id.toLowerCase().includes("sonnet-4"))?.id ||
    models.find((m) => m.id.toLowerCase().includes("sonnet"))?.id ||
    models[0]?.id ||
    "kp-sonnet-4.6"
  );
}
