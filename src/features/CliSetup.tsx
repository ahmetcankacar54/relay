import { Button } from "@/components/ui/button";
import { ExternalLink } from "@/components/ExternalLink";
import { useI18n } from "@/data/i18n";
import { useRelay, type Relay } from "@/data/relay-context";
import { EXTERNAL_LINKS } from "../../shared/external-links";

/** Settings’ CLI picker: choose the `claude` executable, then Relay reads its version again. */
export const chooseCliFile = (relay: Pick<Relay, "action" | "api">) =>
  void relay.action("executable", () => relay.api.pickExecutable());

/** Where a usable Claude Code CLI is missing: the setup guide and Choose file. */
export function CliSetupActions() {
  const relay = useRelay();
  const { t } = useI18n();
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <ExternalLink href={EXTERNAL_LINKS.cliSetup}>
        {t("Kurulum rehberi", "Setup guide")}
      </ExternalLink>
      <Button
        variant="outline"
        size="sm"
        disabled={!!relay.busy}
        onClick={() => chooseCliFile(relay)}
      >
        {t("Dosyayı seç", "Choose file")}
      </Button>
    </span>
  );
}
