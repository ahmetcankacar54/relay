import { Monitor, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Account, DesktopState } from "../../shared/types";
import { codeTabStep } from "@/lib/onboarding";
import { workspaceOptions } from "@/lib/workspaces";

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
  reason,
}: {
  account?: Account;
  accounts: Account[];
  desktop?: DesktopState;
  unclaimed: boolean;
  org: string;
  busy: boolean;
  t: (tr: string, en: string) => string;
  /** Only used by the picker (no `account`). */
  selectAccount?: (id: string) => void;
  selectOrg: (id: string) => void;
  close: () => void;
  connect: () => void;
  /** Inside a dialog: no card chrome and no close button (the dialog has its own). */
  bare?: boolean;
  /** Why `busy` disables the button, shown next to it. */
  reason?: string;
}) {
  // Folders under the current sign-in appear once Code has been opened in Claude.
  const workspaces = desktop?.organizations.length ?? 0;
  return (
    <section
      id={account ? `setup-${account.id}` : "desktop-setup-picker"}
      className={
        bare ? "grid gap-3" : "grid gap-3 rounded-lg border bg-card p-3"
      }
      aria-label={t("İlk Claude uygulaması girişi", "First Claude app sign-in")}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <Monitor className="size-4 text-brand" />
          {t("İlk Claude uygulaması girişi", "First Claude app sign-in")}
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
              "Claude uygulamasında açık hesabı doğru Relay profiliyle eşleştir. E-posta ve çalışma alanı aynı hesaba ait olmalı.",
              "Link the account open in the Claude app to the matching Relay profile. The email and workspace must belong to that account.",
            )
          : t(
              "Bu profilin Claude uygulaması girişi henüz kayıtlı değil. Limit okuma girişi kullanım limitlerini okur; hesap geçişi için bir kez Claude uygulaması girişi de gerekir.",
              "This profile has no saved Claude app sign-in yet. The usage sign-in reads usage limits; switching also needs one Claude app sign-in.",
            )}
      </p>
      {!account && (
        <label className="grid gap-1.5 text-sm font-medium">
          {t("Claude uygulamasında açık olan hesap", "Account currently open in the Claude app")}
          <select
            className={selectClass}
            value=""
            onChange={(e) => selectAccount?.(e.target.value)}
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
        workspaces > 0 &&
        (!org || workspaces > 1) && (
          <WorkspaceSelect
            accounts={accounts}
            organizations={desktop?.organizations ?? []}
            value={org}
            onChange={selectOrg}
            disabled={busy}
            t={t}
          />
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
              : t(
                  "Claude uygulaması girişini başlat…",
                  "Start Claude app sign-in…",
                )}
          </Button>
          <small className="text-xs text-muted-foreground">
            {(busy && reason) ||
              (unclaimed && !org
                ? workspaces
                  ? t("Bir Code çalışma alanı seç.", "Choose a Code workspace.")
                  : codeTabStep(t)
                : t(
                    "Sonraki adımda yeniden başlatmayı onaylarsın.",
                    "Review the restart in the next step.",
                  ))}
          </small>
        </div>
      )}
    </section>
  );
}

/** The Code workspace choice: organization names or "Çalışma alanı N", never a raw id. */
export function WorkspaceSelect({
  accounts,
  organizations,
  value,
  onChange,
  disabled,
  t,
}: {
  accounts: readonly Account[];
  organizations: readonly string[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  t: (tr: string, en: string) => string;
}) {
  const options = workspaceOptions(organizations, accounts, t);
  const chosen = options.find((o) => o.id === value);
  return (
    <label className="grid gap-1.5 text-sm font-medium">
      <span className="flex items-baseline gap-2">
        {t("Code çalışma alanı", "Code workspace")}
        {chosen && (
          <span className="font-mono text-xs font-normal text-muted-foreground">
            {chosen.short}
          </span>
        )}
      </span>
      <select
        className={selectClass}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      >
        <option value="">{t("Çalışma alanı seç", "Choose a workspace")}</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
