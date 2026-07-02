# Token Compression Pipeline

Reduces input tokens before forwarding requests upstream. Sits between the
content sanitizer and the provider router, runs in <10 ms, and writes
per-request savings to `request_logs.compression_stats` for telemetry.

> **TL;DR** — Defaults are sensible. Toggle ON, leave the knobs alone, and
> you'll save ~6 % input tokens at zero risk. Tune only if you have an
> unusual workload.

---

## Pipeline order

```
sanitizeRequest()          (existing — strips Claude Code identity etc.)
        │
        ▼
┌─── compressRequest() ────────────────────────────┐
│  1. DCP          (lossless)  dedup repeat tools   │
│  2. RTK          (lossy)     truncate tool output │
│  3. Caveman      (lossy)     compact system prompt│
│  4. Image dedupe (lossless)  dedup repeat images  │
│  5. Cache markers (struct)   tag cacheable prefix │
└──────────────────────────────────────────────────┘
        │
        ▼
routeRequest()             (existing — picks account, retries, etc.)
```

Lossless techniques run first so lossy steps don't waste cycles compressing
text that was about to be removed anyway. Cache markers run last because
they tag whatever the final prefix shape is.

If anything in the pipeline throws, the original sanitized request is
forwarded as a fallback — compression failure never breaks a real request.

---

## Each technique

### 1. RTK — Tool Result Compression *(lossy, default ON)*

Truncates `tool_result` blocks (and OpenAI-shape `role: "tool"` messages) in
**older** turns. The last N turns are passed through untouched.

**Why it works.** Most agent transcripts contain a few turns where
`Read /huge/file.ts` or `git diff` returned 10–50 KB of output. The model
only needed that text once — to make a decision in the next turn. After
that, it's pure context overhead. RTK detects and trims those.

**What's protected.** The last `keepLastNTurnsFull * 2` messages
(N user/assistant pairs) are NEVER touched. Default 2, so the model always
sees the most recent two pairs in full.

**Smart truncation.** When `smartTruncate: true` (default), RTK recognises
common command shapes and uses pattern-aware logic:

- **`git diff`** — keeps every hunk header (`@@ -1,5 +1,5 @@`) and the first/
  last 5 lines of each hunk body. The bulk in the middle is replaced with
  `…[N hunk lines elided]…`.
- **`tree` / `ls -R`** — keeps depth ≤ 2, summarises deeper entries with
  `…[N deeper entries collapsed]…`.
- **Everything else** — head 70 % + tail 30 %, with a banner
  `…[truncated 25KB / ~128 lines]…` between them.

**Settings**

| Key                                       | Default | Range          | Meaning                                                                          |
| ----------------------------------------- | ------- | -------------- | -------------------------------------------------------------------------------- |
| `compression_rtk_enabled`                 | `true`  | bool           | Master switch.                                                                   |
| `compression_rtk_max_tool_chars`          | `4000`  | 500 – 50 000   | Cap per older `tool_result`. ~4 chars = 1 token, so 4000 ≈ 1000 tokens.          |
| `compression_rtk_keep_last_n_turns_full`  | `2`     | 0 – 20         | Turns to leave fully untouched. Lower = more saving; higher = safer.             |
| `compression_rtk_smart_truncate`          | `true`  | bool           | Pattern-aware truncation for git diff / tree. Off → generic head+tail only.      |

**Quick presets** (in the dashboard)

| Preset       | maxToolChars | keepN | When to use                                                       |
| ------------ | ------------ | ----- | ----------------------------------------------------------------- |
| Conservative | 8000         | 3     | Long-context agents, debugging sessions where history matters.    |
| Balanced     | 4000         | 2     | **Default.** Sensible for Claude Code style coding agents.        |
| Aggressive   | 2000         | 1     | High-volume, mostly-stateless calls. Saves more, may miss detail. |

**Example.** A `git diff` of 18 000 chars in turn #3 of a 12-turn session,
with default RTK on:

```
before: 18 000 chars  (~4500 tokens)
after:    520 chars   (~130 tokens)   — hunk headers + 5 lines/edge kept
saved:  17 480 chars  (~4370 tokens, 97% on this block)
```

---

