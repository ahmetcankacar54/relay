import { Check, Hand, Power, Zap, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Banner } from "@/components/Banner";
import { Note } from "@/components/SettingRow";
import { StatusDot } from "@/components/StatusDot";
import { useI18n, type MessageId } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import {
  AUTOMATION_MODES,
  type AutomationMode,
} from "../../shared/automation-mode";
import {
  switchNowLabel,
  type AutomationStatus,
} from "../../shared/automation-status";
import { desktopCliMismatch } from "../../shared/account-state";
import { rankContinuationTargets } from "../../shared/continuation-target-ranking";
import { allowedHistoryPair } from "../../shared/history-policy";
import { freshUsage, quotaWindows } from "../../shared/usage";
import type { Account, AccountUsage, RelaySettings } from "../../shared/types";
import {
  AUTOMATION_DOT,
  automationModeCopy,
  useAutomation,
} from "./useAutomation";

/** "Şimdi <hesap>’e geç": opens the confirmed switch review for the target. */
export function SwitchNowButton({
  status,
  size,
}: {
  status: AutomationStatus;
  size: "xs" | "sm";
}) {
  const relay = useRelay();
  const { t } = useI18n();
  const target = relay.accounts.find((a) => a.id === status.switchTo);
  if (!target) return null;
  return (
    <Button
      type="button"
      variant="outline"
      size={size}
      className="shrink-0"
      disabled={
        relay.desktopBusy ||
        !!relay.pendingDesktop ||
        !!relay.desktop?.recoveryRequired
      }
      onClick={() => relay.requestDesktop(target, "switch")}
    >
      {switchNowLabel(target.name, t)}
    </Button>
  );
}

/**
 * The status sentence with its "<account> %n kullanıldı · " prefix outside the live
 * region, so a usage refresh alone is not announced again.
 */
function StatusText({ status }: { status: AutomationStatus }) {
  return (
    <>
      {status.prefix}
      <span role="status" aria-live="polite">
        {status.text.slice(status.prefix.length)}
      </span>
    </>
  );
}

/** What automatic switching is doing, in one sentence, with switch-now when offered. */
export function AutomationStatusLine({
  status,
  compact,
}: {
  status: AutomationStatus;
  /** Overview: smaller text that wraps, no box. */
  compact?: boolean;
}) {
  return (
    <div
      className={
        compact
          ? "flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
          : "flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-sm"
      }
    >
      <p className="flex min-w-0 flex-1 basis-48 items-start gap-2">
        <StatusDot
          tone={AUTOMATION_DOT[status.tone]}
          className={compact ? "mt-1" : "mt-1.5"}
        />
        <span>
          <StatusText status={status} />
        </span>
      </p>
      {status.switchTo && (
        <SwitchNowButton status={status} size={compact ? "xs" : "sm"} />
      )}
    </div>
  );
}

/** What a chip says beside an account's name; none for an account that is simply eligible. */
export type AfterExitChipState = "open" | "next" | "stale" | "sign-in";

/**
 * The accounts for "Claude uygulamasını kapatınca", as chips: whether each is selected, and where it stands.
 * "next" is the account the next switch goes to: the one Relay's watch has picked, else the one
 * it would pick now among the selected (fresh, under 90% in every window, history allowed),
 * ranked as automatic switching ranks them. "stale" is a reading too old to choose by.
 */
