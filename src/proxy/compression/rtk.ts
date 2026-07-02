/**
 * RTK — Tool Result Compression.
 *
 * Truncates large `tool_result` content blocks (and OpenAI-style `tool` role
 * messages) in OLDER turns. The last N turns are left fully intact so the
 * model still has fresh context for whatever it just did.
 *
 * Smart truncation runs through an ordered shape filter pipeline. The first
 * filter that matches wins; if none matches, we fall back to a generic
 * head + truncation footer.
 *
 * Filters (in probe order — most-specific first):
 *   1. git-diff       → preserve hunk headers + first/last 5 lines per hunk
 *   2. git-status     → categorise Staged/Modified/Untracked, top 10 each
 *   3. tree           → keep depth ≤ 1, count and summarise the tail
 *   4. read-numbered  → cat -n / line-prefixed Read output: head + tail with line range
 *   5. grep           → group by file, keep top 5 matches per file
 *   6. dedup-log      → collapse consecutive duplicate lines (lossless)
 *   7. (fallback)     → generic head + tail with banner
 *
 * Per-filter errors are caught and the pipeline falls through to the next
 * filter (or fallback) — a single buggy filter never breaks the request.
 */

import type { ChatCompletionRequest, ChatMessage } from "../providers/base";
import type { RTKConfig } from "./types";

// ─── Detection regexes ──────────────────────────────────────────────────────

const HUNK_HEAD_RE = /^@@ .+ @@/;
const TREE_LINE_RE = /^[│├└─\s]*[├└]──\s/;
const GIT_DIFF_HEAD_RE = /^(diff --git |index [0-9a-f]+|---|\+\+\+) /m;

const GIT_STATUS_HEAD_RE =
  /^(On branch |nothing to commit|Changes (not |to be )|Untracked files:|## )/m;
const GIT_PORCELAIN_RE = /^[ MADRCU?!][ MADRCU?!] \S/m;

// Read tool output: cat -n style "  123\tcontent" or "123→content" or "123|content".
// We require multiple consecutive numbered lines so single occurrences in a log don't trigger.
const READ_NUMBERED_RE = /(^\s*\d+[→|\t]\s)/m;

// Grep tool output: standard ripgrep / Grep tool format "path:line:content"
const GREP_HEADER_RE = /^Result of search in '[^']*' \(total \d+ files?\):/m;
const GREP_LINE_RE = /^[^\s:]+:\d+:/;

const FILTER_DEBUG = false; // set true to console.warn when a filter falls through

export interface FilterHit {
  filter: string;
  saved: number;
}

// ─── Filter implementations ─────────────────────────────────────────────────

/**
 * git-diff: keep hunk headers + first/last `HUNK_KEEP_EDGE` body lines per hunk.
 */
function truncateGitDiff(text: string, maxChars: number): string {
  const lines = text.split("\n");
  const out: string[] = [];
  const HUNK_KEEP_EDGE = 5;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (HUNK_HEAD_RE.test(line)) {
      const hunkStart = i;
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j] ?? "";
        if (HUNK_HEAD_RE.test(next) || /^diff --git /.test(next)) break;
        j++;
      }
      const hunkLines = lines.slice(hunkStart, j);
      if (hunkLines.length <= 1 + HUNK_KEEP_EDGE * 2) {
        out.push(...hunkLines);
      } else {
        out.push(hunkLines[0]!); // hunk header
        out.push(...hunkLines.slice(1, 1 + HUNK_KEEP_EDGE));
        const dropped = hunkLines.length - 1 - HUNK_KEEP_EDGE * 2;
        out.push(`…[${dropped} hunk lines elided]…`);
        out.push(...hunkLines.slice(-HUNK_KEEP_EDGE));
      }
      i = j;
      continue;
    }
    out.push(line);
    i++;
  }
  let joined = out.join("\n");
  if (joined.length > maxChars) {
    joined =
      joined.slice(0, Math.floor(maxChars * 0.8)) +
      `\n…[truncated remainder of diff: ${joined.length - Math.floor(maxChars * 0.8)} chars]…`;
  }
  return joined;
}

/**
 * git-status: categorise into Staged / Modified / Untracked / Conflicts with
 * top-10 file names per category. For human-readable `git status` output as
 * well as `git status --porcelain`.
 */
