import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, Clock3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  formatPickerClock,
  moveTimeGridCursor,
  parsePickerClock,
  type ClockParts,
} from "../../shared/time-picker";

type T = (tr: string, en: string) => string;
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = Array.from({ length: 12 }, (_, i) => i * 5);
const pad = (n: number) => String(n).padStart(2, "0");
/** Popover width: 336 px, or the window less a 12 px margin each side. */
const popoverWidth = () =>
  typeof window === "undefined" ? 336 : Math.min(336, window.innerWidth - 24);

export function TimePicker({
  id,
  label,
  value,
  disabled,
  onChange,
  t,
}: {
  id: string;
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  t: T;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const hourRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const minuteRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // Whether closing returns focus to the trigger (Radix does it unless prevented).
  const restoreFocus = useRef(true);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const [hourCursor, setHourCursor] = useState(0);
  const [minuteCursor, setMinuteCursor] = useState(0);
  const [columns, setColumns] = useState(6);
  const [showError, setShowError] = useState(false);
  const parsed = parsePickerClock(draft);

  function close(returnFocus: boolean) {
    restoreFocus.current = returnFocus;
    setOpen(false);
    setShowError(false);
  }

  function begin() {
    if (disabled) return;
    const seed = parsePickerClock(value);
    setDraft(value);
    setHourCursor(seed?.hour ?? 0);
    setMinuteCursor(Math.floor((seed?.minute ?? 0) / 5));
    setColumns(popoverWidth() < 320 ? 4 : 6);
    setShowError(false);
    restoreFocus.current = true;
    setOpen(true);
  }

  function apply() {
    if (disabled) return close(false);
    if (!parsed) {
      setShowError(true);
      inputRef.current?.focus({ preventScroll: true });
      return;
    }
    onChange(formatPickerClock(parsed));
    close(true);
  }

  function choose(part: keyof ClockParts, selected: number) {
    const base = parsed ?? parsePickerClock(value) ?? { hour: 0, minute: 0 };
    setDraft(formatPickerClock({ ...base, [part]: selected }));
    setShowError(false);
    if (part === "hour") setHourCursor(selected);
    else setMinuteCursor(selected / 5);
  }

  function focusAfterTrigger() {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const controls = Array.from(
      document.querySelectorAll<HTMLElement>(
        'a[href],button,input,select,textarea,[tabindex],[contenteditable="true"]',
      ),
    ).filter(
      (element) =>
        element.tabIndex >= 0 &&
        !element.matches(":disabled") &&
        !element.closest('[inert],[hidden],[aria-hidden="true"]') &&
        !panelRef.current?.contains(element) &&
        element.getClientRects().length > 0 &&
        getComputedStyle(element).visibility !== "hidden",
    );
    const index = controls.indexOf(trigger);
    const next = controls[index + 1] ?? controls[0];
    close(false);
    next?.focus();
  }

  function revealOption(element: HTMLButtonElement | null) {
    const body = bodyRef.current;
    if (!body || !element) return;
    const bounds = body.getBoundingClientRect();
    const option = element.getBoundingClientRect();
    if (option.top < bounds.top) body.scrollTop -= bounds.top - option.top;
    else if (option.bottom > bounds.bottom)
      body.scrollTop += option.bottom - bounds.bottom;
  }

  function move(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
    part: keyof ClockParts,
  ) {
    const options = part === "hour" ? HOURS : MINUTES;
    const next = moveTimeGridCursor(index, event.key, options.length, columns);
    if (next === null) return;
    event.preventDefault();
    if (part === "hour") {
      setHourCursor(next);
      hourRefs.current[next]?.focus({ preventScroll: true });
    } else {
      setMinuteCursor(next);
      minuteRefs.current[next]?.focus({ preventScroll: true });
    }
  }

  useEffect(() => {
    if (disabled && open) close(false);
  }, [disabled, open]);

  const option = (
    part: keyof ClockParts,
    n: number,
    index: number,
    refs: typeof hourRefs,
    cursor: number,
    setCursor: (n: number) => void,
  ) => {
    const selected = parsed?.[part] === n;
    const name = part === "hour" ? t("Saat", "Hour") : t("Dakika", "Minute");
    return (
      <Button
        key={n}
        ref={(element: HTMLButtonElement | null) => {
          refs.current[index] = element;
        }}
        type="button"
        variant={selected ? "default" : "ghost"}
        size="sm"
        className={cn("h-8 px-0 tabular-nums", !selected && "font-normal")}
        tabIndex={cursor === index ? 0 : -1}
        aria-label={`${name} ${pad(n)}`}
        aria-pressed={selected}
        data-selected={selected || undefined}
        onClick={() => choose(part, n)}
        onFocus={() => {
          setCursor(index);
          revealOption(refs.current[index]);
        }}
        onKeyDown={(event) => move(event, index, part)}
      >
        {pad(n)}
      </Button>
    );
  };
  const grid = { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` };

  return (
    <div className="grid min-w-0 gap-1">
      {/* The row names each picker; the label stays for assistive tech. */}
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <Popover
        open={open}
        onOpenChange={(next) => (next ? begin() : close(true))}
      >
        <PopoverTrigger asChild>
          <Button
            id={id}
            ref={triggerRef}
            type="button"
            variant="outline"
            className="w-full justify-start gap-2 px-2.5 font-normal"
            disabled={disabled}
            aria-label={`${label}, ${value}, ${t("24 saat", "24-hour")}`}
          >
            <Clock3 className="text-muted-foreground" aria-hidden="true" />
            <span className="text-base font-medium tabular-nums">{value}</span>
            <ChevronDown
              className="ml-auto text-muted-foreground"
              aria-hidden="true"
            />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          ref={panelRef}
          align="start"
          collisionPadding={12}
          aria-modal="false"
          aria-labelledby={`${id}-heading`}
          className="flex max-h-[min(480px,var(--radix-popover-content-available-height))] flex-col gap-0 p-0"
          style={{ width: popoverWidth() }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            inputRef.current?.focus({ preventScroll: true });
            inputRef.current?.select();
          }}
          onCloseAutoFocus={(event) => {
            if (!restoreFocus.current) event.preventDefault();
            restoreFocus.current = true;
          }}
        >
          <div className="flex items-baseline justify-between gap-2 border-b px-4 pt-3 pb-2">
            <span id={`${id}-heading`} className="text-sm font-semibold">
              {label}
            </span>
            <span className="text-xs text-muted-foreground">
              {t("24 saat biçimi", "24-hour format")}
            </span>
          </div>
          <div className="grid gap-1 border-b px-4 py-3">
            <label
              htmlFor={`${id}-entry`}
              className="block text-xs font-medium text-muted-foreground"
            >
              {t("Tam saati gir", "Enter exact time")}
            </label>
            <Input
              id={`${id}-entry`}
              ref={inputRef}
              type="text"
              inputMode="text"
              autoComplete="off"
              spellCheck={false}
              maxLength={5}
              placeholder="HH:mm"
              className="h-9 text-base tabular-nums"
              value={draft}
              aria-invalid={showError || undefined}
              aria-describedby={`${id}-hint${showError ? ` ${id}-error` : ""}`}
              onChange={(event) => {
                const next = event.target.value;
                setDraft(next);
                setShowError(false);
                const parts = parsePickerClock(next);
                if (parts) {
                  setHourCursor(parts.hour);
                  setMinuteCursor(Math.floor(parts.minute / 5));
                }
              }}
              onKeyDown={(event) => {
                if (event.key === "Tab" && event.shiftKey) {
                  event.preventDefault();
                  close(true);
                  return;
                }
                if (event.key !== "Enter") return;
                event.preventDefault();
                apply();
              }}
            />
            <small id={`${id}-hint`} className="text-xs text-muted-foreground">
              {t(
                "00:00–23:59 · Her dakika seçilebilir.",
                "00:00–23:59 · Any minute is available.",
              )}
            </small>
            {showError && (
              <p
                id={`${id}-error`}
                className="text-xs font-medium text-destructive"
                role="alert"
              >
                {t(
                  "Geçerli bir saat gir. Örnek: 09:17.",
                  "Enter a valid time, such as 09:17.",
                )}
              </p>
            )}
          </div>
          <div
            className="grid min-h-0 flex-1 gap-3 overflow-y-auto px-4 py-3"
            ref={bodyRef}
          >
            <section className="grid gap-1.5">
              <h4
                id={`${id}-hours`}
                className="text-xs font-semibold text-muted-foreground"
              >
                {t("Saat", "Hour")}
              </h4>
              <div
                className="grid gap-1"
                style={grid}
                role="group"
                aria-labelledby={`${id}-hours`}
              >
                {HOURS.map((hour) =>
                  option(
                    "hour",
                    hour,
                    hour,
                    hourRefs,
                    hourCursor,
                    setHourCursor,
                  ),
                )}
              </div>
            </section>
            <section className="grid gap-1.5">
              <h4
                id={`${id}-minutes`}
                className="flex items-center justify-between text-xs font-semibold text-muted-foreground"
              >
                {t("Dakika", "Minute")}
                {parsed && parsed.minute % 5 !== 0 && (
                  <span className="font-medium text-foreground">
                    {t("Özel", "Custom")} · {pad(parsed.minute)}
                  </span>
                )}
              </h4>
              <div
                className="grid gap-1"
                style={grid}
                role="group"
                aria-labelledby={`${id}-minutes`}
              >
                {MINUTES.map((minute, index) =>
                  option(
                    "minute",
                    minute,
                    index,
                    minuteRefs,
                    minuteCursor,
                    setMinuteCursor,
                  ),
                )}
              </div>
            </section>
          </div>
          <div className="flex justify-end gap-2 border-t px-4 py-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => close(true)}
            >
              {t("Vazgeç", "Cancel")}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={apply}
              onKeyDown={(event) => {
                if (event.key !== "Tab" || event.shiftKey) return;
                event.preventDefault();
                focusAfterTrigger();
              }}
            >
              {t("Uygula", "Apply")}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