export function afterExitChips({
  accounts,
  settings,
  usage,
  activeId,
  targetId,
  now,
}: {
  accounts: Account[];
  settings: RelaySettings;
  usage: Record<string, AccountUsage>;
  activeId?: string;
  targetId?: string;
  now: number;
}): { account: Account; selected: boolean; state?: AfterExitChipState }[] {
  const selected = settings.autoSwitchAccounts;
  const source = accounts.find((a) => a.id === activeId);
  const ready = (a: Account) => !!a.desktop && !desktopCliMismatch(a);
  const usable = (a: Account) => {
    const windows = quotaWindows(usage[a.id]);
    return (
      a.id !== activeId &&
      selected.includes(a.id) &&
      ready(a) &&
      freshUsage(usage[a.id], now) &&
      (!a.cooldownUntil || Date.parse(a.cooldownUntil) <= now) &&
      (!source || allowedHistoryPair(source, a, settings)) &&
      !!windows?.every((w) => w.usedPercent < 90)
    );
  };
  const next =
    (targetId !== activeId && accounts.find((a) => a.id === targetId)?.id) ||
    rankContinuationTargets(
      accounts.filter(usable).map((account) => ({ account, usage: usage[account.id] })),
      { now },
    )[0]?.account.id;
  return accounts.map((account) => ({
    account,
    selected: selected.includes(account.id),
    state:
      account.id === activeId
        ? "open"
        : !ready(account)
          ? "sign-in"
          : account.id === next
            ? "next"
            : !freshUsage(usage[account.id], now)
              ? "stale"
              : undefined,
  }));
}

const CHIP_STATE: Record<AfterExitChipState, MessageId> = {
  open: "automationControl.openNow",
  next: "automationControl.next",
  stale: "automationControl.usageDataIsOutOfDate",
  "sign-in": "switchPreferences.claudeAppSignInNeeded",
};

/** The always-visible account chips for "Claude uygulamasını kapatınca": a press selects or drops one. */
function AfterExitAccounts({ disabled }: { disabled: boolean }) {
  const relay = useRelay();
  const { t } = useI18n();
  const { api, accounts, settings, action } = relay;
  const chips = afterExitChips({
    accounts,
    settings,
    usage: relay.data?.usage ?? {},
    activeId: relay.desktop?.activeProfileId,
    targetId: relay.data?.autoSwitch?.targetId,
    now: Date.now(),
  });
  const selected = settings.autoSwitchAccounts;
  const update = (ids: string[]) =>
    void action("settings", () => api.updateSettings({ autoSwitchAccounts: ids }));
  return (
    <fieldset className="grid gap-2 rounded-lg border border-border p-3 disabled:opacity-60" disabled={disabled}>
      <legend className="px-1 text-sm font-medium">
        {t("automationControl.accountsEligibleForAutomaticSwitching")}{" "}
        <span className="text-muted-foreground">
          {chips.filter((c) => c.selected).length} / {accounts.length}
        </span>
      </legend>
      <div className="flex flex-wrap gap-1.5">
        {chips.map(({ account, selected: on, state }) => (
          <button
            key={account.id}
            type="button"
            aria-pressed={on}
            onClick={() =>
              update(on ? selected.filter((id) => id !== account.id) : [...selected, account.id])
            }
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs outline-none transition-colors",
              "hover:border-foreground/20 focus-visible:ring-[3px] focus-visible:ring-ring/50",
              on ? "border-primary bg-accent/40 font-medium" : "bg-card text-muted-foreground",
            )}
          >
            {on && <Check aria-hidden="true" className="size-3.5 text-primary" />}
            <span className="max-w-40 truncate">{account.name}</span>
            {state && (
              <span
                className={cn(
                  "text-2xs font-normal",
                  state === "next" ? "text-primary" : state === "open" ? "text-muted-foreground" : "text-warn-foreground",
                )}
              >
                · {t(CHIP_STATE[state])}
              </span>
            )}
          </button>
        ))}
        {!accounts.length && <Note>{t("automationControl.addAnAccountFirst")}</Note>}
      </div>
    </fieldset>
  );
}

/** Each choice's card: an icon and a title that says who acts. */
const MODE_ICON: Record<AutomationMode, LucideIcon> = { off: Hand, "after-exit": Power, quota: Zap };
export const MODE_TITLE: Record<AutomationMode, MessageId> = {
  off: "automationControl.iSwitchMyself",
  "after-exit": "automationControl.whenIQuitTheClaudeApp",
  quota: "automationMode.whenTheLimitIsReached",
};

