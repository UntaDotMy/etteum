import { useState, useEffect, useCallback, useRef } from "react";

interface UseApiResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: (silent?: boolean) => void;
}

export function useApi<T>(fetcher: () => Promise<T>, deps: any[] = []): UseApiResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const prevDataRef = useRef<T | null>(null);
  const isInitialMount = useRef(true);

  const fetchData = useCallback(async (silent = false) => {
    // Only show loading on initial fetch, not on background refetch
    if (isInitialMount.current || !silent) {
      setLoading(true);
    }
    setError(null);
    try {
      const result = await fetcher();
      // Only update state if data actually changed (structural comparison)
      if (JSON.stringify(prevDataRef.current) !== JSON.stringify(result)) {
        setData(result);
        prevDataRef.current = result;
      }
    } catch (err: any) {
      setError(err.message || "An error occurred");
    } finally {
      setLoading(false);
      isInitialMount.current = false;
    }
  }, deps);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { data, loading, error, refetch: fetchData };
}
