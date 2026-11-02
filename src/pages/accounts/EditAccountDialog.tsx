import { useState } from "react";
import { LoaderCircle } from "lucide-react";
import type { Account } from "../../../shared/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { RelayErrorAlert } from "@/app/RelayErrorAlert";
import {
  ProfileFields,
  groupsShown,
  profileInput,
  profileValue,
  type ProfileValue,
} from "../../features/ProfileFields";

/** Renames an account and changes its type and sharing group. */
export function EditAccountDialog({
  account,
  onOpenChange,
}: {
  /** The account to edit; the dialog is open while it is set. */
  account?: Account;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog open={!!account} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("Hesabı düzenle", "Edit account")}</DialogTitle>
          <DialogDescription>
            {t(
              "Adı, türü ve şirket hesaplarında paylaşım grubu.",
              "Its name, type and, for work accounts, sharing group.",
            )}
          </DialogDescription>
        </DialogHeader>
        {account && <EditAccountBody key={account.id} account={account} close={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

export function EditAccountBody({ account, close }: { account: Account; close: () => void }) {
  const { t } = useI18n();
  const { api, busy, action, settings } = useRelay();
  const [value, setValue] = useState<ProfileValue>(() => profileValue(account));
  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void action("profile", async () => {
          await api.updateAccount(
            account.id,
            profileInput(value, groupsShown(settings.desktopHistoryTransfer, value.kind, t)),
          );
          close();
        });
      }}
    >
      <RelayErrorAlert />
      <ProfileFields id="edit-account" value={value} onChange={setValue} exceptId={account.id} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={close}>
          {t("Vazgeç", "Cancel")}
        </Button>
        <Button type="submit" disabled={!!busy || !value.name.trim()}>
          {busy === "profile" && <LoaderCircle className="animate-spin" />}
          {t("Kaydet", "Save")}
        </Button>
      </div>
    </form>
  );
}
