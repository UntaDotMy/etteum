import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const alertVariants = cva(
  "relative w-full rounded-md border p-4 text-sm",
  {
    variants: {
      variant: {
        default: "bg-[var(--background)] text-[var(--foreground)]",
        success: "border-[var(--success)]/30 bg-[var(--success)]/10 text-[var(--success)]",
        warning: "border-[var(--warning)]/30 bg-[var(--warning)]/10 text-[var(--warning)]",
        error: "border-[var(--error)]/30 bg-[var(--error)]/10 text-[var(--error)]",
        info: "border-[var(--info)]/30 bg-[var(--info)]/10 text-[var(--info)]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface AlertProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof alertVariants> {}

const Alert = React.forwardRef<HTMLDivElement, AlertProps>(
  ({ className, variant, ...props }, ref) => {
    return (
      <div
        ref={ref}
        role="alert"
        className={cn(alertVariants({ variant }), className)}
        {...props}
      />
    );
  }
);
Alert.displayName = "Alert";

export { Alert, alertVariants };
