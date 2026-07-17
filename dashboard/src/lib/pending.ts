/**
 * Tracks in-flight "generate / chat" requests so they survive SPA navigation.
 *
 * Root cause of "request is gone": the backend route already persists the
 * finished result to the DB *before* responding (image-studio.ts inserts into
 * image_studio_results, then returns). So the work completes server-side even
 * if the user navigates away mid-flight. The only thing lost is the *client
 * display*: the awaiting fetch() resolves into an unmounted component, so the
 * result never appears until a manual reload.
 *
 * This module is a tiny mount-independent registry. A page marks a request
 * pending when it starts; on mount it re-fetches from the DB (source of truth)
 * so anything that completed while away shows up, and it can render a
 * "finishing…" indicator for requests still in flight.
 *
 * Kept deliberately framework-free (plain module state + subscribe) so both
 * ImageStudio and Chat can share it without a provider.
 */

export type PendingKind = "image" | "video" | "assist" | "chat";

export interface PendingRequest {
  /** Stable key, e.g. `${kind}:${chatId ?? "anon"}:${promptHash}` */
  key: string;
  kind: PendingKind;
  startedAt: number;
  /** Human label for the indicator (e.g. the prompt, truncated). */
  label: string;
}

const pending = new Map<string, PendingRequest>();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* listener errors are non-fatal */
    }
  }
}

export function markPending(req: PendingRequest): void {
  pending.set(req.key, req);
  emit();
}

export function clearPending(key: string): void {
  if (pending.delete(key)) emit();
}

export function getPending(): PendingRequest[] {
  return Array.from(pending.values()).sort((a, b) => a.startedAt - b.startedAt);
}

export function hasPending(): boolean {
  return pending.size > 0;
}

/** Subscribe to pending-set changes. Returns an unsubscribe fn. */
export function subscribePending(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Cheap non-cryptographic prompt hash for a stable pending key. */
export function promptKey(kind: PendingKind, scope: string | number, text: string): string {
  let h = 0;
  const s = `${kind}|${scope}|${text}`;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return `${kind}:${scope}:${(h >>> 0).toString(36)}`;
}
