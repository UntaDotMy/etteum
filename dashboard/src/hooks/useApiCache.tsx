import { useState, useEffect, useRef, useCallback } from 'react';
import { useWsEvent } from './useWebSocket';

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  isValidating: boolean;
}

type CacheStore = Map<string, CacheEntry<any>>;

const cache: CacheStore = new Map();

// Default stale time: 5 seconds
const DEFAULT_STALE_TIME = 5000;

// Coalesce WS-triggered revalidations across multiple useApiCache instances.
// When request_log fires, dashboard-stats + dashboard-models + requests-*
// + analytics all want to revalidate. Instead of each scheduling independently,
// we batch all pending revalidations on a single 300ms timer tick.
let coalesceTimer: ReturnType<typeof setTimeout> | null = null;
const coalescedCallbacks = new Set<() => void>();

function scheduleCoalesced(revalidateCb: () => void) {
  coalescedCallbacks.add(revalidateCb);
  if (coalesceTimer) return;
  coalesceTimer = setTimeout(() => {
    coalesceTimer = null;
    for (const cb of coalescedCallbacks) cb();
    coalescedCallbacks.clear();
  }, 300);
}

/**
 * Fast structural comparison — checks if two values are "the same" for
 * rendering purposes. Handles primitives, arrays, and plain objects
 * up to 2 levels deep. Avoids re-render flicker when the API returns
 * an identical response on revalidation.
 *
 * Handles numeric coercion: "123" == 123 (common API inconsistency)
 */
function isDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;

  // Handle numeric coercion: "123" vs 123
  if (typeof a === 'number' && typeof b === 'string') {
    return !isNaN(Number(b)) && a === Number(b);
  }
  if (typeof a === 'string' && typeof b === 'number') {
    return !isNaN(Number(a)) && Number(a) === b;
  }

  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!isDeepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (Array.isArray(a) || Array.isArray(b)) return false;

  const keysA = Object.keys(a as Record<string, unknown>);
  const keysB = Object.keys(b as Record<string, unknown>);
  if (keysA.length !== keysB.length) return false;

  for (const key of keysA) {
    if (!isDeepEqual(
      (a as Record<string, unknown>)[key],
      (b as Record<string, unknown>)[key]
    )) return false;
  }
  return true;
}

/**
 * SWR-style data fetching hook with caching and background revalidation.
 * 
 * - Returns cached data instantly on mount (no flicker, no scroll reset)
 * - Revalidates in background when data is stale
 * - Skips re-render when revalidated data is structurally identical
 * - Invalidates on WebSocket events
 *
 * @param key - Unique cache key (e.g., 'accounts', 'dashboard-stats')
 * @param fetcher - Async function to fetch data
 * @param options - Configuration options
 * @returns { data, error, isValidating, mutate }
 */
