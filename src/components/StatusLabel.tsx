import { cva } from "class-variance-authority";
import { StatusDot } from "@/components/StatusDot";
import type { AccountStatus } from "@/lib/account-status";

const label = cva("flex min-w-0 items-center gap-1.5", {
  variants: {
    size: { sm: "text-xs", md: "text-sm" },
    tone: { ok: "", warn: "", crit: "", off: "text-muted-foreground" },
  },
  defaultVariants: { size: "sm" },
});

/**
 * An account's status: its dot and at most four words. The colour is on the dot only; the reason is
 * the title, so the list stays one line.
 */
export function StatusLabel({ status, size }: { status: AccountStatus; size?: "sm" | "md" }) {
  return (
    <span data-slot="status-label" data-tone={status.tone} title={status.reason ?? status.text} className={label({ size, tone: status.tone })}>
      <StatusDot tone={status.tone} />
      <span className="truncate">{status.text}</span>
    </span>
  );
}
