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
import { pendingFlow } from "@/data/selectors";
import { displayedIssue, renewalIssue } from "@/lib/account-health";
import { AutomationBanner } from "../features/AutomationControl";
import { RelayErrorAlert } from "./RelayErrorAlert";
import { UpdateBanner } from "./UpdateBanner";

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
    const issue = mismatch ? "identity-mismatch" : (displayedIssue(u) ?? "");
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
  t: (tr: string, en: string) => string,
): string {
  if (!account.auth?.loggedIn) return t("giriş yapılmamış", "not signed in");
  const another = () =>
    t("giriş başka bir hesaba ait", "the sign-in belongs to another account");
  switch (usage?.issue) {
    case "expired":
      return t("girişin süresi doldu", "the sign-in expired");
    case "credentials-missing":
      return t("kayıtlı giriş bulunamadı", "the saved sign-in is missing");
    case "scope":
      return t(
        "giriş kullanım verisine erişemiyor",
        "the sign-in cannot read usage",
      );
    case "identity-mismatch":
      return another();
    default:
      return desktopCliMismatch(account)
        ? another()
        : t("bağlantı kullanılamıyor", "the connection is unavailable");
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
      {t(
        "Tarayıcıda açılan girişi onayla.",
        "Approve the sign-in that opens in the browser.",
      )}
    </p>
  );
  /** A warning's button. In the group, `named` adds the account to its name, after the visible label. */
  const issueAction = (
    { account: a, issue, action }: ReconnectIssue,
    named = false,
  ) => {
    const label =
      action === "login"
        ? t("Limit okuma girişini yenile", "Renew usage sign-in")
        : issue === "keychain-locked"
          ? t("Anahtarlık erişimine izin ver", "Allow Keychain access")
          : t("Yenilemeye izin ver", "Allow renewal");
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
              ? t(
                  `${a.name} · tarayıcı onayı bekleniyor.`,
                  `${a.name} · browser approval pending.`,
                )
              : t(
                  `${a.name} · limit okuma girişinin yenilenmesi gerekiyor: ${cause}.`,
                  `${a.name} · the usage sign-in needs renewal: ${cause}.`,
                )}
          </span>
          {explain && explanation}
        </div>
      );
    }
    return (
      <span>
        {issue === "keychain-locked"
          ? t(
              `${a.name} · limitleri okumak için Anahtarlık erişimi gerekiyor.`,
              `${a.name} · Relay needs Keychain access to read the limits.`,
            )
          : t(
              `${a.name} · limit okuma girişinin yenilenmesi gerekiyor.`,
              `${a.name} · the usage sign-in needs renewal.`,
            )}
      </span>
    );
  };
  return (
    <div className="flex flex-col gap-2 px-5 pb-3 empty:hidden">
      {relay.preview && (
        <Banner tone="info">
          <Monitor className="size-4 shrink-0" aria-hidden />
          <span>
            {t(
              "Tarayıcı önizlemesi · Hesaplar örnektir. Geçişler Relay uygulamasında çalışır.",
              "Browser preview · Sample accounts. Switches work in the Relay app.",
            )}
          </span>
        </Banner>
      )}
      <RelayErrorAlert />
      <UpdateBanner />
      {notice && (
        <Banner
          tone="info"
          role="status"
          onDismiss={() => relay.setNotice("")}
          dismissLabel={t("Bildirimi kapat", "Dismiss notification")}
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
              {t("Yedeği geri yükle", "Restore backup")}
            </Button>
          }
        >
          <span>
            {t(
              "Yarım kalan bir geçiş var. Önce yedeği geri yükle.",
              "A switch did not finish. Restore the backup first.",
            )}
          </span>
        </Banner>
      )}
      {reconnect.length === 1 && (
        <Banner
          key={issueKey(reconnect[0])}
          tone="warn"
          onDismiss={() => dismiss(issueKey(reconnect[0]))}
          dismissLabel={t("Uyarıyı kapat", "Dismiss warning")}
          action={issueAction(reconnect[0])}
        >
          {issueText(reconnect[0])}
        </Banner>
      )}
      {reconnect.length >= 2 && (
        <Banner
          tone="warn"
          onDismiss={() => dismissMany(reconnect.map(issueKey))}
          dismissLabel={t("Tüm uyarıları kapat", "Dismiss all warnings")}
          action={
            <Button
              size="sm"
              variant="outline"
              aria-expanded={expanded}
              aria-controls={listId}
              onClick={() => setExpanded((open) => !open)}
            >
              {expanded ? t("Gizle", "Hide") : t("Göster", "Show")}
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
                            aria-label={t(
                              `${item.account.name} uyarısını kapat`,
                              `Dismiss warning for ${item.account.name}`,
                            )}
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
            {t(
              `${reconnect.length} hesabın limit okuma girişi dikkat istiyor.`,
              `${reconnect.length} usage sign-ins need attention.`,
            )}
          </span>
        </Banner>
      )}
    </div>
  );
}
