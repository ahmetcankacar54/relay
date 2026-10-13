const DAY_MINUTES = 1_440;

export interface DialPoint {
  x: number;
  y: number;
}

// A 24-hour dial starts at midnight at the top and advances clockwise. The
// visual is a wall-clock projection, so callers preserve every DST segment.
export function dialPoint(
  minute: number,
  radius: number,
  center = 180,
): DialPoint {
  const angle = (minute / DAY_MINUTES) * Math.PI * 2 - Math.PI / 2;
  return {
    x: center + Math.cos(angle) * radius,
    y: center + Math.sin(angle) * radius,
  };
}
function coordinate(value: number) {
  return String(Math.round(value * 1_000) / 1_000);
}
function pair(point: DialPoint) {
  return `${coordinate(point.x)} ${coordinate(point.y)}`;
}

// SVG arcs cannot represent a full circle with coinciding endpoints. Split a
// full civil-day segment into two arcs instead of dropping or shortening it.
export function dialSegmentPath(
  startMinute: number,
  endMinute: number,
  radius: number,
  center = 180,
) {
  if (
    !Number.isFinite(startMinute) ||
    !Number.isFinite(endMinute) ||
    !Number.isFinite(radius) ||
    !Number.isFinite(center) ||
    radius <= 0 ||
    startMinute < 0 ||
    endMinute > DAY_MINUTES ||
    endMinute <= startMinute
  )
    return "";
  const start = dialPoint(startMinute, radius, center);
  const end = dialPoint(endMinute, radius, center);
  const sweep = endMinute - startMinute;
  if (sweep === DAY_MINUTES) {
    const middle = dialPoint(startMinute + sweep / 2, radius, center);
    return `M ${pair(start)} A ${radius} ${radius} 0 0 1 ${pair(middle)} A ${radius} ${radius} 0 0 1 ${pair(end)}`;
  }
  return `M ${pair(start)} A ${radius} ${radius} 0 ${sweep > DAY_MINUTES / 2 ? 1 : 0} 1 ${pair(end)}`;
}
