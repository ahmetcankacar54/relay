import type { Account, AutoCaptureState, DesktopState } from "../../shared/types";
import { SignInNotSettled } from "./desktop-session";
import { readSignIn } from "./sign-in-wait";

export interface AutoCaptureDeps {
  snapshot(): Promise<DesktopState>;
  accounts(): readonly Account[];
  /** Saves the Claude app sign-in into the profile; quits and reopens Claude. */
  capture(accountId: string, orgId: string): Promise<void>;
  /** Something the main window shows changed. */
  changed(): void;
  now(): number;
}

/** How long Relay waits for the sign-in before it gives up; the sign-in itself stays pending. */
export const AUTO_CAPTURE_LIMIT_MS = 30 * 60_000;

/**
 * Saves a Claude app sign-in by itself once it is complete, so adding an account needs one
 * confirmation at the start instead of a second "Save sign-in": the user signs in to the Claude
 * app and opens Code, and the next tick captures it (Claude restarts once more, as the first
 * confirmation said). With several Code workspaces it saves the one the Claude app is in, and
 * waits for the user to pick one only when nothing says which that is. Armed for
 * one profile at a time, in memory: after a Relay restart the pending sign-in is saved by hand.
 */
export class AutoCapture {
  private current?: AutoCaptureState & { since: number };
  private running = false;
  constructor(private deps: AutoCaptureDeps) {}

  state(): AutoCaptureState | undefined {
    if (!this.current) return undefined;
    const { since: _since, ...state } = this.current;
    return state;
  }

  arm(accountId: string) {
    this.current = { accountId, status: "waiting", since: this.deps.now() };
    this.deps.changed();
  }

  disarm(accountId?: string) {
    if (accountId && this.current?.accountId !== accountId) return;
    this.current = undefined;
    this.deps.changed();
  }

  /** The user picked the workspace of a sign-in that has several. */
  async choose(accountId: string, orgId: string) {
    if (this.current?.accountId !== accountId || this.current.status !== "choose-org") return;
    if (!this.current.orgs?.includes(orgId)) throw new Error("Unknown workspace.");
    await this.save(accountId, orgId);
  }

  /** One look; safe to call on a timer, never overlaps itself. */
  async tick() {
    const armed = this.current;
    if (!armed || this.running || armed.status === "saving") return;
    if (armed.status === "saved" || armed.status === "failed") return;
    if (this.deps.now() - armed.since > AUTO_CAPTURE_LIMIT_MS) {
      this.set({ status: "failed", error: "timeout" });
      return;
    }
    this.running = true;
    try {
      const reading = readSignIn(await this.deps.snapshot(), this.deps.accounts(), armed.accountId);
      if (this.current !== armed) return;
      switch (reading.kind) {
        case "other-pending":
          this.set({ status: "failed", error: "other-pending" });
          return;
        case "done":
          this.set({ status: "saved" });
          return;
        case "saved-elsewhere":
          if (armed.alreadySaved !== reading.account.name)
            this.set({ status: "waiting", alreadySaved: reading.account.name });
          return;
        case "waiting":
          if (armed.alreadySaved) this.set({ status: "waiting", alreadySaved: undefined });
          return;
        case "ready":
          // Several workspaces: the one the Claude app is in is saved without asking; a blind
          // choice binds the profile to a workspace its usage sign-in can never match.
          if (reading.orgs.length > 1 && !reading.preferred) {
            if (armed.status !== "choose-org" || armed.suggestedOrg !== reading.suggested)
              this.set({
                status: "choose-org",
                orgs: reading.orgs,
                suggestedOrg: reading.suggested,
                alreadySaved: undefined,
              });
            return;
          }
          await this.save(armed.accountId, reading.preferred ?? reading.orgs[0]);
      }
    } catch {
      // A reading that failed is tried again at the next tick.
    } finally {
      this.running = false;
    }
  }

  private async save(accountId: string, orgId: string) {
    this.set({ status: "saving", alreadySaved: undefined });
    try {
      await this.deps.capture(accountId, orgId);
      if (this.current?.accountId === accountId)
        this.set({ status: "saved", orgs: undefined, suggestedOrg: undefined });
    } catch (error) {
      // The sign-in is not in Claude's cookie file yet; nothing was quit. The next tick saves it.
      if (error instanceof SignInNotSettled) {
        if (this.current?.accountId === accountId) this.set({ status: "waiting" });
        return;
      }
      if (this.current?.accountId === accountId)
        this.set({ status: "failed", error: error instanceof Error ? error.message : String(error) });
    }
  }

  private set(patch: Partial<AutoCaptureState>) {
    if (!this.current) return;
    this.current = { ...this.current, ...patch };
    for (const key of Object.keys(this.current) as (keyof AutoCaptureState)[])
      if (this.current[key] === undefined) delete this.current[key];
    this.deps.changed();
  }
}
