import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

type MarkdownContentProps = {
  content: string;
  className?: string;
};

/**
 * Theme-aware markdown for assistant chat replies (GFM: tables, lists, code fences).
 */
export function MarkdownContent({ content, className }: MarkdownContentProps) {
  if (!content) return null;

  return (
    <div
      className={cn(
        "chat-md text-sm leading-relaxed text-[var(--foreground)]",
        "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="mb-2 mt-4 text-base font-semibold tracking-tight text-[var(--foreground)] first:mt-0">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="mb-2 mt-3.5 text-[0.95rem] font-semibold tracking-tight text-[var(--foreground)] first:mt-0">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="mb-1.5 mt-3 text-sm font-semibold text-[var(--foreground)] first:mt-0">
              {children}
            </h3>
          ),
          p: ({ children }) => <p className="mb-2.5 last:mb-0 whitespace-pre-wrap">{children}</p>,
          ul: ({ children }) => (
            <ul className="mb-2.5 list-disc space-y-1 pl-5 last:mb-0 marker:text-[var(--muted-foreground)]">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="mb-2.5 list-decimal space-y-1 pl-5 last:mb-0 marker:text-[var(--muted-foreground)]">
              {children}
            </ol>
          ),
          li: ({ children }) => <li className="leading-relaxed pl-0.5">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="mb-2.5 border-l-2 border-[var(--primary)]/40 bg-[color-mix(in_srgb,var(--primary)_6%,transparent)] py-1 pl-3 pr-2 text-[var(--muted-foreground)] last:mb-0">
              {children}
            </blockquote>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-[var(--primary)] underline decoration-[var(--primary)]/40 underline-offset-2 hover:decoration-[var(--primary)]"
            >
              {children}
            </a>
          ),
          hr: () => <hr className="my-3 border-[var(--border)]" />,
          strong: ({ children }) => (
            <strong className="font-semibold text-[var(--foreground)]">{children}</strong>
          ),
          em: ({ children }) => <em className="italic text-[var(--foreground)]">{children}</em>,
          code: ({ className: codeClass, children, ...props }) => {
            const isBlock = Boolean(codeClass?.includes("language-")) || String(children).includes("\n");
            if (!isBlock) {
              return (
                <code
                  className="rounded border border-[var(--border)] bg-[var(--secondary)] px-1 py-0.5 font-mono text-[0.8em] text-[var(--foreground)]"
                  {...props}
                >
                  {children}
                </code>
              );
            }
            return (
              <code
                className={cn(
                  "block font-mono text-[0.8em] text-[var(--card-foreground)]",
                  codeClass,
                )}
                {...props}
              >
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="mb-2.5 overflow-x-auto rounded-md border border-[var(--border)] bg-[var(--secondary)] p-2.5 font-mono text-[11px] leading-relaxed text-[var(--foreground)] shadow-[var(--shadow-card)] last:mb-0">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="mb-2.5 overflow-x-auto rounded-md border border-[var(--border)] last:mb-0">
              <table className="w-full border-collapse text-left text-xs">{children}</table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="border-b border-[var(--border)] bg-[var(--secondary)] text-[var(--foreground)]">
              {children}
            </thead>
          ),
          th: ({ children }) => (
            <th className="px-2 py-1.5 font-semibold text-[var(--foreground)]">{children}</th>
          ),
          td: ({ children }) => (
            <td className="border-t border-[var(--border)] bg-[var(--card)] px-2 py-1.5 text-[var(--foreground)]">
              {children}
            </td>
          ),
          tr: ({ children }) => <tr className="align-top">{children}</tr>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
