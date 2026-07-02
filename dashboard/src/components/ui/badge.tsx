import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--ring)] focus:ring-offset-2 focus:ring-offset-[var(--background)]",
  {
    variants: {
      variant: {
        default: "border-transparent bg-[var(--primary)] text-[var(--primary-foreground)]",
        secondary: "border-transparent bg-[var(--secondary)] text-[var(--secondary-foreground)]",
        destructive: "border-transparent bg-[var(--destructive)] text-[var(--destructive-foreground)]",
        outline: "border-[var(--border)] text-[var(--foreground)]",
        success: "border-transparent bg-[var(--success)]/15 text-[var(--success)]",
        warning: "border-transparent bg-[var(--warning)]/15 text-[var(--warning)]",
        error: "border-transparent bg-[var(--error)]/15 text-[var(--error)]",
        info: "border-transparent bg-[var(--info)]/15 text-[var(--info)]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
