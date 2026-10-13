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

export function positionTimePopover(
  anchor: { left: number; top: number; bottom: number },
  viewport: { width: number; height: number },
  contentHeight: number,
) {
  const inset = Math.min(12, viewport.width / 2, viewport.height / 2);
  const gap = 8;
  const width = Math.min(336, Math.max(0, viewport.width - inset * 2));
  const height = Math.min(contentHeight, viewport.height - inset * 2);
  const below = Math.max(0, viewport.height - anchor.bottom - gap - inset);
  const above = Math.max(0, anchor.top - gap - inset);
  const side = height <= below || below >= above ? "below" : "above";
  const available = side === "below" ? below : above;
  // In a short window, keep the input and actions usable rather than clipping them.
  const maxHeight = available < 220 ? height : Math.min(height, available);
  const proposedTop =
    side === "below" ? anchor.bottom + gap : anchor.top - gap - maxHeight;
  const left = Math.max(
    inset,
    Math.min(anchor.left, viewport.width - width - inset),
  );
  const top = Math.max(
    inset,
    Math.min(proposedTop, viewport.height - maxHeight - inset),
  );
  return { left, top, width, maxHeight };
}
