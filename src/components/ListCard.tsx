import type { KeyboardEvent, ReactNode } from "react";
import { cva } from "class-variance-authority";
import { ProviderLogo } from "@/components/ProviderLogo";
import { cn } from "@/lib/utils";
import type { AccountProvider } from "../../shared/types";

/*
 * The one list of the app: a card whose rows share a column template with their header, grouped by
 * provider under its logo. The Accounts page, the Overview's accounts, the plan's accounts and the
 * gateway's pool are all this list, so an account reads the same wherever it is listed. The card is a
 * container, so a narrow window drops a column (`@max-2xl`) instead of cutting the names.
 */

const grid = cva("grid items-center gap-x-3 px-4", {
  variants: {
    columns: {
      /** Dot, name, status, 5 hours, week, action, menu. */
      accounts:
        "grid-cols-[0.5rem_minmax(0,1fr)_minmax(0,10rem)_4.5rem_4.5rem_4.5rem_1.5rem] @max-2xl:grid-cols-[0.5rem_minmax(0,1fr)_minmax(0,8rem)_4.5rem_4.5rem_1.5rem]",
      /** Dot, name, 5 hours, week, a model's or pool's own limit, action. */
      board:
        "grid-cols-[0.5rem_minmax(0,10rem)_minmax(0,1fr)_minmax(0,1fr)_7rem_4.5rem] @max-2xl:grid-cols-[0.5rem_minmax(0,1fr)_minmax(0,9rem)_minmax(0,9rem)_4.5rem]",
      /** Switch, name, plan, first start, status. */
      plan: "grid-cols-[2rem_minmax(0,1fr)_10rem_6.5rem_minmax(0,10rem)] @max-2xl:grid-cols-[2rem_minmax(0,1fr)_10rem_6.5rem]",
      /** Order, name, 5 hours, week, in the pool. */
      pool: "grid-cols-[1.75rem_minmax(0,1fr)_minmax(0,9rem)_minmax(0,9rem)_2.5rem] @max-2xl:grid-cols-[1.75rem_minmax(0,1fr)_minmax(0,8rem)_2.5rem]",
      /** Mark, name, state, action. */
      steps: "grid-cols-[1rem_minmax(0,1fr)_auto_auto]",
    },
  },
});

/** A column that a narrow list leaves out (its header cell and each row's). */
export const narrowHidden = "@max-2xl:hidden";

export type ListColumns = NonNullable<Parameters<typeof grid>[0]>["columns"];

export function ListCard({ children, label, slot }: { children: ReactNode; label?: string; slot?: string }) {
  return (
    <div data-slot={slot ?? "list-card"} role="group" aria-label={label} className="@container overflow-hidden rounded-lg border bg-card">
      {children}
    </div>
  );
}

/** The column names, small and quiet. */
export function ListHead({ columns, children }: { columns: ListColumns; children: ReactNode }) {
  return (
    <div data-slot="list-head" aria-hidden="true" className={cn(grid({ columns }), "h-8 border-b text-2xs text-muted-foreground")}>
      {children}
    </div>
  );
}

/** A provider's rows begin under its logo, name and count. */
export function ListGroup({ provider, name, count }: { provider: AccountProvider; name: string; count?: number }) {
  return (
    <div data-slot="list-group" data-provider={provider} className="flex h-8 items-center gap-2 border-b bg-muted/50 px-4 text-xs font-semibold">
      <ProviderLogo provider={provider} />
      {name}
      {count !== undefined && <span className="font-normal text-muted-foreground tabular-nums">{count}</span>}
    </div>
  );
}

const row = cva("border-b last:border-b-0", {
  variants: {
    size: { md: "min-h-12 py-2", sm: "min-h-10 py-1.5" },
    interactive: {
      true: "cursor-pointer outline-none transition-colors hover:bg-foreground/3 focus-visible:bg-foreground/5 data-[selected=true]:bg-foreground/5",
      false: "",
    },
  },
  defaultVariants: { size: "md", interactive: false },
});

/** One row; with `onOpen` it opens on a click or Enter, like a link to the item's page. */
export function ListRow({
  columns,
  children,
  onOpen,
  selected,
  size,
  label,
  data,
}: {
  columns: ListColumns;
  children: ReactNode;
  onOpen?: () => void;
  selected?: boolean;
  size?: "md" | "sm";
  /** The row's name for assistive technology when it opens. */
  label?: string;
  /** `data-*` attributes for the row (an account id). */
  data?: Record<`data-${string}`, string>;
}) {
  const open = onOpen
    ? {
        role: "button",
        tabIndex: 0,
        "aria-label": label,
        onClick: onOpen,
        onKeyDown: (e: KeyboardEvent) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen();
          }
        },
      }
    : {};
  return (
    <div data-slot="list-row" data-selected={selected || undefined} {...data} {...open} className={cn(grid({ columns }), row({ size, interactive: !!onOpen }))}>
      {children}
    </div>
  );
}

/** A footer row: a quiet line and an optional action ("4 accounts not in the plan · Show"). */
export function ListFoot({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div data-slot="list-foot" className="flex min-h-10 items-center justify-between gap-3 px-4 text-xs text-muted-foreground">
      <span className="min-w-0 truncate">{children}</span>
      {action}
    </div>
  );
}
