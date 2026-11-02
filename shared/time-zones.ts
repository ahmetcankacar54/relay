/** Picker data uses IANA identities; offsets are a dated display, never storage. */
export type TimeZoneOption = {
  zone: string;
  city: string;
  offset: string;
  common: boolean;
};

export const COMMON_TIME_ZONES = [
  "Europe/Istanbul",
  "Europe/London",
  "Europe/Berlin",
  "America/New_York",
  "America/Los_Angeles",
  "Asia/Dubai",
  "Asia/Tokyo",
  "UTC",
] as const;

// Older webviews may not expose supportedValuesOf. These include representative
// half/quarter-hour zones and preserve the common choices without a network call.
const FALLBACK_TIME_ZONES = [
  ...COMMON_TIME_ZONES,
  "Africa/Cairo",
  "Africa/Johannesburg",
  "Africa/Lagos",
  "America/Anchorage",
  "America/Chicago",
  "America/Denver",
  "America/Mexico_City",
  "America/Sao_Paulo",
  "America/Toronto",
  "Asia/Bangkok",
  "Asia/Hong_Kong",
  "Asia/Kathmandu",
  "Asia/Kolkata",
  "Asia/Seoul",
  "Asia/Shanghai",
  "Asia/Singapore",
  "Asia/Tehran",
  "Australia/Adelaide",
  "Australia/Perth",
  "Australia/Sydney",
  "Europe/Amsterdam",
  "Europe/Athens",
  "Europe/Madrid",
  "Europe/Paris",
  "Europe/Rome",
  "Pacific/Auckland",
  "Pacific/Honolulu",
];

const validCache = new Map<string, boolean>();
const offsetFormatters = new Map<string, Intl.DateTimeFormat>();
let catalogCache: string[] | undefined;

export function validTimeZone(zone: string): boolean {
  if (!zone || zone.length > 100 || !/^[A-Za-z][A-Za-z0-9_+./-]*$/.test(zone))
    return false;
  const cached = validCache.get(zone);
  if (cached !== undefined) return cached;
  let valid = false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    valid = true;
  } catch {
    // Search text stays transient until it identifies a valid Intl/IANA zone.
  }
  if (validCache.size >= 1_024) validCache.clear();
  validCache.set(zone, valid);
  return valid;
}

export function timeZoneCity(zone: string): string {
  if (!validTimeZone(zone)) return "—";
  return zone.split("/").at(-1)!.replaceAll("_", " ");
}

export function timeZoneOffset(zone: string, now = Date.now()): string {
  if (!validTimeZone(zone) || !Number.isFinite(now)) return "—";
  try {
    let formatter = offsetFormatters.get(zone);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat("en", {
        timeZone: zone,
        timeZoneName: "shortOffset",
      });
      if (offsetFormatters.size >= 1_024) offsetFormatters.clear();
      offsetFormatters.set(zone, formatter);
    }
    const raw = formatter
      .formatToParts(now)
      .find((part) => part.type === "timeZoneName")?.value;
    if (raw === "GMT" || raw === "UTC") return "UTC+00:00";
    const match = raw?.match(/^(?:GMT|UTC)([+-])(\d{1,2})(?::(\d{2}))?$/);
    return match
      ? `UTC${match[1]}${match[2].padStart(2, "0")}:${match[3] ?? "00"}`
      : "—";
  } catch {
    return "—";
  }
}

/** Exported for deterministic fallback verification without replacing global Intl. */
export function buildTimeZoneCatalog(supported?: readonly string[]): string[] {
  const all = new Set<string>(COMMON_TIME_ZONES);
  for (const zone of supported?.length ? supported : FALLBACK_TIME_ZONES) {
    if (validTimeZone(zone)) all.add(zone);
  }
  const common = COMMON_TIME_ZONES.filter((zone) => all.has(zone));
  const rest = [...all]
    .filter((zone) => !common.includes(zone as (typeof common)[number]))
    .sort();
  return [...common, ...rest];
}

function timeZoneCatalog(): readonly string[] {
  if (!catalogCache) {
    let supported: string[] | undefined;
    try {
      supported = Intl.supportedValuesOf("timeZone");
    } catch {
      // Webviews without this optional ECMA-402 API use the local fallback.
    }
    catalogCache = buildTimeZoneCatalog(supported);
  }
  return catalogCache;
}

export function foldTimeZoneSearch(value: string): string {
  // Map both Turkish I forms first; English lowercasing otherwise treats ı as
  // distinct and maps İ to an extra combining dot.
  return value
    .replace(/[İıI]/g, "i")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replaceAll("_", " ")
    .trim();
}

function offsetSearch(value: string): string {
  return foldTimeZoneSearch(value)
    .replace(/^gmt/, "utc")
    .replace(/([+-])0(\d)/g, "$1$2");
}

export function timeZoneOptions(
  current: string,
  now = Date.now(),
  catalog: readonly string[] = timeZoneCatalog(),
): TimeZoneOption[] {
  const zones = [...catalog];
  // Persisted aliases remain visible instead of silently changing the identity.
  if (validTimeZone(current) && !zones.includes(current))
    zones.unshift(current);
  return zones.map((zone) => ({
    zone,
    city: timeZoneCity(zone),
    offset: timeZoneOffset(zone, now),
    common: COMMON_TIME_ZONES.some((common) => common === zone),
  }));
}

export function filterTimeZones(
  options: readonly TimeZoneOption[],
  query: string,
  now = Date.now(),
): TimeZoneOption[] {
  const trimmed = query.trim();
  const folded = foldTimeZoneSearch(trimmed);
  if (!folded) return [...options];
  const matches = options.filter(
    (option) =>
      foldTimeZoneSearch(`${option.city} ${option.zone}`).includes(folded) ||
      offsetSearch(option.offset).includes(offsetSearch(trimmed)),
  );
  // Intl accepts historical IANA aliases omitted from supportedValuesOf. An
  // exact valid identifier is selectable, but arbitrary/partial text never is.
  if (
    validTimeZone(trimmed) &&
    !matches.some(
      (option) => option.zone.toLowerCase() === trimmed.toLowerCase(),
    )
  ) {
    matches.unshift({
      zone: trimmed,
      city: timeZoneCity(trimmed),
      offset: timeZoneOffset(trimmed, now),
      common: false,
    });
  }
  return matches;
}
