import type {
  Account,
  AccountUsage,
  AutoSwitchState,
  DesktopState,
  RelaySettings,
  UsageWindow,
} from "../../shared/types";
import {
  allowedHistoryPair,
  historySources,
} from "../../shared/history-policy";
import { quotaWindows } from "../../shared/usage";
import { rankContinuationTargets } from "../../shared/continuation-target-ranking";
import type { Store } from "./store";
import type { DesktopManager } from "./desktop";

const MAX_AGE = 5 * 60_000;
const RETRY_DELAY = 10 * 60_000;
const MAX_ATTEMPTS = 3;
const EXIT_GRACE = 10_000;

interface Exhaustion {
  key: string;
  expiresAt: number;
}
interface Decision {
  state: AutoSwitchState;
  exhausted?: Exhaustion[];
}
interface Dependencies {
  now?: () => number;
  pendingAuth?: () => boolean;
  /** Continue at quota owns the stopped conversations; preparing waits for it. */
  continuationOwns?: () => boolean;
  changed?: () => void;
  platformSupported?: boolean;
  withDesktopLock?: <T>(action: () => Promise<T>) => Promise<T>;
  /** Pro units per hour now (the tempo); undefined when unknown. */
  tempoRate?: () => number | undefined;
}
function identityReady(account: Account) {
  return (
    !!account.desktop &&
    !!account.auth?.loggedIn &&
    !!account.auth.accountUuid &&
    !!account.auth.orgId &&
    account.auth.accountUuid.toLowerCase() ===
      account.desktop.accountUuid.toLowerCase() &&
    account.auth.orgId.toLowerCase() === account.desktop.orgId.toLowerCase()
  );
}
function fresh(usage: AccountUsage | undefined, now: number) {
  const checkedAt = usage?.checkedAt ? Date.parse(usage.checkedAt) : NaN;
  return (
    !!usage &&
    usage.status === "ready" &&
    !usage.stale &&
    !usage.issue &&
    Number.isFinite(checkedAt) &&
    checkedAt <= now &&
    now - checkedAt <= MAX_AGE
  );
}
function validWindow(window: UsageWindow | undefined) {
  return (
    !!window &&
    Number.isFinite(window.usedPercent) &&
    window.usedPercent >= 0 &&
    window.usedPercent <= 100
  );
}
function futureReset(window: UsageWindow, now: number) {
  const reset = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
  return Number.isFinite(reset) && reset > now ? reset : undefined;
}
function exhaustion(account: Account, usage: AccountUsage, now: number) {
  return (["fiveHour", "sevenDay"] as const).flatMap((name) => {
    const window = usage[name];
    const expiresAt = window && futureReset(window, now);
    return validWindow(window) && window!.usedPercent >= 100 && expiresAt
      ? [
          {
            key: `${account.desktop!.accountUuid.toLowerCase()}:${account.desktop!.orgId.toLowerCase()}:${name}:${expiresAt}`,
            expiresAt,
          },
        ]
      : [];
  });
}
function usableTarget(
  account: Account,
  usage: AccountUsage | undefined,
  now: number,
) {
  if (!identityReady(account) || !fresh(usage, now)) return false;
  if (account.cooldownUntil) {
    const cooldown = Date.parse(account.cooldownUntil);
    if (!Number.isFinite(cooldown) || cooldown > now) return false;
  }
  const windows = quotaWindows(usage);
  return (
    !!windows &&
    windows.every(
      (window) =>
        validWindow(window) &&
        window.usedPercent < 90 &&
        (!window.resetsAt || !!futureReset(window, now)),
    )
  );
}

