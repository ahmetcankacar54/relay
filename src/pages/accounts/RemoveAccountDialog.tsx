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
  if (result.signedOut !== false) return t(`${name} kaldırıldı.`, `Removed ${name}.`);
  return macWording(platform)
    ? t(
        `${name} kaldırıldı. Limit okuma girişinden çıkış yapılamadı; Anahtarlık’taki kaydı kalabilir.`,
        `Removed ${name}. The sign-out from its usage sign-in failed. Its Keychain item can stay.`,
      )
    : t(
        `${name} kaldırıldı. Limit okuma girişinden çıkış yapılamadı; kayıtlı girişi kalabilir.`,
        `Removed ${name}. The sign-out from its usage sign-in failed. Its saved sign-in can stay.`,
      );
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
          <DialogTitle>{t("Hesabı kaldır", "Remove account")}</DialogTitle>
          <DialogDescription className="sr-only">
            {t(
              "Hesabı Relay’den kaldırmayı onayla.",
              "Confirm the removal of the account from Relay.",
            )}
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
    t("Kayıtlı Claude uygulaması girişi", "Its saved Claude app sign-in"),
    t(
      "Limit okuma girişi ve terminal oturumları",
      "Its usage sign-in and terminal sessions",
    ),
    t("Tarayıcı eklentisi girişi", "Its browser extension sign-in"),
    t(
      "Planlama, otomatik geçiş ve geçmiş paylaşımındaki yeri",
      "Its place in planning, automatic switching and shared history",
    ),
  ];
  const stays = [
    t(
      "Claude uygulamasının kendi verisi ve bu hesabın Code geçmişi",
      "The Claude app’s own data and this account’s Code history",
    ),
    t("Kullanım geçmişi ve token sayıları", "Usage history and token counts"),
    t("Claude hesabının kendisi", "The Claude account itself"),
  ];
  return (
    <div className="grid gap-3" data-slot="remove-account">
      {/* The page banners sit under the overlay; a refusal shows here. */}
      <RelayErrorAlert />
      <p className="text-sm">
        {t(`${account.name} Relay’den kaldırılsın mı?`, `Remove ${account.name} from Relay?`)}
      </p>
      <div className="grid gap-3 rounded-lg border bg-muted/40 px-3 py-2.5 text-sm">
        {[
          { key: "goes", title: t("Silinir", "Deleted"), items: goes },
          { key: "stays", title: t("Kalır", "Kept"), items: stays },
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
          {t("Vazgeç", "Cancel")}
        </Button>
        {/* Another action holds the lock, so a click now would do nothing. */}
        <Button type="button" variant="destructive" disabled={!!relay.busy} onClick={confirm}>
          {running ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
          {t("Hesabı kaldır", "Remove account")}
        </Button>
      </div>
    </div>
  );
}
