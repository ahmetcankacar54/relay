import type { ReactNode } from "react";
import { Check, Monitor, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { localizeError } from "../messages";
import { AutoSwitchStatus } from "../features/AutoSwitchStatus";

const RECONNECT_ISSUES = new Set([
  "renewal-required",
  "expired",
  "credentials-missing",
]);

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
  const { t, language } = useI18n();
  const { desktop, error, notice, settings, accounts, active } = relay;
  const reconnect = accounts.filter((a) => {
    const issue = relay.data?.usage[a.id]?.issue;
    return !!issue && RECONNECT_ISSUES.has(issue);
  });
  const message = error || desktop?.error;
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
      {message && (
        <Banner
          tone="error"
          role="alert"
          onDismiss={() => void relay.dismissError()}
          dismissLabel={t("Hatayı kapat", "Dismiss error")}
        >
          <span>{localizeError(message, language)}</span>
        </Banner>
      )}
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
      {reconnect.map((a) => (
        <Banner
          key={a.id}
          tone="warn"
          action={
            <Button
              size="sm"
              variant="outline"
              disabled={!!relay.busy}
              onClick={() => void relay.startCli(a)}
            >
              {t("Yeniden bağlan", "Reconnect")}
            </Button>
          }
        >
          <span>
            {t(
              `${a.name} · kullanım bağlantısının yenilenmesi gerekiyor.`,
              `${a.name} · the usage connection needs to be renewed.`,
            )}
          </span>
        </Banner>
      ))}
    </div>
  );
}
