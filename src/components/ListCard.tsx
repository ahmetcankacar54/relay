import { createContext, useContext, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { cva } from "class-variance-authority";
import { ChevronDown, Users } from "lucide-react";
import { ProviderLogo } from "@/components/ProviderLogo";
import { cn } from "@/lib/utils";
import type { AccountProvider } from "../../shared/types";

/*
 * The one list of the app: a card whose rows share a column template with their header, grouped by
 * provider under its logo. The Accounts page, the Overview's accounts, the plan's accounts and the
 * gateway's pool are all this list, so an account reads the same wherever it is listed. The card is a
 * container, so a narrow window rearranges a row (`@max-2xl`) instead of cutting the names.
 *
 * A group's items sit in a `ListSection` under the group's header, without stepping in: the header says
 * which group they are in. Accounts are cards in a grid (`layout="cards"`, `AccountCard`); the plan
 * keeps rows.
 */

/*
 * Column sizing, for lists that keep columns (the plan, steps). Accounts are listed in two lines
 * (`AccountRow`) instead. A row inside a section is indented (`ps-9`, `ps-14`) while the header is
 * not, so only the name column may flex: every column after it is a fixed size or a share of the card
 * (`cqw`), the same in the header and in each row, and so they line up from the right edge whatever the
 * indent. Breakpoints are the card's width (a container).
 */
const grid = cva("grid items-center gap-x-3 pe-4", {
  variants: {
    columns: {
      /** Switch, name, plan, first start, status. Below 48rem the status moves to the second line. */
      plan: "grid-cols-[2rem_minmax(0,1fr)_9.5rem_10.5rem_clamp(7rem,16cqw,11rem)] @max-3xl:grid-cols-[2rem_minmax(0,1fr)_9.5rem_10.5rem]",
      /** Mark, name, state, action. */
      steps: "grid-cols-[1rem_minmax(0,1fr)_auto_auto]",
    },
  },
});

/** A column the plan list shows only from 48rem; below, the same thing sits in the row's second line. */
export const planWide = "@max-3xl:hidden";
export const planNarrow = "@3xl:hidden";

export type ListColumns = NonNullable<Parameters<typeof grid>[0]>["columns"];

/** How deep the rows below sit: 0 outside any section, one more inside each `ListSection`. */
export const ListIndentContext = createContext(0);

/*
 * A row sits one modest step in under a work group (provider → work group), no deeper: the group
 * headers already say which group a row is in, so the list does not walk to the right.
 */
const indent = ["ps-4", "ps-4", "ps-7"] as const;

/**
 * How the list draws its items: rows in a bordered card (the plan), or cards in a grid under plain
 * group headings (accounts: `AccountCard`).
 */
export type ListLayout = "rows" | "cards";
const ListLayoutContext = createContext<ListLayout>("rows");
export const useListLayout = () => useContext(ListLayoutContext);

/** The elements the arrow keys move between: group headers and the rows' names. */
const NAV = "[data-list-nav]";

/*
 * Arrow keys move between the card's headers and names in reading order; Home and End jump to the first
 * and the last. On a header, Left closes the group and Right opens it; on a name, Left goes up to its
 * group's header. Keys typed anywhere else in a row (a menu, a switch) are left to that control.
 */
function navigate(e: KeyboardEvent<HTMLDivElement>) {
  const target = e.target as HTMLElement;
  if (!target.matches(NAV)) return;
  const stops = [...e.currentTarget.querySelectorAll<HTMLElement>(NAV)];
  const at = stops.indexOf(target);
  const group = target.dataset.slot === "list-group";
  let next: HTMLElement | null | undefined;
  switch (e.key) {
    case "ArrowDown":
      next = stops[at + 1];
      break;
    case "ArrowUp":
      next = stops[at - 1];
      break;
    case "Home":
      next = stops[0];
      break;
    case "End":
      next = stops.at(-1);
      break;
    case "ArrowLeft":
      if (group) {
        if (target.getAttribute("aria-expanded") !== "true") return;
        target.click();
        e.preventDefault();
        return;
      }
      next = target.closest("[data-slot=list-section]")?.previousElementSibling as HTMLElement | null;
      if (!next?.matches("button[data-slot=list-group]")) return;
      break;
    case "ArrowRight":
      if (!group || target.getAttribute("aria-expanded") !== "false") return;
      target.click();
      e.preventDefault();
      return;
    default:
      return;
  }
  e.preventDefault();
  next?.focus();
}

export function ListCard({ children, label, slot, layout = "rows" }: { children: ReactNode; label?: string; slot?: string; layout?: ListLayout }) {
  return (
    <div
      data-slot={slot ?? "list-card"}
      data-layout={layout}
      role="group"
      aria-label={label}
      onKeyDown={navigate}
      className={layout === "cards" ? "@container grid gap-2" : "@container overflow-hidden rounded-lg border bg-card"}
    >
      <ListLayoutContext.Provider value={layout}>{children}</ListLayoutContext.Provider>
    </div>
  );
}

/** The column names, small and quiet. */
export function ListHead({ columns, children }: { columns: ListColumns; children: ReactNode }) {
  return (
    <div data-slot="list-head" aria-hidden="true" className={cn(grid({ columns }), "ps-4 h-8 border-b text-2xs text-muted-foreground [&>*]:min-w-0 [&>*]:truncate")}>
      {children}
    </div>
  );
}

// A closed section last in its list leaves its header last: the list's own edge is its bottom line.
const groupClass = cva("flex w-full items-center gap-2 text-xs", {
  variants: {
    level: { 0: "", 1: "" },
    layout: {
      rows: "border-b [&:has(+[hidden]:last-child)]:border-b-0",
      // A plain heading over its cards, across the whole grid.
      cards: "col-span-full rounded-md px-1",
    },
    toggles: {
      true: "text-start outline-none transition-colors hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50",
      false: "",
    },
  },
  compoundVariants: [
    { layout: "rows", level: 0, className: "h-9 bg-muted/60 px-4 font-semibold" },
    { layout: "rows", level: 1, className: "h-8 bg-transparent px-4 font-medium text-muted-foreground" },
    { layout: "cards", level: 0, className: "mt-2 h-8 text-sm font-semibold first:mt-0" },
    { layout: "cards", level: 1, className: "h-7 font-medium text-muted-foreground" },
  ],
});

/**
 * A group's header: a provider's logo (a work group's people mark below a provider), its name and count.
 * With `onToggle` it is a button that opens and closes the section it `controls`.
 */
export function ListGroup({
  provider,
  name,
  count,
  open,
  onToggle,
  controls,
  level = 0,
}: {
  provider?: AccountProvider;
  name: string;
  count?: number;
  open?: boolean;
  onToggle?: () => void;
  /** The id of the `ListSection` this header opens and closes. */
  controls?: string;
  level?: 0 | 1;
}) {
  const layout = useListLayout();
  const content = (
    <>
      {provider ? <ProviderLogo provider={provider} /> : <Users aria-hidden="true" className="size-3.5 shrink-0" />}
      {name}
      {count !== undefined && <span className="font-normal text-muted-foreground tabular-nums">{count}</span>}
    </>
  );
  if (!onToggle) {
    return (
      <div data-slot="list-group" data-provider={provider} className={groupClass({ level, layout, toggles: false })}>
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      data-slot="list-group"
      data-provider={provider}
      data-list-nav=""
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      className={groupClass({ level, layout, toggles: true })}
    >
      {content}
      <ChevronDown aria-hidden="true" className={cn("ms-auto size-3.5 text-muted-foreground transition-transform", !open && "-rotate-90")} />
    </button>
  );
}

/**
 * A group's items under its `ListGroup`. In rows, the rows; in cards, a grid of cards (two a line from
 * 42rem, three from 64rem) that a nested group's heading and section span. A closed section stays in
 * the page (its header points at it) but holds nothing.
 */
export function ListSection({
  id,
  level = 0,
  label,
  hidden,
  children,
}: {
  id?: string;
  level?: 0 | 1;
  label: string;
  hidden?: boolean;
  children: ReactNode;
}) {
  const layout = useListLayout();
  return (
    <div
      data-slot="list-section"
      id={id}
      role="group"
      aria-label={label}
      hidden={hidden}
      className={
        layout === "cards"
          ? "col-span-full grid gap-3 @2xl:grid-cols-2 @5xl:grid-cols-3"
          : "border-b last:border-b-0"
      }
    >
      {!hidden && <ListIndentContext.Provider value={level + 1}>{children}</ListIndentContext.Provider>}
    </div>
  );
}

const row = cva("border-b last:border-b-0", {
  variants: {
    size: { md: "min-h-12 py-2", sm: "min-h-10 py-1.5" },
    interactive: {
      true: "cursor-pointer transition-colors hover:bg-foreground/3 has-[[data-list-nav]:focus-visible]:bg-foreground/5 data-[selected=true]:bg-foreground/5",
      false: "",
    },
  },
  defaultVariants: { size: "md", interactive: false },
});

/**
 * One row; with `onOpen` a click anywhere on it opens the item's page. Keyboard and assistive technology
 * reach the same page through the row's `ListOpen` name, so the row holds no control inside a control.
 */
export function ListRow({
  columns,
  children,
  onOpen,
  selected,
  size,
  data,
}: {
  columns: ListColumns;
  children: ReactNode;
  onOpen?: () => void;
  selected?: boolean;
  size?: "md" | "sm";
  /** `data-*` attributes for the row (an account id). */
  data?: Record<`data-${string}`, string>;
}) {
  const level = useContext(ListIndentContext);
  return (
    <div
      data-slot="list-row"
      data-selected={selected || undefined}
      {...data}
      onClick={onOpen}
      className={cn(grid({ columns }), indent[Math.min(level, 2)], row({ size, interactive: !!onOpen }))}
    >
      {children}
    </div>
  );
}

/** A row's name as the link to its page: the row's one keyboard stop, reached with the arrow keys. */
export function ListOpen({ onOpen, children, title }: { onOpen: () => void; children: ReactNode; title?: string }) {
  return (
    <button
      type="button"
      data-list-nav=""
      onClick={(e: MouseEvent) => {
        e.stopPropagation();
        onOpen();
      }}
      className="min-w-0 max-w-full truncate rounded-xs text-start text-sm font-semibold hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      title={title}
    >
      {children}
    </button>
  );
}

/** A full-width line under a row (a prompt, a few steps), indented like the rows of its section. */
export function ListNote({ children, className }: { children: ReactNode; className?: string }) {
  const level = useContext(ListIndentContext);
  const layout = useListLayout();
  if (layout === "cards") return <div className={cn("col-span-full rounded-lg border bg-card px-4 py-2.5", className)}>{children}</div>;
  return <div className={cn("border-b pe-4 py-2 last:border-b-0", indent[Math.min(level, 2)], className)}>{children}</div>;
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

/** Placeholder rows while the first snapshot loads, so the page does not flash its empty state. */
export function ListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div aria-busy="true" className="grid gap-px p-2">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-10 animate-pulse rounded-md bg-muted/70" />
      ))}
    </div>
  );
}
