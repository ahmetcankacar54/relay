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

export function moveTimeGridCursor(
  index: number,
  key: string,
  count: number,
  columns = 6,
): number | null {
  const next: Record<string, number> = {
    ArrowLeft: index - 1,
    ArrowRight: index + 1,
    ArrowUp: index - columns,
    ArrowDown: index + columns,
    Home: 0,
    End: count - 1,
  };
  return Object.hasOwn(next, key)
    ? Math.max(0, Math.min(count - 1, next[key]))
    : null;
}
