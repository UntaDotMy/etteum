import { useState, useEffect, useRef, useCallback } from 'react';
import { useWsEvent } from './useWebSocket';

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  isValidating: boolean;
}

type CacheStore = Map<string, CacheEntry<any>>;
type InvalidateHandler = (key: string) => void;

const cache: CacheStore = new Map();
const subscribers = new Set<InvalidateHandler>();

// Default stale time: 5 seconds
const DEFAULT_STALE_TIME = 5000;

/**
 * SWR-style data fetching hook with caching and background revalidation.
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

  const [data, setData] = useState<T | null>(() => {
    if (!key) return null;
    const cached = cache.get(key);
    return cached?.data ?? null;
  });
  const [error, setError] = useState<Error | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  
  const mountedRef = useRef(true);
  const keyRef = useRef(key);
  keyRef.current = key;

  // Revalidation function
  const revalidate = useCallback(async () => {
    if (!keyRef.current) return;
    
    const cacheKey = keyRef.current;
    setIsValidating(true);
    
    // Update cache entry to show validating state
    const existing = cache.get(cacheKey);
    if (existing) {
      cache.set(cacheKey, { ...existing, isValidating: true });
    }

    try {
      const result = await fetcher();
      
      if (mountedRef.current) {
        // Update cache
        cache.set(cacheKey, {
          data: result,
          timestamp: Date.now(),
          isValidating: false,
        });
        
        setData(result);
        setError(null);
        setIsValidating(false);
      }
    } catch (err) {
      if (mountedRef.current) {
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
        setIsValidating(false);
        
        // Update cache to not be validating anymore
        const existing = cache.get(cacheKey);
        if (existing) {
          cache.set(cacheKey, { ...existing, isValidating: false });
        }
      }
    }
  }, [fetcher]);

  // Check if data is stale
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
    
    // If we have fresh data, use it immediately
    if (cached && now - cached.timestamp <= staleTime) {
      setData(cached.data);
      setIsValidating(false);
      return;
    }

    // If we have stale data, show it but revalidate in background
    if (cached) {
      setData(cached.data);
      setIsValidating(true);
    }

    revalidate();

    return () => {
      mountedRef.current = false;
    };
  }, [key, revalidate, staleTime, revalidateOnMount]);

  // Revalidate on focus
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

  // Invalidate on WebSocket events
  useWsEvent(wsEvents, () => {
    if (key && isStale()) {
      revalidate();
    }
  });

  // Manual mutation function
  const mutate = useCallback(async (newData?: T) => {
    if (!keyRef.current) return;
    
    if (newData !== undefined) {
      // Optimistic update
      cache.set(keyRef.current, {
        data: newData,
        timestamp: Date.now(),
        isValidating: false,
      });
      setData(newData);
    } else {
      // Revalidate
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
  subscribers.forEach(handler => handler(key));
}

/**
 * Clear entire cache
 */
export function clearCache() {
  cache.clear();
}

/**
 * Pre-populate cache with data (useful for SSR or optimistic updates)
 */
export function setCacheData<T>(key: string, data: T) {
  cache.set(key, {
    data,
    timestamp: Date.now(),
    isValidating: false,
  });
}