/** The Switching page card: one choice, what it does, and its status. */
export function AutomationSettings() {
  const relay = useRelay();
  const { t } = useI18n();
  const { mode, status, locked, supports, setMode } = useAutomation();
  const { api, settings, action } = relay;
  const disabled = !!relay.busy || !!relay.desktop?.busy;
  const fleet = relay.data?.fleet;
  return (
    <section aria-labelledby="automation-title" className="grid gap-3">
      <h2 id="automation-title" className="px-1 text-sm font-semibold">
        {t("automationControl.whenToSwitch")}
      </h2>
      <div
        role="radiogroup"
        aria-labelledby="automation-title"
        className="grid gap-3 @lg:grid-cols-3"
      >
        {AUTOMATION_MODES.map((m) => {
          const Icon = MODE_ICON[m.value];
          const checked = mode === m.value;
          const off = locked || !supports(m.value);
          return (
            <button
              key={m.value}
              type="button"
              role="radio"
              aria-checked={checked}
              disabled={off}
              onClick={() => !checked && setMode(m.value)}
              className={cn(
                "flex flex-col gap-2 rounded-lg border bg-card p-3 text-left outline-none transition-colors",
                "hover:border-foreground/20 focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50",
                checked && "border-2 border-primary bg-accent/40 p-[11px]",
              )}
            >
              <span className="flex items-center justify-between">
                <span
                  aria-hidden="true"
                  className={cn(
                    "grid size-7 place-items-center rounded-md [&_svg]:size-3.5",
                    checked ? "bg-accent text-accent-foreground" : "bg-muted text-foreground/80",
                  )}
                >
                  <Icon />
                </span>
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-4 rounded-full border-[1.5px] border-input bg-card",
                    checked && "border-[4.5px] border-primary",
                  )}
                />
              </span>
              <span className="text-sm font-semibold">{t(MODE_TITLE[m.value])}</span>
              <span className="text-xs leading-snug text-muted-foreground">
                {t(m.description)}
              </span>
            </button>
          );
        })}
      </div>
      <AutomationStatusLine status={status} />
      {!supports("after-exit") ? (
        <Note>
          {t("automationControl.automaticSwitchingIsAvailableOnlyOn")}
        </Note>
      ) : (
        !supports("quota") && (
          <Note>
            {t("automationControl.switchingAndContinuingConversationsAtThe")}
          </Note>
        )
      )}
      {mode === "after-exit" && (
        <div className="grid gap-1">
          <AfterExitAccounts disabled={disabled} />
          <Note>
            {t("automationControl.selectTheCurrentAndTargetAccounts")}
          </Note>
          {settings.usageRefreshMinutes === 0 && (
            <Note>
              {t("automationControl.forAutomaticSwitchingTurnOnRefresh")}
            </Note>
          )}
        </div>
      )}
      {mode === "quota" && (
        <div className="grid justify-items-start gap-2">
          {fleet?.reason === "accessibility-permission-required" && (
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={() =>
                void action("continuation-permission", () =>
                  api.requestDesktopAccessibility(),
                )
              }
            >
              {t("automationControl.openMacosAccessibilityPermission")}
            </Button>
          )}
          <Note>
            {t("automationControl.relayMustStayOpenRelayDoes")}
          </Note>
        </div>
      )}
    </section>
  );
}

/** The page-top line, only when automatic switching needs a look or offers a switch. */
export function AutomationBanner() {
  const { t } = useI18n();
  const { status } = useAutomation();
  if (!status.banner) return null;
  return (
    <Banner
      tone={status.tone === "attention" ? "warn" : "info"}
      action={
        status.switchTo ? (
          <SwitchNowButton status={status} size="sm" />
        ) : undefined
      }
    >
      <span>
        {`${t("automationControl.automaticSwitching")} · `}
        <StatusText status={status} />
      </span>
    </Banner>
  );
}
