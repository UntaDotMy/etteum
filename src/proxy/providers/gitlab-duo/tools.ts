/**
 * GitLab Duo — Tool Bridge
 *
 * Maps the workflow's typed `ServerAction`s to whatever tools the client
 * declared on the request, so an agentic client (Claude Code, Cline, Roo Code)
 * sees a normal tool_use round and can echo a tool_result back. We convert
 * that tool_result back into an `actionResponse` frame on the next turn.
 *
 * Strategy:
 *   1. Try to find a client-declared tool with a "matching" name (case
 *      insensitive substring on a small whitelist per action kind).
 *   2. If nothing matches, fall back to a synthetic tool name that mirrors
 *      Claude Code's built-ins (`Bash`, `Read`, `Write`, `Edit`, `Glob`,
 *      `Grep`). Most clients still accept this and bridge it locally.
 *
 * Args translation: we keep the action's native field names where possible
 * (the LLM sees the schema we declare on its side, so the names below match
 * the most common conventions). Anything we don't understand is JSON-stringified
 * and passed through.
 */

import type { ServerAction } from "./protocol";
import path from "path";

/**
 * Resolve a path to absolute using the given working directory.
 * If the path is already absolute, returns it as-is.
 * If relative, resolves it against the working directory.
 */
export function resolvePath(p: string, cwd: string): string {
  if (!p || path.isAbsolute(p)) return p;
  return path.resolve(cwd, p);
}

/**
 * Detect `cd` commands in shell actions and extract the target directory.
 * Returns the new working directory if a cd command is detected, otherwise null.
 * 
 * Handles common patterns:
 * - `cd /path/to/dir`
 * - `cd path/to/dir`
 * - `cd path && other commands`
 * - `cd path ; other commands`
 */
