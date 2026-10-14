import { useState, type ReactNode } from "react";
import { Check, Monitor, X } from "lucide-react";
import type { Account, AccountUsage } from "../../shared/types";
import { cliNeedsReconnect } from "../../shared/account-state";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { localizeError } from "../messages";
import { AutoSwitchStatus } from "../features/AutoSwitchStatus";

export interface ReconnectIssue {
  account: Account;
  issue: string;
  /** `login` needs a new browser sign-in; `renew` re-reads the saved one (may prompt). */
  action: "login" | "renew";
}

/**
 * Signed-in accounts whose usage connection needs attention, minus the ones the
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

/** The current Relay or Desktop error, for surfaces (dialogs) that cover the page banners. */
export function RelayErrorAlert() {
  const relay = useRelay();
  const { t, language } = useI18n();
  const message = relay.error || relay.desktop?.error;
  if (!message) return null;
  return (
    <Banner
      tone="error"
      role="alert"
      onDismiss={() => void relay.dismissError()}
      dismissLabel={t("Hatayı kapat", "Dismiss error")}
    >
      <span>{localizeError(message, language)}</span>
    </Banner>
  );
}

export function Banner({
  tone,
  children,
  action,
  onDismiss,
  dismissLabel,
  role,
}: {
  tone: "info" | "warn" | "error";
  children: ReactNode;
  action?: ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
  role?: "alert" | "status";
}) {
  return (
    <div
      role={role}
      className={cn(
        "flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm",
        tone === "error" && "border-destructive/30 bg-destructive/10",
        tone === "warn" && "border-warn/40 bg-warn/10",
        tone === "info" && "bg-accent",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">{children}</div>
      {(action || onDismiss) && (
        <div className="flex shrink-0 items-center gap-1">
          {action}
          {onDismiss && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={dismissLabel}
              onClick={onDismiss}
            >
              <X />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export function Banners() {
  const relay = useRelay();
  const { t } = useI18n();
  const { desktop, notice, settings, accounts, active } = relay;
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
      {settings.autoSwitchMode !== "off" && (
        <AutoSwitchStatus
          value={relay.data?.autoSwitch}
          accounts={accounts}
          t={t}
        />
      )}
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
      {reconnect.map(({ account: a, issue, action }) => (
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
                  ? t("Anahtarlık erişimine izin ver", "Allow Keychain access")
                  : t("Bağlantıyı yenile", "Renew connection")}
              </Button>
            )
          }
        >
          <span>
            {issue === "keychain-locked"
              ? t(
                  `${a.name} · limitleri okumak için Anahtarlık erişimi gerekiyor.`,
                  `${a.name} · Keychain access is needed to read usage limits.`,
                )
              : action === "renew"
                ? t(
                    `${a.name} · kullanım bağlantısının yenilenmesi gerekiyor.`,
                    `${a.name} · the usage connection needs to be renewed.`,
                  )
                : t(
                    `${a.name} · tarayıcı girişinin yenilenmesi gerekiyor.`,
                    `${a.name} · the browser sign-in needs to be renewed.`,
                  )}
          </span>
        </Banner>
      ))}
    </div>
  );
}
