/** What the windows read: the snapshots, usage statistics, token usage and the lost-and-found. */
import { lostFoundCollection } from "../../../shared/lost-found";
import { buildTokenUsageView } from "../../../shared/token-usage-view";
import { buildStatisticsView } from "../../../shared/usage-statistics-view";
import { draftSummaries } from "../../core/draft-main";
import { sidebarSummary } from "../../core/sidebar-main";
import { usageStatisticsInput } from "../../core/usage-statistics-input";
import { say } from "../../i18n";
import { antigravityApp } from "../antigravity";
import { displayUsage, separateWindows } from "../desktop-support";
import { meters } from "../notifications";
import {
  activeTimeline,
  autoSwitch,
  continuation,
  desktop,
  fleet,
  globalShortcuts,
  keeper,
  service,
  usageHistory,
} from "../state";
import {
  TOKEN_FRESH_MS,
  TOKEN_REFRESH_BUDGET_MS,
  tokenLastTick,
  tokenLedger,
  tokenTick,
  tokenTickedAt,
} from "../tokens-widget";
import { appUpdates } from "../updates";
import type { IpcKit } from "./index";
export function registerSnapshotIpc({ handle }: IpcKit) {
  handle("panel-snapshot", async () => ({
    ...(await service.panelSnapshot()),
    windows: await separateWindows(),
    update: appUpdates?.state(),
    antigravity: await antigravityApp(),
    usage: displayUsage(),
    continuation: continuation.snapshot(),
    fleet: fleet.snapshot(),
    autoSwitch: autoSwitch.snapshot(),
    planning: keeper.snapshot(),
    drafts: await draftSummaries(desktop),
    sidebar: await sidebarSummary(desktop),
    extension: await desktop.extensionOffer(),
  }));
  handle("snapshot", () =>
    service.transaction(async () => ({
      ...(await service.snapshot()),
      windows: await separateWindows(),
      update: appUpdates?.state(),
      shortcuts: globalShortcuts?.status(),
      antigravity: await antigravityApp(),
      meters: meters.snapshot(),
      usage: displayUsage(),
      continuation: continuation.snapshot(),
      fleet: fleet.snapshot(),
      autoSwitch: autoSwitch.snapshot(),
      planning: keeper.snapshot(),
      drafts: await draftSummaries(desktop),
      sidebar: await sidebarSummary(desktop),
      extension: await desktop.extensionOffer(),
    })),
  );
  handle("usage-statistics", (input) => {
    const { range, accountId } = usageStatisticsInput.parse(input);
    return buildStatisticsView({
      rollups: usageHistory.rollups(),
      available: usageHistory.rollupsAvailable,
      accounts: service.store.state.accounts,
      range,
      ...(accountId ? { accountId } : {}),
      zone: service.store.state.settings.planning.timeZone,
      hours: {
        weekday: service.store.state.settings.planning.weekday,
        weekend: service.store.state.settings.planning.weekend,
      },
      now: Date.now(),
    });
  });
  handle("token-usage", async (input) => {
    const { range, accountId } = usageStatisticsInput.parse(input);
    if (!tokenLedger)
      throw new Error(
        say("electronMain.relayCannotReadTheTokenUsage"),
      );
    if (Date.now() - tokenTickedAt > TOKEN_FRESH_MS) {
      // Ticks until the pass is complete or about a second has passed.
      const until = Date.now() + TOKEN_REFRESH_BUDGET_MS;
      do await tokenTick();
      while (
        tokenLastTick !== "failed" &&
        !tokenLastTick.complete &&
        Date.now() < until
      );
    }
    const exactSince = activeTimeline.exactSince();
    return buildTokenUsageView({
      ledger: tokenLedger.snapshot(),
      accounts: service.store.state.accounts,
      range,
      ...(accountId ? { accountId } : {}),
      zone: service.store.state.settings.planning.timeZone,
      now: Date.now(),
      ...(exactSince === undefined ? {} : { exactSince }),
    });
  });
  const lostFoundSource = () => {
    const ledger = tokenLedger?.snapshot();
    return {
      rollups: usageHistory.rollups(),
      segments: activeTimeline.list(),
      ledgerDays: ledger?.days ?? {},
      ...(ledger?.slots ? { ledgerSlots: ledger.slots } : {}),
      ...(ledger?.slotsSince === undefined
        ? {}
        : { slotsSince: ledger.slotsSince }),
      accounts: service.store.state.accounts,
      zone: service.store.state.settings.planning.timeZone,
      now: Date.now(),
    };
  };
  handle("lost-found-collection", () => lostFoundCollection(lostFoundSource()));
}
