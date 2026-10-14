import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { historySources } from "../../shared/history-policy";
import { DesktopActionReview } from "../DesktopActionReview";

/** Confirms every Desktop action (switch, sign-in, recovery…) on whatever page is open. */
export function DesktopActionDialog() {
  const relay = useRelay();
  const { t } = useI18n();
  const request = relay.desktopRequest;
  const busy = !!relay.desktopBusy;
  const account =
    request && relay.accounts.find((a) => a.id === request.accountId);
  return (
    <Dialog
      open={!!request}
      onOpenChange={(open) => !open && !busy && relay.cancelDesktopRequest()}
    >
      <DialogContent className="sm:max-w-lg" showCloseButton={false}>
        <DialogTitle className="sr-only">
          {t("Desktop işlemini onayla", "Confirm Desktop action")}
        </DialogTitle>
        <DialogDescription className="sr-only">
          {t(
            "Claude yeniden başlatılmadan önce onay gerekir.",
            "Confirmation is required before Claude restarts.",
          )}
        </DialogDescription>
        {request && (
          <DesktopActionReview
            key={`${request.accountId}:${request.kind}`}
            account={account}
            active={relay.active}
            kind={request.kind}
            historyAccounts={
              account
                ? historySources(account, relay.accounts, relay.settings)
                : []
            }
            busy={busy}
            t={t}
            cancel={relay.cancelDesktopRequest}
            confirm={relay.confirmDesktopAction}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