// Decisions never read credentials, infer task completion or send a message.
// The Desktop adapter remains responsible for enforcing absence before writes.
export function autoSwitchDecision(
  settings: RelaySettings,
  accounts: Account[],
  desktop: DesktopState,
  usage: Record<string, AccountUsage>,
  now: number,
  pendingAuth = false,
  platformSupported = process.platform === "darwin",
  /** Pro units per hour now (the tempo), for the switch rule's threshold. */
  rate?: number,
  /** A continuation or the fleet owns quota-stopped conversations. */
  continuationOwns = false,
): Decision {
  const state = (
    status: AutoSwitchState["status"],
    reason: AutoSwitchState["reason"],
    sourceId?: string,
    targetId?: string,
  ): Decision => ({
    state: {
      status,
      reason,
      sourceId,
      targetId,
      checkedAt: new Date(now).toISOString(),
    },
  });
  if (settings.autoSwitchMode !== "after-exit") return state("off", "disabled");
  if (!platformSupported) return state("blocked", "unsupported-platform");
  if (!desktop.available) return state("blocked", "desktop-unavailable");
  if (desktop.recoveryRequired) return state("blocked", "desktop-recovery");
  if (desktop.busy) return state("blocked", "desktop-busy");
  if (desktop.pendingProfileId) return state("blocked", "desktop-sign-in");
  if (continuationOwns) return state("blocked", "continuation-active");
  if (pendingAuth) return state("blocked", "browser-sign-in");
  const source = accounts.find(
    (account) => account.id === desktop.activeProfileId,
  );
  if (
    !source?.desktop ||
    desktop.currentAccountUuid?.toLowerCase() !==
      source.desktop.accountUuid.toLowerCase() ||
    !desktop.organizations.some(
      (org) => org.toLowerCase() === source.desktop!.orgId.toLowerCase(),
    )
  )
    return state("blocked", "unknown-active");
  if (!settings.autoSwitchAccounts.includes(source.id))
    return state("watching", "not-selected", source.id);
  if (!identityReady(source))
    return state("blocked", "source-not-ready", source.id);
  const current = usage[source.id];
  if (!fresh(current, now))
    return state("blocked", "usage-not-fresh", source.id);
  const exhausted = exhaustion(source, current, now);
  if (!exhausted.length) {
    const full = [current.fiveHour, current.sevenDay].some(
      (window) => validWindow(window) && window!.usedPercent >= 100,
    );
    return state(
      full ? "blocked" : "watching",
      full ? "usage-not-fresh" : "quota-available",
      source.id,
    );
  }
  const eligible = accounts.filter(
    (account) =>
      settings.autoSwitchAccounts.includes(account.id) &&
      allowedHistoryPair(source, account, settings) &&
      usableTarget(account, usage[account.id], now) &&
      !(
        account.desktop!.accountUuid.toLowerCase() ===
          source.desktop!.accountUuid.toLowerCase() &&
        account.desktop!.orgId.toLowerCase() ===
          source.desktop!.orgId.toLowerCase()
      ),
  );
  // The same rule as the other automatic switches: soonest reset among the
  // accounts with enough quota at the tempo, else capacity × remaining.
  const target = rankContinuationTargets(
    eligible.map((account) => ({ account, usage: usage[account.id] })),
    { now, rate },
  )[0]?.account;
  if (!target)
    return { ...state("blocked", "no-ready-target", source.id), exhausted };
  return {
    ...state(
      desktop.running ? "waiting" : "watching",
      desktop.running ? "claude-running" : "quota-exhausted",
      source.id,
      target.id,
    ),
    exhausted,
  };
}

