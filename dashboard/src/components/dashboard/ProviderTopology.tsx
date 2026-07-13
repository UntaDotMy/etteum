"use client";

import { useMemo, useCallback, useRef, useEffect } from "react";
import {
  ReactFlow,
  Handle,
  Position,
  Controls,
  Background,
  BackgroundVariant,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useTheme } from "@/hooks/useTheme";

// ── Provider identity colors (stable per provider; not theme semantic status) ─

const PROVIDER_COLORS: Record<string, string> = {
  kiro: "#10b981",
  "kiro-pro": "#059669",
  codebuddy: "#6366f1",
  "codebuddy-china": "#4f46e5",
  codex: "#f59e0b",
  canva: "#ec4899",
  qoder: "#8b5cf6",
  "gitlab-duo": "#e11d48",
  youmind: "#06b6d4",
  byok: "#78716c",
  alibaba: "#ef4444",
  grok: "#00ff88",
};

function getColor(provider: string): string {
  return PROVIDER_COLORS[provider] || "#6b7280";
}

/** Theme semantic status colors (read live so light/dark both work). */
function statusColor(kind: "active" | "error"): string {
  if (typeof document === "undefined") {
    return kind === "active" ? "#00ff88" : "#ff5c5c";
  }
  const styles = getComputedStyle(document.documentElement);
  return (
    styles.getPropertyValue(kind === "active" ? "--success" : "--error").trim() ||
    (kind === "active" ? "#00ff88" : "#ff5c5c")
  );
}

function getLabel(provider: string): string {
  const map: Record<string, string> = {
    "kiro-pro": "Kiro Pro",
    "codebuddy-china": "Codebuddy CN",
    "gitlab-duo": "GitLab Duo",
  };
  return map[provider] || provider.charAt(0).toUpperCase() + provider.slice(1);
}

function getIcon(provider: string): string {
  return (provider || "?").slice(0, 2).toUpperCase();
}

// ── Custom Nodes ────────────────────────────────────────────────────

function ProviderNode({ data }: { data: any }) {
  const { label, color, icon, active, error } = data;
  const activeColor = statusColor("active");
  const errorColor = statusColor("error");

  return (
    <div
      className="flex items-center gap-2.5 px-4 py-2.5 rounded-lg border-2 transition-all duration-300"
      style={{
        borderColor: active ? activeColor : error ? errorColor : "var(--border)",
        boxShadow: active
          ? `0 0 16px color-mix(in srgb, ${activeColor} 35%, transparent)`
          : error
            ? `0 0 12px color-mix(in srgb, ${errorColor} 30%, transparent)`
            : "none",
        backgroundColor: "var(--card)",
        minWidth: "150px",
      }}
    >
      <Handle type="target" position={Position.Top} id="top" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="target" position={Position.Bottom} id="bottom" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="target" position={Position.Left} id="left" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="target" position={Position.Right} id="right" className="!bg-transparent !border-0 !w-0 !h-0" />

      <div
        className="w-8 h-8 rounded-md flex items-center justify-center shrink-0"
        style={{ backgroundColor: `${color}20` }}
      >
        <span className="text-sm font-bold" style={{ color }}>{icon}</span>
      </div>

      <span
        className="text-sm font-medium truncate"
        style={{ color: active ? activeColor : error ? errorColor : "var(--foreground)" }}
      >
        {label}
      </span>

      {active && (
        <span className="relative flex h-2.5 w-2.5 shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75" style={{ backgroundColor: activeColor }} />
          <span className="relative inline-flex rounded-full h-2.5 w-2.5" style={{ backgroundColor: activeColor }} />
        </span>
      )}

      {error && !active && (
        <span className="relative flex h-2.5 w-2.5 shrink-0">
          <span className="absolute inline-flex h-full w-full rounded-full opacity-50" style={{ backgroundColor: errorColor }} />
          <span className="relative inline-flex rounded-full h-2.5 w-2.5" style={{ backgroundColor: errorColor }} />
        </span>
      )}
    </div>
  );
}

function RouterNode({ data }: { data: any }) {
  return (
    <div className="flex items-center justify-center px-5 py-3 rounded-xl border-2 border-[var(--primary)] bg-[color-mix(in_srgb,var(--primary)_8%,var(--card))] shadow-[var(--shadow-card)] min-w-[120px]">
      <Handle type="source" position={Position.Top} id="top" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="source" position={Position.Bottom} id="bottom" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="source" position={Position.Left} id="left" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="source" position={Position.Right} id="right" className="!bg-transparent !border-0 !w-0 !h-0" />

      <svg className="w-5 h-5 mr-2 text-[var(--primary)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="3" />
        <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
      </svg>
      <span className="text-sm font-bold text-[var(--primary)]">Pool Proxy</span>
      {data.activeCount > 0 && (
        <span className="ml-2 px-1.5 py-0.5 rounded-full bg-[var(--primary)] text-[var(--primary-foreground)] text-xs font-bold">
          {data.activeCount}
        </span>
      )}
    </div>
  );
}

const nodeTypes = { provider: ProviderNode, router: RouterNode };

// ── Layout Engine ───────────────────────────────────────────────────

