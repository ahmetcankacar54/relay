import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { Clock3 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  clockFieldKey,
  clockStart,
  formatPickerClock,
  parseLooseClock,
  parsePickerClock,
  shouldResyncDraft,
  stepClock,
  timeFieldAccess,
  wheelSteps,
  type WheelState,
} from "../../shared/time-picker";

type T = (tr: string, en: string) => string;

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
  const wheel = useRef<WheelState>({ total: 0, at: -Infinity });
  // Timers and the native wheel listener read the latest props from here.
  const latest = useRef({ value, disabled, onChange });
  // A click that focuses the field selects its text; its mouseup must not undo that.
  const keepSelection = useRef(false);
  const [draft, setDraft] = useState(value);
  // Only decides how a busy field is locked (see timeFieldAccess).
  const [holdsFocus, setHoldsFocus] = useState(false);
  const [showError, setShowError] = useState(false);
  const shown = parseLooseClock(draft) ?? parsePickerClock(value);
  const minutes = shown ? shown.hour * 60 + shown.minute : 0;
  const access = timeFieldAccess(disabled, holdsFocus);
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  useLayoutEffect(() => {
    latest.current = { value, disabled, onChange };
  });

  // Follow the saved value once the field is idle again. While an action runs
  // the saved value is stale, so the draft the user just entered stays put.
  useEffect(() => {
    const active = document.activeElement === inputRef.current;
    if (!shouldResyncDraft(active, disabled)) return;
    setDraft(value);
    setShowError(false);
  }, [value, disabled]);

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

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (disabled) return;
    if (event.key === "Enter") {
      event.preventDefault();
      if (!commit()) setShowError(true);
      return;
    }
    if (event.key === "Escape") {
      if (draft !== value || showError) {
        event.preventDefault();
        show(value);
      }
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const next = clockFieldKey(clockStart(draft, value), event.key);
    if (next === null) return;
    event.preventDefault();
    show(next);
  }

  function onBlur() {
    wheel.current = { total: 0, at: -Infinity };
    setHoldsFocus(false);
    // While an action runs the saved value is stale: leave the draft alone and
    // let it settle when the action ends.
    if (disabled) return;
    const parts = parseLooseClock(draft);
    if (!parts) return show(value);
    const next = formatPickerClock(parts);
    show(next);
    // Saving makes every picker busy. Doing that inside the blur would disable
    // the field the user is moving to before it receives focus, so wait for
    // the browser to finish moving focus.
    setTimeout(() => {
      const now = latest.current;
      if (now.disabled || next === now.value) return;
      now.onChange(next);
    }, 0);
  }

  function onMouseDown(event: MouseEvent<HTMLInputElement>) {
    keepSelection.current = document.activeElement !== event.currentTarget;
  }

  function onMouseUp(event: MouseEvent<HTMLInputElement>) {
    if (!keepSelection.current) return;
    keepSelection.current = false;
    event.preventDefault();
  }

  // React's onWheel is passive, so it cannot cancel the page scroll. Listen
  // natively. The step goes through a state updater so it starts from the
  // latest draft even before a re-render.
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const onWheel = (event: WheelEvent) => {
      if (document.activeElement !== input || latest.current.disabled) return;
      if (event.deltaY === 0) return;
      event.preventDefault();
      const scale =
        event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
      const turn = wheelSteps(
        wheel.current,
        event.deltaY * scale,
        event.timeStamp,
      );
      wheel.current = turn.state;
      if (turn.steps === 0) return;
      // Scrolling up (negative deltaY) moves the time forward.
      setDraft((current) =>
        stepClock(clockStart(current, latest.current.value), -turn.steps),
      );
      setShowError(false);
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
        className="pr-2 pl-8 font-medium tabular-nums aria-disabled:cursor-not-allowed aria-disabled:opacity-50 md:text-base"
        value={draft}
        disabled={access.disabled}
        readOnly={access.readOnly}
        aria-disabled={disabled || undefined}
        aria-valuemin={0}
        aria-valuemax={1439}
        aria-valuenow={minutes}
        aria-valuetext={formatPickerClock(shown ?? { hour: 0, minute: 0 })}
        aria-invalid={showError || undefined}
        aria-describedby={`${hintId}${showError ? ` ${errorId}` : ""}`}
        onChange={(event) => {
          if (!disabled) show(event.target.value);
        }}
        onFocus={(event) => {
          wheel.current = { total: 0, at: -Infinity };
          setHoldsFocus(true);
          event.currentTarget.select();
        }}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
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