export class AutoSwitchManager {
  private state: AutoSwitchState = { status: "off", reason: "disabled" };
  private timer?: ReturnType<typeof setInterval>;
  private evaluating = false;
  private stopped = false;
  private completed = new Map<string, number>();
  private failures = new Map<
    string,
    { expiresAt: number; attempts: number; retryAt: number }
  >();
  private lastSuccess?: AutoSwitchState;
  private closedSince?: number;
  private now: () => number;
  private platformSupported: boolean;
  constructor(
    private store: Store,
    private desktop: Pick<DesktopManager, "snapshot" | "switchTo">,
    private usage: { snapshot(): Record<string, AccountUsage> },
    private dependencies: Dependencies = {},
  ) {
    this.now = dependencies.now ?? Date.now;
    this.platformSupported =
      dependencies.platformSupported ?? process.platform === "darwin";
    this.completed = new Map(
      Object.entries(store.state.autoSwitchCompleted ?? {}),
    );
    this.prune(this.now());
  }
  snapshot(): AutoSwitchState {
    return structuredClone(this.state);
  }
  start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.tick();
    }, 30_000);
    this.timer.unref();
    void this.tick();
  }
  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  private publish(state: AutoSwitchState) {
    const { checkedAt: previousCheckedAt, ...previous } = this.state;
    const { checkedAt: nextCheckedAt, ...next } = state;
    this.state = state;
    if (JSON.stringify(previous) !== JSON.stringify(next))
      this.dependencies.changed?.();
  }
  private decide(desktop: DesktopState) {
    return autoSwitchDecision(
      this.store.state.settings,
      this.store.state.accounts,
      desktop,
      this.usage.snapshot(),
      this.now(),
      this.dependencies.pendingAuth?.() ?? false,
      this.platformSupported,
      this.dependencies.tempoRate?.(),
      this.dependencies.continuationOwns?.() ?? false,
    );
  }
  private prune(now: number) {
    for (const [key, expiresAt] of this.completed)
      if (expiresAt <= now) this.completed.delete(key);
    for (const [key, failure] of this.failures)
      if (failure.expiresAt <= now) this.failures.delete(key);
  }
  private episodeState(decision: Decision): AutoSwitchState | undefined {
    if (
      decision.exhausted?.some((episode) => this.completed.has(episode.key))
    ) {
      return {
        ...decision.state,
        status: "blocked",
        reason: "already-switched",
      };
    }
    const failure = decision.exhausted
      ?.map((episode) => this.failures.get(episode.key))
      .filter((value) => !!value)
      .sort((a, b) => b.attempts - a.attempts || b.retryAt - a.retryAt)[0];
    if (
      failure &&
      (failure.attempts >= MAX_ATTEMPTS || failure.retryAt > this.now())
    ) {
      return {
        ...decision.state,
        status: "blocked",
        reason:
          failure.attempts >= MAX_ATTEMPTS ? "switch-failed" : "retry-backoff",
        retryAt:
          failure.attempts >= MAX_ATTEMPTS
            ? undefined
            : new Date(failure.retryAt).toISOString(),
      };
    }
  }
  async tick(): Promise<void> {
    if (this.evaluating || this.stopped) return;
    this.evaluating = true;
    try {
      this.prune(this.now());
      if (this.store.state.settings.autoSwitchMode !== "after-exit") {
        this.lastSuccess = undefined;
        this.closedSince = undefined;
        this.publish({
          status: "off",
          reason: "disabled",
          checkedAt: new Date(this.now()).toISOString(),
        });
        return;
      }
      const desktop = await this.desktop.snapshot();
      if (this.stopped) return;
      if (desktop.running || !desktop.available) this.closedSince = undefined;
      else this.closedSince ??= this.now();
      let decision = this.decide(desktop);
      const episodeState = this.episodeState(decision);
      if (episodeState) {
        this.publish(episodeState);
        return;
      }
      const lastSuccess = this.lastSuccess;
      if (
        lastSuccess &&
        decision.state.reason === "quota-available" &&
        decision.state.sourceId === lastSuccess.targetId
      ) {
        this.publish({ ...lastSuccess, checkedAt: decision.state.checkedAt });
        return;
      }
      this.publish(decision.state);
      if (
        decision.state.reason !== "quota-exhausted" ||
        !decision.state.sourceId ||
        !decision.state.targetId
      )
        return;
      if (
        this.closedSince === undefined ||
        this.now() - this.closedSince < EXIT_GRACE
      ) {
        this.publish({
          ...decision.state,
          status: "waiting",
          reason: "exit-settling",
        });
        return;
      }
      // Re-read mutable state after the asynchronous Desktop snapshot. No await
      // separates the final consent check from acquiring Desktop's write lock.
      const sourceId = decision.state.sourceId,
        targetId = decision.state.targetId;
      const episodes = decision.exhausted!;
      const recheckedDesktop = await this.desktop.snapshot();
      if (this.stopped) return;
      if (recheckedDesktop.running || !recheckedDesktop.available)
        this.closedSince = undefined;
      decision = this.decide(recheckedDesktop);
      if (
        decision.state.sourceId !== sourceId ||
        decision.state.targetId !== targetId ||
        decision.state.reason !== "quota-exhausted" ||
        JSON.stringify(decision.exhausted) !== JSON.stringify(episodes)
      ) {
        this.publish(decision.state);
        return;
      }
      const selectedIdentity = () =>
        JSON.stringify(
          [sourceId, targetId].map((id) => {
            const account = this.store.state.accounts.find(
              (value) => value.id === id,
            );
            return [
              account?.desktop?.accountUuid,
              account?.desktop?.orgId,
              account?.auth?.accountUuid,
              account?.auth?.orgId,
              account?.auth?.loggedIn,
            ];
          }),
        );
      const identityAtDispatch = selectedIdentity();
      // The Desktop transaction can import history from accounts that are not
      // automatic-switch candidates. Bind the entire planned sharing boundary,
      // including every source identity, rather than only the A → B endpoints.
      const plannedHistoryScope = () => {
        const { settings, accounts } = this.store.state;
        const target = accounts.find((account) => account.id === targetId);
        const scope = (account: Account) => [
          account.id,
          account.group,
          account.desktop?.accountUuid,
          account.desktop?.orgId,
          account.auth?.accountUuid,
          account.auth?.orgId,
        ];
        const selected = (ids: string[]) =>
          [
            ...new Set(
              ids.filter((id) => accounts.some((account) => account.id === id)),
            ),
          ].sort();
        return JSON.stringify({
          autoMode: settings.autoSwitchMode,
          autoAccounts: selected(settings.autoSwitchAccounts),
          historyMode: settings.desktopHistoryTransfer,
          historyGrant:
            settings.desktopHistoryTransfer === "selected"
              ? selected(settings.desktopHistoryAccounts)
              : [],
          target: target ? scope(target) : undefined,
          sources: target
            ? historySources(target, accounts, settings)
                .sort((a, b) => a.id.localeCompare(b.id))
                .map(scope)
            : [],
        });
      };
      const historyScopeAtDispatch = plannedHistoryScope();
      const allowed = () => {
        const recheck = this.decide({
          available: true,
          running: false,
          busy: false,
          recoveryRequired: false,
          activeProfileId: sourceId,
          currentAccountUuid: this.store.state.accounts.find(
            (account) => account.id === sourceId,
          )?.desktop?.accountUuid,
          organizations: [
            this.store.state.accounts.find((account) => account.id === sourceId)
              ?.desktop?.orgId ?? "",
          ],
          errorRevision: 0,
        });
        return (
          !this.stopped &&
          recheck.state.reason === "quota-exhausted" &&
          recheck.state.sourceId === sourceId &&
          recheck.state.targetId === targetId &&
          JSON.stringify(recheck.exhausted) === JSON.stringify(episodes) &&
          selectedIdentity() === identityAtDispatch &&
          plannedHistoryScope() === historyScopeAtDispatch &&
          !this.episodeState(recheck)
        );
      };
      this.publish({ ...decision.state, status: "switching" });
      try {
        const switchAccount = () =>
          this.desktop.switchTo(targetId, {
            closedOnly: true,
            expectedActiveProfileId: sourceId,
            canProceed: allowed,
          });
        if (this.dependencies.withDesktopLock)
          await this.dependencies.withDesktopLock(switchAccount);
        else await switchAccount();
        for (const episode of episodes) {
          this.completed.set(episode.key, episode.expiresAt);
          this.failures.delete(episode.key);
        }
        let ledgerSaved = true;
        try {
          this.prune(this.now());
          const completed = Object.fromEntries(
            [...this.completed.entries()]
              .sort(([, a], [, b]) => b - a)
              .slice(0, 100),
          );
          this.store.update((state) => {
            state.autoSwitchCompleted = completed;
          });
        } catch {
          // Desktop has already prepared the account. A registry failure must
          // not turn that completed operation into a retryable Desktop failure.
          ledgerSaved = false;
        }
        this.lastSuccess = {
          ...decision.state,
          status: "switched",
          reason: ledgerSaved ? "prepared" : "ledger-unavailable",
          switchedAt: new Date(this.now()).toISOString(),
        };
        this.publish(this.lastSuccess);
      } catch {
        if (this.stopped) return;
        if (this.store.state.settings.autoSwitchMode !== "after-exit") {
          this.publish({
            status: "off",
            reason: "disabled",
            checkedAt: new Date(this.now()).toISOString(),
          });
          return;
        }
        const attempts =
          1 +
          Math.max(
            0,
            ...episodes.map(
              (episode) => this.failures.get(episode.key)?.attempts ?? 0,
            ),
          );
        const retryAt = this.now() + RETRY_DELAY;
        for (const episode of episodes)
          this.failures.set(episode.key, {
            expiresAt: episode.expiresAt,
            attempts,
            retryAt,
          });
        this.publish({
          ...decision.state,
          status: "blocked",
          reason: "switch-failed",
          retryAt:
            attempts < MAX_ATTEMPTS
              ? new Date(retryAt).toISOString()
              : undefined,
        });
      }
    } catch {
      // A failed snapshot is not proof that the application has exited.
      this.closedSince = undefined;
      this.publish({
        status: "blocked",
        reason: "desktop-unavailable",
        checkedAt: new Date(this.now()).toISOString(),
      });
    } finally {
      this.evaluating = false;
    }
  }
}
