import { useEffect, useId, useState } from "react";
import { Check, Monitor, X } from "lucide-react";
import type { Account, AccountUsage } from "../../shared/types";
import {
  cliNeedsReconnect,
  desktopCliMismatch,
  readsThroughApp,
} from "../../shared/account-state";
import { Button } from "@/components/ui/button";
import { Banner } from "@/components/Banner";
import {
  dismissalKey,
  pruneDismissals,
  useDismissals,
} from "@/data/dismissals";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { keychainWords } from "@/data/platform";
import { pendingFlow } from "@/data/selectors";
import { displayedIssue, isClaudeAccount, renewalIssue } from "@/lib/account-health";
import { AutomationBanner } from "../features/AutomationControl";
import { RelayErrorAlert } from "./RelayErrorAlert";
import type { T } from "../../shared/i18n/translate";

export interface ReconnectIssue {
  account: Account;
  issue: string;
  /** `login` needs a new browser sign-in; `renew` re-reads the saved one (may prompt). */
  action: "login" | "renew";
}

const NONE: ReadonlySet<string> = new Set();
const issueKey = (i: ReconnectIssue) => dismissalKey(i.account.id, i.issue);

/**
 * Signed-in accounts whose usage sign-in needs attention, minus the ones the
 * user dismissed (keyed `accountId:issue`, see `dismissalKey`). It reads the
 * issue as the status and UsageCard do (`displayedIssue`, `renewalIssue`).
 * A usage sign-in of another account than the Claude app sign-in reads the wrong
 * limits, so it needs a new sign-in whatever the last read said: it gets a
 * `login` warning of its own (`identity-mismatch`) unless the read reported a
 * sign-in problem already, and it outranks a renewal, which cannot fix it.
 */
export function reconnectIssues(
  accounts: Account[],
  usage: Record<string, AccountUsage | undefined>,
  dismissed: ReadonlySet<string>,
): ReconnectIssue[] {
  const result: ReconnectIssue[] = [];
  for (const account of accounts) {
    // Only a Claude account has a Claude Code sign-in to renew; the others' buttons would open it.
    if (!isClaudeAccount(account)) continue;
    const u = usage[account.id];
    if (!account.auth?.loggedIn) {
      // Read through the Claude app's sign-in, only the Keychain can need the user here.
      if (
        readsThroughApp(account, u) &&
        renewalIssue(u) === "keychain-locked" &&
        !dismissed.has(dismissalKey(account.id, "keychain-locked"))
      )
        result.push({ account, issue: "keychain-locked", action: "renew" });
      continue;
    }
    const reported = cliNeedsReconnect(account, u);
    const mismatch = !reported && desktopCliMismatch(account);
    const issue = mismatch
      ? "identity-mismatch"
      : (displayedIssue(u) ?? (u?.cliSignInEnded ? "expired" : ""));
    const action =
      reported || mismatch
        ? "login"
        : renewalIssue(u)
          ? "renew"
          : undefined;
    if (!action || dismissed.has(dismissalKey(account.id, issue))) continue;
    result.push({ account, issue, action });
  }
  return result;
}

/**
 * Why an account's CLI sign-in cannot be used, in a few words for the sign-in
 * banner. The first matching row wins; a sign-in of another account than the
 * Claude app's is named even when the read reported nothing; anything else
 * unlisted is a lost connection.
 */
export function reconnectCause(
  account: Account,
  usage: AccountUsage | undefined,
  t: T,
): string {
  if (!account.auth?.loggedIn) return t("banners.notSignedIn");
  const another = () =>
    t("banners.theSignInBelongsToAnother");
  switch (usage?.issue ?? (usage?.cliSignInEnded ? "expired" : undefined)) {
    case "expired":
      return t("banners.theSignInExpired");
    case "credentials-missing":
      return t("banners.theSavedSignInIsMissing");
    case "scope":
      return t("banners.theSignInCannotReadUsage");
    case "identity-mismatch":
      return another();
    default:
      return desktopCliMismatch(account)
        ? another()
        : t("banners.theConnectionIsUnavailable");
  }
}

