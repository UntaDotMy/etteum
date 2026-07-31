/**
 * MCP stdio↔SSE bridge — TS port of the reference proxy's src/lib/mcp/stdioSseBridge.js, 1:1.
 *
 * Hosts local MCP server plugins: spawns one child process per plugin on
 * demand, broadcasts its newline-delimited JSON-RPC stdout over SSE to all
 * connected clients, and accepts client messages via HTTP POST (written to the
 * child's stdin).
 *
 * SECURITY: only preset stdio plugins (LOCAL_STDIO_PLUGINS) may spawn. No
 * user-defined commands — this prevents remote code execution. The preset list
 * is intentionally narrow and code-defined.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

export interface StdioPlugin {
  name: string;
  command: string;
  args: string[];
  description?: string;
}

// Preset, code-defined plugins only. Users cannot add arbitrary commands.
// (These are safe, well-known MCP servers; extend this list in code, never via
// untrusted input.)
// Every npm package is pinned to an exact reviewed version. Never use a bare
// package name here: `npx -y` would otherwise execute whatever is latest at
// request time. Add a preset only after verifying the package exists.
export function buildLocalStdioPlugins(env: NodeJS.ProcessEnv = process.env): StdioPlugin[] {
  const filesystemRoot = env.MCP_FILESYSTEM_ROOT?.trim();
  if (!filesystemRoot) return [];
  if (!path.isAbsolute(filesystemRoot)) {
    throw new Error("MCP_FILESYSTEM_ROOT must be an absolute path");
  }
  const resolvedRoot = path.resolve(filesystemRoot);
  const cwdFromRoot = path.relative(resolvedRoot, process.cwd());
  if (!cwdFromRoot || (!cwdFromRoot.startsWith(`..${path.sep}`) && cwdFromRoot !== ".." && !path.isAbsolute(cwdFromRoot))) {
    throw new Error("MCP_FILESYSTEM_ROOT must not contain the process working directory");
  }
  return [
    {
      name: "filesystem",
      command: "npx",
      args: [
        "-y",
        "@modelcontextprotocol/server-filesystem@2026.7.10",
        resolvedRoot,
      ],
      description: "Local filesystem access",
    },
  ];
}

// Filesystem access is opt-in. Never default to `.`: the process working
// directory often contains source, configuration, logs, and deployment data.
export const LOCAL_STDIO_PLUGINS: StdioPlugin[] = buildLocalStdioPlugins();

/** Max ms to wait for a freshly-spawned plugin to emit its first stdout line
 *  (npx -y fetches the package on first run; this bounds that wait). */
const SPAWN_READINESS_MS = 30_000;

const G_KEY = "__etteumMcpBridges";
const MAX_TEXT_CHARS = 50_000;
const COLLAPSE_THRESHOLD = 30;
const COLLAPSE_KEEP_HEAD = 10;
const COLLAPSE_KEEP_TAIL = 5;

type SendFn = (chunk: string) => void;
interface BridgeEntry {
  proc: ReturnType<typeof spawn> | null;
  sessions: Map<string, SendFn>;
  buffer: string;
}

function getStore(): Map<string, BridgeEntry> {
  if (!(globalThis as any)[G_KEY]) (globalThis as any)[G_KEY] = new Map();
  return (globalThis as any)[G_KEY];
}

// --- Text filtering (collapses huge tool results to keep SSE manageable) ---
function smartFilterText(text: string): string {
  if (typeof text !== "string" || text.length < 2000) return text;
  let out = text;
  out = out.replace(/^\s*-\s*generic:?\s*$/gm, "");
  out = out.replace(/^\s*-\s*text:\s*""\s*$/gm, "");
  out = collapseRepeated(out);
  if (out.length > MAX_TEXT_CHARS) {
    const head = out.slice(0, MAX_TEXT_CHARS - 300);
    out = `${head}\n\n... [truncated ${text.length - head.length} chars by MCP bridge. Page is large; navigate to a specific section.]`;
  }
  return out;
}

function collapseRepeated(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] || "";
    const m = line.match(/^(\s*)-\s*([a-zA-Z]+)\b/);
    if (!m) { out.push(line); i++; continue; }
    const indent = m[1];
    const role = m[2];
    let j = i;
    while (j < lines.length) {
      const ln = lines[j] || "";
      const mm = ln.match(/^(\s*)-\s*([a-zA-Z]+)\b/);
      if (mm && mm[1] === indent && mm[2] === role) { j++; continue; }
      if (ln.startsWith(`${indent} `) || ln.startsWith(`${indent}\t`)) { j++; continue; }
      break;
    }
    const groupLen = j - i;
    if (groupLen >= COLLAPSE_THRESHOLD) {
      const safeIndent = indent || "";
      const safeRole = role || "";
      const headEnd = findNthSiblingEnd(lines, i, safeIndent, safeRole, COLLAPSE_KEEP_HEAD);
      const tailStart = findLastNSiblingStart(lines, j, safeIndent, safeRole, COLLAPSE_KEEP_TAIL);
      for (let k = i; k < headEnd; k++) out.push(lines[k] || "");
      out.push(`${safeIndent}... [${groupLen - COLLAPSE_KEEP_HEAD - COLLAPSE_KEEP_TAIL} similar "${safeRole}" items omitted by MCP bridge]`);
      for (let k = tailStart; k < j; k++) out.push(lines[k] || "");
    } else {
      for (let k = i; k < j; k++) out.push(lines[k] || "");
    }
    i = j;
  }
  return out.join("\n");
}

