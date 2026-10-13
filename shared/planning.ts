import type { Account } from "./types";

const HOUR = 3_600_000;
const dateFormatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
  let f = dateFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    dateFormatters.set(timeZone, f);
  }
  return f;
}
function localParts(time: number, timeZone: string) {
  return Object.fromEntries(
    formatter(timeZone)
      .formatToParts(new Date(time))
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, p.value]),
  );
}
export function localDate(time: number, timeZone: string) {
  const p = localParts(time, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}
// Resolve wall times using the zone's actual offsets on either side of a DST
// transition. A nonexistent time is skipped; an ambiguous time uses its first
// occurrence so no quota-consuming job can run twice in the repeated hour.
export function wallTime(date: string, clock: string, timeZone: string) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(clock)
  )
    return;
  const nominal = Date.parse(`${date}T${clock}:00Z`);
  if (!Number.isFinite(nominal)) return;
  const offsets = new Set<number>();
  for (const delta of [-36, -12, 0, 12, 36]) {
    const probe = nominal + delta * HOUR;
    const p = localParts(probe, timeZone);
    offsets.add(
      Date.parse(
        `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`,
      ) - probe,
    );
  }
  const matches = [...offsets]
    .map((offset) => nominal - offset)
    .filter((candidate) => {
      const p = localParts(candidate, timeZone);
      return (
        `${p.year}-${p.month}-${p.day}` === date &&
        `${p.hour}:${p.minute}` === clock
      );
    });
  return matches.length ? Math.min(...matches) : undefined;
}
export function planningIdentity(a: Account) {
  if (!a.auth?.loggedIn || !a.auth.accountUuid || !a.auth.orgId) return;
  if (
    a.desktop &&
    (a.auth.accountUuid !== a.desktop.accountUuid ||
      a.auth.orgId !== a.desktop.orgId)
  )
    return;
  return `${a.auth.accountUuid}:${a.auth.orgId}`;
}
export function planCapacity(a: Account) {
  switch (a.planning?.plan) {
    case "pro":
      return 1;
    case "max5":
      return 5;
    case "max20":
      return 20;
    default: {
      const weight = a.planning?.capacityWeight ?? 1;
      return Number.isFinite(weight) ? Math.min(100, Math.max(1, weight)) : 1;
    }
  }
}
