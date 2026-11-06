import type { ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/**
 * One page-top line: a message with an optional action and dismiss button.
 * `detail` adds a block under that line, inside the same banner. The banner
 * changes shape when `detail` is given, even as `null`, never when it flips
 * between a node and `null`: a caller that opens and closes the block passes
 * `null` while closed, so the buttons keep their place in the tree and their focus.
 */
export function Banner({
  tone,
  children,
  action,
  onDismiss,
  dismissLabel,
  role,
  detail,
}: {
  tone: "info" | "warn" | "error";
  children: ReactNode;
  action?: ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
  role?: "alert" | "status";
  detail?: ReactNode;
}) {
  const line = (
    <>
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
    </>
  );
  // Neutral boxes: an error keeps a red edge; the icon in the line carries the rest.
  const box = "rounded-lg border bg-card px-3 py-2 text-sm";
  const tones = cn(tone === "error" && "border-destructive/40");
  if (detail === undefined)
    return (
      <div
        role={role}
        data-tone={tone}
        className={cn("flex items-center justify-between gap-3", box, tones)}
      >
        {line}
      </div>
    );
  return (
    <div role={role} data-tone={tone} className={cn("flex flex-col gap-2", box, tones)}>
      <div className="flex items-center justify-between gap-3">{line}</div>
      {detail}
    </div>
  );
}
