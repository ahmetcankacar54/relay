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