function buildLayout(
  providers: { provider: string; count: number; active: boolean; error: boolean }[],
) {
  const nodeW = 180;
  const nodeH = 30;
  const routerW = 110;
  const routerH = 44;
  const nodeGap = 24;

  const count = providers.length;

  if (count === 0) {
    return {
      nodes: [
        { id: "router", type: "router" as const, position: { x: 0, y: 0 }, data: { activeCount: 0 }, draggable: false },
      ],
      edges: [],
    };
  }

  // Compute rx so arc spacing between nodes is at least nodeW + nodeGap
  const minRx = ((nodeW + nodeGap) * count) / (2 * Math.PI);
  const rx = Math.max(300, minRx);
  const ry = Math.max(180, rx * 0.55);

  const nodes: any[] = [];
  const edges: any[] = [];

  nodes.push({
    id: "router",
    type: "router",
    position: { x: -routerW / 2, y: -routerH / 2 },
    data: { activeCount: providers.filter((p) => p.active).length },
    draggable: false,
  });

  providers.forEach((p, i) => {
    const color = getColor(p.provider);
    const nodeId = `provider-${p.provider}`;

    const angle = -Math.PI / 2 + (2 * Math.PI * i) / count;
    const cx = rx * Math.cos(angle);
    const cy = ry * Math.sin(angle);

    // Pick router handle closest to the node direction
    let sourceHandle: string, targetHandle: string;
    const d = angle + Math.PI / 2; // normalize so top = 0
    const ad = ((d % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    if (ad < Math.PI / 4 || ad >= (7 * Math.PI) / 4) {
      sourceHandle = "top"; targetHandle = "bottom";
    } else if (ad < (3 * Math.PI) / 4) {
      sourceHandle = "right"; targetHandle = "left";
    } else if (ad < (5 * Math.PI) / 4) {
      sourceHandle = "bottom"; targetHandle = "top";
    } else {
      sourceHandle = "left"; targetHandle = "right";
    }

    nodes.push({
      id: nodeId,
      type: "provider",
      position: { x: cx - nodeW / 2, y: cy - nodeH / 2 },
      data: {
        label: getLabel(p.provider),
        color,
        icon: getIcon(p.provider),
        active: p.active,
        error: p.error,
      },
      draggable: false,
    });

    const activeColor = statusColor("active");
    const errorColor = statusColor("error");
    edges.push({
      id: `e-${nodeId}`,
      source: "router",
      sourceHandle,
      target: nodeId,
      targetHandle,
      animated: p.active,
      style: p.error
        ? { stroke: errorColor, strokeWidth: 2.5, opacity: 0.9 }
        : p.active
          ? { stroke: activeColor, strokeWidth: 2.5, opacity: 0.9 }
          : { stroke: "var(--border)", strokeWidth: 1, opacity: 0.35 },
    });
  });

  return { nodes, edges };
}

// ── Component ───────────────────────────────────────────────────────

interface TopologyProvider {
  provider: string;
  count: number;
  active: boolean;
  error: boolean;
}

interface Props {
  providers: TopologyProvider[];
}

export default function ProviderTopology({ providers }: Props) {
  const { theme } = useTheme();
  // Rebuild when theme flips so edge/node status colors pick up new CSS vars.
  const { nodes, edges } = useMemo(() => buildLayout(providers), [providers, theme]);

  const rfInstance = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const fitOpts = { padding: 0.2, duration: 200 };

  const onInit = useCallback((instance: any) => {
    rfInstance.current = instance;
    setTimeout(() => instance.fitView(fitOpts), 50);
  }, []);

  // Re-fit on container resize
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (rfInstance.current) rfInstance.current.fitView(fitOpts);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Re-fit when node count/layout changes
  useEffect(() => {
    if (rfInstance.current) {
      setTimeout(() => rfInstance.current.fitView(fitOpts), 50);
    }
  }, [nodes.length]);

  const providersKey = useMemo(
    () => providers.map((p) => p.provider).sort().join(","),
    [providers],
  );

  if (providers.length === 0) {
    return (
      <div className="h-[300px] sm:h-[400px] w-full rounded-lg border border-[var(--border)] bg-[var(--card)]/30 flex items-center justify-center text-sm text-[var(--muted-foreground)]">
        No providers connected yet
      </div>
    );
  }

  return (
    <div ref={containerRef} className="h-[300px] sm:h-[400px] w-full min-w-0 rounded-lg border border-[var(--border)] bg-[var(--card)]/30">
      <ReactFlow
        key={`${providersKey}-${theme}`}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        colorMode={theme}
        fitView
        fitViewOptions={fitOpts}
        minZoom={0.1}
        maxZoom={2}
        onInit={onInit}
        proOptions={{ hideAttribution: true }}
        panOnDrag
        zoomOnScroll
        zoomOnPinch
        zoomOnDoubleClick
        preventScrolling={false}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        style={{ background: "transparent" }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={18}
          size={1}
          color="var(--border)"
        />
        <Controls
          showInteractive={false}
          className="!rounded-md !border !border-[var(--border)] !bg-[var(--card)] !shadow-[var(--shadow-card)] [&>button]:!border-[var(--border)] [&>button]:!bg-[var(--card)] [&>button]:!text-[var(--foreground)] [&>button:hover]:!bg-[var(--secondary)]"
        />
      </ReactFlow>
    </div>
  );
}