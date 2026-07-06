/**
 * Provider capability database.
 * Maps provider + model to supported modalities. Used by routeRequest() to:
 *   1. Prefer vision-capable accounts for image requests (hard constraint)
 *   2. Reorder combo candidates by capability fit (soft)
 *
 * Hard capabilities (missing = request must be stripped):
 *   vision      Image URLs / base64 in content blocks
 *   pdf         PDF / document uploads
 *   audioInput  Audio transcription input
 *
 * Soft capabilities (missing = degraded feature, not failure):
 *   search       Built-in web search tool
 *   computerUse  Computer use / browser automation
 *   thinking     Extended thinking / reasoning
 */

export type Capability = "vision" | "pdf" | "audioInput" | "search" | "computerUse" | "thinking";

export interface ModelCapabilities {
  vision?: boolean;
  pdf?: boolean;
  audioInput?: boolean;
  search?: boolean;
  computerUse?: boolean;
  thinking?: boolean;
}

const HARD_CAPS = new Set<Capability>(["vision", "pdf", "audioInput"]);

export function isHardCapability(cap: Capability): boolean {
  return HARD_CAPS.has(cap);
}

type CapEntry = [pattern: string, caps: ModelCapabilities];

const DB: Record<string, CapEntry[]> = {
  "gitlab-duo": [["*", { thinking: true }]],
  kiro: [["*", { thinking: true }]],
  "kiro-pro": [["*", { thinking: true }]],
  codebuddy: [["*", { thinking: true }]],
  "codebuddy-china": [["*", { thinking: true }]],
  canva: [["*", { vision: true }]],
  codex: [["*", { thinking: true }]],
  qoder: [["*", { thinking: true }]],
  byok: [["*", {}]],
  youmind: [["*", {}]],
  alibaba: [["*", { vision: true, thinking: true }]],
  antigravity: [
    ["gemini-2.0*", { vision: true, thinking: true, search: true, computerUse: true }],
    ["gemini*", { vision: true, thinking: true, search: true, computerUse: false }],
    ["*", { vision: true, thinking: true }],
  ],
};

function matchPattern(pattern: string, model: string): boolean {
  const m = model.toLowerCase();
  if (pattern === "*") return true;
  const p = pattern.toLowerCase();
  if (p.startsWith("*") && p.endsWith("*")) return m.includes(p.slice(1, -1));
  if (p.startsWith("*")) return m.endsWith(p.slice(1));
  if (p.endsWith("*")) return m.startsWith(p.slice(0, -1));
  return m === p;
}

const _cache = new Map<string, ModelCapabilities>();

export function getCapabilities(provider: string, model: string): ModelCapabilities {
  const key = `${provider}::${model}`;
  if (_cache.has(key)) return _cache.get(key)!;

  const entries = DB[provider];
  if (!entries) { _cache.set(key, {}); return {}; }

  for (const [pattern, caps] of entries) {
    if (matchPattern(pattern, model)) { _cache.set(key, caps); return caps; }
  }
  _cache.set(key, {});
  return {};
}

export function detectRequiredCapabilities(
  messages: { role: string; content: string | any[] | null }[],
  tools?: any[],
): Set<Capability> {
  const required = new Set<Capability>();

  const scanBlock = (b: any) => {
    if (!b || typeof b !== "object") return;
    const t = b.type;
    if (t === "image_url" || t === "image") required.add("vision");
    if (t === "file" || t === "document" || t === "input_file") {
      const mime = b.mime_type || b.document?.mime_type || "";
      if (mime.startsWith("image/")) required.add("vision");
      else required.add("pdf");
    }
    const mime = b.inlineData?.mimeType || b.fileData?.mimeType || b.mime_type || "";
    if (mime.startsWith("image/")) required.add("vision");
    if (mime === "application/pdf" || mime.includes("pdf")) required.add("pdf");
    if (mime.startsWith("audio/")) required.add("audioInput");
  };

  for (const msg of messages) {
    if (!msg?.content) continue;
    if (typeof msg.content === "string") {
      if (/data:image\//.test(msg.content)) required.add("vision");
      continue;
    }
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) scanBlock(block);
    }
  }

  if (tools) {
    for (const tool of tools) {
      const name = tool?.function?.name?.toLowerCase() || "";
      if (name.includes("search") || name.includes("web") || name.includes("browse")) {
        required.add("search");
      }
    }
  }

  return required;
}

export function reorderByCapabilities<C>(
  candidates: C[],
  required: Set<Capability>,
  getKey: (c: C) => { provider: string; model: string },
): C[] {
  if (!required.size || candidates.length <= 1) return candidates;

  const hardRequired = [...required].filter(isHardCapability);
  const softRequired = [...required].filter((c) => !isHardCapability(c));

  const tierOf = (c: C): number => {
    const { provider, model } = getKey(c);
    const caps = getCapabilities(provider, model);
    if (!hardRequired.every((h) => caps[h])) return 2;
    return softRequired.every((s) => caps[s]) ? 0 : 1;
  };

  return candidates
    .map((c, i) => ({ c, i, t: tierOf(c) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map(({ c }) => c);
}

export function stripUnsupportedCapabilities(
  messages: { role: string; content: string | any[] | null }[],
  provider: string,
  model: string,
): { visionStripped: boolean; pdfStripped: boolean; audioStripped: boolean } {
  const caps = getCapabilities(provider, model);
  const stripped = { visionStripped: false, pdfStripped: false, audioStripped: false };

  for (const msg of messages) {
    if (!msg?.content || typeof msg.content !== "object" || !Array.isArray(msg.content)) continue;
    const newBlocks: any[] = [];
    for (const block of msg.content) {
      if (!block || typeof block !== "object") { newBlocks.push(block); continue; }
      const t = block.type;
      if (t === "image_url" || t === "image") {
        if (!caps.vision) { stripped.visionStripped = true; newBlocks.push({ type: "text", text: "[Image removed - not supported by this model]" }); continue; }
      }
      if (t === "file" || t === "document" || t === "input_file") {
        const mime = block.mime_type || block.document?.mime_type || "";
        if (mime.startsWith("image/") && !caps.vision) { stripped.visionStripped = true; newBlocks.push({ type: "text", text: "[Image removed - not supported by this model]" }); continue; }
        if (!caps.pdf && (mime.includes("pdf") || mime === "application/pdf")) { stripped.pdfStripped = true; newBlocks.push({ type: "text", text: "[Document removed - not supported by this model]" }); continue; }
        if (mime.startsWith("audio/") && !caps.audioInput) { stripped.audioStripped = true; newBlocks.push({ type: "text", text: "[Audio removed - not supported by this model]" }); continue; }
      }
      const mime = block.inlineData?.mimeType || block.fileData?.mimeType || "";
      if (mime.startsWith("image/") && !caps.vision) { stripped.visionStripped = true; newBlocks.push({ type: "text", text: "[Image removed - not supported by this model]" }); continue; }
      newBlocks.push(block);
    }
    if (newBlocks.length > 0 && newBlocks.length !== (msg.content as any[]).length) {
      (msg as any).content = newBlocks;
    }
  }
  return stripped;
}
