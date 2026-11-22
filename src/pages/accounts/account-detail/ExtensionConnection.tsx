import { AppWindow, Link2, LoaderCircle } from "lucide-react";
import { RefreshIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { useExtensionStatus } from "@/data/useExtension";
import { routeHash } from "@/app/routes";
import { accountUuids, extensionGuide } from "@/lib/extension-ui";
import type { Account, ExtensionStatus } from "../../../../shared/types";
import { ConnectionRow } from "./Connections";

/**
 * The browser extension's connection: linked, or the steps to link it. Opening the row checks who
 * the extension is signed in to (from a copy; no browser is quit) and links a known account.
 */
export function ExtensionRow({
  account,
  initialStatus,
}: {
  account: Account;
  /** For static rendering; otherwise read, and checked, on mount. */
  initialStatus?: ExtensionStatus;
}) {
  const extension = useExtensionStatus({ check: true, initial: initialStatus });
  return <ExtensionConnection account={account} extension={extension} />;
}

/** The extension's row from a status the caller reads, so the page can count it among the connections. */
export function ExtensionConnection({
  account: a,
  extension: { status, checking, check, link },
}: {
  account: Account;
  extension: ReturnType<typeof useExtensionStatus>;
}) {
  const { accounts, data } = useRelay();
  const { t, language } = useI18n();
  if (status === null) return null;
  const guide = extensionGuide(a, status, accounts, t, language, undefined, data?.diagnostics?.platform);
  return (
    <ConnectionRow
      icon={<AppWindow />}
      title={t("Tarayıcı eklentisi", "Browser extension")}
      purpose={t("Bu hesaba o da geçer.", "Switches to this account too.")}
      optional
      tone={guide.tone}
      status={guide.label}
      where={guide.where}
      steps={guide.steps}
      detail={guide.detail}
      refresh={
        guide.action === "claim" || (!guide.action && guide.tone === "ok") ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("Eklentiyi yeniden kontrol et", "Check the extension again")}
            title={t("Eklentiyi yeniden kontrol et", "Check the extension again")}
            disabled={checking}
            onClick={() => void check()}
          >
            {checking && guide.action !== "claim" ? <LoaderCircle className="animate-spin" /> : <RefreshIcon />}
          </Button>
        ) : undefined
      }
      action={
        guide.action === "claim" ? (
          <Button
            size="sm"
            disabled={checking || !accountUuids(a).length}
            title={accountUuids(a).length ? undefined : t("Önce Claude uygulaması girişini kaydet.", "Save the Claude app sign-in first.")}
            onClick={() => void link(a.id)}
          >
            {checking ? <LoaderCircle className="animate-spin" /> : <Link2 />}
            {t("Bu hesap olarak bağla", "Link as this account")}
          </Button>
        ) : guide.action === "check" ? (
          <Button
            size="sm"
            variant="outline"
            disabled={checking}
            onClick={() => void check()}
          >
            {checking ? <LoaderCircle className="animate-spin" /> : <RefreshIcon />}
            {t("Kontrol et", "Check")}
          </Button>
        ) : guide.action === "settings" ? (
          <Button size="sm" variant="outline" asChild>
            <a href={routeHash("gecis")}>{t("Geçiş", "Switching")}</a>
          </Button>
        ) : undefined
      }
    />
  );
}