export function Banners({
  automation = true,
  initialExpanded = false,
  exceptAccount,
}: {
  /** An account whose own page shows its sign-in problem next to its row: no banner repeats it. */
  exceptAccount?: string;
  /** False on pages that show the automation status inline. */
  automation?: boolean;
  /** Whether the grouped sign-in warning starts open. For tests. */
  initialExpanded?: boolean;
}) {
  const relay = useRelay();
  const { t } = useI18n();
  const keychain = keychainWords(relay.data?.diagnostics?.platform, t);
  const { desktop, notice, accounts, active } = relay;
  const { dismissed, dismiss, dismissMany } = useDismissals();
  const [expanded, setExpanded] = useState(initialExpanded);
  const listId = useId();
  const usage = relay.data?.usage ?? {};
  const reconnect = reconnectIssues(accounts, usage, dismissed).filter(
    (issue) => issue.account.id !== exceptAccount,
  );
  // Every current issue, dismissed or not: a dismissal lives while its issue does.
  const currentKeys = reconnectIssues(accounts, usage, NONE).map(issueKey);
  // Accounts whose usage was not read yet: right after a launch the cache is empty, so
  // each logged-in account is idle with no issue. Their dismissals must outlive that, and
  // a read the service turned away for now (down or rate-limited) tells no more.
  const unread = accounts
    .filter((a) => {
      const u = usage[a.id];
      if (!a.auth?.loggedIn && !readsThroughApp(a, u)) return false;
      if (u?.issue === "unavailable" || u?.issue === "rate-limited")
        return true;
      return !u?.issue && (!u || u.status === "idle" || u.status === "loading");
    })
    .map((a) => a.id);
  const signature = JSON.stringify([currentKeys, unread]);
  const loaded = relay.data !== undefined;
  useEffect(() => {
    // Before the first snapshot no issue is known, so everything would look gone.
    // `currentKeys` and `unread` are the lists `signature` was made from.
    if (loaded) pruneDismissals(currentKeys, unread);
  }, [loaded, signature]);

  // The same check the accounts table makes: a browser approval of this account is in progress.
  const waiting = (a: Account) =>
    pendingFlow(relay.data?.authFlows.find((f) => f.accountId === a.id));
  const explanation = (
    <p className="mt-0.5 text-xs text-muted-foreground">
      {t("banners.approveTheSignInThatOpens")}
    </p>
  );
  /** A warning's button. In the group, `named` adds the account to its name, after the visible label. */
  const issueAction = (
    { account: a, issue, action }: ReconnectIssue,
    named = false,
  ) => {
    const label =
      action === "login"
        ? t("common.renewUsageSignIn")
        : issue === "keychain-locked"
          ? keychain.allow
          : t("common.allowRenewal");
    return action === "login" ? (
      <Button
        size="sm"
        variant="outline"
        aria-label={named ? `${label} · ${a.name}` : undefined}
        disabled={!!relay.busy || waiting(a)}
        onClick={() => void relay.startCli(a)}
      >
        {label}
      </Button>
    ) : (
      <Button
        size="sm"
        variant="outline"
        aria-label={named ? `${label} · ${a.name}` : undefined}
        disabled={relay.usageBusy.has(a.id)}
        onClick={() => void relay.refreshUsage(a, true)}
      >
        {label}
      </Button>
    );
  };
  /** A warning's text. The group explains the renewal once, under its list, so its rows leave it out. */
  const issueText = (
    { account: a, issue, action }: ReconnectIssue,
    explain = true,
  ) => {
    if (action === "login") {
      const cause = reconnectCause(a, relay.data?.usage?.[a.id], t);
      return (
        <div className="min-w-0">
          <span>
            {waiting(a)
              ? t("banners.browserApprovalPending", { aName: a.name })
              : t("banners.theUsageSignInNeedsRenewal", { aName: a.name, cause })}
          </span>
          {explain && explanation}
        </div>
      );
    }
    return (
      <span>
        {issue === "keychain-locked"
          ? keychain.neededFor(a.name)
          : t("banners.theUsageSignInNeedsRenewal2", { aName: a.name })}
      </span>
    );
  };
  return (
    <div className="flex flex-col gap-2 px-5 pb-3 empty:hidden">
      {/* `?screenshot` (development only) leaves it out of the README's screenshots. */}
      {relay.preview && !(import.meta.env.DEV && new URLSearchParams(location.search).has("screenshot")) && (
        <Banner tone="info">
          <Monitor className="size-4 shrink-0" aria-hidden />
          <span>
            {t("banners.browserPreviewSampleAccountsSwitchesWork")}
          </span>
        </Banner>
      )}
      <RelayErrorAlert />
      {notice && (
        <Banner
          tone="info"
          role="status"
          onDismiss={() => relay.setNotice("")}
          dismissLabel={t("banners.dismissNotification")}
        >
          <Check className="size-4 shrink-0 text-ok" aria-hidden />
          <span>{notice}</span>
        </Banner>
      )}
      {automation && <AutomationBanner />}
      {desktop?.recoveryRequired && (
        <Banner
          tone="error"
          action={
            <Button
              size="sm"
              variant="outline"
              disabled={relay.desktopBusy}
              onClick={() => relay.requestDesktop(active, "recover")}
            >
              {t("banners.restoreBackup")}
            </Button>
          }
        >
          <span>
            {t("banners.aSwitchDidNotFinishRestore")}
          </span>
        </Banner>
      )}
      {reconnect.length === 1 && (
        <Banner
          key={issueKey(reconnect[0])}
          tone="warn"
          onDismiss={() => dismiss(issueKey(reconnect[0]))}
          dismissLabel={t("banners.dismissWarning")}
          action={issueAction(reconnect[0])}
        >
          {issueText(reconnect[0])}
        </Banner>
      )}
      {reconnect.length >= 2 && (
        <Banner
          tone="warn"
          onDismiss={() => dismissMany(reconnect.map(issueKey))}
          dismissLabel={t("banners.dismissAllWarnings")}
          action={
            <Button
              size="sm"
              variant="outline"
              aria-expanded={expanded}
              aria-controls={listId}
              onClick={() => setExpanded((open) => !open)}
            >
              {expanded ? t("common.hide") : t("common.show")}
            </Button>
          }
          detail={
            expanded ? (
              <>
                <ul
                  id={listId}
                  className="flex flex-col gap-1.5 border-t border-warn/20 pt-2"
                >
                  {reconnect.map((item) => {
                    const key = issueKey(item);
                    return (
                      <li
                        key={key}
                        className="flex items-center justify-between gap-3"
                      >
                        <div className="min-w-0">{issueText(item, false)}</div>
                        <div className="flex shrink-0 items-center gap-1">
                          {issueAction(item, true)}
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label={t("banners.dismissWarningFor", { accountName: item.account.name })}
                            onClick={() => dismiss(key)}
                          >
                            <X />
                          </Button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
                {reconnect.some((item) => item.action === "login") &&
                  explanation}
              </>
            ) : null
          }
        >
          <span>
            {t("banners.usageSignInsNeedAttention", { reconnectLength: reconnect.length })}
          </span>
        </Banner>
      )}
    </div>
  );
}
