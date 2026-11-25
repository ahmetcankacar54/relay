/** The token ledger's scan, and the widget and menu bar figures written from it. */
import { app } from "electron";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { calibrateLimits, type LimitCalibration } from "../../shared/limit-calibration";
import { localDate, wallTime } from "../../shared/planning";
import { tempoAt } from "../../shared/tempo";
import { buildTokenUsageView } from "../../shared/token-usage-view";
import type { TrayToday } from "../../shared/tray";
import type { UsageSample } from "../../shared/usage-statistics";
import { buildStatisticsView } from "../../shared/usage-statistics-view";
import { buildWidgetSnapshot } from "../../shared/widget-snapshot";
import type { SessionOwner } from "../core/desktop-windows";
import { attribute } from "../core/token-attribution";
import { TokenLedger, tokenTickDelay } from "../core/token-ledger";
import { loadWidgetCenter } from "../core/widget-center";
import { WidgetFile } from "../core/widget-file";
import { getAppLocale } from "../i18n";
import { gatewayRequests } from "./gateway-requests";
import { activeTimeline, desktopWindows, keeper, observedDesktop, service, usage, usageHistory } from "./state";
import { scheduleStatusline } from "./statusline";
/** Which account's window holds each Claude Code session, for token attribution. */
let windowSessionOwners = new Map<string, SessionOwner>();
/** Today's tokens and API value for the menu bar title, taken from the ledger when the widget is written. */
export let trayToday: TrayToday | undefined;
// Token usage: the ledger of transcripts read so far, and the ticks that read
// them, at the pace `tokenTickDelay` sets.
/** The Usage page asks for ticks first when the last one is older than this. */
export const TOKEN_FRESH_MS = 60_000;
/** How long the Usage page waits, at most, for those ticks to finish the pass. */
export const TOKEN_REFRESH_BUDGET_MS = 1_000;
/** Limit samples are kept 14 days; older responses cannot be estimated from them. */
const TOKEN_ATTRIBUTION_WINDOW_MS = 14 * 86_400_000;
/** The limit samples are copied for attribution at most this often. */
const TOKEN_SAMPLES_REFRESH_MS = 60_000;
export let tokenLedger: TokenLedger | undefined;
/** Each account's dollars per percent of its 5-hour window, worked out again every ten minutes. */
let calibrationCache: { at: number; value: Record<string, LimitCalibration> } | undefined;
export function limitCalibrations(): Record<string, LimitCalibration> {
  const now = Date.now();
  if (calibrationCache && now - calibrationCache.at < 10 * 60_000) return calibrationCache.value;
  let value: Record<string, LimitCalibration> = {};
  try {
    const slots = tokenLedger?.snapshot().slots;
    if (usageHistory && slots)
      value = calibrateLimits({
        samples: usageHistory.recentSamples(now - 7 * 86_400_000),
        slots,
        zone: service.store.state.settings.planning.timeZone,
        now,
      });
  } catch {
    // Not now: the next status asks again in ten minutes.
  }
  calibrationCache = { at: now, value };
  return value;
}
/** `~/.claude/projects`, then the profile of each account that has written transcripts. */
const tokenRoots: { dir: string; profileAccountId?: string }[] = [];
let tokenTimer: ReturnType<typeof setTimeout> | undefined;
let tokenRunning: Promise<void> | undefined;
/** How the last tick ended; before the first, as a pass yet to finish. */
export let tokenLastTick: { complete: boolean } | "failed" = { complete: false };
export let tokenTickedAt = 0;
/** The limit samples attribution reads, copied at most once a minute and never once per row. */
let tokenSamples: UsageSample[] = [];
let tokenSamplesAt = -Infinity;
let tokenScanStopped = false;
/** The macOS widget's file, rewritten after every tick and at local midnight. */
let widgetFile: WidgetFile | undefined;
let widgetMidnight: ReturnType<typeof setTimeout> | undefined;
/** The account open in Claude when the widget file was last written. */
export let widgetActiveId: string | undefined;
/**
 * Roots are only ever appended, so the indexes the ledger keeps into them stay
 * valid; an account that starts a terminal after launch is read from its next pass.
 */
