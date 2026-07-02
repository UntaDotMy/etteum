#!/usr/bin/env bun
/**
 * Etteum Pool — Client Integration CLI
 *
 * Detects installed AI coding clients and configures them to use the
 * etteum-pool proxy. Run from any machine; only needs the proxy URL and API key.
 *
 * Usage:
 *   bun scripts/integrate-clients.ts
 *       Interactive mode — detects clients, prompts for selection.
 *
 *   bun scripts/integrate-clients.ts --url http://localhost:1930 --key <KEY>
 *       Non-interactive — configures all detected clients.
 *
 *   bun scripts/integrate-clients.ts --url <URL> --key <KEY> --client claudeCode
 *       Configure only a specific client.
 *
 *   bun scripts/integrate-clients.ts --dry-run
 *       Preview configs without writing to disk.
 *
 *   bun scripts/integrate-clients.ts --restore
 *       Restore all backups created by this tool.
 *
 * Options:
 *   --url <url>       Proxy base URL (default: http://localhost:1930)
 *   --key <key>       API key for authentication
 *   --model <id>      Default model ID (default: kp-sonnet-4.6)
 *   --client <id>     Configure specific client (repeatable)
 *   --dry-run         Print configs without writing
 *   --restore         Restore backups instead of applying
 *   --help            Show this help
 */

import {
  getClientList,
  applyClientConfig,
  applyAllClients,
  type ClientTarget,
  type ProxyConnectionInfo,
} from "../src/lib/client-configs/index";
import { CLIENT_META } from "../src/lib/client-configs/types";
import { isClientDetected } from "../src/lib/client-configs/paths";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline";

// ── Argument Parsing ──────────────────────────────────────────

interface Options {
  url: string;
  key: string;
  model: string;
  clients: ClientTarget[];
  dryRun: boolean;
  restore: boolean;
  help: boolean;
}

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const opts: Options = {
    url: "http://localhost:1930",
    key: "",
    model: "kp-sonnet-4.6",
    clients: [],
    dryRun: false,
    restore: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    switch (arg) {
      case "--url":
        opts.url = args[++i] || opts.url;
        break;
      case "--key":
        opts.key = args[++i] || "";
        break;
      case "--model":
        opts.model = args[++i] || opts.model;
        break;
      case "--client":
        opts.clients.push((args[++i] || "") as ClientTarget);
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--restore":
        opts.restore = true;
        break;
      case "--help":
      case "-h":
        opts.help = true;
        break;
    }
  }

  return opts;
}

// ── Display Helpers ────────────────────────────────────────────

function header(text: string) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${text}`);
  console.log(`${"=".repeat(60)}`);
}

function success(text: string) {
  console.log(`  ✅ ${text}`);
}

function fail(text: string) {
  console.log(`  ❌ ${text}`);
}

function info(text: string) {
  console.log(`  ℹ️  ${text}`);
}

function warn(text: string) {
  console.log(`  ⚠️  ${text}`);
}

// ── Build Proxy Info ───────────────────────────────────────────

function buildProxyInfo(opts: Options): ProxyConnectionInfo {
  return {
    proxyOrigin: opts.url,
    openaiBaseUrl: `${opts.url}/v1`,
    apiKey: opts.key || "pool-proxy-secret-key",
    modelId: opts.model,
    models: [], // CLI doesn't have full model list, but generators still work
  };
}

// ── Restore ────────────────────────────────────────────────────

async function restoreAllBackups() {
  header("Restoring from backups");

  for (const clientId of Object.keys(CLIENT_META) as ClientTarget[]) {
    const meta = CLIENT_META[clientId];
    const { getPrimaryConfigPath } = await import(
      "../src/lib/client-configs/paths"
    );
    const configPath = getPrimaryConfigPath(clientId);
    const dir = path.dirname(configPath);

    let files: string[] = [];
    try {
      files = await fs.readdir(dir);
    } catch {
      continue;
    }

    const backups = files
      .filter((f) =>
        f.startsWith(path.basename(configPath) + ".etteum-backup-")
      )
      .sort()
      .reverse();

    if (backups.length === 0) {
      console.log(`  ${meta.name}: no backups found`);
      continue;
    }

    const latestBackup = path.join(dir, backups[0]!);
    await fs.copyFile(latestBackup, configPath);
    await fs.unlink(latestBackup);
    success(`${meta.name} restored from ${backups[0]}`);
  }

  console.log();
}

// ── Interactive Mode ───────────────────────────────────────────

async function interactiveMode(info: ProxyConnectionInfo) {
  const detected = getClientList().filter((c) => c.detected);

  if (detected.length === 0) {
    console.log("No AI coding clients detected on this system.");
    console.log("Supported clients:");
    for (const c of getClientList()) {
      console.log(`  - ${c.name} (${c.cli})`);
    }
    return;
  }

  header("Detected AI Coding Clients");
  detected.forEach((c, i) => {
    const marker = c.detected ? "✅" : "❌";
    console.log(`  ${i + 1}. ${marker} ${c.name} (${c.cli})`);
    console.log(`     ${c.configPaths[0]}`);
  });

  console.log(`\n  Proxy URL: ${info.proxyOrigin}`);
  console.log(`  API Key:   ${info.apiKey ? info.apiKey.slice(0, 8) + "..." : "(not set)"}`);
  console.log(`  Model:     ${info.modelId}`);
  console.log();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, resolve));

  const choice = await ask(
    "Configure which? [1-8 / 'all' / 'q']: "
  );
  rl.close();

  if (choice.toLowerCase() === "q") {
    console.log("Cancelled.");
    return;
  }

  let targets: ClientTarget[];
  if (choice.toLowerCase() === "all") {
    targets = detected.map((c) => c.id);
  } else {
    const indices = choice
      .split(/[\s,]+/)
      .map(Number)
      .filter((n) => n >= 1 && n <= detected.length);
    targets = indices.map((i) => detected[i - 1]!.id);
  }

  if (targets.length === 0) {
    console.log("No valid selection.");
    return;
  }

  console.log();
  for (const clientId of targets) {
    const meta = CLIENT_META[clientId];
    console.log(`  Configuring ${meta.name}...`);
    const result = await applyClientConfig(clientId, info);
    if (result.success) {
      success(`${meta.name}: ${result.paths.join(", ")}`);
    } else {
      fail(`${meta.name}: ${result.error}`);
    }
  }

  console.log("\nDone! Your tools should now route through etteum-pool.\n");
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  if (opts.help) {
    console.log(`
