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
import { RelayErrorAlert } from "@/app/RelayErrorAlert";

/** What the removal did, for the notice after it; a usage sign-in left signed in is said. */
export function removedNotice(name: string, result: AccountRemoved, t: T): string {
  return result.signedOut === false
    ? t(
        `${name} kaldırıldı. Limit okuma girişinden çıkış yapılamadı; Anahtarlık’taki kaydı kalabilir.`,
        `Removed ${name}. Could not sign out of the usage sign-in; its Keychain item may remain.`,
      )
    : t(`${name} kaldırıldı.`, `Removed ${name}.`);
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
              "Hesap Relay’den kaldırılmadan önce onay gerekir.",
              "Confirmation is required before the account is removed from Relay.",
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
  const confirm = () => {
    let done = false;
    void relay
      .action(`remove:${account.id}`, async () => {
        const result = await relay.api.removeAccount(account.id);
        done = true;
        relay.setNotice(removedNotice(account.name, result, t));
      })
      .then(() => done && removed(account.id));
  };
  const goes = [
    t("Kayıtlı Claude uygulaması girişi", "Its saved Claude app sign-in"),
    t(
      "Claude Code profili: limit okuma girişi (çıkış yapılır) ve bu profilde açılan terminal oturumları",
      "Its Claude Code profile: the usage sign-in (signed out) and the terminal sessions opened in it",
    ),
    t("Tarayıcı eklentisi için saklanan giriş", "The browser extension sign-in kept for it"),
    t(
      "Planlama, otomatik geçiş ve geçmiş paylaşımındaki yeri",
      "Its place in planning, automatic switching and history sharing",
    ),
  ];
  const stays = [
    t(
      "Claude uygulamasının kendi verisi ve bu hesabın Code geçmişi",
      "The Claude app’s own data and this account’s Code history",
    ),
    t("Kullanım geçmişi ve token sayıları", "Usage history and token counts"),
    t(
      "Claude hesabının kendisi; istediğin zaman yeniden ekleyebilirsin",
      "The Claude account itself; you can add it again any time",
    ),
  ];
  return (
    <div className="grid gap-3" data-slot="remove-account">
      {/* The page banners sit under the overlay; a refusal shows here. */}
      <RelayErrorAlert />
      <p className="text-sm">
        {t(
          `${account.name} unutulacak: kayıtlı Claude uygulaması girişi ve Claude Code profili (limit okuma girişi) silinir. Claude uygulamasının kendi verisine dokunulmaz.`,
          `${account.name} will be forgotten: its saved Claude app sign-in and its Claude Code profile (usage sign-in) are deleted. The Claude app’s own data is not touched.`,
        )}
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
        <Button type="button" variant="destructive" disabled={running} onClick={confirm}>
          {running ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
          {t("Hesabı kaldır", "Remove account")}
        </Button>
      </div>
    </div>
  );
}
