import type { ReactNode } from "react";
import { Check, CircleAlert } from "lucide-react";
import { Disclosure } from "@/components/Disclosure";
import { StatusDot } from "@/components/StatusDot";
import { useI18n } from "@/data/i18n";
import { cn } from "@/lib/utils";

/** A connection's leading mark: a check when it is ready, a mark when it needs a step, its kind when absent. */
const toneMark = {
  ok: "text-muted-foreground",
  warn: "text-warn-foreground",
  crit: "text-crit",
  off: "text-muted-foreground",
} as const;

/**
 * The connections as one grid: mark, text, a refresh column and an action column. Each row is a
 * subgrid, so every refresh button and every Renew button sits in the same column.
 */
export function ConnectionList({ children }: { children: ReactNode }) {
  return (
    <div
      data-slot="connection-list"
      className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] gap-x-3"
    >
      {children}
    </div>
  );
}

/** A guide's numbered steps, shown while the connection is not linked. */
function Steps({ steps }: { steps: string[] }) {
  return (
    <ol className="grid gap-1.5 rounded-lg bg-muted/60 px-3 py-2.5 text-sm">
      {steps.map((step, i) => (
        <li key={i} className="flex gap-2">
          <span className="grid size-5 shrink-0 place-items-center rounded-full bg-background text-xs font-semibold tabular-nums">
            {i + 1}
          </span>
          <span>{step}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * A connection: what it is for in a few words, its state, a refresh button and its action, on one
 * row; its steps, a closed "how it works" note and a setup panel open under it.
 */
export function ConnectionRow({
  icon,
  title,
  purpose,
  status,
  where,
  tone,
  refresh,
  action,
  steps,
  detail,
  optional,
  children,
}: {
  /** Not needed to switch: marked, and left out of the page's ready count. */
  optional?: boolean;
  icon: ReactNode;
  title: string;
  purpose: string;
  status: string;
  /** Where the connection lives (a browser profile), muted beside the status. */
  where?: ReactNode;
  tone: "ok" | "warn" | "crit" | "off";
  /** An icon button that reads the connection again; it sits just left of the action. */
  refresh?: ReactNode;
  /** The row's one text button (Renew, Sign in, Check…), at the right edge. */
  action?: ReactNode;
  steps?: string[];
  detail?: string;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div
      data-slot="connection"
      className="col-span-full grid grid-cols-subgrid gap-y-2 border-t py-3.5 first:border-t-0 first:pt-0 last:pb-0"
    >
      <span
        aria-hidden="true"
        className={cn("mt-0.5 grid size-5 shrink-0 place-items-center [&_svg]:size-5", toneMark[tone])}
      >
        {tone === "ok" ? <Check /> : tone === "off" ? icon : <CircleAlert />}
      </span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          {/* What the connection is for, on hover: the row stays one line. */}
          <span className="text-sm font-semibold" title={purpose}>
            {title}
          </span>
          {optional && <span className="text-2xs text-muted-foreground">{t("connections.optional")}</span>}
          <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <StatusDot tone={tone} />
            <span className="min-w-0 break-words">{status}</span>
          </span>
          {where && (
            <span data-slot="connection-where" className="text-xs text-muted-foreground/70">
              {where}
            </span>
          )}
        </div>
      </div>
      <div data-slot="connection-refresh" className="flex items-center self-center">
        {refresh}
      </div>
      <div data-slot="connection-action" className="flex items-center justify-end gap-1.5 self-center">
        {action}
      </div>
      {(steps || detail || children) && (
        <div className="col-span-3 col-start-2 grid gap-2">
          {/* The steps and the explanation wait behind one closed line, so the list stays short. */}
          {(steps || detail) && (
            <Disclosure title={steps ? t("connections.howToConnect") : t("connections.howItWorks")}>
              <div className="grid gap-2">
                {steps && <Steps steps={steps} />}
                {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
              </div>
            </Disclosure>
          )}
          {children}
        </div>
      )}
    </div>
  );
}
