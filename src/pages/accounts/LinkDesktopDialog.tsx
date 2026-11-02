import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { DesktopSetup } from "../../features/DesktopSetup";

/** Links the account already open in Claude (not yet claimed by any profile) to a profile. */
export function LinkDesktopDialog({
  open,
  onOpenChange,
  picked,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the chosen profile; the account sheet continues the setup. */
  picked: (id: string) => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t("Claude uygulaması hesabını eşleştir", "Link Claude app account")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t(
              "Claude uygulamasında açık hesabı bir Relay profiliyle eşleştir.",
              "Link the account open in the Claude app to a Relay profile.",
            )}
          </DialogDescription>
        </DialogHeader>
        <LinkDesktopBody picked={picked} />
      </DialogContent>
    </Dialog>
  );
}

/** Dialog contents, rendered outside the portal so it can be tested statically. */
export function LinkDesktopBody({ picked }: { picked: (id: string) => void }) {
  const relay = useRelay();
  const { t } = useI18n();
  return (
    <DesktopSetup
      bare
      accounts={relay.accounts}
      desktop={relay.desktop}
      unclaimed={relay.hasUnclaimedDesktop}
      org={relay.targetOrg}
      busy={relay.desktopBusy}
      t={t}
      selectOrg={relay.setOrg}
      selectAccount={(id) => id && picked(id)}
      close={() => {}}
      connect={() => {}}
    />
  );
}
