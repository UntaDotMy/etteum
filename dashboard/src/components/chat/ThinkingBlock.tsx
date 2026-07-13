import { useState } from "react";
import { Brain, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

type ThinkingBlockProps = {
  content: string;
  /** While the model is still producing thinking tokens. */
  streaming?: boolean;
  /** Start expanded (default: open while streaming, closed when finished). */
  defaultOpen?: boolean;
  className?: string;
};

/**
 * Collapsible chain-of-thought / reasoning panel for assistant replies.
 */
export function ThinkingBlock({
  content,
  streaming = false,
  defaultOpen,
  className,
}: ThinkingBlockProps) {
  const [open, setOpen] = useState(defaultOpen ?? streaming);

  if (!content && !streaming) return null;

  return (
    <div
      className={cn(
        "mb-2 overflow-hidden rounded-md border border-[var(--border)] bg-[color-mix(in_srgb,var(--secondary)_80%,var(--card))] shadow-[var(--shadow-card)]",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0" />
        )}
        <Brain className="h-3.5 w-3.5 shrink-0 text-[var(--primary)]" />
        <span className="flex-1">Thinking</span>
        {streaming && (
          <span className="inline-flex items-center gap-1 text-[10px] text-[var(--muted-foreground)]">
            <Loader2 className="h-3 w-3 animate-spin text-[var(--primary)]" />
            reasoning…
          </span>
        )}
      </button>
      {open && (
        <div className="border-t border-[var(--border)] px-2.5 py-2">
          {content ? (
            <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-[var(--muted-foreground)]">
              {content}
              {streaming && (
                <span className="ml-0.5 inline-block h-3 w-1 animate-pulse bg-[var(--primary)]/50 align-middle" />
              )}
            </pre>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-[var(--muted-foreground)]">
              <Loader2 className="h-3 w-3 animate-spin text-[var(--primary)]" />
              Model is reasoning…
            </span>
          )}
        </div>
      )}
    </div>
  );
}
