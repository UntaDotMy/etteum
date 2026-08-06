/**
 * Pure logic for the BYOK provider panel, extracted from ByokAccountList.tsx so
 * it can be unit-tested under `bun test` without a DOM/React renderer.
 *
 * Each function is side-effect free: it takes plain data in and returns plain
 * data out. The React component owns state; these own the decisions.
 */

export type BulkKeyLine = { label: string; key: string };

/** The auto-label assigned to the first manually-added key row. */
export const DEFAULT_KEY_LABEL = "default";

/**
 * Parse bulk-paste lines of the form "label:key", "label key", or a bare "key".
 *
 * Bare keys are auto-labeled from the first free `key-N`, counting the labels
 * already on the provider (and `default`), so a repeat paste never collides
 * with an existing `key-1` and rejects the whole batch with a 409. An explicit
 * label that already exists is also remapped to a free auto label rather than
 * failing the batch. Labels are lowercased to match the server's key-label
 * format (BYOK_KEY_LABEL_RE).
 *
 * @param text raw textarea contents, one entry per line
 * @param existingLabels labels already present on the provider (any case)
 * @returns parsed entries in input order; blank lines and empty keys dropped
 */
export function parseBulkLines(text: string, existingLabels: string[] = []): BulkKeyLine[] {
  const parsed: BulkKeyLine[] = [];
  const taken = new Set<string>();
  for (const label of existingLabels) {
    if (label) taken.add(label.toLowerCase());
  }
  taken.add(DEFAULT_KEY_LABEL);

  let nextIndex = 1;
  const nextFreeLabel = (): string => {
    while (taken.has(`key-${nextIndex}`)) nextIndex++;
    const label = `key-${nextIndex}`;
    taken.add(label);
    return label;
  };

  for (const rawLine of text.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    let label = "";
    let key = "";
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx > 0) {
      label = trimmed.slice(0, colonIdx).trim().toLowerCase();
      key = trimmed.slice(colonIdx + 1).trim();
    } else {
      const spaceIdx = trimmed.indexOf(" ");
      if (spaceIdx > 0) {
        label = trimmed.slice(0, spaceIdx).trim().toLowerCase();
        key = trimmed.slice(spaceIdx + 1).trim();
      } else {
        key = trimmed;
      }
    }
    if (!key) continue;
    if (!label) {
      label = nextFreeLabel();
    } else if (taken.has(label)) {
      // Explicit label already on the provider: a bare-key label would 409 the
      // batch, so fall back to a free auto label instead.
      label = nextFreeLabel();
    } else {
      taken.add(label);
    }
    parsed.push({ label, key });
  }
  return parsed;
}

/**
 * Diff an upstream model catalog against the models already listed, returning
 * only the ones not present (case-insensitive). This is what the fetch-models
 * picker offers, so adding never duplicates an existing entry.
 */
export function freshUpstreamModels(upstream: string[], existingModels: string[]): string[] {
  const existing = new Set(existingModels.map((m) => m.toLowerCase()));
  return upstream.filter((m) => !existing.has(m.toLowerCase()));
}

/**
 * Merge picked models into the current list, preserving order and skipping
 * case-insensitive duplicates. Returns the comma-separated string the models
 * textarea stores. Purely additive: existing entries are never removed.
 */
export function mergeModels(existingModels: string[], picked: string[]): string {
  const seen = new Set(existingModels.map((m) => m.toLowerCase()));
  const merged = [...existingModels];
  for (const model of picked) {
    const lower = model.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      merged.push(model);
    }
  }
  return merged.join(", ");
}

/**
 * Cap a keys list for display. Returns the full list when `showAll` is set or
 * when the list already fits, otherwise the first `pageSize` entries. The
 * caller maps over the result with the original array index, so enable/test/
 * delete and sequential priority keep operating on the correct row.
 */
export function paginateKeys<T>(keys: T[], showAll: boolean, pageSize: number): T[] {
  if (showAll || keys.length <= pageSize) return keys;
  return keys.slice(0, pageSize);
}