function truncateGitStatus(text: string): string {
  const lines = text.split("\n");
  let branch = "";
  const staged: string[] = [];
  const modified: string[] = [];
  const untracked: string[] = [];
  let conflicts = 0;
  let stagedCount = 0;
  let modifiedCount = 0;
  let untrackedCount = 0;

  for (const raw of lines) {
    if (!raw.trim()) continue;

    // Branch header (trim-tolerant)
    const bm = raw.match(/^\s*On branch (\S+)/);
    if (bm) {
      branch = bm[1] ?? "";
      continue;
    }
    if (raw.trimStart().startsWith("##")) {
      branch = raw.trimStart().replace(/^##\s*/, "");
      continue;
    }

    // Porcelain format: "XY <path>" — must be exactly 2 status chars then space.
    // Do NOT trim leading space — " M path" has X=" ", Y="M" and is a valid worktree
    // modification. Trimming would shift X→M, Y=" ", path="path" which is wrong.
    if (raw.length >= 3 && /^[ MADRCU?!][ MADRCU?!] /.test(raw)) {
      const x = raw[0]!;
      const y = raw[1]!;
      const path = raw.slice(3);
      if (raw.startsWith("?? ")) {
        untrackedCount++;
        untracked.push(path);
        continue;
      }
      if ("MADRC".includes(x)) {
        stagedCount++;
        staged.push(path);
      } else if (x === "U") {
        conflicts++;
      }
      if (y === "M" || y === "D") {
        modifiedCount++;
        modified.push(path);
      }
      continue;
    }

    // Verbose format: "modified: path" / "new file: path" / "deleted: path" / "both modified: path"
    const vm = raw.match(/^\s*(modified|new file|deleted|renamed|both modified):\s+(.+)$/);
    if (vm) {
      const kind = vm[1];
      const path = vm[2]!.trim();
      if (kind === "both modified") {
        conflicts++;
      } else if (kind === "modified" || kind === "deleted") {
        modifiedCount++;
        modified.push(path);
      } else {
        // new file / renamed
        stagedCount++;
        staged.push(path);
      }
    }
  }

  let out = "";
  if (branch) out += `* ${branch}\n`;
  if (stagedCount > 0) {
    out += `+ Staged: ${stagedCount} files\n`;
    for (const p of staged.slice(0, 10)) out += `   ${p}\n`;
    if (staged.length > 10) out += `   ... +${staged.length - 10} more\n`;
  }
  if (modifiedCount > 0) {
    out += `~ Modified: ${modifiedCount} files\n`;
    for (const p of modified.slice(0, 10)) out += `   ${p}\n`;
    if (modified.length > 10) out += `   ... +${modified.length - 10} more\n`;
  }
  if (untrackedCount > 0) {
    out += `? Untracked: ${untrackedCount} files\n`;
    for (const p of untracked.slice(0, 10)) out += `   ${p}\n`;
    if (untracked.length > 10) out += `   ... +${untracked.length - 10} more\n`;
  }
  if (conflicts > 0) out += `conflicts: ${conflicts} files\n`;
  if (!out) {
    // Empty parse → return original; caller will fall through to fallback.
    return text;
  }
  return out.replace(/\n+$/, "");
}

/**
 * tree: keep entries at depth 0–1, drop deeper.
 */
function looksLikeTree(text: string): boolean {
  const lines = text.split("\n").slice(0, 30);
  let hits = 0;
  for (const l of lines) if (TREE_LINE_RE.test(l)) hits++;
  return hits >= 5;
}

function truncateTree(text: string, maxChars: number): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  let deeperDropped = 0;
  for (const line of lines) {
    const m = line.match(/^([│ ]*)([├└]──)?/);
    const indent = (m?.[1]?.length ?? 0) / 2;
    if (indent <= 1) {
      kept.push(line);
    } else {
      deeperDropped++;
    }
    if (kept.join("\n").length > maxChars - 100) break;
  }
  const summary =
    deeperDropped > 0 ? `\n…[${deeperDropped} deeper entries collapsed]\n` : "";
  return kept.join("\n") + summary;
}

/**
 * read-numbered: cat -n style output. Keep head + tail with line-range banner
 * instead of char-count banner — more compact when content has 100+ short lines.
 */
