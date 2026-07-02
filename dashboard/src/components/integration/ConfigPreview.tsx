import { Copy, Check } from "lucide-react";
import { useState } from "react";

interface ConfigPreviewProps {
  config: Record<string, unknown> | string;
  label?: string;
}

export function ConfigPreview({ config, label }: ConfigPreviewProps) {
  const [copied, setCopied] = useState(false);

  const content =
    typeof config === "string" ? config : JSON.stringify(config, null, 2);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="space-y-1">
      {label && (
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-[var(--muted-foreground)]">
            {label}
          </span>
          <button
            onClick={handleCopy}
            className="p-1 rounded hover:bg-[var(--secondary)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
            title="Copy config"
          >
            {copied ? (
              <Check className="w-3 h-3 text-[var(--success)]" />
            ) : (
              <Copy className="w-3 h-3" />
            )}
          </button>
        </div>
      )}
      <pre className="px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--background)] text-[11px] font-mono text-[var(--foreground)] overflow-x-auto whitespace-pre max-h-64 overflow-y-auto">
        {content}
      </pre>
    </div>
  );
}
