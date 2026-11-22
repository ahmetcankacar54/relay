import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { ArrowDown, ArrowUp, Ellipsis, GripVertical, Trash2 } from "lucide-react";
import { PlusIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Panda } from "@/components/Panda";
import { cn } from "@/lib/utils";
import type { useI18n, Language, MessageId } from "@/data/i18n";
import type { useRelay } from "@/data/relay-context";
import type { MenuBarItem, MenuBarNow } from "../../../shared/types";
import { Disclosure } from "@/components/Disclosure";
import {
  DEFAULT_MENU_BAR_ITEMS,
  MENU_BAR_ITEMS,
  MENU_BAR_MAX_ITEMS,
  menuBarPreview,
} from "../../../shared/tray";

/** Each menu bar item's name in Settings. */
export const MENU_BAR_ITEM_LABELS: Record<MenuBarItem, MessageId> = {
  "five-hour": "menuBarItems.fiveHourUsage",
  week: "menuBarItems.weeklyUsage",
  reset: "menuBarItems.timeLeftInTheFiveHourPeriod",
  tokens: "menuBarItems.tokensToday",
  cost: "menuBarItems.apiValueToday",
  account: "addAccountProviders.accountName",
};

/** Why an item shows nothing for the account open in the Claude app now. */
const MENU_BAR_ITEM_MISSING: Record<MenuBarItem, MessageId> = {
  "five-hour": "menuBarItems.noUsageData",
  week: "menuBarItems.thisAccountReportsNoWeeklyLimit",
  reset: "menuBarItems.theFiveHourPeriodHasNotStarted",
  tokens: "menuBarItems.todaysTotalIsNotReady",
  cost: "menuBarItems.todaysTotalIsNotReady",
  account: "menuBarItems.noAccountOpenInTheClaudeApp",
};

/** `items` with the one at `from` moved to `to`; unchanged when either is out of range. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length)
    return [...items];
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** A row being dragged by its handle: where it started, how far the pointer went, where it lands. */
type Drag = { from: number; y0: number; dy: number; to: number; step: number };

/**
 * Where a row dragged from `from` lands, the pointer at `y`: past every other row whose middle is
 * above it. `middles` are the rows' vertical middles, in order.
 */
export function dropIndex(middles: readonly number[], from: number, y: number): number {
  return middles.filter((middle, i) => i !== from && middle < y).length;
}

/**
 * What the menu bar title shows, as menu bar apps such as iStat Menus let it be put together: a
 * live menu bar on top, the items shown in it as an ordered list below, and the others to add.
 * A row moves by dragging its handle (the rows between make room as it goes), by Option-Up/Down
 * on the handle, or from its ⋯ menu, so no order needs a drag (WCAG 2.5.7); each move is
 * announced. The choice lives outside the registry, so this reads and saves it itself; main
 * redraws the title at once.
 */