function truncateReadNumbered(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const lines = text.split("\n");
  if (lines.length < 20) {
    // Few lines but very long content → fall back to generic
    return text;
  }

  // Keep first ~60% of budget as head, ~30% as tail, ~10% banner overhead.
  const headLines: string[] = [];
  const tailLines: string[] = [];
  let headChars = 0;
  let tailChars = 0;
  const headBudget = Math.floor(maxChars * 0.6);
  const tailBudget = Math.floor(maxChars * 0.3);

  for (const l of lines) {
    if (headChars + l.length + 1 > headBudget) break;
    headLines.push(l);
    headChars += l.length + 1;
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (tailChars + l.length + 1 > tailBudget) break;
    tailLines.unshift(l);
    tailChars += l.length + 1;
  }

  if (headLines.length + tailLines.length >= lines.length) {
    // Overlap — content fits, give up.
    return text;
  }

  const elidedStart = headLines.length + 1;
  const elidedEnd = lines.length - tailLines.length;
  const elidedCount = elidedEnd - elidedStart + 1;
  if (elidedCount <= 0) return text;

  // Try to extract line numbers from boundaries for a clean range banner.
  const startNum = extractLeadingNumber(lines[headLines.length]);
  const endNum = extractLeadingNumber(lines[elidedEnd - 1]);
  const rangeStr =
    startNum != null && endNum != null
      ? `lines ${startNum}–${endNum}`
      : `${elidedCount} lines`;
  const banner = `…[${rangeStr} elided]…`;

  return [...headLines, banner, ...tailLines].join("\n");
}

