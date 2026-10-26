import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { historySources } from "../../shared/history-policy";
import { limitFull } from "@/data/selectors";
import { fullLimitWarning } from "@/lib/account-row";
import { DesktopActionReview } from "../features/DesktopActionReview";
import { RelayErrorAlert } from "./RelayErrorAlert";

/** Confirms every Desktop action (switch, sign-in, recovery…) on whatever page is open. */
export function DesktopActionDialog() {
  const relay = useRelay();
  const { t } = useI18n();
  const busy = !!relay.desktopBusy;
  return (
    <Dialog
      open={!!relay.desktopRequest}
      onOpenChange={(open) => !open && !busy && relay.cancelDesktopRequest()}
    >
      <DialogContent className="sm:max-w-lg" showCloseButton={false}>
        <DialogTitle className="sr-only">
          {t("Claude uygulaması işlemini onayla", "Confirm Claude app action")}
        </DialogTitle>
        <DialogDescription className="sr-only">
          {t(
            "Claude uygulaması yeniden başlatılmadan önce onay gerekir.",
            "Confirmation is required before the Claude app restarts.",
          )}
        </DialogDescription>
        <DesktopActionBody />
      </DialogContent>
    </Dialog>
  );
}

/** Dialog contents, rendered outside the portal so it can be tested statically. */
export function DesktopActionBody() {
  const relay = useRelay();
  const { t, language } = useI18n();
  const request = relay.desktopRequest;
  if (!request) return null;
  const account = relay.accounts.find((a) => a.id === request.accountId);
  const now = Date.now();
  const full =
    request.kind === "switch" ? limitFull(relay.data?.usage[request.accountId], now) : undefined;
  return (
    <>
      {/* The page banners sit under the overlay; failures of this action show here. */}
      <RelayErrorAlert />
      {/* confirmDesktopAction runs under this key; another Desktop job never shows the panda here. */}
      <DesktopActionReview
        key={`${request.accountId}:${request.kind}`}
        account={account}
        active={relay.active}
        kind={request.kind}
        historyAccounts={
          account ? historySources(account, relay.accounts, relay.settings) : []
        }
        busy={!!relay.desktopBusy}
        running={relay.busy === `desktop-action:${request.accountId}`}
        fullLimit={
          full &&
          fullLimitWarning(full.availableAt, t, language, relay.settings.planning.timeZone, now)
        }
        t={t}
        cancel={relay.cancelDesktopRequest}
        confirm={relay.confirmDesktopAction}
      />
    </>
  );
}
