import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Clock3 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  clockFieldKey,
  formatPickerClock,
  parseLooseClock,
  parsePickerClock,
  stepClock,
} from "../../shared/time-picker";

type T = (tr: string, en: string) => string;
/** One wheel step per this many pixels of scroll. */
const WHEEL_STEP_PX = 40;

/** An inline hh:mm field: type a time, or step it with the arrows and wheel. */
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
  const inputRef = useRef<HTMLInputElement>(null);
  const wheelDelta = useRef(0);
  const wheelStep = useRef<(steps: number) => void>(() => {});
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  const [showError, setShowError] = useState(false);
  const shown = parseLooseClock(draft) ?? parsePickerClock(value);
  const minutes = shown ? shown.hour * 60 + shown.minute : 0;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  // Follow the saved value whenever the field is not being edited.
  useEffect(() => {
    if (focused && !disabled) return;
    setDraft(value);
    setShowError(false);
  }, [value, focused, disabled]);

  /** The clock a step starts from: a valid typed draft, else the saved value. */
  function startingFrom(text: string) {
    const typed = parseLooseClock(text);
    return typed ? formatPickerClock(typed) : value;
  }

  function show(next: string) {
    setDraft(next);
    setShowError(false);
  }

  function commit(): boolean {
    const parts = parseLooseClock(draft);
    if (!parts) return false;
    const next = formatPickerClock(parts);
    if (next !== value) onChange(next);
    show(next);
    return true;
  }

  function restore() {
    show(value);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      if (!commit()) setShowError(true);
      return;
    }
    if (event.key === "Escape") {
      if (draft !== value || showError) {
        event.preventDefault();
        restore();
      }
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const next = clockFieldKey(startingFrom(draft), event.key);
    if (next === null) return;
    event.preventDefault();
    show(next);
  }

  // React's onWheel is passive, so it cannot cancel the page scroll. Listen
  // natively; the step reads the latest draft through a state updater, so
  // wheel events that arrive before a re-render still add up.
  useEffect(() => {
    wheelStep.current = (steps) => {
      setDraft((current) => stepClock(startingFrom(current), steps));
      setShowError(false);
    };
  });
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const onWheel = (event: WheelEvent) => {
      if (document.activeElement !== input || input.disabled) return;
      if (event.deltaY === 0) return;
      event.preventDefault();
      const scale =
        event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
      wheelDelta.current += event.deltaY * scale;
      const steps = Math.trunc(wheelDelta.current / WHEEL_STEP_PX);
      if (steps === 0) return;
      wheelDelta.current -= steps * WHEEL_STEP_PX;
      wheelStep.current(-steps);
    };
    input.addEventListener("wheel", onWheel, { passive: false });
    return () => input.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <div className="relative min-w-0">
      {/* The row names each field; the label stays for assistive tech. */}
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <Clock3
        className={cn(
          "pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground",
          disabled && "opacity-50",
        )}
        aria-hidden="true"
      />
      <Input
        id={id}
        ref={inputRef}
        role="spinbutton"
        inputMode="numeric"
        autoComplete="off"
        spellCheck={false}
        maxLength={5}
        className="pr-2 pl-8 font-medium tabular-nums md:text-base"
        value={draft}
        disabled={disabled}
        aria-valuemin={0}
        aria-valuemax={1439}
        aria-valuenow={minutes}
        aria-valuetext={formatPickerClock(shown ?? { hour: 0, minute: 0 })}
        aria-invalid={showError || undefined}
        aria-describedby={`${hintId}${showError ? ` ${errorId}` : ""}`}
        onChange={(event) => show(event.target.value)}
        onFocus={() => {
          wheelDelta.current = 0;
          setFocused(true);
        }}
        onBlur={() => {
          wheelDelta.current = 0;
          if (!commit()) restore();
          setFocused(false);
        }}
        onKeyDown={onKeyDown}
      />
      <small id={hintId} className="sr-only">
        {t(
          "↑↓ 15 dk, PageUp/PageDown 1 saat",
          "↑↓ 15 min, PageUp/PageDown 1 hour",
        )}
      </small>
      {showError && (
        <p
          id={errorId}
          role="alert"
          className="absolute top-full left-0 z-10 mt-1 w-max max-w-64 rounded-md border border-destructive/40 bg-popover px-2 py-1 text-xs font-medium text-destructive shadow-md"
        >
          {t(
            "Geçerli bir saat gir. Örnek: 09:30.",
            "Enter a valid time, such as 09:30.",
          )}
        </p>
      )}
    </div>
  );
}
