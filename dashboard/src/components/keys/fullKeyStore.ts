/**
 * Session-only map of api_keys.id → full key string, captured at create time.
 * The list endpoint only returns a masked preview, so this lets the manager
 * build copyable share links for keys created this session. It is NOT persisted
 * (the full key is never stored to localStorage) — reload and only newly
 * created keys have copyable links; older keys are edited/revoked by id.
 */
const map = new Map<number, string>();

export function rememberFullKey(id: number, key: string): void {
  map.set(id, key);
}

export function getFullKey(id: number): string | undefined {
  return map.get(id);
}