export async function addTokenRoots() {
  for (const account of service.store.state.accounts) {
    if (tokenRoots.some((root) => root.profileAccountId === account.id))
      continue;
    const dir = path.join(service.store.profile(account.id), "projects");
    if (await fsp.stat(dir).then((stat) => stat.isDirectory(), () => false))
      tokenRoots.push({ dir, profileAccountId: account.id });
  }
}
/** A new copy of the limit samples when the last is a minute old, or the clock went back. */
function refreshTokenSamples() {
  const now = Date.now();
  const age = now - tokenSamplesAt;
  if (age >= 0 && age < TOKEN_SAMPLES_REFRESH_MS) return;
  tokenSamples = usageHistory.recentSamples(now - TOKEN_ATTRIBUTION_WINDOW_MS);
  tokenSamplesAt = now;
}
async function tokenTickOnce() {
  if (!tokenLedger) return;
  try {
    await addTokenRoots();
    refreshTokenSamples();
    if (desktopWindows)
      windowSessionOwners = await desktopWindows.sessionOwners().catch(() => windowSessionOwners);
    tokenLastTick = await tokenLedger.tick();
    writeWidget();
  } catch {
    // A scan that fails (a full disk, a bad time zone) never disturbs Relay; it
    // is tried again at the slow pace.
    tokenLastTick = "failed";
  } finally {
    tokenTickedAt = Date.now();
  }
}
/** One tick at a time: a caller during a tick shares it instead of starting another. */
export function tokenTick(): Promise<void> {
  tokenRunning ??= tokenTickOnce().finally(() => {
    tokenRunning = undefined;
  });
  return tokenRunning;
}
/** The next tick is armed only when the last has ended, on a timer that never holds Relay open. */
function scheduleTokenTick() {
  if (tokenScanStopped) return;
  if (tokenTimer) clearTimeout(tokenTimer);
  tokenTimer = setTimeout(
    () => {
      tokenTimer = undefined;
      void tokenTick().finally(scheduleTokenTick);
    },
    tokenTickDelay(tokenLastTick),
  );
  tokenTimer.unref();
}
/** Today's numbers for the widget and the menu bar title, from the ledger as it stands; never disturbs Relay. */
export function writeWidget(force = false) {
  scheduleStatusline();
  widgetActiveId = observedDesktop?.activeProfileId;
  if (!tokenLedger || !widgetFile) return;
  try {
    const zone = service.store.state.settings.planning.timeZone;
    const now = Date.now();
    const ledger = tokenLedger.snapshot();
    const { scannedBytes, totalBytes, complete } = ledger.progress;
    const percent = complete
      ? 100
      : totalBytes > 0
        ? Math.min(99, Math.floor((scannedBytes / totalBytes) * 100))
        : 0;
    const { accounts, settings } = service.store.state;
    const tokens = buildTokenUsageView({ ledger, accounts, range: 7, zone, now });
    // The menu bar title reads today's figures from here, so its 5-second timer never reads the
    // ledger; until the first pass is done they are partial and left out.
    const totals = tokens.today.totals;
    trayToday = complete
      ? {
          date: tokens.today.date,
          tokens: totals.input + totals.output + totals.cacheWrite + totals.cacheRead,
          cost: totals.cost ?? 0,
          ...(totals.costEstimated ? { costEstimated: true } : {}),
        }
      : undefined;
    widgetFile.write(
      buildWidgetSnapshot({
        today: tokens.today,
        days: tokens.days,
        progress: { complete, percent },
        language: getAppLocale(),
        zone,
        now,
        limits: {
          accounts,
          usage: usage?.snapshot() ?? {},
          activeId: observedDesktop?.activeProfileId,
          settings,
          rate: widgetTempoRate(now),
        },
        hits: widgetLimitHits(zone, now),
      }),
      force,
    );
  } catch {
    // A widget file that cannot be written leaves the widget saying Relay is not current.
  }
}
/** The keeper's tempo now, as the panel ranks accounts with it; undefined without one. */
export function widgetTempoRate(now: number) {
  try {
    const tempo = keeper?.snapshot().tempo;
    return tempo
      ? tempoAt(tempo, service.store.state.settings.planning, now)
      : undefined;
  } catch {
    return undefined;
  }
}
/** Limits reached in the last seven days, as the Usage page counts them; undefined without history. */
function widgetLimitHits(zone: string, now: number) {
  try {
    if (!usageHistory?.rollupsAvailable) return undefined;
    const view = buildStatisticsView({
      rollups: usageHistory.rollups(),
      available: true,
      accounts: service.store.state.accounts,
      range: 7,
      zone,
      now,
    });
    if (view.status === "unavailable") return undefined;
    return view.totals.hits.fiveHour + view.totals.hits.weekly;
  } catch {
    return undefined;
  }
}
/** At local midnight the widget starts the new day, even with nothing to count. */
function scheduleWidgetMidnight() {
  if (widgetMidnight) clearTimeout(widgetMidnight);
  if (tokenScanStopped) return;
  let wait = 60 * 60_000;
  try {
    const zone = service.store.state.settings.planning.timeZone;
    const now = Date.now();
    const today = localDate(now, zone);
    const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);
    const midnight = wallTime(tomorrow, "00:00", zone);
    if (midnight !== undefined && midnight > now)
      wait = Math.min(wait, midnight - now + 1_000);
  } catch {
    // An invalid zone: try again within the hour.
  }
  widgetMidnight = setTimeout(() => {
    writeWidget();
    scheduleWidgetMidnight();
  }, wait);
  widgetMidnight.unref();
}
export function startTokenScan() {
  try {
    tokenRoots.push({ dir: path.join(os.homedir(), ".claude", "projects") });
    tokenLedger = new TokenLedger({
      file: path.join(app.getPath("userData"), "token-ledger.json"),
      roots: tokenRoots,
      attribute: (row) =>
        attribute(row, {
          timeline: activeTimeline,
          samples: tokenSamples,
          accounts: service.store.state.accounts,
          windowOwner: (sessionId, time) => {
            const owner = windowSessionOwners.get(sessionId.toLowerCase());
            return owner && time <= owner.until ? owner.accountUuid : undefined;
          },
          gatewayAccount: (requestId) => gatewayRequests().accountFor(requestId),
        }),
      zone: () => service.store.state.settings.planning.timeZone,
    });
    widgetFile = new WidgetFile(
      path.join(app.getPath("userData"), "widget"),
      loadWidgetCenter(__dirname),
    );
    writeWidget();
    scheduleWidgetMidnight();
    scheduleTokenTick();
  } catch {
    // Without a ledger the Usage page's token card reports an error; Relay runs on.
    tokenLedger = undefined;
  }
}
/** Relay is quitting: no tick or midnight rewrite is armed again. */
export function stopTokenScan() {
  tokenScanStopped = true;
  if (tokenTimer) clearTimeout(tokenTimer);
  if (widgetMidnight) clearTimeout(widgetMidnight);
}
