import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { getWsBase } from "@/lib/api";

/**
 * A single shared WebSocket connection for the whole app.
 *
 * Pages subscribe to message types via `useWsEvent(type, handler)` instead of
 * each opening their own socket. One connection, auto-reconnecting with
 * backoff, fans every message out to the registered handlers.
 */

export type WsStatus = "connecting" | "open" | "closed";

interface WsMessage {
  type: string;
  data?: any;
  [key: string]: any;
}

type Handler = (msg: WsMessage) => void;

interface WsContextValue {
  status: WsStatus;
  /** Subscribe to a message type (or "*" for all). Returns an unsubscribe fn. */
  subscribe: (type: string, handler: Handler) => () => void;
  send: (data: any) => void;
}

const WsContext = createContext<WsContextValue | null>(null);

const MAX_BACKOFF_MS = 15_000;
const BASE_BACKOFF_MS = 1_000;

export function WebSocketProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<WsStatus>("connecting");

  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef<Map<string, Set<Handler>>>(new Map());
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);
  const aliveRef = useRef(true);
  const connectionIdRef = useRef(0);

  const subscribe = useCallback((type: string, handler: Handler) => {
    let set = handlersRef.current.get(type);
    if (!set) {
      set = new Set();
      handlersRef.current.set(type, set);
    }
    set.add(handler);
    return () => {
      const s = handlersRef.current.get(type);
      if (!s) return;
      s.delete(handler);
      if (s.size === 0) handlersRef.current.delete(type);
    };
  }, []);

  const dispatch = useCallback((msg: WsMessage) => {
    const exact = handlersRef.current.get(msg.type);
    if (exact) for (const h of exact) { try { h(msg); } catch { /* handler error is non-fatal */ } }
    const wild = handlersRef.current.get("*");
    if (wild) for (const h of wild) { try { h(msg); } catch { /* */ } }
  }, []);

  const connect = useCallback(() => {
    if (!aliveRef.current) return;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    const connectionId = ++connectionIdRef.current;
    setStatus(attemptRef.current === 0 ? "connecting" : "connecting");

    let ws: WebSocket;
    try {
      ws = new WebSocket(`${getWsBase()}/ws`);
    } catch {
      scheduleReconnect();
      return;
    }
    wsRef.current = ws;

    ws.onopen = () => {
      if (connectionId !== connectionIdRef.current) return;
      attemptRef.current = 0;
      setStatus("open");
    };

    ws.onmessage = (event) => {
      if (connectionId !== connectionIdRef.current) return;
      try {
        dispatch(JSON.parse(event.data));
      } catch {
        /* ignore non-JSON frames */
      }
    };

    ws.onclose = () => {
      if (connectionId !== connectionIdRef.current) return;
      setStatus("closed");
      scheduleReconnect();
    };

    ws.onerror = () => {
      if (connectionId !== connectionIdRef.current) return;
      ws.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch]);

  const scheduleReconnect = useCallback(() => {
    if (!aliveRef.current) return;
    const delay = Math.min(
      MAX_BACKOFF_MS,
      BASE_BACKOFF_MS * 2 ** attemptRef.current
    );
    attemptRef.current += 1;
    reconnectTimerRef.current = setTimeout(connect, delay);
  }, [connect]);

  useEffect(() => {
    aliveRef.current = true;
    connect();

    // Reconnect promptly when the tab becomes visible again.
    const onVisible = () => {
      if (
        document.visibilityState === "visible" &&
        wsRef.current?.readyState !== WebSocket.OPEN &&
        wsRef.current?.readyState !== WebSocket.CONNECTING
      ) {
        attemptRef.current = 0;
        connect();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      aliveRef.current = false;
      connectionIdRef.current++;
      document.removeEventListener("visibilitychange", onVisible);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
        ws.close();
      }
    };
  }, [connect]);

  const send = useCallback((data: any) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(typeof data === "string" ? data : JSON.stringify(data));
    }
  }, []);

  return (
    <WsContext.Provider value={{ status, subscribe, send }}>
      {children}
    </WsContext.Provider>
  );
}

/** Connection status of the shared socket: "connecting" | "open" | "closed". */
export function useWsStatus(): WsStatus {
  const ctx = useContext(WsContext);
  return ctx?.status ?? "closed";
}

/**
 * Subscribe to one (or many) server event types. The handler is kept in a ref
 * so callers can pass an inline function without re-subscribing every render.
 *
 *   useWsEvent("request_log", (msg) => setLogs((l) => [msg.data, ...l]));
 *   useWsEvent(["account_status", "account_updated"], reload);
 */
export function useWsEvent(
  type: string | string[],
  handler: Handler
): void {
  const ctx = useContext(WsContext);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  const types = Array.isArray(type) ? type : [type];
  const key = types.join("|");

  useEffect(() => {
    if (!ctx) return;
    const stable: Handler = (msg) => handlerRef.current(msg);
    const unsubs = types.map((t) => ctx.subscribe(t, stable));
    return () => unsubs.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, key]);
}

/** Access the raw send() if a page needs to push to the server. */
export function useWsSend() {
  const ctx = useContext(WsContext);
  return ctx?.send ?? (() => {});
}
