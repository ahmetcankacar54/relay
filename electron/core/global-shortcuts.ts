import type {
  Account,
  AccountUsage,
  RelaySettings,
  ShortcutAction,
  ShortcutSettings,
  ShortcutState,
} from "../../shared/types";
import {
  SHORTCUT_ACTIONS,
  normalizeAccelerator,
  shortcutFor,
} from "../../shared/shortcuts";
import { suggestedAccount } from "../../shared/usage";
import { desktopCliMismatch } from "../../shared/account-state";
import { overviewAccounts } from "../../src/data/selectors";

/** The part of Electron's `globalShortcut` Relay uses; tests pass a fake. */
export interface ShortcutHost {
  /** False when another app holds the keys. */
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

export type ShortcutStatus = Record<ShortcutAction, ShortcutState>;

/**
 * Relay's global shortcuts: registered from the settings at start and after every change, so a
 * key another app holds is reported ("taken") next to its field instead of failing. Applying
 * again retries a taken key, which may have been freed since. While Settings records a new key
 * they are paused, so pressing the key already registered is recorded instead of acting.
 */
export class GlobalShortcuts {
  private registered = new Map<ShortcutAction, string>();
  private states: ShortcutStatus = {
    openPanel: "off",
    switchToSuggested: "off",
  };
  private choice: ShortcutSettings | undefined;
  private paused = false;
  constructor(
    private readonly host: ShortcutHost,
    private readonly handlers: Record<ShortcutAction, () => void>,
    private readonly log?: (
      event: string,
      fields: Record<string, unknown>,
    ) => void,
  ) {}

  /**
   * Registers the chosen keys and drops the ones no longer chosen; resolves with each state.
   * While paused the choice is only kept, and registered on resume.
   */
  apply(choice: ShortcutSettings | undefined): ShortcutStatus {
    this.choice = choice;
    if (this.paused) return this.status();
    const wanted = new Map<ShortcutAction, string>();
    for (const action of SHORTCUT_ACTIONS) {
      const accelerator = normalizeAccelerator(shortcutFor(choice, action));
      if (accelerator) wanted.set(action, accelerator);
    }
    // Every key that changes is let go first, so two actions can trade keys in one change.
    for (const [action, accelerator] of [...this.registered]) {
      if (wanted.get(action) === accelerator) continue;
      this.release(accelerator);
      this.registered.delete(action);
    }
    const used = new Set(this.registered.values());
    const states = {} as ShortcutStatus;
    for (const action of SHORTCUT_ACTIONS) {
      const accelerator = wanted.get(action);
      if (!accelerator) states[action] = "off";
      else if (this.registered.get(action) === accelerator)
        states[action] = "on";
      else if (used.has(accelerator)) states[action] = "taken";
      else if (this.take(action, accelerator)) {
        this.registered.set(action, accelerator);
        used.add(accelerator);
        states[action] = "on";
      } else states[action] = "taken";
    }
    this.states = states;
    return this.status();
  }

  status(): ShortcutStatus {
    return { ...this.states };
  }

  /** Lets every key go until resume; the states stay as they were, for Settings. */
  pause() {
    if (this.paused) return;
    this.paused = true;
    for (const accelerator of this.registered.values())
      this.release(accelerator);
    this.registered.clear();
  }

  /** Registers the latest choice again after pause. */
  resume(): ShortcutStatus {
    if (!this.paused) return this.status();
    this.paused = false;
    return this.apply(this.choice);
  }

  /** Lets every key go: Relay is quitting. */
  dispose() {
    this.paused = false;
    for (const accelerator of this.registered.values())
      this.release(accelerator);
    this.registered.clear();
    this.states = { openPanel: "off", switchToSuggested: "off" };
  }

  private take(action: ShortcutAction, accelerator: string) {
    try {
      return this.host.register(accelerator, () => {
        try {
          this.handlers[action]();
        } catch (error) {
          this.log?.("shortcut-failed", {
            action,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    } catch (error) {
      // Electron throws for keys this platform cannot register; it reads as unavailable.
      this.log?.("shortcut-register-failed", {
        action,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private release(accelerator: string) {
    try {
      this.host.unregister(accelerator);
    } catch {
      // A key that is already gone needs nothing.
    }
  }
}

/**
 * The account "switch to the suggested account" offers: the panel's badge. That is the account
 * suggested once the active one passes the warning threshold (suggestedAccount), else the top
 * of the panel's ranking that can be switched to now; never one open in its own Claude window,
 * nor one whose Claude app and usage sign-ins disagree (the widget's Geç rule).
 */
export function shortcutSwitchTarget(input: {
  activeId?: string;
  accounts: Account[];
  usage: Record<string, AccountUsage>;
  settings: RelaySettings;
  now: number;
  rate?: number;
  inWindows: ReadonlySet<string>;
}): Account | undefined {
  const { accounts, usage, settings, now, rate, inWindows } = input;
  const active = accounts.find((a) => a.id === input.activeId);
  const switchable = (a: Account) =>
    a.id !== active?.id &&
    (a.provider ?? "claude") === "claude" &&
    !inWindows.has(a.id) &&
    !!a.desktop?.accountUuid &&
    !!a.desktop.orgId &&
    !desktopCliMismatch(a);
  const candidates = accounts.filter(
    (a) => a.id === active?.id || switchable(a),
  );
  const suggestion = suggestedAccount(
    active,
    candidates,
    usage,
    settings,
    now,
    rate,
  );
  if (suggestion) return suggestion;
  return overviewAccounts(
    active,
    candidates,
    usage,
    now,
    rate,
    inWindows,
    settings.autoSwitchStrategy,
  ).find((row) => row.recommended && switchable(row.account))?.account;
}
