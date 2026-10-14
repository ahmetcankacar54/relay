import { Monitor, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Account, DesktopState } from "../shared/types";

export const selectClass =
  "h-9 w-full rounded-md border bg-background px-2.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50";

export function DesktopSetup({
  account,
  accounts,
  desktop,
  unclaimed,
  org,
  busy,
  t,
  selectAccount,
  selectOrg,
  close,
  connect,
  bare = false,
}: {
  account?: Account;
  accounts: Account[];
  desktop?: DesktopState;
  unclaimed: boolean;
  org: string;
  busy: boolean;
  t: (tr: string, en: string) => string;
  selectAccount: (id: string) => void;
  selectOrg: (id: string) => void;
  close: () => void;
  connect: () => void;
  /** Inside a dialog: no card chrome and no close button (the dialog has its own). */
  bare?: boolean;
}) {
  return (
    <section
      id={account ? `setup-${account.id}` : "desktop-setup-picker"}
      className={
        bare ? "grid gap-3" : "grid gap-3 rounded-lg border bg-card p-3"
      }
      aria-label={t("Desktop ilk kurulumu", "First Desktop setup")}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <Monitor className="size-4 text-brand" />
          {t("Desktop ilk kurulumu", "First Desktop setup")}
        </h3>
        {!bare && (
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={busy}
            aria-label={t("Kurulumu kapat", "Close setup")}
            onClick={close}
          >
            <X />
          </Button>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        {unclaimed
          ? t(
              "Claude’da açık hesabı doğru Relay profiliyle eşleştir. E-posta ve çalışma alanı aynı hesaba ait olmalı.",
              "Link the account open in Claude to the matching Relay profile. The email and workspace must belong to that account.",
            )
          : t(
              "Bu profil henüz Desktop’a bağlı değil. Tarayıcı girişi kullanım limitlerini bağlar; Desktop geçişi için bir kez Claude’da da giriş yapman gerekir.",
              "This profile is not connected to Desktop yet. Browser sign-in connects usage limits; switching in Desktop requires one sign-in inside Claude too.",
            )}
      </p>
      {!account && (
        <label className="grid gap-1.5 text-sm font-medium">
          {t("Claude’da açık olan hesap", "Account currently open in Claude")}
          <select
            className={selectClass}
            value=""
            onChange={(e) => selectAccount(e.target.value)}
            disabled={busy}
          >
            <option value="">{t("Profil seç", "Choose a profile")}</option>
            {accounts
              .filter((a) => !a.desktop)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.auth?.email ? ` · ${a.auth.email}` : ""}
                </option>
              ))}
          </select>
        </label>
      )}
      {account &&
        unclaimed &&
        (!org || (desktop?.organizations.length ?? 0) > 1) && (
          <label className="grid gap-1.5 text-sm font-medium">
            {t("Code çalışma alanı", "Code workspace")}
            <select
              className={selectClass}
              value={org}
              onChange={(e) => selectOrg(e.target.value)}
              disabled={busy}
            >
              <option value="">
                {t(
                  "Code’u aç / çalışma alanı seç",
                  "Open Code / choose workspace",
                )}
              </option>
              {desktop?.organizations.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>
        )}
      {account && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <Button
            variant="outline"
            size="sm"
            disabled={busy || (unclaimed && !org)}
            onClick={connect}
          >
            {unclaimed
              ? t("Bu hesabı eşleştir…", "Link this account…")
              : t("Desktop bağlantısını başlat…", "Start Desktop connection…")}
          </Button>
          <small className="text-xs text-muted-foreground">
            {t(
              "Sonraki adımda yeniden başlatmayı onaylarsın.",
              "Review the restart in the next step.",
            )}
          </small>
        </div>
      )}
    </section>
  );
}
