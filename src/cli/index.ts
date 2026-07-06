#!/usr/bin/env bun
/**
 * etteum CLI — TS port of 9router's cli/ interactive menus, adapted to our stack.
 *
 * Provides operator commands for account/token/combos management without needing
 * the dashboard. Talks to the running server's REST API via API key.
 *
 * Usage:
 *   etteum accounts list
 *   etteum accounts login <id>
 *   etteum accounts refresh --provider kiro
 *   etteum keys list | create | revoke <id>
 *   etteum combos list | create <name> --models a,b,c
 *   etteum media backends
 *   etteum status
 *
 * Closes the CLI-tools wave (Wave 8).
 */
import { readFileSync } from "node:fs";

const API_BASE = process.env.ETTEUM_API_BASE || "http://localhost:1930";
const API_KEY = process.env.ETTEUM_API_KEY || process.env.API_KEY || "";

async function api(path: string, opts: RequestInit = {}): Promise<any> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${API_KEY}`,
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text, status: res.status }; }
}

function println(s: string) { console.log(s); }
function table(rows: any[], cols: string[]) {
  if (!rows.length) { println("(none)"); return; }
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  const pad = (s: string, i: number) => s.padEnd(widths[i] ?? s.length);
  println(cols.map((c, i) => pad(c, i)).join("  "));
  println(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) println(cols.map((c, i) => pad(String(r[c] ?? ""), i)).join("  "));
}

async function cmdAccounts(args: string[]) {
  const sub = args[0] || "list";
  if (sub === "list") {
    const j = await api("/api/accounts");
    const accounts = Array.isArray(j) ? j : j.accounts || [];
    table(accounts.map((a: any) => ({ id: a.id, provider: a.provider, email: a.email, status: a.status, enabled: a.enabled ? "on" : "off" })), ["id", "provider", "email", "status", "enabled"]);
  } else if (sub === "login") {
    const id = Number(args[1]);
    if (!id) { println("usage: accounts login <id>"); process.exit(1); }
    const j = await api(`/api/auth/login/${id}`, { method: "POST", body: JSON.stringify({ headless: true }) });
    println(j.success ? `✓ Login succeeded for account ${id}` : `✗ ${j.error || "Login failed"}`);
  } else if (sub === "refresh") {
    const providerIdx = args.indexOf("--provider");
    const provider = providerIdx >= 0 ? (args[providerIdx + 1] || undefined) : undefined;
    println("Triggering token refresh for all eligible accounts...");
    const j = await api("/api/auth/refresh-all", { method: "POST", body: JSON.stringify({ provider }) });
    println(JSON.stringify(j, null, 2));
  } else {
    println("usage: accounts [list|login <id>|refresh --provider <p>]");
  }
}

async function cmdKeys(args: string[]) {
  const sub = args[0] || "list";
  if (sub === "list") {
    const j = await api("/api/keys/managed");
    table(j.keys || [], ["id", "name", "machineId", "isActive", "keyPreview"]);
  } else if (sub === "create") {
    const name = args[1];
    const j = await api("/api/keys/managed", { method: "POST", body: JSON.stringify({ name }) });
    if (j.key) { println(`✓ Created key "${j.name || ""}" (id ${j.id})`); println(`  KEY (store securely, shown once): ${j.key}`); }
    else println(`✗ ${j.error || "Failed"}`);
  } else if (sub === "revoke") {
    const id = Number(args[1]);
    await api(`/api/keys/managed/${id}/revoke`, { method: "POST" });
    println(`✓ Revoked key ${id}`);
  } else {
    println("usage: keys [list|create <name>|revoke <id>]");
  }
}

async function cmdCombos(args: string[]) {
  const sub = args[0] || "list";
  if (sub === "list") {
    const j = await api("/api/combos");
    const combos = Array.isArray(j) ? j : j.combos || [];
    table(combos.map((c: any) => ({ id: c.id, name: c.name, kind: c.kind, models: (c.models || []).join("→"), enabled: c.enabled ? "on" : "off" })), ["id", "name", "kind", "models", "enabled"]);
  } else if (sub === "create") {
    const name = args[1];
    const modelsIdx = args.indexOf("--models");
    const models = modelsIdx >= 0 ? (args[modelsIdx + 1] || "").split(",").filter(Boolean) : [];
    if (!name) { println("usage: combos create <name> --models a,b,c"); process.exit(1); }
    const j = await api("/api/combos", { method: "POST", body: JSON.stringify({ name, models, kind: "fallback" }) });
    println(j.id ? `✓ Created combo "${name}" (id ${j.id})` : `✗ ${j.error || "Failed"}`);
  } else {
    println("usage: combos [list|create <name> --models a,b,c]");
  }
}

async function cmdMedia() {
  const j = await api("/api/accounts?provider=media");
  const accounts = Array.isArray(j) ? j : j.accounts || [];
  if (!accounts.length) { println("No media backends configured."); return; }
  for (const a of accounts) {
    let info: any = {};
    try { info = JSON.parse(a.tokens || "{}"); } catch {}
    println(`${a.email}  →  ${info.base_url}  [${(info.modalities || []).join(", ")}]`);
  }
}

async function cmdStatus() {
  const [info, specs] = await Promise.all([
    api("/api/info").catch(() => null),
    api("/api/system/specs").catch(() => null),
  ]);
  if (info) println(`etteum-pool ${info.version || ""} (commit ${info.commit || "n/a"})`);
  if (specs) println(`Platform: ${specs.platform}/${specs.arch}  CPUs: ${specs.cpuCores}  optimalWorkers: ${specs.optimalWorkers}`);
  println(`API: ${API_BASE}`);
  println(`API key: ${API_KEY ? "configured ✓" : "NOT set ✗"}`);
}

const [cmd, ...rest] = process.argv.slice(2);
const commands: Record<string, (a: string[]) => Promise<void>> = {
  accounts: cmdAccounts,
  keys: cmdKeys,
  combos: cmdCombos,
  media: cmdMedia,
  status: cmdStatus,
};

if (!cmd || cmd === "help" || cmd === "--help") {
  println("etteum — operator CLI");
  println("");
  println("Commands:");
  println("  accounts list | login <id> | refresh --provider <p>");
  println("  keys list | create <name> | revoke <id>");
  println("  combos list | create <name> --models a,b,c");
  println("  media              list media backends");
  println("  status             show server + host info");
  println("");
  println("Env: ETTEUM_API_BASE, ETTEUM_API_KEY (or API_KEY)");
  process.exit(0);
}

const fn = commands[cmd];
if (!fn) { println(`Unknown command: ${cmd}. Try 'etteum help'.`); process.exit(1); }
fn(rest).catch((err) => { println(`Error: ${err.message}`); process.exit(1); });