export function detectCwdCommand(command: string, currentCwd: string): string | null {
  if (!command || !command.trim()) return null;
  
  // Handle quoted paths: cd "path with space" or cd 'path with space'
  const quotedPattern = /\bcd\s+(["'])([^"']+)\1/;
  const quotedMatch = command.match(quotedPattern);
  
  if (quotedMatch && quotedMatch[2]) {
    const targetDir = quotedMatch[2];
    const resolved = resolvePath(targetDir, currentCwd);
    if (!resolved.startsWith('-')) {
      return resolved;
    }
  }
  
  // Handle unquoted paths: cd path (no space allowed)
  const unquotedPattern = /\bcd\s+([^'"\s;&&]+)/;
  const unquotedMatch = command.match(unquotedPattern);
  
  if (!unquotedMatch || !unquotedMatch[1]) return null;
  
  const targetDir = unquotedMatch[1];
  const resolved = resolvePath(targetDir, currentCwd);
  
  // Validate it's not something that looks like a flag or option
  if (resolved.startsWith('-')) return null;
  
  return resolved;
}

/**
 * Apply path resolution to tool arguments.
 * Resolves relative paths in filepath/path/file fields to absolute paths.
 */
export function resolveToolPaths(
  argsJson: string,
  toolName: string,
  cwd: string
): string {
  if (!argsJson || !cwd) return argsJson;
  
  try {
    const args = JSON.parse(argsJson);
    if (!args || typeof args !== 'object') return argsJson;
    
    // Fields that typically contain file paths
    const pathFields = ['filepath', 'path', 'file', 'directory', 'directory_path'];
    
    let modified = false;
    for (const field of pathFields) {
      if (args[field] && typeof args[field] === 'string') {
        const original = args[field];
        const resolved = resolvePath(original, cwd);
        if (resolved !== original) {
          args[field] = resolved;
          modified = true;
        }
      }
    }
    
    return modified ? JSON.stringify(args) : argsJson;
  } catch {
    // If JSON parsing fails, return original
    return argsJson;
  }
}

/** Subset of JSON Schema we need to look up declared property names. */
interface ToolSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
}

/** A single client-declared tool, in either the Anthropic (flat `name` +
 *  `input_schema`/`parameters`) or OpenAI (nested `function.name` +
 *  `function.parameters`) wire format. `normalizeTools()` flattens both. */
interface ClientTool {
  type?: string;
  name?: string;
  description?: string;
  input_schema?: ToolSchema;
  parameters?: ToolSchema;
  function?: { name?: string; description?: string; parameters?: ToolSchema };
}

export interface MatchedToolCall {
  /** Client-facing tool name (must match one of clientTools[].name when
   *  matched, or a sane default otherwise). */
  name: string;
  /** Stringified JSON of arguments the client will pass to its tool. */
  argsJson: string;
  /** Original requestID from the action — we echo it on actionResponse. */
  requestID: string;
}

export class ToolBridge {
  /** Heuristic candidates for each Duo action. First match wins.
   *
   *  IMPORTANT: Avoid generic terms like "search" that could match multiple
   *  action types. Use specific tool names only (e.g. "grep" not "search").
   *  The looseMatch() fallback handles substring matching with word boundaries.
   */
  private static readonly CANDIDATES: Record<string, string[]> = {
    runCommand: ["bash", "shell", "run_command", "execute_command", "terminal", "command"],
    runShellCommand: ["bash", "shell", "run_shell", "run_command", "execute_command", "terminal"],
    runReadFile: ["read", "read_file", "view", "fs_read", "file_read", "openfile"],
    runReadFiles: ["read", "read_file", "read_files", "view", "fs_read"],
    runWriteFile: ["write", "write_file", "create_file", "fs_write", "file_write"],
    runEditFile: ["edit", "edit_file", "str_replace", "fs_edit", "file_edit", "replace"],
    mkdir: ["mkdir", "make_directory", "create_directory"],
    listDirectory: ["ls", "list_dir", "list_directory", "fs_list", "tree"],
    findFiles: ["glob", "find_files", "find", "fs_find"],
    // ❌ REMOVED "search" — too generic, overlaps with web_search/file_search
    grep: ["grep", "fs_grep", "ripgrep", "rg"],
    runGrep: ["grep", "fs_grep", "ripgrep", "rg"],
    scanDirectoryTree: ["tree", "scan_directory", "list_directory", "ls"],
    runGitCommand: ["bash", "shell", "git", "run_command", "execute_command"],
    runReadOnlyGitCommand: ["bash", "shell", "git", "run_command", "execute_command"],
    runHTTPRequest: ["fetch", "http", "http_request", "web_fetch", "curl"],
    // ── Newer Duo agentic actions (17.x+) ────────────────────────────────────
    // Web search: explicit web-prefixed names only, no generic "search"
    runWebSearch: ["web_search", "websearch", "search_web", "google_search", "internet_search"],
    // Semantic / RAG file search: specific names only, no overlap with grep
    runFileSearch: ["file_search", "fs_search", "semantic_search", "codebase_search"],
    // MCP tool calls: route by the upstream `tool` name when the client
    // declared an MCP-style namespaced tool (e.g. "github__create_issue"),
    // otherwise we emit the bare tool name and hope the client recognizes it.
    runMCPCall: [],
  };

  /** Defaults when the client didn't declare anything matching. Mirrors the
   *  Claude-Code-canonical tool names — but only used as a last resort when
   *  even `Bash` isn't declared. The match() flow prefers `Bash` over these
   *  whenever the client has it, because every agentic client has Bash but
   *  not all of them have Grep/Read/Glob/etc. */
  private static readonly FALLBACK: Record<string, string> = {
    runCommand: "Bash",
    runShellCommand: "Bash",
    runReadFile: "Read",
    runReadFiles: "Read",
    runWriteFile: "Write",
    runEditFile: "Edit",
    mkdir: "Bash",
    listDirectory: "LS",
    findFiles: "Glob",
    grep: "Grep",
    runGrep: "Grep",
    scanDirectoryTree: "LS",
    runGitCommand: "Bash",
    runReadOnlyGitCommand: "Bash",
    runHTTPRequest: "WebFetch",
    runWebSearch: "WebSearch",
    runFileSearch: "Grep",
    // MCP fallback: keep the upstream tool name verbatim. argsFor() handles
    // the special case so the client just sees a tool_use with whatever
    // name the workflow asked for.
    runMCPCall: "",
  };

  /** Action kinds we can emulate purely through `Bash` if the client only
   *  declared shell access. Every entry here has a corresponding shell-form
   *  branch in `argsFor()` — adding a kind here without that branch will emit
   *  a payload the bash tool can't execute, so keep them in sync. */
  private static readonly BASH_EMULATABLE = new Set<string>([
    "runCommand", "runShellCommand", "runGitCommand", "runReadOnlyGitCommand",
    "runReadFile", "runReadFiles", "runWriteFile", "runEditFile",
    "mkdir", "listDirectory", "scanDirectoryTree", "findFiles",
    "grep", "runGrep",
    // runFileSearch degrades to a `grep -rn <regex>` shell command —
    // good enough when the client only has Bash.
    "runFileSearch",
    // runWebSearch can degrade to `curl` against a search engine when the
    // client only has Bash — better than emitting an unknown "WebSearch" tool.
    "runWebSearch",
    // runHTTPRequest is also Bash-emulatable via curl; argsFor() already has
    // the http branch but no shell branch, so we add one below.
    "runHTTPRequest",
  ]);

  /**
   * Match a Duo action against the client's tool list.
   *
   * Returns null if the action isn't one we know how to bridge. Returns a
   * matched call (with synthesized args JSON) otherwise — the caller should
   * use this to emit a tool_use / tool_calls block to the client.
   */
  static match(
    action: ServerAction,
    clientTools: ClientTool[] | undefined,
  ): MatchedToolCall | null {
    const kind = ToolBridge.actionKind(action);
    if (!kind) return null;

    // Normalize the client's tool list up front into a flat {name, props}
    // shape that accepts BOTH wire formats:
    //   • Anthropic: { name, input_schema | parameters }
    //   • OpenAI:    { type:"function", function:{ name, parameters } }
    // Without this, an OpenAI-Compatible client (tools nested under
    // `function.*`) yields empty names + undefined schemas, so nothing ever
    // matches and every action dies as "(unmatched)". See normalizeTools().
    const tools = ToolBridge.normalizeTools(clientTools);
    const declared = tools.map((t) => t.name);
    const propsOf = (name: string): Record<string, unknown> =>
      tools.find((t) => t.name === name)?.props ?? {};
    const requiredOf = (name: string): string[] =>
      tools.find((t) => t.name === name)?.required ?? [];

    // Special case: runMCPCall carries its own tool name. Try to honor it
    // verbatim, then fall through to a name-similarity lookup, then emit it
    // raw — most clients with MCP support will recognize the bare name.
    if (kind === "runMCPCall" && "runMCPCall" in action) {
      const mcp = action.runMCPCall;
      const wanted = `${mcp.server}__${mcp.tool}`;
      const exact = declared.find((d) => d.toLowerCase() === wanted.toLowerCase()
                                     || d.toLowerCase() === mcp.tool.toLowerCase());
      const sub = exact ?? declared.find((d) => d.toLowerCase().includes(mcp.tool.toLowerCase()));
      const toolName = sub ?? wanted;
      return {
        name: toolName,
        argsJson: ToolBridge.argsFor(action, toolName, propsOf(toolName), requiredOf(toolName)),
        requestID: action.requestID,
      };
    }

    const candidates = ToolBridge.CANDIDATES[kind] ?? [];
    const fallback = ToolBridge.FALLBACK[kind] ?? "Bash";

    // Guard for batch-read: a tool only qualifies for runReadFiles if it can
    // actually accept an array of paths. Single-file readers like Claude Code's
    // `Read` (only `file_path`) would silently reject `{paths:[...]}`, so we
    // reject them here and let the Bash-emulation path (step 3) take over.
    const acceptsTool = (name: string): boolean => {
      if (kind !== "runReadFiles") return true;
      const keys = Object.keys(propsOf(name));
      // If the schema is empty we can't prove it's a batch reader → reject so
      // we fall through to Bash, which always works for multi-file reads.
      return keys.some((k) => ["paths", "file_paths", "filepaths", "files"]
        .some((c) => c.toLowerCase() === k.toLowerCase()));
    };

    // 1. Prefer an exact / case-insensitive match against declared tools.
    let toolName: string | null = null;
    for (const cand of candidates) {
      const hit = declared.find((d) => d.toLowerCase() === cand.toLowerCase() && acceptsTool(d));
      if (hit) { toolName = hit; break; }
    }
    if (!toolName) {
      // 2. Substring fallback (e.g. client declared "execute_bash" → matches "bash").
      //    Use a word-boundary-aware match so short candidates like "ls" don't
      //    falsely hit unrelated tools (e.g. "KillShell" contains "ls", and
      //    "BashOutput" contains "bash"). See `looseMatch`.
      for (const cand of candidates) {
        const hit = declared.find((d) => ToolBridge.looseMatch(d, cand) && acceptsTool(d));
        if (hit) { toolName = hit; break; }
      }
    }

    // 3. CRITICAL: if no specific match found AND this action can be emulated
    //    via Bash, prefer the client's declared Bash-like tool over emitting
    //    a fallback name like "Grep"/"Read" that the client may not have.
    //    This is the difference between a turn that silently dies after a
    //    shell call and one that keeps running. Every agentic client declares
    //    Bash; only some declare Grep/Read/Glob/etc.
    if (!toolName && ToolBridge.BASH_EMULATABLE.has(kind)) {
      const bashLike = ["bash", "shell", "run_command", "execute_command", "terminal", "command"];
      for (const cand of bashLike) {
        const hit = declared.find((d) => d.toLowerCase() === cand.toLowerCase());
        if (hit) { toolName = hit; break; }
      }
      if (!toolName) {
        for (const cand of bashLike) {
          const hit = declared.find((d) => ToolBridge.looseMatch(d, cand));
          if (hit) { toolName = hit; break; }
        }
      }
    }

    // 4. Last-resort fallback to the canonical Claude-Code name. Only reached
    //    when the client declared neither a matching tool nor any Bash-like
    //    tool — extremely rare but kept for backwards compat.
    if (!toolName) toolName = fallback;

    // Look up the actual schema of the matched tool — we shape args to its
    // declared property names so e.g. Claude Code's `file_path` doesn't end
    // up as `path: undefined` on the client.
    return {
      name: toolName,
      argsJson: ToolBridge.argsFor(action, toolName, propsOf(toolName), requiredOf(toolName)),
      requestID: action.requestID,
    };
  }

  /** Flatten a client's declared tools into a uniform {name, props} list,
   *  accepting both the Anthropic and OpenAI tool wire formats:
   *
   *    Anthropic: { name, input_schema?: {properties}, parameters?: {properties} }
   *    OpenAI:    { type: "function", function: { name, parameters: {properties} } }
   *
   *  OpenAI nests the name + schema under `function`, so reading `t.name`
   *  directly (as the rest of match() does) would see `undefined` for every
   *  OpenAI-Compatible client and match nothing. Normalizing once here keeps
   *  the matching logic format-agnostic. Entries without a resolvable name are
   *  dropped — they can never be matched and only pollute `declared`. */
  private static normalizeTools(
    clientTools: ClientTool[] | undefined,
  ): Array<{ name: string; props: Record<string, unknown>; required: string[] }> {
    return (clientTools ?? [])
      .map((t) => {
        const fn = t?.function;
        const name = (fn?.name ?? t?.name ?? "").toString();
        const schema = fn?.parameters ?? t?.input_schema ?? t?.parameters;
        return {
          name,
          props: schema?.properties ?? {},
          // Carry the client's `required` list so argsFor() can satisfy
          // mandatory fields the action doesn't map to (e.g. Claude Code's
          // Bash tool requires BOTH `command` and `description`; omitting
          // `description` makes the client reject the call with
          // `SchemaError(Missing key at ["description"])`).
          required: Array.isArray(schema?.required) ? schema!.required : [],
        };
      })
      .filter((t) => t.name.length > 0);
  }

  /** Word-boundary-aware substring match used for the fallback tool lookup.
   *
   *  Plain `.includes()` is dangerous for short candidates: "ls" matches
   *  "KillShell", "bash" matches "BashOutput", etc. — silently routing an
   *  action to the wrong tool. We instead require the candidate to appear at
   *  a token boundary (start/end of name, or delimited by `_`/`-`/case
   *  change). Candidates ≤ 3 chars (e.g. "ls") must match a whole token
   *  EXACTLY — no substring matching at all.
   *
   *  CRITICAL: short generic words like "search" must NEVER match compound
   *  tool names like "web_search" or "file_search" because that would route
   *  grep actions to web-search tools. We enforce this by requiring the
   *  candidate to be a FULL token — `web_search` splits into ["web","search"]
   *  and "search" IS a full token there, so we add an extra check: for
   *  candidates that are common suffixes in compound names, require the
   *  declared name to BE the candidate (case-insensitive), not just contain it.
   */
  private static readonly COMPOUND_SUFFIXES = new Set([
    "search", "read", "write", "edit", "command", "fetch", "list",
  ]);

  private static looseMatch(declared: string, candidate: string): boolean {
    const d = declared.toLowerCase();
    const c = candidate.toLowerCase();
    if (d === c) return true;
    // Split the declared name into tokens on delimiters and camelCase humps:
    // "KillShell" → ["kill","shell"], "execute_bash" → ["execute","bash"].
    const tokens = declared
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[\s_\-]+/)
      .map((t) => t.toLowerCase())
      .filter(Boolean);
    if (!tokens.includes(c)) return false;
    // Compound suffix guard: "search" is a full token in "web_search" and
    // "file_search", but we must NOT match grep/runGrep candidates to those
    // tools. If the candidate is a known compound suffix AND the declared
    // name has more than one token, require the candidate to be the ONLY
    // token (i.e. the tool is literally called "search", not "web_search").
    if (ToolBridge.COMPOUND_SUFFIXES.has(c) && tokens.length > 1) return false;
    // For very short candidates (≤ 2 chars), exact-token match is already
    // enforced above — no further substring needed.
    if (c.length <= 2) return true;
    // For longer candidates, allow substring within a single token.
    return tokens.some((t) => t.includes(c));
  }

  /** Pick the first property name from the schema that's in `candidates`,
   *  preserving the case the client declared. Falls back to the first item
   *  in `candidates` when nothing matches — that gives sensible defaults
   *  (e.g. `command`, `file_path`) for unknown clients. */
  private static pickField(
    props: Record<string, unknown>,
    candidates: string[],
  ): string {
    const keys = Object.keys(props);
    const lowerKeys = keys.map((k) => k.toLowerCase());
    for (const cand of candidates) {
      const idx = lowerKeys.indexOf(cand.toLowerCase());
      if (idx !== -1) return keys[idx]!;
    }
    return candidates[0] ?? "value";
  }

  /** True if the schema declares any of `candidates` (case-insensitive). */
  private static hasField(
    props: Record<string, unknown>,
    candidates: string[],
  ): boolean {
    const lowerKeys = Object.keys(props).map((k) => k.toLowerCase());
    return candidates.some((c) => lowerKeys.includes(c.toLowerCase()));
  }

  /** Drop any key not declared by the tool's schema. No-op when the schema is
   *  empty (we can't prove what's valid, so we pass everything through and let
   *  the client decide — same behavior as before this guard existed). This
   *  prevents hallucinated/optional fields (e.g. `-i`, `file_path`) from
   *  reaching a client whose schema doesn't declare them, which would make the
   *  client reject the entire tool call. */
  private static prune(
    out: Record<string, unknown>,
    props: Record<string, unknown>,
  ): Record<string, unknown> {
    const keys = Object.keys(props);
    if (keys.length === 0) return out;
    const allowed = new Set(keys.map((k) => k.toLowerCase()));
    const filtered: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(out)) {
      if (allowed.has(k.toLowerCase())) filtered[k] = v;
    }
    return filtered;
  }

  private static actionKind(a: ServerAction): keyof typeof ToolBridge.CANDIDATES | null {
    for (const k of Object.keys(ToolBridge.CANDIDATES)) {
      if (k in a) return k as keyof typeof ToolBridge.CANDIDATES;
    }
    return null;
  }

  /** Build the JSON args object the client's tool will see. We adapt to the
   *  client's declared schema (Claude Code uses `file_path`, others use `path`,
   *  some use `filename`) — `pickField()` looks at `props` to choose the right
   *  property name. Falls back to canonical names when the schema doesn't
   *  declare one. */
  private static argsFor(
    a: ServerAction,
    toolName: string,
    props: Record<string, unknown> = {},
    required: string[] = [],
  ): string {
    // Build the natural arg mapping, then satisfy any mandatory fields the
    // action didn't populate (e.g. Claude Code Bash requires `description`).
    const json = ToolBridge.argsForInner(a, toolName, props);
    return ToolBridge.fillRequired(json, props, required, a);
  }

  /** Ensure every `required` field declared by the client's schema is present
   *  in the emitted args. Some clients (notably Claude Code's Bash tool) mark
   *  `description` as required in addition to `command`; an action like
   *  `runShellCommand` only yields `command`, so without this the client
   *  rejects the whole call with `SchemaError(Missing key at ["description"])`.
   *
   *  We only add keys the schema actually declares (so we never inject fields
   *  the client doesn't know about), and only when they're missing. Defaults:
   *  `description` → a short human summary of the action; everything else → "".
   *  No-op when the schema declares no `required` fields. */
  private static fillRequired(
    json: string,
    props: Record<string, unknown>,
    required: string[],
    a: ServerAction,
  ): string {
    if (!required || required.length === 0) return json;
    let out: Record<string, unknown>;
    try {
      out = JSON.parse(json) as Record<string, unknown>;
    } catch {
      return json; // non-object payloads are passed through untouched
    }
    if (out === null || typeof out !== "object" || Array.isArray(out)) return json;

    const present = new Set(Object.keys(out).map((k) => k.toLowerCase()));
    const declared = new Set(Object.keys(props).map((k) => k.toLowerCase()));
    const DESC = ["description", "desc", "summary"];

    for (const field of required) {
      const lf = field.toLowerCase();
      if (present.has(lf)) continue;
      // Only fill fields the schema actually declares. (`required` should be a
      // subset of `properties`, but be defensive against malformed schemas.)
      if (declared.size > 0 && !declared.has(lf)) continue;
      if (DESC.includes(lf)) {
        out[field] = ToolBridge.describeAction(a, out);
      } else {
        out[field] = "";
      }
    }
    return JSON.stringify(out);
  }

  /** A short, human-readable one-liner describing what an action does, used to
   *  satisfy a required `description` field. Prefers the actual command/path in
   *  the already-built args so the summary is accurate. */
  private static describeAction(
    a: ServerAction,
    out: Record<string, unknown>,
  ): string {
    const cmd = out["command"] ?? out["cmd"] ?? out["script"];
    if (typeof cmd === "string" && cmd.trim()) {
      const oneLine = cmd.replace(/\s+/g, " ").trim();
      return oneLine.length > 80 ? `${oneLine.slice(0, 77)}...` : oneLine;
    }
    const path = out["file_path"] ?? out["path"] ?? out["filename"];
    if (typeof path === "string" && path.trim()) return `Operate on ${path}`;
    const kind = ToolBridge.actionKind(a);
    return kind ? `Run ${kind}` : "Run tool";
  }

  /** Core arg-shaping logic. Returns a JSON string mapping the action onto the
   *  client tool's declared property names. `argsFor()` wraps this to backfill
   *  required fields. */
  private static argsForInner(
    a: ServerAction,
    toolName: string,
    props: Record<string, unknown> = {},
  ): string {
    const lower = toolName.toLowerCase();
    const payload = ToolBridge.payload(a);

    // Common candidate orderings — first one wins per `pickField`.
    const F_CMD = ["command", "cmd", "shell_command", "script"];
    const F_PATH = ["file_path", "path", "filepath", "filename", "file"];
    const F_DIR = ["directory_path", "directory", "path", "dir", "folder"];
    // Directory listing tools (Claude Code `LS`) use `path`; keep it first so
    // an empty schema defaults to `path` rather than `file_path`/`directory_path`.
    const F_LS_PATH = ["path", "directory", "dir", "directory_path", "folder"];
    const F_CONTENT = ["content", "contents", "text", "data", "body"];
    const F_OLD = ["old_string", "oldString", "old", "search", "from", "before"];
    const F_NEW = ["new_string", "newString", "new", "replace", "to", "after"];
    const F_PATTERN = ["pattern", "query", "regex", "search"];
    const F_OFFSET = ["offset", "line_offset", "lineOffset", "start_line"];
    const F_PATHS = ["paths", "file_paths", "filepaths", "files"];

    if ("runCommand" in a) {
      const p = a.runCommand;
      const cmdline = [p.program, ...(p.flags ?? []), ...(p.arguments ?? [])].filter(Boolean).join(" ");
      if (lower.includes("bash") || lower.includes("shell") || lower.includes("command") || lower === "terminal") {
        return JSON.stringify({ [ToolBridge.pickField(props, F_CMD)]: cmdline });
      }
      return JSON.stringify(payload);
    }

    if ("runShellCommand" in a) {
      const p = a.runShellCommand;
      if (lower.includes("bash") || lower.includes("shell") || lower.includes("command") || lower === "terminal") {
        return JSON.stringify({ [ToolBridge.pickField(props, F_CMD)]: p.command });
      }
      return JSON.stringify(payload);
    }

    if ("runGitCommand" in a || "runReadOnlyGitCommand" in a) {
      const p = ("runGitCommand" in a ? a.runGitCommand : a.runReadOnlyGitCommand);
      const cmdline = ["git", p.command, ...(p.arguments ?? [])].filter(Boolean).join(" ");
      if (lower.includes("bash") || lower.includes("shell") || lower.includes("command") || lower === "terminal") {
        return JSON.stringify({ [ToolBridge.pickField(props, F_CMD)]: cmdline });
      }
      return JSON.stringify(payload);
    }

    if ("runReadFile" in a) {
      const p = a.runReadFile;
      if (lower.includes("read") || lower === "view") {
        const out: Record<string, unknown> = {
          [ToolBridge.pickField(props, F_PATH)]: p.filepath,
        };
        // Always forward offset and limit (best practice: don't skip based on schema)
        const F_OFFSET_EXTENDED = ["offset", "line_offset", "lineOffset", "start_line", "startLine"];
        const F_LIMIT = ["limit", "length", "chunk_size", "chunkSize", "num_lines", "numLines"];
        
        // offset (1-indexed start line)
        if (p.lineOffset !== undefined) {
          out[ToolBridge.pickField(props, F_OFFSET_EXTENDED)] = p.lineOffset;
        }
        
        // limit (number of lines to read)
        if (p.chunkSize !== undefined) {
          out[ToolBridge.pickField(props, F_LIMIT)] = p.chunkSize;
        }
        
        return JSON.stringify(out);
      }
      // Bash-emulation: when the client only declared Bash, use `cat` (or
      // `sed -n` for line offsets). Without this branch, a Bash-routed
      // runReadFile would emit `{filepath:..., lineOffset:...}` to a tool
      // that expects `{command: "..."}` and the call would fail silently.
      if (lower.includes("bash") || lower.includes("shell") || lower === "terminal") {
        let cmd: string;
        if (p.lineOffset && p.chunkSize) {
          // sed -n 'start,endp' for specific line range
          const endLine = p.lineOffset + p.chunkSize - 1;
          cmd = `sed -n '${p.lineOffset},${endLine}p' ${shellQuote(p.filepath)}`;
        } else if (p.lineOffset) {
          cmd = `sed -n '${Number(p.lineOffset)},$p' ${shellQuote(p.filepath)}`;
        } else {
          cmd = `cat ${shellQuote(p.filepath)}`;
        }
        return JSON.stringify({ [ToolBridge.pickField(props, F_CMD)]: cmd });
      }
      return JSON.stringify(payload);
    }

    if ("runReadFiles" in a) {
      const p = a.runReadFiles;
      // A native batch-read tool must declare an array-of-paths field; only
      // then do we hand it the list. Claude Code's `Read` takes a SINGLE
      // `file_path` with no batch mode, so match() routes runReadFiles to Bash
      // when the only read-ish tool can't take an array (see match()).
      const hasPathsField = Object.keys(props).some((k) =>
        F_PATHS.some((c) => c.toLowerCase() === k.toLowerCase()),
      );
      if (!hasPathsField && (lower.includes("bash") || lower.includes("shell") || lower === "terminal")) {
        // `for f in ...; do echo "===$f==="; cat "$f"; done` keeps boundaries.
        const args = p.filepaths.map(shellQuote).join(" ");
        const cmd = `for f in ${args}; do echo "=== $f ==="; cat "$f"; done`;
        return JSON.stringify({ [ToolBridge.pickField(props, F_CMD)]: cmd });
      }
      return JSON.stringify({ [ToolBridge.pickField(props, F_PATHS)]: p.filepaths });
    }

    if ("runWriteFile" in a) {
      const p = a.runWriteFile;
      if (lower.includes("write") || lower.includes("create")) {
        return JSON.stringify({
          [ToolBridge.pickField(props, F_PATH)]: p.filepath,
          [ToolBridge.pickField(props, F_CONTENT)]: p.contents,
        });
      }
      // Bash-emulation: heredoc with a randomized sentinel that won't collide
      // with user content. Note: this is best-effort — for huge files Edit
      // would be more efficient, but Bash gets the job done.
      if (lower.includes("bash") || lower.includes("shell") || lower === "terminal") {
        const sentinel = `EOF_${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
        const cmd = `cat > ${shellQuote(p.filepath)} <<'${sentinel}'\n${p.contents}\n${sentinel}`;
        return JSON.stringify({ [ToolBridge.pickField(props, F_CMD)]: cmd });
      }
      return JSON.stringify(payload);
    }

    if ("runEditFile" in a) {
      const p = a.runEditFile;
      if (lower.includes("edit") || lower.includes("replace")) {
        return JSON.stringify({
          [ToolBridge.pickField(props, F_PATH)]: p.filepath,
          [ToolBridge.pickField(props, F_OLD)]: p.oldString,
          [ToolBridge.pickField(props, F_NEW)]: p.newString,
        });
      }
      // Bash-emulation: use python for safe in-place string replacement —
      // sed/awk are too painful to escape arbitrary strings reliably.
      if (lower.includes("bash") || lower.includes("shell") || lower === "terminal") {
        const py = `import sys,pathlib;p=pathlib.Path(sys.argv[1]);t=p.read_text();o=sys.argv[2];n=sys.argv[3];` +
          `assert t.count(o)==1, f"old_string not unique ({t.count(o)} matches)"; p.write_text(t.replace(o,n))`;
        const cmd = `python3 -c ${shellQuote(py)} ${shellQuote(p.filepath)} ${shellQuote(p.oldString)} ${shellQuote(p.newString)}`;
        return JSON.stringify({ [ToolBridge.pickField(props, F_CMD)]: cmd });
      }
      return JSON.stringify(payload);
    }

    if ("mkdir" in a) {
      const p = a.mkdir;
      if (lower.includes("bash") || lower.includes("shell") || lower === "terminal") {
        return JSON.stringify({
          [ToolBridge.pickField(props, F_CMD)]: `mkdir -p ${shellQuote(p.directory_path)}`,
        });
      }
      return JSON.stringify({ [ToolBridge.pickField(props, F_DIR)]: p.directory_path });
    }

    if ("listDirectory" in a || "scanDirectoryTree" in a) {
      const p = ("listDirectory" in a ? a.listDirectory : a.scanDirectoryTree);
      if (lower.includes("bash") || lower.includes("shell") || lower.includes("command") || lower === "terminal") {
        return JSON.stringify({
          [ToolBridge.pickField(props, F_CMD)]: `ls -la ${shellQuote(p.directory)}`,
        });
      }
      // Native directory-listing tools (Claude Code's `LS`) use `path`, NOT
      // `file_path`. Order candidates so `path` wins, and default to `path`
      // when the schema is empty — `file_path` would be rejected by `LS`.
      return JSON.stringify({ [ToolBridge.pickField(props, F_LS_PATH)]: p.directory });
    }

    if ("findFiles" in a) {
      const p = a.findFiles;
      if (lower.includes("glob")) {
        const out: Record<string, unknown> = {
          [ToolBridge.pickField(props, F_PATTERN)]: p.name_pattern,
        };
        if (p.search_directory) out[ToolBridge.pickField(props, F_PATH)] = p.search_directory;
        return JSON.stringify(out);
      }
      if (lower.includes("bash") || lower.includes("shell") || lower.includes("command") || lower === "terminal") {
        const dir = p.search_directory || ".";
        return JSON.stringify({
          [ToolBridge.pickField(props, F_CMD)]: `find ${shellQuote(dir)} -name ${shellQuote(p.name_pattern)}`,
        });
      }
      return JSON.stringify(payload);
    }

    if ("grep" in a || "runGrep" in a) {
      const p = ("grep" in a ? a.grep : a.runGrep);
      if (lower.includes("grep") || lower.includes("search")) {
        const out: Record<string, unknown> = {
          [ToolBridge.pickField(props, F_PATTERN)]: p.pattern,
        };
        // Only attach optional args the tool actually declares. Claude Code's
        // `Grep` schema may expose only `pattern`; emitting `file_path`/`-i`
        // when they aren't declared makes the client reject the whole call.
        if (p.search_directory && ToolBridge.hasField(props, F_PATH)) {
          out[ToolBridge.pickField(props, F_PATH)] = p.search_directory;
        }
        if (p.case_insensitive && ToolBridge.hasField(props, ["-i", "case_insensitive", "ignore_case", "ignoreCase", "i"])) {
          out[ToolBridge.pickField(props, ["-i", "case_insensitive", "ignore_case", "ignoreCase", "i"])] = true;
        }
        return JSON.stringify(ToolBridge.prune(out, props));
      }
      // Bash-emulation: real `grep -rn` matches what the upstream tool
      // schema expects (line numbers + path + match, recursive into dir).
      if (lower.includes("bash") || lower.includes("shell") || lower === "terminal") {
        const dir = p.search_directory || ".";
        const flags = ["-rn", p.case_insensitive ? "-i" : ""].filter(Boolean).join(" ");
        const cmd = `grep ${flags} ${shellQuote(p.pattern)} ${shellQuote(dir)} || true`;
        return JSON.stringify({ [ToolBridge.pickField(props, F_CMD)]: cmd });
      }
      return JSON.stringify(payload);
    }

    if ("runHTTPRequest" in a) {
      const p = a.runHTTPRequest;
      if (lower.includes("fetch") || lower.includes("http")) {
        return JSON.stringify({
          url: p.url,
          method: p.method,
          ...(p.headers ? { headers: p.headers } : {}),
          ...(p.body ? { body: p.body } : {}),
        });
      }
      if (lower.includes("bash") || lower.includes("shell") || lower === "terminal") {
        const parts: string[] = ["curl", "-fsSL", "-X", p.method.toUpperCase()];
        for (const [k, v] of Object.entries(p.headers ?? {})) {
          parts.push("-H", shellQuote(`${k}: ${v}`));
        }
        if (p.body) parts.push("--data-raw", shellQuote(p.body));
        parts.push(shellQuote(p.url));
        return JSON.stringify({ [ToolBridge.pickField(props, F_CMD)]: parts.join(" ") });
      }
      return JSON.stringify(payload);
    }

    if ("runWebSearch" in a) {
      const p = a.runWebSearch;
      // Native web-search tool: pass query straight through.
      if (lower.includes("search") || lower.includes("web")) {
        const out: Record<string, unknown> = {
          [ToolBridge.pickField(props, ["query", "q", "search", "term"])]: p.query,
        };
        if (p.max_results !== undefined) {
          out[ToolBridge.pickField(props, ["max_results", "limit", "count"])] = p.max_results;
        }
        return JSON.stringify(out);
      }
      // WebFetch fallback — synthesize a search-engine URL.
      if (lower.includes("fetch") || lower.includes("http")) {
        const url = `https://duckduckgo.com/?q=${encodeURIComponent(p.query)}`;
        return JSON.stringify({ url, method: "GET" });
      }
      // Bash fallback — best-effort curl to a search engine.
      if (lower.includes("bash") || lower.includes("shell") || lower === "terminal") {
        const url = `https://duckduckgo.com/?q=${encodeURIComponent(p.query)}`;
        return JSON.stringify({
          [ToolBridge.pickField(props, F_CMD)]: `curl -fsSL ${shellQuote(url)}`,
        });
      }
      return JSON.stringify(payload);
    }

    if ("runFileSearch" in a) {
      const p = a.runFileSearch;
      // Native semantic search — pass through.
      if (lower.includes("file_search") || lower.includes("semantic")) {
        const out: Record<string, unknown> = {
          [ToolBridge.pickField(props, ["query", "q", "search", "term"])]: p.query,
        };
        if (p.search_directory) out[ToolBridge.pickField(props, F_PATH)] = p.search_directory;
        if (p.max_results !== undefined) {
          out[ToolBridge.pickField(props, ["max_results", "limit", "count"])] = p.max_results;
        }
        return JSON.stringify(out);
      }
      // Grep degradation — treat the natural-language query as a literal pattern.
      if (lower.includes("grep") || lower.includes("search") || lower.includes("ripgrep")) {
        const out: Record<string, unknown> = {
          [ToolBridge.pickField(props, F_PATTERN)]: p.query,
        };
        if (p.search_directory) out[ToolBridge.pickField(props, F_PATH)] = p.search_directory;
        return JSON.stringify(out);
      }
      // Bash fallback — recursive grep, tolerate no matches.
      if (lower.includes("bash") || lower.includes("shell") || lower === "terminal") {
        const dir = p.search_directory || ".";
        const cmd = `grep -rn ${shellQuote(p.query)} ${shellQuote(dir)} || true`;
        return JSON.stringify({ [ToolBridge.pickField(props, F_CMD)]: cmd });
      }
      return JSON.stringify(payload);
    }

    if ("runMCPCall" in a) {
      const p = a.runMCPCall;
      // MCP tool args are already a structured object — forward verbatim.
      // The matched tool's schema will reshape if needed via pickField, but
      // most MCP tools accept the upstream property names as-is.
      return JSON.stringify(p.arguments ?? {});
    }

    return JSON.stringify(payload);
  }

  /** Strip the requestID off and return just the action's payload. */
  private static payload(a: ServerAction): unknown {
    const { requestID: _id, ...rest } = a as { requestID: string; [k: string]: unknown };
    // `rest` has exactly one key: the action kind itself. Return its value so
    // the JSON shape matches the upstream schema.
    const keys = Object.keys(rest);
    const first = keys[0];
    if (keys.length === 1 && first !== undefined) return rest[first];
    return rest;
  }
}

/** Minimal POSIX-shell quoter for `Bash` fallbacks. */
function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./@:+,=%-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