export function MenuBarTitleRows({
  api,
  action,
  data,
  name,
  t,
  language,
}: Pick<ReturnType<typeof useRelay>, "api" | "action"> & {
  /** Relay's state; each change reads the menu bar again. */
  data?: unknown;
  /** The account open in the Claude app, for the name item's sample. */
  name?: string;
  t: ReturnType<typeof useI18n>["t"];
  language: Language;
}) {
  const [items, setItems] = useState<MenuBarItem[]>();
  // What the menu bar shows now, for the account open in the Claude app; samples without it.
  const [now, setNow] = useState<MenuBarNow>();
  const [announcement, setAnnouncement] = useState("");
  const [drag, setDragState] = useState<Drag>();
  // The same, read by the pointer handlers: a release may come before React renders the last move.
  const dragging = useRef<Drag>(undefined);
  const setDrag = (next: Drag | undefined) => {
    dragging.current = next;
    setDragState(next);
  };
  const handles = useRef(new Map<MenuBarItem, HTMLButtonElement>());
  const rows = useRef(new Map<MenuBarItem, HTMLLIElement>());
  const readNow = () =>
    Promise.resolve()
      .then(() => api.menuBarNow())
      .then(setNow)
      .catch(() => setNow(undefined));
  useEffect(() => {
    void readNow();
  }, [api, data]);
  useEffect(() => {
    let live = true;
    api
      .menuBarTitle()
      .then((choice) => live && setItems(choice.items))
      .catch(() => live && setItems([...DEFAULT_MENU_BAR_ITEMS]));
    return () => {
      live = false;
    };
  }, [api]);
  const label = (item: MenuBarItem) => t(MENU_BAR_ITEM_LABELS[item]);
  const save = (next: MenuBarItem[], said: string, focus?: MenuBarItem) => {
    setItems(next);
    setAnnouncement(said);
    // The moved row keeps the keyboard where it went.
    if (focus) requestAnimationFrame(() => handles.current.get(focus)?.focus?.());
    void action("menu-bar-title", async () => {
      setItems((await api.setMenuBarTitle({ items: next })).items);
      await readNow();
    });
  };
  const chosen = items ?? [];
  const full = chosen.length >= MENU_BAR_MAX_ITEMS;
  const move = (from: number, to: number) => {
    const item = chosen[from];
    if (!item || to < 0 || to >= chosen.length || to === from) return;
    save(
      moveItem(chosen, from, to),
      t("menuBarItems.position", { label: label(item), position: to + 1 }),
      item,
    );
  };
  const remove = (item: MenuBarItem) =>
    save(
      chosen.filter((i) => i !== item),
      t("menuBarItems.removedFromTheMenuBar", { label: label(item) }),
    );
  const add = (item: MenuBarItem) =>
    save(
      [...chosen, item],
      t("menuBarItems.addedAtPosition", { label: label(item), position: chosen.length + 1 }),
    );
  const sample = name ?? "Max";
  const value = (item: MenuBarItem) =>
    now ? now.values[item] : menuBarPreview([item], language, sample);
  const missing = (item: MenuBarItem) => !!now && !now.values[item];
  const title = items && (now ? now.title : menuBarPreview(items, language, sample));
  const keys = (event: KeyboardEvent, index: number) => {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    move(index, index + (event.key === "ArrowUp" ? -1 : 1));
  };
  const grab = (event: PointerEvent<HTMLButtonElement>, index: number) => {
    if (event.button !== 0) return;
    try {
      // The handle keeps the pointer while it is dragged, wherever it goes.
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // A pointer the page no longer has: the drag still follows it over the handle.
    }
    const box = rows.current.get(chosen[index])?.getBoundingClientRect();
    setDrag({ from: index, y0: event.clientY, dy: 0, to: index, step: box?.height ?? 40 });
  };
  const follow = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragging.current;
    if (!drag) return;
    const middles = chosen.map((item) => {
      const box = rows.current.get(item)?.getBoundingClientRect();
      return box ? box.top + box.height / 2 : 0;
    });
    // The dragged row's own middle, where the pointer carries it.
    const y = middles[drag.from] + (event.clientY - drag.y0);
    setDrag({ ...drag, dy: event.clientY - drag.y0, to: dropIndex(middles, drag.from, y) });
  };
  const release = () => {
    const drag = dragging.current;
    setDrag(undefined);
    if (drag && drag.to !== drag.from) move(drag.from, drag.to);
  };
  /** How far a row moves while another is dragged: up or down a place to make room. */
  const shift = (index: number) => {
    if (!drag) return 0;
    if (index === drag.from) return drag.dy;
    if (drag.from < drag.to && index > drag.from && index <= drag.to) return -drag.step;
    if (drag.from > drag.to && index >= drag.to && index < drag.from) return drag.step;
    return 0;
  };
  const others = MENU_BAR_ITEMS.filter((item) => !chosen.includes(item));
  return (
    <div className="border-t border-border py-3 first:border-t-0">
      <span id="menu-bar-title-label" className="text-sm font-medium">
        {t("menuBarItems.showInTheMenuBar")}
      </span>
      <div className="mt-1">
        <Disclosure title={t("menuBarItems.howDoesItWork")}>
          <p className="text-sm text-muted-foreground">
            {t("menuBarItems.percentagesAndTimeAreForThe")}
          </p>
        </Disclosure>
      </div>
      {/* The menu bar as it reads now, or as these items would read on sample figures. */}
      <div className="mt-3 flex h-9 items-center gap-3 rounded-lg border bg-muted/40 px-3">
        <span className="text-xs text-muted-foreground">
          {now ? t("menuBarItems.now") : t("menuBarItems.preview")}
        </span>
        <span className="ml-auto flex min-w-0 items-center gap-1.5 rounded-md bg-background/70 px-2 py-0.5 shadow-xs">
          <Panda scene="lookout" size={16} />
          {items && (
            <span
              data-slot="menu-bar-preview"
              className={cn(
                "truncate text-sm font-medium whitespace-pre tabular-nums",
                !title && "text-muted-foreground",
              )}
            >
              {title || t("menuBarItems.pandaOnly")}
            </span>
          )}
        </span>
      </div>
      <div className="mt-3 flex items-baseline justify-between text-xs text-muted-foreground">
        <span id="menu-bar-shown-label">
          {t("menuBarItems.inTheMenuBar")} · {chosen.length}/{MENU_BAR_MAX_ITEMS}
        </span>
      </div>
      {items && chosen.length === 0 ? (
        <p className="mt-1 rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
          {t("menuBarItems.noValuesSelected")}
        </p>
      ) : (
        <ol
          aria-labelledby="menu-bar-shown-label"
          className={cn("mt-1 rounded-lg border", drag && "select-none")}
        >
          {chosen.map((item, index) => {
            const dragged = drag?.from === index;
            return (
              <li
                key={item}
                data-item={item}
                ref={(node) => {
                  if (node) rows.current.set(item, node);
                  else rows.current.delete(item);
                }}
                style={drag ? { transform: `translateY(${shift(index)}px)` } : undefined}
                className={cn(
                  "relative flex h-10 items-center gap-2 border-t bg-card pr-1 pl-1 first:rounded-t-lg first:border-t-0 last:rounded-b-lg",
                  drag && !dragged && "transition-transform duration-150 ease-out",
                  dragged && "z-10 rounded-lg shadow-lg ring-1 ring-border",
                )}
              >
                <Button
                  ref={(node) => {
                    if (node) handles.current.set(item, node);
                    else handles.current.delete(item);
                  }}
                  variant="ghost"
                  size="icon-xs"
                  className={cn(
                    "touch-none text-muted-foreground",
                    dragged ? "cursor-grabbing" : "cursor-grab",
                  )}
                  aria-label={t("menuBarItems.positionDragOrPressToMove", { label: label(item), position: index + 1 })}
                  title={t("menuBarItems.dragToReorder")}
                  onKeyDown={(event) => keys(event, index)}
                  onPointerDown={(event) => grab(event, index)}
                  onPointerMove={follow}
                  onPointerUp={release}
                  onPointerCancel={() => setDrag(undefined)}
                >
                  <GripVertical />
                </Button>
                <span className="w-3 text-center text-xs text-muted-foreground tabular-nums">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm">{label(item)}</span>
                <span
                  data-slot={missing(item) ? "menu-bar-missing" : undefined}
                  className={cn(
                    "max-w-[45%] truncate text-sm text-muted-foreground",
                    missing(item) ? "text-xs italic" : "tabular-nums",
                  )}
                  title={missing(item) ? t(MENU_BAR_ITEM_MISSING[item]) : undefined}
                >
                  {missing(item) ? t(MENU_BAR_ITEM_MISSING[item]) : value(item)}
                </span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="text-muted-foreground"
                      aria-label={t("menuBarItems.options", { label: label(item) })}
                      title={t("menuBarItems.moveOrRemove")}
                    >
                      <Ellipsis />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem disabled={index === 0} onSelect={() => move(index, index - 1)}>
                      <ArrowUp />
                      {t("menuBarItems.moveUp")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={index === chosen.length - 1}
                      onSelect={() => move(index, index + 1)}
                    >
                      <ArrowDown />
                      {t("menuBarItems.moveDown")}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={() => remove(item)}>
                      <Trash2 />
                      {t("menuBarItems.removeFromTheMenuBar")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            );
          })}
        </ol>
      )}
      {others.length > 0 && (
        <div className="mt-3">
          <div id="menu-bar-more-label" className="text-xs text-muted-foreground">
            {full
              ? t("menuBarItems.maximumValuesRemoveOneToAdd", { MENU_BAR_MAX_ITEMS })
              : t("menuBarItems.moreToAdd")}
          </div>
          <ul aria-labelledby="menu-bar-more-label" className="mt-1 flex flex-wrap gap-1.5">
            {others.map((item) => (
              <li key={item} data-item={item}>
                <Button
                  id={`menu-bar-add-${item}`}
                  variant="outline"
                  size="sm"
                  disabled={!items || full}
                  onClick={() => add(item)}
                  title={missing(item) ? t(MENU_BAR_ITEM_MISSING[item]) : undefined}
                >
                  <PlusIcon />
                  {label(item)}
                  <span
                    data-slot={missing(item) ? "menu-bar-missing" : undefined}
                    className={cn(
                      "text-muted-foreground",
                      missing(item) ? "text-xs italic" : "tabular-nums",
                    )}
                  >
                    {missing(item) ? t(MENU_BAR_ITEM_MISSING[item]) : value(item)}
                  </span>
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>
    </div>
  );
}