### 2. DCP — Context Deduplication *(lossless, default OFF)*

When the same read-only tool is called twice with **identical** input, the
**older** result is replaced with a stub like:

```
[deduplicated: identical Read({"path":"/src/foo.ts"}) — see message #14]
```

The most recent result is preserved (it's the freshest), and the model
still sees that the call happened — just routed through the later block.

**What's whitelisted.** Only tools that are idempotent / read-only:

- `Read`, `Glob`, `Grep`, `LS`, `WebFetch`

Tools with side effects (`Bash`, `Edit`, `Write`, `BashOutput`, `Task`,
…) are **never** deduped — their outputs aren't replayable.

**What's never deduped.**

- Errored results (`is_error: true`) — model needs to see the failure.
- Tiny blocks (< 200 chars) — stub itself would be the same size or larger.

**Settings**

| Key                       | Default | Notes                                                            |
| ------------------------- | ------- | ---------------------------------------------------------------- |
| `compression_dcp_enabled` | `false` | Default off — flip the toggle once you've validated your agents. |
| `compression_dcp_whitelist` | `["Read","Glob","Grep","LS","WebFetch"]` | JSON array, override only if you know your tools are safe. |

**Why off by default.** It's lossless in theory, but if your agent inspects
`tool_result.content` for parsing (rather than just reading), a stub will
look like garbage. Validate first, enable second.

**Saving range.** Typical 10–25 % on long sessions with repeated `Read`s
(very common in Claude Code workflows where the model re-reads the same
file across turns).

---

### 3. Caveman — System Prompt Compaction *(lossy, default OFF)*

Strips filler words and compacts the system prompt. **Off by default**
because shrinking a system prompt CAN change model behaviour.

Three tiers, increasingly aggressive:

| Level   | Saving      | What it does                                                                      |
| ------- | ----------- | --------------------------------------------------------------------------------- |
| `lite`  | ~5 – 15 %   | Drops politeness ("please", "make sure to") and verbose connectors ("in order to" → "to"). Sentence structure preserved. |
| `full`  | ~30 – 50 %  | Lite + drops narrative connectors ("furthermore", "that being said"), drops "the following …" lead-ins, simplifies if/when clauses. |
| `ultra` | ~50 – 70 %  | Full + drops articles (a/an/the), drops modal helpers ("you can/may/might"), forces imperative voice ("X is required" → "X required"). |

**Settings**

| Key                          | Default | Values                  |
| ---------------------------- | ------- | ----------------------- |
| `compression_caveman_enabled` | `false` | `true` / `false`        |
| `compression_caveman_level`   | `lite`  | `lite` / `full` / `ultra` |

**Recommended workflow before flipping ON.**

1. Pick a representative request from `request_logs`.
2. Run the system prompt through `compactText()` locally at each level.
3. Diff the output — does anything important disappear?
4. Run a small batch of real requests with the level enabled.
5. Compare output quality (manual eyeball or judge LLM).
6. Only deploy if the quality didn't drop.

**Why we don't recommend Ultra by default.** Anthropic's own training data
includes lots of "Please" and "you should" phrasings — the model expects
that voice. Telegraphic prompts work but degrade subtly (less hedging,
sometimes more confident-but-wrong outputs).

---

### 4. Image Dedupe *(lossless, default ON)*

Detects duplicate images attached more than once in a single request and
replaces later occurrences with `[duplicate of image in message #N]`. Pure
fingerprint — no decoding, no resize.

**Fingerprint.** `length + first 64 chars + last 64 chars` of the base64
data, or the URL itself for URL-style images. Collision-resistant for the
"same screenshot pasted twice" case which is what we actually see.

**Settings**

| Key                              | Default | Notes |
| -------------------------------- | ------- | ----- |
| `compression_image_dedupe_enabled` | `true`  | Lossless; safe to leave on. |

---

### 5. Cache Markers — Anthropic Prompt Caching *(structural, default ON)*

Tags the stable system-prompt prefix (or last tool definition) with
`cache_control: { type: "ephemeral" }` so upstream Anthropic-compatible
providers can cache the prefix. Anthropic discounts cached input tokens by
~75 %.

**Auto-skip on unstable prefix.** If the system prompt contains a timestamp
(`2024-...`) or UUID, caching would never hit anyway, so we leave it
alone. No false-positive markers in the wire.

**Per-provider override.** Codex doesn't accept `cache_control` — it's
disabled for that provider by default.

**Settings**

| Key                                   | Default | Notes                                                       |
| ------------------------------------- | ------- | ----------------------------------------------------------- |
| `compression_cache_markers_enabled`   | `true`  | Master switch.                                              |
| `compression_cache_markers_overrides` | `{"codex":false}` | JSON object `{ provider: bool }`. `false` = disable for that provider. |

**Stats note.** Cache markers report `0` tokens saved in
`compressionStats.byTechnique.cacheMarkers`. The actual saving comes back
from the upstream `usage.cache_read_input_tokens` field at billing time,
which is recorded separately. We don't double-count.

---

## Telemetry — `request_logs.compression_stats`

JSON column on every successful request. Schema:

```ts
{
  tokensBefore: number,         // estimated tokens before pipeline
  tokensAfter:  number,         // estimated tokens after pipeline
  saved:        number,         // tokensBefore - tokensAfter
  savedPct:     number,         // 0-100, two decimals
  byTechnique: {
    rtk?:         number,       // tokens saved by each technique that ran
    dcp?:         number,
    caveman?:     number,
    imageDedupe?: number,
    // cacheMarkers omitted on purpose — savings are realised upstream
  },
  durationMs:   number          // wall-clock pipeline cost
}
```

**Estimation method.** Char/4 — a real tokenizer would add 5–50 ms to the
hot path. The 4-chars-per-token heuristic is accurate within ~10 % for
English + code. Upstream `usage.prompt_tokens` is the source of truth for
billing; this number is for showing trends in the dashboard.

**Sample queries**

```sql
-- Top 10 sessions by tokens saved today
SELECT
  account_email,
  SUM(json_extract(compression_stats, '$.saved')) AS saved,
  COUNT(*) AS reqs
FROM request_logs
WHERE compression_stats IS NOT NULL
  AND created_at > unixepoch('now', '-1 day') * 1000
GROUP BY account_email
ORDER BY saved DESC
LIMIT 10;

-- Average savings by technique, last 7 days
SELECT
  AVG(json_extract(compression_stats, '$.byTechnique.rtk')) AS avg_rtk,
  AVG(json_extract(compression_stats, '$.byTechnique.dcp')) AS avg_dcp,
  AVG(json_extract(compression_stats, '$.savedPct'))        AS avg_pct,
  AVG(json_extract(compression_stats, '$.durationMs'))      AS avg_ms,
  COUNT(*) AS reqs
FROM request_logs
WHERE compression_stats IS NOT NULL
  AND created_at > unixepoch('now', '-7 day') * 1000;

-- Pipeline overhead distribution
SELECT
  json_extract(compression_stats, '$.durationMs') AS ms,
  COUNT(*) AS n
FROM request_logs
WHERE compression_stats IS NOT NULL
GROUP BY ms
ORDER BY ms;
```

---

## Configuration interfaces

There are three ways to change settings, ordered by recommendation:

### A. Dashboard — `/settings` page

Card titled **Compression**. One toggle + small controls per technique.
Saves to the `settings` table; cache invalidates within 10 s of the next
request.

### B. HTTP API

```bash
# Read everything compression-related
curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:1930/api/settings | jq '.data | with_entries(select(.key | startswith("compression_")))'

# Set one key
curl -s -H "Authorization: Bearer $TOKEN" \
  -X PUT http://localhost:1930/api/settings/compression_rtk_max_tool_chars \
  -H 'Content-Type: application/json' \
  -d '{"value":"6000"}'

# Bulk update
curl -s -H "Authorization: Bearer $TOKEN" \
  -X PUT http://localhost:1930/api/settings \
  -H 'Content-Type: application/json' \
  -d '{
    "compression_rtk_enabled": "true",
    "compression_rtk_max_tool_chars": "6000",
    "compression_dcp_enabled": "true"
  }'
```

All values are stored as strings in the DB — booleans as `"true"`/`"false"`,
ints as their string form, JSON as a JSON-encoded string.

### C. Direct SQL (debugging only)

```sql
-- Disable everything in one go
DELETE FROM settings WHERE key LIKE 'compression_%';   -- back to defaults
-- Or pin a specific value:
INSERT INTO settings (key, value) VALUES
  ('compression_rtk_max_tool_chars', '8000')
ON CONFLICT(key) DO UPDATE SET value = excluded.value;
```

After SQL changes, either restart (`etteum restart`) or wait 10 s for the
config cache to expire. The HTTP API does this invalidation for you.

---

## Defaults reference

```ts
// src/proxy/compression/types.ts
export const DEFAULT_COMPRESSION_CONFIG: CompressionConfig = {
  rtk: {
    enabled: true,
    maxToolChars: 4000,
    keepLastNTurnsFull: 2,
    smartTruncate: true,
  },
  dcp: {
    enabled: false,
    whitelist: ["Read", "Glob", "Grep", "LS", "WebFetch"],
  },
  caveman: {
    enabled: false,
    level: "lite",
  },
  cacheMarkers: {
    enabled: true,
    providerOverrides: { codex: false },
  },
  imageDedupe: {
    enabled: true,
  },
};
```

---

## Edge cases the pipeline handles

| Scenario                                      | What happens                                                       |
| --------------------------------------------- | ------------------------------------------------------------------ |
| `tool_result` smaller than `maxToolChars`     | RTK no-op, savings = 0.                                            |
| Last 2 turns include a 50 KB tool_result      | Untouched (in protected window).                                   |
| Errored tool result repeated 3×               | DCP skips errors entirely.                                         |
| Bash command repeated 3× (e.g. `ls`)          | Never deduped (Bash is not in the read-only whitelist).            |
| System prompt has a UUID or timestamp          | Cache markers auto-skip (would never cache).                       |
| Provider is Codex                             | Cache markers auto-skip.                                           |
| Pipeline throws unexpectedly                  | Sanitized request is forwarded; error logged; request still served. |
| User pastes the same image twice              | Second copy → `[duplicate of image in message #N]`. ~9 KB saved per duplicate. |
| `Read /tmp/big.txt` with 200 KB content       | Older calls truncated; latest fully preserved.                     |
| Settings changed via HTTP                     | Cache invalidates immediately; next request uses new config.       |
| Settings changed via direct SQL               | Cache TTL = 10 s; new config picked up on next reload.             |

---

## Performance budget

| Stage         | Typical | p99   | Worst case  |
| ------------- | ------- | ----- | ----------- |
| Token estimate | < 1 ms  | 2 ms  | ~5 ms       |
| RTK            | 1–3 ms  | 8 ms  | ~15 ms      |
| DCP            | 1–2 ms  | 5 ms  | ~10 ms      |
| Caveman        | < 1 ms  | 2 ms  | ~5 ms       |
| Image dedupe   | < 1 ms  | 3 ms  | ~8 ms       |
| Cache markers  | < 1 ms  | 1 ms  | ~2 ms       |
| **Total**      | **3–8 ms** | **20 ms** | **~30 ms** |

Live measurements after deploy: median ~5 ms, p99 ~12 ms. Token-saving
gain dwarfs the latency cost on real Claude Code workloads.

---

## Implementation map

```
src/proxy/compression/
├── types.ts             # CompressionConfig, CompressionStats, defaults
├── token-estimate.ts    # Char/4 estimator
├── settings.ts          # DB-backed config loader, 10 s TTL cache
├── rtk.ts               # Tool-result truncation + smart patterns
├── dcp.ts               # Read-only tool dedup
├── caveman.ts           # 3-tier system prompt compaction
├── cache-markers.ts     # Anthropic cache_control injector
├── image-dedupe.ts      # Duplicate image detection
├── index.ts             # compressRequest() orchestrator
└── compression.test.ts  # 21 unit tests, 52 assertions
```

Integration points:

- `src/proxy/router.ts` — invokes `compressRequest()` after `sanitizeRequest()`
- `src/proxy/index.ts` — persists `CompressionStats` per request
- `src/api/proxy-settings.ts` — invalidates compression cache on PUT
- `src/db/schema.ts` — `request_logs.compression_stats` (JSON column)

Run tests: `bun test src/proxy/compression/`