export function useApiCache<T>(
  key: string | null,
  fetcher: () => Promise<T>,
  options: {
    staleTime?: number;
    revalidateOnFocus?: boolean;
    revalidateOnMount?: boolean;
    wsEvents?: string[];
  } = {}
) {
  const {
    staleTime = DEFAULT_STALE_TIME,
    revalidateOnFocus = true,
    revalidateOnMount = true,
    wsEvents = [],
  } = options;

  // Initialize from cache synchronously — this is the key to no-flicker.
  // On first render we already have data, so React never shows an empty state.
  const [data, setData] = useState<T | null>(() => {
    if (!key) return null;
    return cache.get(key)?.data ?? null;
  });
  const [error, setError] = useState<Error | null>(null);
  const [isValidating, setIsValidating] = useState(false);

  const mountedRef = useRef(true);
  const keyRef = useRef(key);
  keyRef.current = key;
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const lastRevalidateRef = useRef(0);
  const revalidateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Stable revalidation — uses fetcherRef to avoid re-creating the callback
  // every time the fetcher identity changes (which would retrigger useEffect).
  // CRITICAL: This function must NOT call setState unless data actually changed.
  const revalidate = useCallback(async () => {
    const cacheKey = keyRef.current;
    if (!cacheKey) return;

    // Don't update isValidating state - it causes unnecessary re-renders
    // Just update the cache silently
    const existing = cache.get(cacheKey);
    if (existing) {
      cache.set(cacheKey, { ...existing, isValidating: true });
    }

    try {
      const result = await fetcherRef.current();

      if (!mountedRef.current) return;

      // CRITICAL: only update state if data actually changed.
      // This prevents the flicker and scroll reset that happens when
      // React re-renders with a "new" object that is structurally identical.
      const prev = cache.get(cacheKey)?.data;
      const changed = !isDeepEqual(prev, result);

      cache.set(cacheKey, {
        data: result,
        timestamp: Date.now(),
        isValidating: false,
      });

      if (changed) {
        setData(result);
      }
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;

      const error = err instanceof Error ? err : new Error(String(err));
      setError(error);

      const existing = cache.get(cacheKey);
      if (existing) {
        cache.set(cacheKey, { ...existing, isValidating: false });
      }
    }
  }, []);

  const isStale = useCallback(() => {
    if (!keyRef.current) return true;
    const cached = cache.get(keyRef.current);
    if (!cached) return true;
    return Date.now() - cached.timestamp > staleTime;
  }, [staleTime]);

  // Initial fetch on mount
  useEffect(() => {
    mountedRef.current = true;

    if (!key || !revalidateOnMount) return;

    const cached = cache.get(key);
    const now = Date.now();

    // Fresh cache → use immediately, no fetch needed
    if (cached && now - cached.timestamp <= staleTime) {
      setData(cached.data);
      return;
    }

    // Stale cache → show stale data immediately, fetch in background
    if (cached) {
      setData(cached.data);
    }

    revalidate();

    return () => {
      mountedRef.current = false;
    };
  }, [key, staleTime, revalidateOnMount, revalidate]);

  // Revalidate on tab focus
  useEffect(() => {
    if (!revalidateOnFocus || !key) return;

    const handleFocus = () => {
      if (document.visibilityState === 'visible' && isStale()) {
        revalidate();
      }
    };

    document.addEventListener('visibilitychange', handleFocus);
    return () => document.removeEventListener('visibilitychange', handleFocus);
  }, [key, revalidateOnFocus, isStale, revalidate]);

  // Invalidate on WebSocket events — coalesced across all useApiCache instances.
  // When request_log fires, 4+ different caches all need revalidation. Instead
  // of each scheduling independently, we batch all pending calls on a single
  // 300ms timer tick, reducing the spike from O(n) separate API calls to one
  // burst of calls within a single JS microtask cycle.
  useWsEvent(wsEvents, () => {
    if (!key) return;

    const now = Date.now();
    const timeSinceLastRevalidate = now - lastRevalidateRef.current;

    if (timeSinceLastRevalidate < 2000) {
      if (revalidateTimerRef.current) {
        clearTimeout(revalidateTimerRef.current);
      }
      const delay = 2000 - timeSinceLastRevalidate;
      revalidateTimerRef.current = setTimeout(() => {
        revalidateTimerRef.current = null;
        lastRevalidateRef.current = Date.now();
        scheduleCoalesced(revalidate);
      }, delay);
      return;
    }

    lastRevalidateRef.current = now;
    scheduleCoalesced(revalidate);
  });
  
  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (revalidateTimerRef.current) {
        clearTimeout(revalidateTimerRef.current);
      }
    };
  }, []);

  // Manual mutation function
  const mutate = useCallback(async (newData?: T) => {
    if (!keyRef.current) return;

    if (newData !== undefined) {
      cache.set(keyRef.current, {
        data: newData,
        timestamp: Date.now(),
        isValidating: false,
      });
      setData(newData);
    } else {
      await revalidate();
    }
  }, [revalidate]);

  return {
    data,
    error,
    isValidating,
    mutate,
  };
}

/**
 * Invalidate a specific cache key, forcing revalidation on next access
 */
export function invalidateCache(key: string) {
  cache.delete(key);
}

/**
 * Clear entire cache
 */
export function clearCache() {
  cache.clear();
}

/**
 * Pre-populate cache with data
 */
export function setCacheData<T>(key: string, data: T) {
  cache.set(key, {
    data,
    timestamp: Date.now(),
    isValidating: false,
  });
}
