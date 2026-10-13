import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Globe2, LocateFixed, Search } from "lucide-react";
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

type Position = { left: number; top: number; width: number; maxHeight: number };

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
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState<Position | null>(null);
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

  function close(restoreFocus = false) {
    setOpen(false);
    setQuery("");
    if (restoreFocus) trigger.current?.focus();
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
    setOpen(true);
  }

  useEffect(() => {
    if (disabled) close();
  }, [disabled]);

  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const margin = 12;
      const gap = 8;
      const viewport = window.visualViewport;
      const viewportWidth = viewport?.width ?? window.innerWidth;
      const viewportHeight = viewport?.height ?? window.innerHeight;
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const viewportTop = viewport?.offsetTop ?? 0;
      if (
        rect.bottom <= viewportTop + margin ||
        rect.top >= viewportTop + viewportHeight - margin
      ) {
        close();
        return;
      }
      const width = Math.max(
        0,
        Math.min(Math.max(rect.width, 360), viewportWidth - margin * 2),
      );
      const below = viewportTop + viewportHeight - margin - rect.bottom - gap;
      const above = rect.top - viewportTop - margin - gap;
      const flip = below < 360 && above > below;
      const maxHeight = Math.max(0, Math.min(420, flip ? above : below));
      if (maxHeight < 190) {
        close();
        return;
      }
      const measuredHeight = panel.current?.getBoundingClientRect().height;
      const height = measuredHeight
        ? Math.min(maxHeight, measuredHeight)
        : maxHeight;
      const left = Math.max(
        viewportLeft + margin,
        Math.min(rect.left, viewportLeft + viewportWidth - width - margin),
      );
      const top = Math.max(
        viewportTop + margin,
        Math.min(
          flip ? rect.top - height - gap : rect.bottom + gap,
          viewportTop + viewportHeight - height - margin,
        ),
      );
      setPosition({ left, top, width, maxHeight });
    }
    function scroll(event: Event) {
      if (event.target instanceof Node && panel.current?.contains(event.target))
        return;
      place();
    }
    place();
    // Measuring changes keeps an upward-flipped panel adjacent to its trigger
    // when search results shrink; maxHeight alone does not describe its height.
    const observer = new ResizeObserver(place);
    const frame = requestAnimationFrame(() => {
      search.current?.focus();
      if (panel.current) observer.observe(panel.current);
      place();
    });
    window.addEventListener("resize", place);
    window.addEventListener("scroll", scroll, true);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", scroll, true);
      window.visualViewport?.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("scroll", place);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) {
      const target = event.target;
      if (
        target instanceof Node &&
        !trigger.current?.contains(target) &&
        !panel.current?.contains(target)
      )
        close(); // Preserve the user's outside-click focus destination.
    }
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open]);

  useEffect(() => {
    if (open && results.length) {
      const next = Math.min(active, results.length - 1);
      if (next !== active) setActive(next);
      document
        .getElementById(`${id}-option-${next}`)
        ?.scrollIntoView({ block: "nearest" });
    }
  }, [active, results, open, id, position !== null]);

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
    <div className="zone-picker">
      <span className="zone-picker-label" id={`${id}-label`}>
        {label}
      </span>
      <button
        ref={trigger}
        type="button"
        id={id}
        className="zone-picker-trigger"
        disabled={disabled}
        aria-labelledby={`${id}-label ${id}-value`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? `${id}-popover` : undefined}
        onClick={() => (open ? close() : begin())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            begin();
          }
        }}
      >
        <Globe2 size={18} className="zone-picker-icon" aria-hidden="true" />
        <span className="zone-picker-value" id={`${id}-value`}>
          <strong className="zone-picker-city">{currentCity}</strong>
          <small className="zone-picker-zone">
            {validTimeZone(value) ? value : "—"}
          </small>
        </span>
        <span className="zone-picker-offset">{currentOffset}</span>
        <ChevronDown
          size={16}
          className="zone-picker-chevron"
          aria-hidden="true"
        />
      </button>
      {open &&
        position &&
        createPortal(
          <div
            ref={panel}
            id={`${id}-popover`}
            className="zone-picker-popover"
            role="dialog"
            aria-label={t("Saat dilimi seç", "Choose a time zone")}
            style={{ position: "fixed", ...position }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                close(true);
              } else if (event.key === "Tab" && panel.current) {
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
            onBlur={(event) => {
              const next = event.relatedTarget;
              if (
                next instanceof Node &&
                !panel.current?.contains(next) &&
                !trigger.current?.contains(next)
              )
                close();
            }}
          >
            <div className="zone-picker-search">
              <Search size={17} aria-hidden="true" />
              <input
                ref={search}
                type="text"
                role="combobox"
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
              className="zone-picker-list"
              id={`${id}-list`}
              role="listbox"
              aria-label={label}
              style={{
                maxHeight: Math.max(48, position.maxHeight - 145),
                overflowY: "auto",
              }}
            >
              {results.map((option, index) => (
                <div
                  key={option.zone}
                  id={`${id}-option-${index}`}
                  role="option"
                  aria-selected={option.zone === value}
                  className={`zone-picker-option${index === active ? " is-active" : ""}${option.zone === value ? " is-selected" : ""}`}
                  onPointerMove={() => setActive(index)}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => select(option.zone)}
                >
                  <span className="zone-picker-option-copy">
                    <strong>{option.city}</strong>
                    <small>{option.zone}</small>
                  </span>
                  <span className="zone-picker-offset">{option.offset}</span>
                  <span className="zone-picker-check">
                    {option.zone === value && (
                      <Check size={16} aria-hidden="true" />
                    )}
                  </span>
                </div>
              ))}
              {!results.length && (
                <p className="zone-picker-empty" role="status">
                  {t("Eşleşen saat dilimi yok", "No matching time zones")}
                </p>
              )}
            </div>
            <div className="zone-picker-footer">
              {systemZone && (
                <button
                  type="button"
                  className="zone-picker-system"
                  onClick={() => select(systemZone)}
                >
                  <LocateFixed size={16} aria-hidden="true" />
                  {t("Sistem saat dilimini kullan", "Use system time zone")}
                  <small>{systemZone}</small>
                </button>
              )}
              <small>
                {t(
                  "UTC farkları şu an içindir; yaz saatine göre değişebilir.",
                  "Offsets are current and may change with daylight saving time.",
                )}
              </small>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