Etteum Pool — Client Integration CLI
=====================================

Detects installed AI coding clients and configures them to use the
etteum-pool proxy. Sets proxy URL, API key, and default model.

Usage:
  bun scripts/integrate-clients.ts [options]

Options:
  --url <url>       Proxy base URL (default: http://localhost:1930)
  --key <key>       API key for authentication
  --model <id>      Default model ID (default: kp-sonnet-4.6)
  --client <id>     Configure specific client (repeatable)
  --dry-run         Print configs without writing to disk
  --restore         Restore backups instead of applying
  --help, -h        Show this help

Examples:
  # Interactive mode
  bun scripts/integrate-clients.ts

  # Configure all detected clients
  bun scripts/integrate-clients.ts --url http://localhost:1930 --key sk-my-key

  # Configure only Claude Code and OpenCode
  bun scripts/integrate-clients.ts --client claudeCode --client opencode

  # Preview without writing
  bun scripts/integrate-clients.ts --dry-run

  # Restore all backups
  bun scripts/integrate-clients.ts --restore

Supported clients:
  ${(Object.keys(CLIENT_META) as ClientTarget[])
    .map((id) => `  - ${id}  (${CLIENT_META[id].name})`)
    .join("\n  ")}
`);
    return;
  }

  if (opts.restore) {
    await restoreAllBackups();
    return;
  }

  const info = buildProxyInfo(opts);

  // Interactive mode: no URL/key provided, no specific clients
  if (!opts.url || opts.url === "http://localhost:1930") {
    // Check if we have enough args for non-interactive
    if (opts.clients.length === 0) {
      return interactiveMode(info);
    }
  }

  // Non-interactive mode
  if (opts.clients.length === 0) {
    // Apply to all detected clients
    const detected = getClientList().filter((c) => c.detected);
    opts.clients = detected.map((c) => c.id);
    if (opts.clients.length === 0) {
      console.log("No AI coding clients detected.");
      console.log("Use --client <id> to specify clients manually.");
      return;
    }
  }

  if (opts.dryRun) {
    header("Dry Run — Preview Only");
  } else {
    header("Applying Client Configurations");
  }

  console.log(`  Proxy: ${info.proxyOrigin}`);
  console.log(`  Model: ${info.modelId}`);
  console.log();

  for (const clientId of opts.clients) {
    const meta = CLIENT_META[clientId];
    if (!meta) {
      fail(`Unknown client: ${clientId}`);
      continue;
    }

    if (!opts.dryRun && !isClientDetected(clientId)) {
      warn(`${meta.name} not detected — skipping`);
      continue;
    }

    console.log(`  ${meta.name} (${clientId})`);

    if (opts.dryRun) {
      const { generateClientConfig } = await import(
        "../src/lib/client-configs/index"
      );
      const preview = await generateClientConfig(clientId, info);
      if (preview.success) {
        console.log(JSON.stringify(preview.preview, null, 2));
      } else {
        fail(preview.error || "Failed");
      }
    } else {
      const result = await applyClientConfig(clientId, info);
      if (result.success) {
        success(`${meta.name}: configured`);
      } else {
        fail(`${meta.name}: ${result.error}`);
      }
    }
    console.log();
  }

  if (!opts.dryRun) {
    console.log("Done! Your tools should now route through etteum-pool.");
    console.log("To restore original configs, run:");
    console.log("  bun scripts/integrate-clients.ts --restore\n");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
