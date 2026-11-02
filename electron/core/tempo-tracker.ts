import type { Account, PlanningSettings } from "../../shared/types";
import type { UsageRollups } from "../../shared/usage-rollups";
import { localDate, planCapacity } from "../../shared/planning";
import {
  fallbackTempo,
  learnTempo,
  tempoAt,
  type Tempo,
} from "../../shared/tempo";
import { historyIdentity } from "../../shared/usage-statistics";

export interface TempoSource {
  /** Whether the rollups can be read (usageHistory.rollupsAvailable). */
  available(): boolean;
  /** Called only when recomputing: reading the rollups clones them. */
  rollups(): UsageRollups | undefined;
  accounts(): Account[];
  settings(): PlanningSettings;
  now?: () => number;
}

/** Learns the tempo once per local day, or again when what it depends on changes. */
export class TempoTracker {
  private key?: string;
  private value?: Tempo;
  constructor(private readonly source: TempoSource) {}
  private now() {
    return (this.source.now ?? Date.now)();
  }
  current(): Tempo {
    const now = this.now();
    const settings = this.source.settings();
    const accounts = this.source.accounts();
    const available = this.source.available();
    const key = JSON.stringify([
      localDate(now, settings.timeZone),
      settings.tempo ?? "auto",
      settings.timeZone,
      settings.weekday,
      settings.weekend,
      available,
      accounts.map((a) => [
        historyIdentity(a) ?? "",
        !!a.auth?.loggedIn,
        planCapacity(a),
      ]),
    ]);
    if (key !== this.key || !this.value) {
      this.value = learnTempo({
        rollups: available ? this.source.rollups() : undefined,
        accounts,
        settings,
        now,
      });
      this.key = key;
    }
    return this.value;
  }
  /** The current tempo; when learning it fails, the settings' fallback (the keeper still plans). */
  currentOrFallback(): Tempo {
    try {
      return this.current();
    } catch {
      return fallbackTempo(this.source.settings());
    }
  }
  /** Pro units per hour at `time` (default now) under the current tempo. */
  rateAt(time = this.now()) {
    return tempoAt(this.current(), this.source.settings(), time);
  }
}
