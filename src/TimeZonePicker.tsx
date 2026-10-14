import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Check, ChevronDown, Globe2, LocateFixed, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  filterTimeZones,
  timeZoneCity,
  timeZoneOffset,
  timeZoneOptions,
  validTimeZone,
} from "../shared/time-zones";

type Props = {
  id: string;
  label: string;
  value: string;
  disabled?: boolean;
  onChange: (zone: string) => void;
  t: (tr: string, en: string) => string;
  now?: number;
};

function focusableElements(container: ParentNode): HTMLElement[] {
  return [
    ...container.querySelectorAll<HTMLElement>(
      'button, input, select, textarea, a[href], summary, [tabindex], [contenteditable="true"]',
    ),
  ].filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.matches(":disabled") &&
      !element.closest('[hidden], [inert], [aria-hidden="true"]') &&
      element.getClientRects().length > 0,
  );
}

export function TimeZonePicker({
  id,
  label,
  value,
  disabled = false,
  onChange,
  t,
  now = Date.now(),
}: Props) {
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  // Whether closing returns focus to the trigger (Radix does it unless prevented).
  const restoreFocus = useRef(true);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  // Offsets can change at a DST transition. Refresh at minute granularity while
  // avoiding hundreds of formatter calls on unrelated parent renders.
  const minute = Math.floor(now / 60_000) * 60_000;
  const options = useMemo(
    () => timeZoneOptions(value, minute),
    [value, minute],
  );
  const results = useMemo(
    () => filterTimeZones(options, query, minute),
    [options, query, minute],
  );
  const currentCity = timeZoneCity(value);
  const currentOffset = timeZoneOffset(value, now);
  const systemZone = useMemo(() => {
    try {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return validTimeZone(zone) ? zone : null;
    } catch {
      return null;
    }
  }, []);

  function close(returnFocus = false) {
    restoreFocus.current = returnFocus;
    setOpen(false);
    setQuery("");
  }
  function select(zone: string) {
    if (disabled || !validTimeZone(zone)) return;
    onChange(zone);
    close(true);
  }
  function begin() {
    if (disabled) return;
    setQuery("");
    setActive(
      Math.max(
        0,
        options.findIndex((option) => option.zone === value),
      ),
    );
    restoreFocus.current = true;
    setOpen(true);
  }

  useEffect(() => {
    if (disabled) close();
  }, [disabled]);

  useEffect(() => {
    if (open && results.length) {
      const next = Math.min(active, results.length - 1);
      if (next !== active) setActive(next);
      document
        .getElementById(`${id}-option-${next}`)
        ?.scrollIntoView({ block: "nearest" });
    }
  }, [active, results, open, id]);

  function searchKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    const count = results.length;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (count)
        setActive((current) =>
          event.key === "ArrowDown"
            ? (current + 1) % count
            : (current - 1 + count) % count,
        );
    } else if (
      (event.key === "Home" || event.key === "End") &&
      (!query || event.ctrlKey || event.metaKey)
    ) {
      event.preventDefault();
      if (count) setActive(event.key === "Home" ? 0 : count - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = results[active];
      if (option) select(option.zone);
    }
  }

  return (
    <div className="grid min-w-0 gap-1">
      <span
        className="text-xs font-medium text-muted-foreground"
        id={`${id}-label`}
      >
        {label}
      </span>
      <Popover
        open={open}
        // Escape returns focus to the trigger; an outside click keeps its own target.
        onOpenChange={(next) => (next ? begin() : close(true))}
      >
        <PopoverTrigger asChild>
          <Button
            ref={trigger}
            type="button"
            id={id}
            variant="outline"
            className="h-auto min-h-11 w-full justify-start gap-2.5 px-3 py-1.5 text-left font-normal"
            disabled={disabled}
            aria-labelledby={`${id}-label ${id}-value`}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                if (!open) begin();
              }
            }}
          >
            <Globe2 className="text-muted-foreground" aria-hidden="true" />
            <span className="grid min-w-0 flex-1" id={`${id}-value`}>
              <strong className="truncate text-sm font-semibold">
                {currentCity}
              </strong>
              <small className="truncate text-xs text-muted-foreground">
                {validTimeZone(value) ? value : "—"}
              </small>
            </span>
            <span className="text-xs text-muted-foreground tabular-nums">
              {currentOffset}
            </span>
            <ChevronDown className="text-muted-foreground" aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          ref={panel}
          align="start"
          collisionPadding={12}
          aria-label={t("Saat dilimi seç", "Choose a time zone")}
          className="flex max-h-[min(420px,var(--radix-popover-content-available-height))] w-[min(max(var(--radix-popover-trigger-width),360px),calc(100vw-24px))] flex-col gap-0 p-0"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            search.current?.focus();
            document
              .getElementById(`${id}-option-${active}`)
              ?.scrollIntoView({ block: "nearest" });
          }}
          onCloseAutoFocus={(event) => {
            if (!restoreFocus.current) event.preventDefault();
            restoreFocus.current = true;
          }}
          onKeyDown={(event) => {
            if (event.key === "Tab" && panel.current) {
              const fields = focusableElements(panel.current);
              const focused = document.activeElement;
              if (event.shiftKey && focused === fields[0]) {
                event.preventDefault();
                close(true);
              } else if (!event.shiftKey && focused === fields.at(-1)) {
                const outside = focusableElements(document).filter(
                  (element) => !panel.current?.contains(element),
                );
                const triggerIndex = outside.indexOf(trigger.current!);
                const next =
                  triggerIndex >= 0 ? outside[triggerIndex + 1] : undefined;
                close();
                if (next) {
                  event.preventDefault();
                  next.focus();
                }
              }
            }
          }}
        >
          <div className="flex items-center gap-2 border-b px-3">
            <Search
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <input
              ref={search}
              type="text"
              role="combobox"
              className="h-10 w-full min-w-0 rounded-none border-0 bg-transparent px-0 py-0 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:outline-none"
              aria-label={t(
                "Şehir, saat dilimi veya UTC farkı ara",
                "Search city, time zone or UTC offset",
              )}
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls={`${id}-list`}
              aria-activedescendant={
                results[active] ? `${id}-option-${active}` : undefined
              }
              placeholder={t(
                "Şehir veya UTC farkı ara…",
                "Search city or UTC offset…",
              )}
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={searchKey}
            />
          </div>
          <div
            className="min-h-12 flex-1 overflow-y-auto p-1"
            id={`${id}-list`}
            role="listbox"
            aria-label={label}
          >
            {results.map((option, index) => (
              <div
                key={option.zone}
                id={`${id}-option-${index}`}
                role="option"
                aria-selected={option.zone === value}
                className={cn(
                  "flex cursor-pointer items-center gap-3 rounded-md px-2.5 py-1.5",
                  index === active && "bg-accent text-accent-foreground",
                )}
                onPointerMove={() => setActive(index)}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => select(option.zone)}
              >
                <span className="grid min-w-0 flex-1">
                  <strong className="truncate text-sm font-medium">
                    {option.city}
                  </strong>
                  <small className="truncate text-xs text-muted-foreground">
                    {option.zone}
                  </small>
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {option.offset}
                </span>
                <span className="flex size-4 shrink-0 text-primary">
                  {option.zone === value && (
                    <Check className="size-4" aria-hidden="true" />
                  )}
                </span>
              </div>
            ))}
            {!results.length && (
              <p
                className="px-2.5 py-3 text-sm text-muted-foreground"
                role="status"
              >
                {t("Eşleşen saat dilimi yok", "No matching time zones")}
              </p>
            )}
          </div>
          <div className="grid gap-1.5 border-t px-3 py-2.5">
            {systemZone && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="justify-start px-2"
                onClick={() => select(systemZone)}
              >
                <LocateFixed aria-hidden="true" />
                {t("Sistem saat dilimini kullan", "Use system time zone")}
                <small className="ml-auto truncate text-xs font-normal text-muted-foreground">
                  {systemZone}
                </small>
              </Button>
            )}
            <small className="px-2 text-xs text-muted-foreground">
              {t(
                "UTC farkları şu an içindir; yaz saatine göre değişebilir.",
                "Offsets are current and may change with daylight saving time.",
              )}
            </small>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
