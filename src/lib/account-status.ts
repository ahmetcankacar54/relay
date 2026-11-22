import type { Account, AccountUsage } from "../../shared/types";
import { fullestByPeriod, limitHeadline, modelOnlyUsage, spentModelWindows, usedAt } from "../../shared/quota-windows";
import { freshUsage } from "../../shared/usage";
import type { T } from "@/data/i18n";
import type { AccountHealth } from "./account-health";
import { countdown } from "./time";

/** An account's state as every list shows it: a tone for its dot and at most four words. */
export interface AccountStatus {
  tone: "ok" | "warn" | "crit" | "off";
  text: string;
  /** The longer explanation, for the title (hover) and the account page. */
  reason?: string;
}

/** A window's share used now (a passed reset counts as empty); none counts as zero. */
const usedNow = (window: { usedPercent: number; resetsAt?: string } | undefined, now: number) => (window ? usedAt(window, now) : 0);

/** "Dolu · 25 dk", or just "Dolu" without a reset ahead. */
const withLeft = (words: string, resetsAt: string | undefined, now: number, t: T) => {
  const left = countdown(resetsAt, now, t);
  return left ? `${words} · ${left}` : words;
};

/**
 * One status for an account, the same in the Accounts list, the Overview and the account page. The
 * first that applies wins: a sign-in problem (`health`), an old or missing reading, a spent limit
 * (the whole account, a pool or a model, with when it opens), a limit at 90% or more, then in use or
 * ready. In use replaces the countdown, so the words stay four at most.
 */
export function accountStatus(input: {
  account: Account;
  usage: AccountUsage | undefined;
  health: AccountHealth;
  /** The Claude app, the Antigravity app or the gateway works with this account now. */
  inUse: boolean;
  now: number;
  t: T;
}): AccountStatus {
  const { usage, health, inUse, now, t } = input;
  const reason = health.label === health.short ? undefined : health.label;
  // A spent model's limit is told by the limits below, in their words; an old reading is quiet.
  if (health.tone !== "ok" && !health.limit) {
    const old = !!usage && (usage.stale || usage.status === "error") && health.short === t("accountStatus.oldReading");
    return { tone: old ? "off" : health.tone, text: health.short, ...(reason ? { reason } : {}) };
  }
  const lead = inUse ? t("accountStatus.inUse") : undefined;
  // No limits to read (a Codex API key, a provider Relay cannot read): the sign-in decides, and it is fine.
  const readable = !!usage && usage.issue !== "unsupported" && (!!usage.fiveHour || !!usage.sevenDay || !!usage.modelWindows?.length);
  if (!readable) return { tone: "ok", text: lead ?? t("common.ready") };
  if (!freshUsage(usage, now)) return { tone: "off", text: t("accountStatus.oldReading") };
  const say = (tone: AccountStatus["tone"], words: string, resetsAt?: string): AccountStatus => ({
    tone,
    text: lead ? `${lead} · ${words}` : withLeft(words, resetsAt, now, t),
  });

  if (modelOnlyUsage(usage)) {
    // Antigravity: a pool spent leaves the others usable; every pool spent is the account full.
    const pools = new Map<string, { used: number; resetsAt?: string }>();
    for (const w of usage.modelWindows ?? []) {
      const used = usedNow(w, now);
      const seen = pools.get(w.label);
      if (!seen || used > seen.used) pools.set(w.label, { used, resetsAt: w.resetsAt });
    }
    const spent = [...pools].filter(([, p]) => p.used >= 100);
    if (spent.length && spent.length === pools.size) {
      const first = spent.map(([, p]) => p.resetsAt).sort()[0];
      return say("crit", t("common.full"), first);
    }
    if (spent.length) return say("warn", t("accountStatus.full2", { modelLabel: spent[0][0] }), spent[0][1].resetsAt);
    const cols = fullestByPeriod(usage, now);
    const fullest = Math.max(cols.five_hour?.usedPercent ?? 0, cols.seven_day?.usedPercent ?? 0, limitHeadline(usage, now)?.usedPercent ?? 0);
    if (fullest >= 90) return say("warn", t("accountStatus.nearlyFull"));
    return { tone: "ok", text: lead ?? t("common.ready") };
  }

  const five = usedNow(usage.fiveHour, now);
  const week = usedNow(usage.sevenDay, now);
  if (week >= 100) return say("crit", t("accountStatus.weekFull"), usage.sevenDay?.resetsAt);
  if (five >= 100) return say("crit", t("common.full"), usage.fiveHour?.resetsAt);
  const model = spentModelWindows(usage, now).sort((a, b) => (a.resetsAt ?? "").localeCompare(b.resetsAt ?? ""))[0];
  if (model) return say("warn", t("accountStatus.full2", { modelLabel: model.label }), model.resetsAt);
  if (Math.max(five, week) >= 90) return say("warn", t("accountStatus.nearlyFull"));
  return { tone: "ok", text: lead ?? t("common.ready") };
}
