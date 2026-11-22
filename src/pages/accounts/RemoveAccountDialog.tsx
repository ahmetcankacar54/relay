import { LoaderCircle, Trash2 } from "lucide-react";
import type { Account, AccountRemoved } from "../../../shared/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useI18n, type T } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { macWording } from "@/data/platform";
import { RelayErrorAlert } from "@/app/RelayErrorAlert";

/** What the removal did, for the notice after it; a usage sign-in left signed in is said. */
export function removedNotice(name: string, result: AccountRemoved, t: T, platform?: string): string {
  if (result.signedOut !== false) return t("removeAccountDialog.removed", { name });
  return macWording(platform)
    ? t("removeAccountDialog.removedTheSignOutFromIts", { name })
    : t("removeAccountDialog.removedTheSignOutFromIts2", { name });
}

/** Asks before an account is removed, saying what goes and what stays, as `relay remove` does. */
export function RemoveAccountDialog({
  account,
  close,
  removed,
}: {
  /** The account to remove; the dialog is open while there is one. */
  account?: Account;
  close: () => void;
  /** Told once the account is gone. */
  removed: (id: string) => void;
}) {
  const relay = useRelay();
  const { t } = useI18n();
  const running = !!account && relay.busy === `remove:${account.id}`;
  return (
    <Dialog open={!!account} onOpenChange={(open) => !open && !running && close()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("removeAccountDialog.removeAccount")}</DialogTitle>
          <DialogDescription className="sr-only">
            {t("removeAccountDialog.confirmTheRemovalOfTheAccount")}
          </DialogDescription>
        </DialogHeader>
        {account && (
          <RemoveAccountBody account={account} close={close} removed={removed} />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Dialog contents, rendered outside the portal so it can be tested statically. */
export function RemoveAccountBody({
  account,
  close,
  removed,
}: {
  account: Account;
  close: () => void;
  removed: (id: string) => void;
}) {
  const relay = useRelay();
  const { t } = useI18n();
  const running = relay.busy === `remove:${account.id}`;
  const confirm = () =>
    void relay
      .action(`remove:${account.id}`, async () => {
        const result = await relay.api.removeAccount(account.id);
        relay.setNotice(removedNotice(account.name, result, t, relay.data?.diagnostics?.platform));
      })
      .then((done) => done && removed(account.id));
  const goes = [
    t("removeAccountDialog.itsSavedClaudeAppSignIn"),
    t("removeAccountDialog.itsUsageSignInAndTerminal"),
    t("removeAccountDialog.itsBrowserExtensionSignIn"),
    t("removeAccountDialog.itsPlaceInPlanningAutomaticSwitching"),
  ];
  const stays = [
    t("removeAccountDialog.theClaudeAppSOwnData"),
    t("removeAccountDialog.usageHistoryAndTokenCounts"),
    t("removeAccountDialog.theClaudeAccountItself"),
  ];
  return (
    <div className="grid gap-3" data-slot="remove-account">
      {/* The page banners sit under the overlay; a refusal shows here. */}
      <RelayErrorAlert />
      <p className="text-sm">
        {t("removeAccountDialog.removeFromRelay", { accountName: account.name })}
      </p>
      <div className="grid gap-3 rounded-lg border bg-muted/40 px-3 py-2.5 text-sm">
        {[
          { key: "goes", title: t("removeAccountDialog.deleted"), items: goes },
          { key: "stays", title: t("removeAccountDialog.kept"), items: stays },
        ].map(({ key, title, items }) => (
          <section key={key} data-slot={`remove-${key}`} className="grid gap-1">
            <h4 className="text-xs font-semibold text-muted-foreground">{title}</h4>
            <ul className="grid list-disc gap-0.5 pl-4">
              {items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" disabled={running} onClick={close}>
          {t("common.cancel")}
        </Button>
        {/* Another action holds the lock, so a click now would do nothing. */}
        <Button type="button" variant="destructive" disabled={!!relay.busy} onClick={confirm}>
          {running ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
          {t("removeAccountDialog.removeAccount")}
        </Button>
      </div>
    </div>
  );
}
