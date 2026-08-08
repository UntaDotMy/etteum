/**
 * Human-friendly label for an Alibaba upstream model id (e.g. "qwen3.8-max"
 * -> "Qwen 3.8 Max"). Data-driven so the full live catalog renders without a
 * hardcoded replace chain per model.
 */
export function formatAlibabaModelLabel(model: string): string {
  return model
    .replace(/^(deepseek)/i, "DS ")
    .replace(/^(qwen|glm|kimi|qvq|qwq)/i, (m) => m[0]!.toUpperCase() + m.slice(1).toLowerCase() + " ")
    .replace(/[.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
