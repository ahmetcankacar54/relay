/**
 * The order both the gateway router and the day simulation use to pick the next account. Room
 * is counted in Pro units (a Pro window holds 100) so a Max account's last 15 % is not mistaken
 * for a Pro account's.
 */

/** Room at or below this is low: one Pro window 80 % used. */
export const LOW_ROOM_UNITS = 20;
/** Room at or below this is as good as empty: one Pro window 95 % used. */
export const EMPTY_ROOM_UNITS = 5;
/**
 * Accounts whose weeks end within this of each other count as ending together: between them
 * the 5-hour window decides. Weeks that end days apart are what the order is about.
 */
export const DEADLINE_BAND_MS = 6 * 3_600_000;

/** Pro units left in a window that is `remainingPercent` empty on an account of `capacity`. */
export const roomUnits = (remainingPercent: number, capacity: number) =>
  remainingPercent * capacity;

/**
 * The deadline band of a week ending at `weekEnds`, measured from the earliest week of the
 * pool (so two weeks minutes apart never fall on either side of a fixed edge).
 */
export const weekBand = (weekEnds: number, earliest: number) =>
  Math.floor((weekEnds - earliest) / DEADLINE_BAND_MS);
