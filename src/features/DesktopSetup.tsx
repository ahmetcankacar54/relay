import { Monitor, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Account, DesktopState } from "../../shared/types";
import { codeTabStep } from "@/lib/onboarding";
import { workspaceOptions } from "@/lib/workspaces";
import type { T } from "../../shared/i18n/translate";

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
  t: T;
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
  const hint =
    (busy && reason) ||
    (unclaimed && !org
      ? workspaces
        ? t("desktopSetup.selectACodeWorkspace")
        : codeTabStep(t)
      : undefined);
  return (
    <section
      id={account ? `setup-${account.id}` : "desktop-setup-picker"}
      className={
        bare ? "grid gap-3" : "grid gap-3 rounded-lg border bg-card p-3"
      }
      aria-label={t("desktopSetup.claudeAppSignIn")}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <Monitor className="size-4 text-brand" />
          {t("desktopSetup.claudeAppSignIn")}
        </h3>
        {!bare && (
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={busy}
            aria-label={t("desktopSetup.closeSetup")}
            onClick={close}
          >
            <X />
          </Button>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        {unclaimed
          ? t("desktopSetup.linkTheAccountOpenInThe")
          : t("desktopSetup.toSwitchToThisAccountSave")}
      </p>
      {!account && (
        <label className="grid gap-1.5 text-sm font-medium">
          {t("desktopSetup.accountOpenInTheClaudeApp")}
          <select
            className={selectClass}
            value=""
            onChange={(e) => selectAccount?.(e.target.value)}
            disabled={busy}
          >
            <option value="">{t("desktopSetup.selectAProfile")}</option>
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
            suggested={desktop?.orgHint?.orgId}
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
              ? t("desktopSetup.linkThisAccount")
              : t("desktopSetup.startClaudeAppSignIn")}
          </Button>
          {hint && <small className="text-xs text-muted-foreground">{hint}</small>}
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
  suggested,
  t,
}: {
  accounts: readonly Account[];
  organizations: readonly string[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  /** The workspace the Claude app is in: listed first and marked. */
  suggested?: string;
  t: T;
}) {
  const options = workspaceOptions(organizations, accounts, t, suggested);
  const chosen = options.find((o) => o.id === value);
  return (
    <label className="grid gap-1.5 text-sm font-medium">
      <span className="flex items-baseline gap-2">
        {t("desktopSetup.codeWorkspace")}
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
        <option value="">{t("desktopSetup.selectAWorkspace")}</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
