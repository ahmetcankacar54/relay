export type ClockParts = { hour: number; minute: number };

/** Manual entry accepts a single-digit hour, but always commits canonical HH:mm. */
export function parsePickerClock(value: string): ClockParts | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

export function formatPickerClock({ hour, minute }: ClockParts): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

const DAY_MINUTES = 24 * 60;

/**
 * Typed entry for the inline field: `9`, `17`, `930`, `0930`, `9:30`, `9.30`.
 * A bare 1-2 digit number is a whole hour; 3-4 digits are H/HH + MM.
 */
export function parseLooseClock(value: string): ClockParts | null {
  const text = value.trim();
  const match =
    /^(\d{1,2})[:.](\d{2})$/.exec(text) ??
    /^(\d{1,2})(\d{2})$/.exec(text) ??
    /^(\d{1,2})()$/.exec(text);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = match[2] === "" ? 0 : Number(match[2]);
  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

/**
 * Moves a clock by `steps` grid steps of `size` minutes. Off-grid values first
 * snap to the grid in the direction of travel (09:17 +1 -> 09:30, -1 -> 09:15),
 * then move the remaining steps. Wraps at midnight; an invalid value is 00:00.
 */
export function stepClock(value: string, steps: number, size = 15): string {
  const parts = parsePickerClock(value) ?? { hour: 0, minute: 0 };
  const minutes = parts.hour * 60 + parts.minute;
  const remainder = minutes % size;
  let target = minutes + steps * size;
  if (remainder !== 0 && steps > 0) target = minutes - remainder + size * steps;
  else if (remainder !== 0 && steps < 0)
    target = minutes - remainder + size * (steps + 1);
  const wrapped = ((target % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  return formatPickerClock({
    hour: Math.floor(wrapped / 60),
    minute: wrapped % 60,
  });
}

/** Arrow keys step by 15 minutes, Page keys by an hour; anything else is null. */
export function clockFieldKey(value: string, key: string): string | null {
  switch (key) {
    case "ArrowUp":
      return stepClock(value, 1);
    case "ArrowDown":
      return stepClock(value, -1);
    case "PageUp":
      return stepClock(value, 1, 60);
    case "PageDown":
      return stepClock(value, -1, 60);
    default:
      return null;
  }
}

/** The clock a step starts from: a valid typed draft, else the saved value. */
export function clockStart(draft: string, value: string): string {
  const typed = parseLooseClock(draft);
  return typed ? formatPickerClock(typed) : value;
}

/**
 * What leaving the field shows and saves. Only a draft the user edited since
 * focus or the last save is saved, so an untouched field never writes its old
 * text over a value that changed while it had focus (the automatic first
 * start, say). An edited draft that is not a time reverts.
 */
export function leaveClockField(
  draft: string,
  value: string,
  edited: boolean,
): { draft: string; save?: string } {
  const parts = edited ? parseLooseClock(draft) : null;
  if (!parts) return { draft: value };
  const next = formatPickerClock(parts);
  return next === value ? { draft: next } : { draft: next, save: next };
}

/**
 * Whether the draft should snap back to the saved value. Never while the field
 * is being edited, and never while an action is running: the saved value is
 * stale until that action finishes, and the draft is what the user just typed.
 */
export function shouldResyncDraft(
  activeIsInput: boolean,
  disabled: boolean,
): boolean {
  return !activeIsInput && !disabled;
}

/**
 * How the input is locked. A focused field that becomes busy turns read-only
 * rather than disabled, because a disabled element would drop focus.
 */
export function timeFieldAccess(
  disabled: boolean,
  focused: boolean,
): { disabled: boolean; readOnly: boolean } {
  return { disabled: disabled && !focused, readOnly: disabled && focused };
}

export type WheelState = { total: number; at: number };

const WHEEL_STEP_PX = 40;
const WHEEL_IDLE_MS = 200;

/**
 * Turns wheel deltas into at most one step per event. Deltas add up while the
 * wheel keeps moving the same way; a pause of 200 ms or a reversal starts over,
 * and the remainder is dropped after a step so trackpad momentum cannot run on.
 * `steps` follows the sign of deltaY (positive = scrolled down).
 */
export function wheelSteps(
  state: WheelState,
  deltaY: number,
  now: number,
): { steps: number; state: WheelState } {
  const keep =
    now - state.at <= WHEEL_IDLE_MS &&
    (state.total === 0 || Math.sign(state.total) === Math.sign(deltaY));
  const total = (keep ? state.total : 0) + deltaY;
  if (Math.abs(total) >= WHEEL_STEP_PX)
    return { steps: Math.sign(total), state: { total: 0, at: now } };
  return { steps: 0, state: { total, at: now } };
}