function findNthSiblingEnd(lines: string[], start: number, indent: string, role: string, n: number): number {
  let count = 0;
  for (let k = start; k < lines.length; k++) {
    const mm = (lines[k] || "").match(/^(\s*)-\s*([a-zA-Z]+)\b/);
    if (mm && mm[1] === indent && mm[2] === role) {
      count++;
      if (count > n) return k;
    }
  }
  return lines.length;
}

function findLastNSiblingStart(lines: string[], end: number, indent: string, role: string, n: number): number {
  const positions: number[] = [];
  for (let k = 0; k < end; k++) {
    const mm = (lines[k] || "").match(/^(\s*)-\s*([a-zA-Z]+)\b/);
    if (mm && mm[1] === indent && mm[2] === role) positions.push(k);
  }
  return positions.length > n ? (positions[positions.length - n] ?? end) : end;
}

function filterFrame(line: string): string {
  try {
    const msg = JSON.parse(line);
    const content = msg?.result?.content;
    if (!Array.isArray(content)) return line;
    let mutated = false;
    for (const item of content) {
      if (item?.type === "text" && typeof item.text === "string") {
        const filtered = smartFilterText(item.text);
        if (filtered !== item.text) { item.text = filtered; mutated = true; }
      }
    }
    return mutated ? JSON.stringify(msg) : line;
  } catch { return line; }
}

export function findPlugin(name: string): StdioPlugin | null {
  return LOCAL_STDIO_PLUGINS.find((p) => p.name === name) || null;
}

function getOrSpawn(name: string): BridgeEntry {
  const store = getStore();
  const existing = store.get(name);
  if (existing?.proc && !existing.proc.killed && existing.proc.exitCode === null) return existing;

  const plugin = findPlugin(name);
  if (!plugin) throw new Error(`Unknown local plugin: ${name}`);

  const proc = spawn(plugin.command, plugin.args, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
  const entry: BridgeEntry = { proc, sessions: new Map(), buffer: "" };
  store.set(name, entry);

  // Spawn-readiness timeout: if the child produces no stdout within the window
  // (e.g. npx still fetching the package on first run, or a hung install),
  // kill it so the bridge fails fast instead of hanging the SSE client.
  let becameReady = false;
  const readinessTimer = setTimeout(() => {
    if (!becameReady && !proc.killed && proc.exitCode === null) {
      console.error(`[mcp:${name}] spawn-readiness timeout (${SPAWN_READINESS_MS}ms) — killing. Is npx able to fetch the package?`);
      try { proc.kill("SIGKILL"); } catch { /* ignore */ }
      store.delete(name);
    }
  }, SPAWN_READINESS_MS);

  proc.stdout?.on("data", (chunk: Buffer) => {
    if (!becameReady) { becameReady = true; clearTimeout(readinessTimer); }
    entry.buffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = entry.buffer.indexOf("\n")) >= 0) {
      const raw = entry.buffer.slice(0, idx).trim();
      entry.buffer = entry.buffer.slice(idx + 1);
      if (!raw) continue;
      const line = filterFrame(raw);
      for (const send of entry.sessions.values()) {
        try { send(`event: message\ndata: ${line}\n\n`); } catch { /* broken pipe */ }
      }
    }
  });

  proc.stderr?.on("data", (d: Buffer) => console.log(`[mcp:${name}]`, d.toString().trim()));
  proc.on("exit", (code) => {
    clearTimeout(readinessTimer);
    console.log(`[mcp:${name}] exited`, code);
    store.delete(name);
  });

  return entry;
}

export function registerSession(name: string, sendFn: SendFn): string {
  const entry = getOrSpawn(name);
  const sid = randomUUID();
  entry.sessions.set(sid, sendFn);
  return sid;
}

export function unregisterSession(name: string, sid: string): void {
  const entry = getStore().get(name);
  if (!entry) return;
  entry.sessions.delete(sid);
}

/**
 * Is there an active SSE session `sid` for plugin `name`?
 * Used to gate POST /message — only a caller who opened the SSE stream
 * (and thus holds a valid sid) may drive the plugin child's stdin.
 */
export function hasSession(name: string, sid: string | null | undefined): boolean {
  if (!sid) return false;
  const entry = getStore().get(name);
  return !!entry?.sessions.has(sid);
}

export function sendToChild(name: string, jsonRpc: unknown): void {
  const entry = getStore().get(name);
  if (!entry?.proc?.stdin?.writable) throw new Error(`Bridge not running: ${name}`);
  entry.proc.stdin.write(`${JSON.stringify(jsonRpc)}\n`);
}

export function isRunning(name: string): boolean {
  const entry = getStore().get(name);
  return !!(entry?.proc && !entry.proc.killed && entry.proc.exitCode === null);
}

export function listPlugins(): StdioPlugin[] {
  return LOCAL_STDIO_PLUGINS.map(({ name, description }) => ({ name, description, running: isRunning(name) } as StdioPlugin & { running: boolean })) as any;
}
