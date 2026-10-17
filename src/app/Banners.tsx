import { useState } from "react";
import { Check, Monitor } from "lucide-react";
import type { Account, AccountUsage } from "../../shared/types";
import { cliNeedsReconnect } from "../../shared/account-state";
import { Button } from "@/components/ui/button";
import { Banner } from "@/components/Banner";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { AutomationBanner } from "../features/AutomationControl";
import { RelayErrorAlert } from "./RelayErrorAlert";

export interface ReconnectIssue {
  account: Account;
  issue: string;
  /** `login` needs a new browser sign-in; `renew` re-reads the saved one (may prompt). */
  action: "login" | "renew";
}

/**
 * Signed-in accounts whose usage sign-in needs attention, minus the ones the
 * user dismissed this session (keyed `accountId:issue`). Mirrors UsageCard.
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
    const issue =
      u?.issue ?? (u?.connectionRenewalRequired ? "renewal-required" : "");
    const action = cliNeedsReconnect(account, u)
      ? "login"
      : issue === "renewal-required" || issue === "keychain-locked"
        ? "renew"
        : undefined;
    if (!action || dismissed.has(`${account.id}:${issue}`)) continue;
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
}: {
  /** False on pages that show the automation status inline. */
  automation?: boolean;
}) {
  const relay = useRelay();
  const { t } = useI18n();
  const { desktop, notice, accounts, active } = relay;
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const reconnect = reconnectIssues(
    accounts,
    relay.data?.usage ?? {},
    dismissed,
  );
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
      {reconnect.map(({ account: a, issue, action }) => {
        const cause = reconnectCause(a, relay.data?.usage?.[a.id], t);
        return (
          <Banner
            key={`${a.id}:${issue}`}
            tone="warn"
            onDismiss={() =>
              setDismissed((prev) => new Set(prev).add(`${a.id}:${issue}`))
            }
            dismissLabel={t("Uyarıyı kapat", "Dismiss warning")}
            action={
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
                    ? t(
                        "Anahtarlık erişimine izin ver",
                        "Allow Keychain access",
                      )
                    : t("Bağlantıyı yenile", "Renew connection")}
                </Button>
              )
            }
          >
            {action === "login" ? (
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
            ) : (
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
            )}
          </Banner>
        );
      })}
    </div>
  );
}
