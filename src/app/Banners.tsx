import { useEffect, useId, useState } from "react";
import { Check, Monitor, X } from "lucide-react";
import type { Account, AccountUsage } from "../../shared/types";
import { cliNeedsReconnect } from "../../shared/account-state";
import { Button } from "@/components/ui/button";
import { Banner } from "@/components/Banner";
import {
  dismissalKey,
  pruneDismissals,
  useDismissals,
} from "@/data/dismissals";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { AutomationBanner } from "../features/AutomationControl";
import { RelayErrorAlert } from "./RelayErrorAlert";
import { displayedIssue, renewalIssue } from "@/lib/account-health";

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
 */
export function reconnectIssues(
  accounts: Account[],
  usage: Record<string, AccountUsage | undefined>,
  dismissed: ReadonlySet<string>,
): ReconnectIssue[] {
  const result: ReconnectIssue[] = [];
  for (const account of accounts) {
    if (!account.auth?.loggedIn) continue;
    const u = usage[account.id];
    const issue = displayedIssue(u) ?? "";
    const action = cliNeedsReconnect(account, u)
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
 * banner. The first matching row wins; anything unlisted is a lost connection.
 */
export function reconnectCause(
  account: Account,
  usage: AccountUsage | undefined,
  t: (tr: string, en: string) => string,
): string {
  if (!account.auth?.loggedIn) return t("giriş yapılmamış", "not signed in");
  switch (usage?.issue) {
    case "expired":
      return t(
        "oturumun süresi doldu ve yenilenemedi",
        "the session expired and could not be renewed",
      );
    case "credentials-missing":
      return t("kayıtlı giriş bulunamadı", "the saved sign-in was not found");
    case "scope":
      return t(
        "giriş kullanım verisine erişemiyor",
        "the sign-in cannot read usage",
      );
    case "identity-mismatch":
      return t(
        "giriş başka bir hesaba ait",
        "the sign-in belongs to another account",
      );
    default:
      return t("bağlantı kullanılamıyor", "the connection is unavailable");
  }
}

export function Banners({
  automation = true,
  initialExpanded = false,
}: {
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
  const reconnect = reconnectIssues(accounts, usage, dismissed);
  // Every current issue, dismissed or not: a dismissal lives while its issue does.
  const currentKeys = reconnectIssues(accounts, usage, NONE).map(issueKey);
  // Accounts whose usage was not read yet: right after a launch the cache is empty, so
  // each logged-in account is idle with no issue. Their dismissals must outlive that.
  const unread = accounts
    .filter((a) => {
      const u = usage[a.id];
      return (
        a.auth?.loggedIn &&
        !u?.issue &&
        (!u || u.status === "idle" || u.status === "loading")
      );
    })
    .map((a) => a.id);
  const signature = JSON.stringify([currentKeys, unread]);
  const loaded = relay.data !== undefined;
  useEffect(() => {
    // Before the first snapshot no issue is known, so everything would look gone.
    // `currentKeys` and `unread` are the lists `signature` was made from.
    if (loaded) pruneDismissals(currentKeys, unread);
  }, [loaded, signature]);

  const issueAction = ({ account: a, issue, action }: ReconnectIssue) =>
    action === "login" ? (
      <Button
        size="sm"
        variant="outline"
        disabled={!!relay.busy}
        onClick={() => void relay.startCli(a)}
      >
        {t("Yeniden bağlan", "Reconnect")}
      </Button>
    ) : (
      <Button
        size="sm"
        variant="outline"
        disabled={relay.usageBusy.has(a.id)}
        onClick={() => void relay.refreshUsage(a, true)}
      >
        {issue === "keychain-locked"
          ? t("Anahtarlık erişimine izin ver", "Allow Keychain access")
          : t("Bağlantıyı yenile", "Renew connection")}
      </Button>
    );
  const issueText = ({ account: a, issue, action }: ReconnectIssue) => {
    if (action === "login") {
      const cause = reconnectCause(a, relay.data?.usage?.[a.id], t);
      return (
        <div className="min-w-0">
          <span>
            {t(
              `${a.name} · limit okuma girişinin yenilenmesi gerekiyor: ${cause}.`,
              `${a.name} · the usage sign-in needs to be renewed: ${cause}.`,
            )}
          </span>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t(
              "Yeniden bağlan, tarayıcıda bu hesabın limit okuma girişini açar. Onaylayınca uyarı kapanır.",
              "Reconnect opens this account’s usage sign-in in the browser. The warning closes once you approve it.",
            )}
          </p>
        </div>
      );
    }
    return (
      <span>
        {issue === "keychain-locked"
          ? t(
              `${a.name} · limitleri okumak için Anahtarlık erişimi gerekiyor.`,
              `${a.name} · Keychain access is needed to read usage limits.`,
            )
          : t(
              `${a.name} · limit okuma girişinin yenilenmesi gerekiyor.`,
              `${a.name} · the usage sign-in needs to be renewed.`,
            )}
      </span>
    );
  };
  return (
    <div className="flex flex-col gap-2 px-6 pb-3 empty:hidden">
      {relay.preview && (
        <Banner tone="info">
          <Monitor className="size-4 shrink-0" aria-hidden />
          <span>
            {t(
              "Tarayıcı önizlemesi · Hesaplar örnektir. Geçişler masaüstü uygulamasında çalışır.",
              "Browser preview · Sample accounts. Switching works in the desktop app.",
            )}
          </span>
        </Banner>
      )}
      <RelayErrorAlert />
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
              {t("Geri yükle", "Restore backup")}
            </Button>
          }
        >
          <span>
            {t(
              "Yarım kalan Desktop geçişi var. Önce yedeği geri yükle.",
              "A Desktop switch was interrupted. Restore the backup first.",
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
                      <div className="min-w-0">{issueText(item)}</div>
                      <div className="flex shrink-0 items-center gap-1">
                        {issueAction(item)}
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
            ) : null
          }
        >
          <span>
            {t(
              `${reconnect.length} hesabın girişi ilgi bekliyor.`,
              `${reconnect.length} accounts need sign-in attention.`,
            )}
          </span>
        </Banner>
      )}
    </div>
  );
}