function extractLeadingNumber(line: string | undefined): number | null {
  if (!line) return null;
  const m = line.match(/^\s*(\d+)[→|\t]/);
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * grep: aggregate "path:line:content" matches per file, keep top 5 per file.
 * Preserves the "Result of search in 'X' (total N files):" header verbatim.
 */
function truncateGrep(text: string, maxChars: number): string {
  const lines = text.split("\n");
  const header: string[] = [];
  const byFile = new Map<string, Array<{ line: string; raw: string }>>();
  let headerDone = false;
  let totalMatches = 0;

  for (const line of lines) {
    if (!headerDone) {
      // Header: empty-line-terminated preamble OR until first match line.
      if (GREP_LINE_RE.test(line)) {
        headerDone = true;
      } else {
        header.push(line);
        continue;
      }
    }
    const m = line.match(/^([^\s:]+):(\d+):(.*)$/);
    if (m) {
      const path = m[1]!;
      const lineNum = m[2]!;
      const content = m[3]!;
      if (!byFile.has(path)) byFile.set(path, []);
      byFile.get(path)!.push({ line: lineNum, raw: `${path}:${lineNum}:${content}` });
      totalMatches++;
    }
  }

  if (byFile.size === 0) return text; // no matches found, defer to fallback

  const out: string[] = [...header];
  if (out.length === 0 || !/total/.test(out[out.length - 1] ?? "")) {
    out.push(`${totalMatches} matches in ${byFile.size} files:`);
  }
  out.push("");

  const PER_FILE_KEEP = 5;
  // Sort files by match count desc so important files come first.
  const sorted = Array.from(byFile.entries()).sort((a, b) => b[1].length - a[1].length);
  for (const [path, hits] of sorted) {
    out.push(`[${path}] (${hits.length}):`);
    for (const h of hits.slice(0, PER_FILE_KEEP)) {
      out.push(`  ${h.line.padStart(4)}: ${h.raw.split(":").slice(2).join(":").trim()}`);
    }
    if (hits.length > PER_FILE_KEEP) {
      out.push(`  ... +${hits.length - PER_FILE_KEEP} more`);
    }
    if (out.join("\n").length > maxChars) {
      out.push(`…[truncated remaining ${sorted.length - sorted.indexOf([path, hits])} files]…`);
      break;
    }
  }
  return out.join("\n");
}

/**
 * dedup-log: collapse runs of consecutive identical lines.
 * Pure lossless: never drops information beyond pure repetition.
 */
function dedupLog(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let prev: string | null = null;
  let dupCount = 0;

  const flushDup = () => {
    if (dupCount > 0) {
      out.push(`  ... (${dupCount} duplicate ${dupCount > 1 ? "lines" : "line"})`);
    }
  };

  for (const line of lines) {
    if (line === prev) {
      dupCount++;
      continue;
    }
    flushDup();
    out.push(line);
    prev = line;
    dupCount = 0;
  }
  flushDup();
  return out.join("\n");
}

// ─── Dispatcher ─────────────────────────────────────────────────────────────

interface ShapeFilter {
  name: string;
  /** Probe the first ~1024 chars to decide if this filter applies. */
  detect: (probe: string) => boolean;
  /** Truncate. May return original text to signal "fall through to next filter". */
  truncate: (text: string, maxChars: number) => string;
}

const SHAPE_FILTERS: ShapeFilter[] = [
  {
    name: "git-diff",
    detect: (probe) => GIT_DIFF_HEAD_RE.test(probe),
    truncate: truncateGitDiff,
  },
  {
    name: "git-status",
    detect: (probe) => GIT_STATUS_HEAD_RE.test(probe) || GIT_PORCELAIN_RE.test(probe),
    truncate: (text) => truncateGitStatus(text),
  },
  {
    name: "tree",
    detect: (probe) => looksLikeTree(probe),
    truncate: truncateTree,
  },
  {
    name: "read-numbered",
    detect: (probe) => {
      // Need ≥3 numbered lines to qualify (one-off "12→" mention isn't enough).
      const lines = probe.split("\n").slice(0, 20);
      let hits = 0;
      for (const l of lines) if (READ_NUMBERED_RE.test(l)) hits++;
      return hits >= 3;
    },
    truncate: truncateReadNumbered,
  },
  {
    name: "grep",
    detect: (probe) => {
      if (GREP_HEADER_RE.test(probe)) return true;
      // Or: ≥60% of first non-empty lines look like "path:line:content"
      const lines = probe.split("\n").filter((l) => l.trim().length > 0);
      if (lines.length < 5) return false;
      const hits = lines.slice(0, 10).filter((l) => GREP_LINE_RE.test(l)).length;
      return hits / Math.min(10, lines.length) >= 0.6;
    },
    truncate: truncateGrep,
  },
  {
    name: "dedup-log",
    detect: (probe) => {
      // Heuristic: ≥30% of first 100 lines are identical to their predecessor.
      const lines = probe.split("\n").slice(0, 100);
      if (lines.length < 10) return false;
      let dupes = 0;
      for (let i = 1; i < lines.length; i++) {
        if (lines[i] && lines[i] === lines[i - 1]) dupes++;
      }
      return dupes / lines.length >= 0.3;
    },
    truncate: (text) => dedupLog(text),
  },
];

const PROBE_CHARS = 1024;
const MIN_COMPRESSIBLE = 500; // chars — under this, not worth trying.

/**
 * Lossless filters: those that NEVER drop information beyond pure structural
 * redundancy. They run on any content >= MIN_COMPRESSIBLE regardless of
 * whether it fits maxChars, because shrinking lossless redundancy is always
 * a pure win (less tokens billed, no context lost).
 *
 * Lossy filters: only run when content > maxChars (need explicit user opt-in
 * to truncation via the size threshold).
 *
 * Note: dedup-log is the only strictly-lossless filter — it merely collapses
 * runs of identical lines into a count. Other filters (git-status, grep) do
 * lose detail (e.g. file names beyond top 10) and so wait for the size gate.
 */
const LOSSLESS_FILTERS = new Set(["dedup-log"]);

/**
 * Smart-truncate dispatcher. Returns text + saved bytes + which filter fired.
 *
 * If `smart` is false, skips filter probing and goes straight to generic.
 */
export function smartTruncateText(
  text: string,
  maxChars: number,
  smart: boolean
): { text: string; saved: number; filter: string | null } {
  if (text.length < MIN_COMPRESSIBLE) {
    return { text, saved: 0, filter: null };
  }

  const before = text.length;
  const probe = text.length > PROBE_CHARS ? text.slice(0, PROBE_CHARS) : text;
  const fitsMaxChars = text.length <= maxChars;

  if (smart) {
    for (const filter of SHAPE_FILTERS) {
      // Lossy filters only run if content exceeds maxChars; lossless filters
      // run on any content >= MIN_COMPRESSIBLE (already checked above).
      const isLossless = LOSSLESS_FILTERS.has(filter.name);
      if (fitsMaxChars && !isLossless) continue;

      let matched = false;
      try {
        matched = filter.detect(probe);
      } catch (err) {
        if (FILTER_DEBUG) console.warn(`[rtk] detect error for ${filter.name}:`, err);
        continue;
      }
      if (!matched) continue;
      try {
        const out = filter.truncate(text, maxChars);
        if (typeof out !== "string" || out.length === 0 || out.length >= before) {
          // Filter declined / no progress — try next.
          if (FILTER_DEBUG)
            console.warn(`[rtk] ${filter.name} produced no savings, trying next`);
          continue;
        }
        return { text: out, saved: before - out.length, filter: filter.name };
      } catch (err: any) {
        if (FILTER_DEBUG)
          console.warn(`[rtk] ${filter.name} threw, falling through:`, err?.message);
        continue;
      }
    }
  }

  // If content fits maxChars and no lossless filter helped, leave as-is.
  if (fitsMaxChars) return { text, saved: 0, filter: null };

  // Generic head + tail with banner (the original fallback for oversize content).
  const headSize = Math.floor(maxChars * 0.7);
  const tailSize = Math.max(0, maxChars - headSize - 80);
  const head = text.slice(0, headSize);
  const tail = tailSize > 0 ? text.slice(-tailSize) : "";
  const droppedChars = before - head.length - tail.length;
  const droppedLines = (text.slice(headSize, before - tail.length).match(/\n/g) || [])
    .length;
  const banner = `\n\n…[truncated ${droppedChars} chars / ~${droppedLines} lines]…\n\n`;
  const out = head + banner + tail;
  return { text: out, saved: before - out.length, filter: "generic" };
}

// ─── Pipeline integration ───────────────────────────────────────────────────

function indicesToCompress(messages: ChatMessage[], keepN: number): Set<number> {
  const out = new Set<number>();
  const protectedFrom = Math.max(0, messages.length - keepN * 2);
  for (let i = 0; i < protectedFrom; i++) out.add(i);
  return out;
}

function compressBlock(
  block: any,
  cfg: RTKConfig,
  savedRef: { v: number },
  hits: FilterHit[]
): any {
  if (!block || typeof block !== "object") return block;

  if (block.type === "tool_result") {
    if (typeof block.content === "string") {
      const r = smartTruncateText(block.content, cfg.maxToolChars, cfg.smartTruncate);
      if (r.saved > 0) {
        savedRef.v += r.saved;
        if (r.filter) hits.push({ filter: r.filter, saved: r.saved });
      }
      return { ...block, content: r.text };
    }
    if (Array.isArray(block.content)) {
      const newContent = block.content.map((inner: any) => {
        if (inner?.type === "text" && typeof inner.text === "string") {
          const r = smartTruncateText(inner.text, cfg.maxToolChars, cfg.smartTruncate);
          if (r.saved > 0) {
            savedRef.v += r.saved;
            if (r.filter) hits.push({ filter: r.filter, saved: r.saved });
          }
          return { ...inner, text: r.text };
        }
        return inner;
      });
      return { ...block, content: newContent };
    }
  }
  return block;
}

export interface RTKResult {
  request: ChatCompletionRequest;
  saved: number;
  hits: FilterHit[];
}

export function applyRTK(request: ChatCompletionRequest, cfg: RTKConfig): RTKResult {
  if (!cfg.enabled) return { request, saved: 0, hits: [] };
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    return { request, saved: 0, hits: [] };
  }

  const eligible = indicesToCompress(request.messages, cfg.keepLastNTurnsFull);
  if (eligible.size === 0) return { request, saved: 0, hits: [] };

  const savedRef = { v: 0 };
  const hits: FilterHit[] = [];
  const newMessages = request.messages.map((msg, i) => {
    if (!eligible.has(i)) return msg;

    if (msg.role === "tool" && typeof msg.content === "string") {
      const r = smartTruncateText(msg.content, cfg.maxToolChars, cfg.smartTruncate);
      if (r.saved > 0) {
        savedRef.v += r.saved;
        if (r.filter) hits.push({ filter: r.filter, saved: r.saved });
      }
      return { ...msg, content: r.text };
    }

    if (Array.isArray(msg.content)) {
      const newContent = (msg.content as any[]).map((b) =>
        compressBlock(b, cfg, savedRef, hits)
      );
      return { ...msg, content: newContent };
    }
    return msg;
  });

  return {
    request: { ...request, messages: newMessages },
    saved: savedRef.v,
    hits,
  };
}
