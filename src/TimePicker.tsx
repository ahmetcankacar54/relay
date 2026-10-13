import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Clock3 } from "lucide-react";
import {
  formatPickerClock,
  moveTimeGridCursor,
  parsePickerClock,
  positionTimePopover,
  type ClockParts,
} from "../shared/time-picker";

type T = (tr: string, en: string) => string;
type Position = ReturnType<typeof positionTimePopover>;
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = Array.from({ length: 12 }, (_, i) => i * 5);

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
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const [hourCursor, setHourCursor] = useState(0);
  const [minuteCursor, setMinuteCursor] = useState(0);
  const [position, setPosition] = useState<Position | null>(null);
  const [showError, setShowError] = useState(false);
  const parsed = parsePickerClock(draft);
  const columns = position && position.width < 320 ? 4 : 6;

  function close(returnFocus: boolean) {
    setOpen(false);
    setPosition(null);
    setShowError(false);
    if (returnFocus) triggerRef.current?.focus({ preventScroll: true });
  }

  function begin() {
    if (disabled) return;
    const seed = parsePickerClock(value);
    setDraft(value);
    setHourCursor(seed?.hour ?? 0);
    setMinuteCursor(Math.floor((seed?.minute ?? 0) / 5));
    setShowError(false);
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

  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;
    const place = () => {
      const anchor = trigger.getBoundingClientRect();
      const body = bodyRef.current;
      const contentHeight =
        panel.scrollHeight +
          (panel.offsetHeight - panel.clientHeight) +
          (body ? Math.max(0, body.scrollHeight - body.clientHeight) : 0) ||
        480;
      const next = positionTimePopover(
        anchor,
        { width: window.innerWidth, height: window.innerHeight },
        contentHeight,
      );
      setPosition((old) =>
        old &&
        old.left === next.left &&
        old.top === next.top &&
        old.width === next.width &&
        old.maxHeight === next.maxHeight
          ? old
          : next,
      );
    };
    place();
    window.addEventListener("resize", place);
    const observer = new ResizeObserver(place);
    observer.observe(panel);
    return () => {
      window.removeEventListener("resize", place);
      observer.disconnect();
    };
  }, [open]);

  const positioned = position !== null;
  useLayoutEffect(() => {
    if (!open || !positioned) return;
    // The placement render has now made the portal visible, so focus can land.
    inputRef.current?.focus({ preventScroll: true });
    inputRef.current?.select();
  }, [open, positioned]);

  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) =>
      target instanceof Node &&
      (panelRef.current?.contains(target) ||
        triggerRef.current?.contains(target));
    const outside = (event: PointerEvent | FocusEvent) => {
      if (!inside(event.target)) close(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    };
    const scroll = (event: Event) => {
      if (
        !(event.target instanceof Node) ||
        !panelRef.current?.contains(event.target)
      )
        close(false);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [open]);

  return (
    <div className="time-picker-field">
      <label htmlFor={id} className="time-picker-label">
        {label}
      </label>
      <button
        id={id}
        ref={triggerRef}
        type="button"
        className="time-picker-trigger"
        disabled={disabled}
        aria-label={`${label}, ${value}, ${t("24 saat", "24-hour")}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? `${id}-panel` : undefined}
        onClick={() => (open ? close(true) : begin())}
      >
        <Clock3 size={17} aria-hidden="true" />
        <span className="time-picker-value">{value}</span>
        <span className="time-picker-suffix">24h</span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            id={`${id}-panel`}
            ref={panelRef}
            role="dialog"
            aria-modal="false"
            aria-labelledby={`${id}-heading`}
            className="time-picker-popover"
            style={
              {
                position: "fixed",
                ...(position ?? {
                  width: Math.min(336, window.innerWidth - 24),
                  top: 12,
                  left: 12,
                }),
                "--time-picker-columns": columns,
                visibility: position ? "visible" : "hidden",
              } as CSSProperties & { "--time-picker-columns": number }
            }
          >
            <div className="time-picker-heading">
              <span id={`${id}-heading`}>{label}</span>
              <span>{t("24 saat biçimi", "24-hour format")}</span>
            </div>
            <div className="time-picker-manual">
              <label htmlFor={`${id}-entry`}>
                {t("Tam saati gir", "Enter exact time")}
              </label>
              <input
                id={`${id}-entry`}
                ref={inputRef}
                type="text"
                inputMode="text"
                autoComplete="off"
                spellCheck={false}
                maxLength={5}
                placeholder="HH:mm"
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
              <small id={`${id}-hint`}>
                {t(
                  "00:00–23:59 · Her dakika seçilebilir.",
                  "00:00–23:59 · Any minute is available.",
                )}
              </small>
              {showError && (
                <p
                  id={`${id}-error`}
                  className="time-picker-error"
                  role="alert"
                >
                  {t(
                    "Geçerli bir saat gir. Örnek: 09:17.",
                    "Enter a valid time, such as 09:17.",
                  )}
                </p>
              )}
            </div>
            <div className="time-picker-body" ref={bodyRef}>
              <section className="time-picker-section">
                <h4 id={`${id}-hours`} className="time-picker-section-title">
                  {t("Saat", "Hour")}
                </h4>
                <div
                  className="time-picker-grid time-picker-hours"
                  role="group"
                  aria-labelledby={`${id}-hours`}
                >
                  {HOURS.map((hour) => (
                    <button
                      key={hour}
                      ref={(element) => {
                        hourRefs.current[hour] = element;
                      }}
                      className="time-picker-option"
                      type="button"
                      tabIndex={hourCursor === hour ? 0 : -1}
                      aria-label={`${t("Saat", "Hour")} ${String(hour).padStart(2, "0")}`}
                      aria-pressed={parsed?.hour === hour}
                      data-selected={parsed?.hour === hour || undefined}
                      onClick={() => choose("hour", hour)}
                      onFocus={() => {
                        setHourCursor(hour);
                        revealOption(hourRefs.current[hour]);
                      }}
                      onKeyDown={(event) => move(event, hour, "hour")}
                    >
                      {String(hour).padStart(2, "0")}
                    </button>
                  ))}
                </div>
              </section>
              <section className="time-picker-section">
                <h4 id={`${id}-minutes`} className="time-picker-section-title">
                  {t("Dakika", "Minute")}
                  {parsed && parsed.minute % 5 !== 0 && (
                    <span className="time-picker-custom-minute">
                      {t("Özel", "Custom")} ·{" "}
                      {String(parsed.minute).padStart(2, "0")}
                    </span>
                  )}
                </h4>
                <div
                  className="time-picker-grid time-picker-minutes"
                  role="group"
                  aria-labelledby={`${id}-minutes`}
                >
                  {MINUTES.map((minute, index) => (
                    <button
                      key={minute}
                      ref={(element) => {
                        minuteRefs.current[index] = element;
                      }}
                      className="time-picker-option"
                      type="button"
                      tabIndex={minuteCursor === index ? 0 : -1}
                      aria-label={`${t("Dakika", "Minute")} ${String(minute).padStart(2, "0")}`}
                      aria-pressed={parsed?.minute === minute}
                      data-selected={parsed?.minute === minute || undefined}
                      onClick={() => choose("minute", minute)}
                      onFocus={() => {
                        setMinuteCursor(index);
                        revealOption(minuteRefs.current[index]);
                      }}
                      onKeyDown={(event) => move(event, index, "minute")}
                    >
                      {String(minute).padStart(2, "0")}
                    </button>
                  ))}
                </div>
              </section>
            </div>
            <div className="time-picker-actions">
              <button
                className="time-picker-cancel"
                type="button"
                onClick={() => close(true)}
              >
                {t("Vazgeç", "Cancel")}
              </button>
              <button
                className="time-picker-apply"
                type="button"
                onClick={apply}
                onKeyDown={(event) => {
                  if (event.key !== "Tab" || event.shiftKey) return;
                  event.preventDefault();
                  focusAfterTrigger();
                }}
              >
                {t("Uygula", "Apply")}
              </button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
