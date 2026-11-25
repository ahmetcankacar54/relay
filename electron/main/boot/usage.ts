/** The first Desktop reading, the usage history and tempo, and the limit reads with their sign-in renewal. */
import { app } from "electron";
import path from "node:path";
import { readsUsage } from "../../../shared/cli-version";
import { ActiveAccountTimeline } from "../../core/active-account-timeline";
import { AutoCapture } from "../../core/auto-capture";
import { linuxKeyringReachable } from "../../core/linux-safe-storage";
import { acquireProfileLock } from "../../core/profile-lock";
import { readCodexCredential } from "../../core/provider-credentials";
import { readAntigravityTier, readAntigravityUsage, readCodexUsage } from "../../core/provider-usage";
import { TempoTracker } from "../../core/tempo-tracker";
import { UsageManager } from "../../core/usage";
import { readCredential, UsageError, type UsageCredential } from "../../core/usage-credentials";
import { UsageHistory } from "../../core/usage-history";
import { appendUsageIssue } from "../../core/usage-issue-log";
import { anthropicUnreachable, UsageCredentialRefresher } from "../../core/usage-refresh";
import { antigravityBridge, antigravityTierReads } from "../antigravity";
import { desktopLock, manualDesktopLock, profileLocks } from "../desktop-lock";
import { desktopUsageSource } from "../desktop-usage";
import { limitNotices } from "../notifications";
import {
  activeTimeline,
  autoCapture,
  desktop,
  service,
  set,
  tempo,
  usageCredentialRefresher,
  usageHistory,
} from "../state";
import { scheduleStatusline } from "../statusline";
import { broadcastChanged } from "../windows";
import type { BootVault } from "./vault";

/** What the later steps take from the usage step. */
export interface UsageBoot {
  /** The tempo now for the switch rule; undefined when it cannot be read. */
  currentTempoRate: () => number | undefined;
  /** Reads a profile's Claude Code sign-in. */
  readUsageCredential: (profile: string, allowPrompt: boolean) => Promise<UsageCredential>;
}
export async function bootUsage(vault: BootVault): Promise<UsageBoot> {
      // Which account was open when, from every fresh Desktop reading, set before the first one.
      set.activeTimeline(new ActiveAccountTimeline(
        path.join(app.getPath("userData"), "active-account-timeline.json"),
      ));
      desktop.onState = (state) => activeTimeline.observe(state);
      await desktop.initialize();
      set.autoCapture(new AutoCapture({
        snapshot: () => desktop.snapshot(),
        accounts: () => service.store.state.accounts,
        capture: (accountId, orgId) =>
          manualDesktopLock(() => desktop.capture(accountId, orgId)),
        changed: broadcastChanged,
        now: Date.now,
      }));
      // Reads Claude only while armed.
      setInterval(() => void autoCapture?.tick(), 2_000).unref();
      if (vault.error) desktop.reportVaultError(vault.error);
      set.usageHistory(new UsageHistory(app.getPath("userData")));
      set.tempo(new TempoTracker({
        available: () => usageHistory.rollupsAvailable,
        rollups: () => usageHistory.rollups(),
        accounts: () => service.store.state.accounts,
        settings: () => service.store.state.settings.planning,
      }));
      /** The tempo now for the switch rule; a failure falls back to its 10% threshold. */
      const currentTempoRate = () => {
        try {
          return tempo.rateAt();
        } catch {
          return undefined;
        }
      };
      const readUsageCredential = (profile: string, allowPrompt: boolean) =>
        readCredential(profile, allowPrompt);
      set.usageCredentialRefresher(new UsageCredentialRefresher({
        read: readUsageCredential,
        // A renewal that fell on a dropped network waits two minutes, not a new sign-in.
        unreachable: () => anthropicUnreachable(),
        profileLock: (accountId) =>
          acquireProfileLock(profileLocks(), accountId, "exclusive"),
        executable: async () => {
          const { diagnostics } = await service.panelSnapshot();
          if (!diagnostics.executable || diagnostics.error)
            throw new UsageError("unavailable");
          if (!readsUsage(diagnostics.version ?? ""))
            throw new UsageError("unavailable");
          return diagnostics.executable;
        },
        canProceed: (account, profile) => {
          const current = service.store.state.accounts.find(
            (item) => item.id === account.id,
          );
          return (
            !desktopLock.active &&
            !service.auth.active(account.id) &&
            !service.runner
              .list()
              .some(
                (run) =>
                  run.accountId === account.id && run.status === "running",
              ) &&
            !!current?.auth?.loggedIn &&
            current.auth.accountUuid === account.auth?.accountUuid &&
            current.auth.orgId === account.auth?.orgId &&
            service.store.profile(account.id) === profile
          );
        },
      }));
      set.usage(new UsageManager(
        service.store,
        readUsageCredential,
        undefined,
        undefined,
        (account, value) => {
          // The notice first: a failed history write must not hold it back.
          limitNotices.observe(account, value);
          usageHistory.record(account, value);
          scheduleStatusline();
        },
        (account, credential, force, allowInteraction) =>
          service.transaction(() =>
            usageCredentialRefresher.refresh(
              account,
              service.store.profile(account.id),
              credential,
              force,
              allowInteraction,
            ),
          ),
        (account) =>
          usageCredentialRefresher.hasPending(
            service.store.profile(account.id),
          ),
        // A short private log, so the cause of a sign-in warning can be found later.
        (account, issue, detail) =>
          appendUsageIssue(
            path.join(app.getPath("userData"), "usage-issues.json"),
            { accountId: account.id, issue, detail },
            Date.now(),
          ),
        // Without a Claude Code sign-in, the Claude app's own sign-in reads the limits (macOS, and
        // Linux where the desktop's keyring can be read).
        process.platform === "darwin" || (process.platform === "linux" && linuxKeyringReachable())
          ? desktopUsageSource(vault.sealer)
          : undefined,
        // Codex through its ChatGPT sign-in, Antigravity through its CLIProxyAPI sidecar.
        async (account) => {
          if (account.provider === "codex")
            return readCodexUsage(await readCodexCredential(service.store.profile(account.id)));
          if (account.provider === "antigravity") {
            const bridge = antigravityBridge(account.id);
            if (!(await bridge.hasCredential()))
              throw new UsageError("expired", undefined, "antigravity: no saved Google sign-in");
            const call = (request: { url: string; body: string; userAgent?: string }) => bridge.googleCall(request);
            const project = await bridge.projectId();
            const result = await readAntigravityUsage(call, project);
            // The Google plan (AI Pro, Ultra, free) changes rarely: read with the limits at most
            // every six hours, and kept when a read fails.
            const tierAt = antigravityTierReads.get(account.id) ?? 0;
            if (Date.now() - tierAt > 6 * 3_600_000 || !account.auth?.subscription || /oauth/i.test(account.auth.subscription)) {
              antigravityTierReads.set(account.id, Date.now());
              const plan = await readAntigravityTier(call, project);
              if (plan) return { ...result, plan };
            }
            return result;
          }
          throw new UsageError("unsupported", undefined, "provider quota endpoint unavailable");
        },
      ));
      return { currentTempoRate, readUsageCredential };
}
