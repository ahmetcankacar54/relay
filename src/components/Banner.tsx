import type { ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/** One page-top line: a message with an optional action and dismiss button. */
export function Banner({
  tone,
  children,
  action,
  onDismiss,
  dismissLabel,
  role,
}: {
  tone: "info" | "warn" | "error";
  children: ReactNode;
  action?: ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
  role?: "alert" | "status";
}) {
  return (
    <div
      role={role}
      className={cn(
        "flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm",
        tone === "error" && "border-destructive/30 bg-destructive/10",
        tone === "warn" && "border-warn/40 bg-warn/10",
        tone === "info" && "bg-accent",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">{children}</div>
      {(action || onDismiss) && (
        <div className="flex shrink-0 items-center gap-1">
          {action}
          {onDismiss && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={dismissLabel}
              onClick={onDismiss}
            >
              <X />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
