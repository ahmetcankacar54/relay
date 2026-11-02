import { Button } from "@/components/ui/button";
import { ExternalLink } from "@/components/ExternalLink";
import { useI18n } from "@/data/i18n";
import { useRelay, type Relay } from "@/data/relay-context";
import { EXTERNAL_LINKS } from "../../shared/external-links";

/** Asks main for the Claude app's location; main keeps the choice and every window re-reads it. */
export const chooseClaudeApp = (relay: Pick<Relay, "action" | "api">) =>
  void relay.action("claude-app", () => relay.api.pickClaudeApp());

/**
 * Where Relay found no Claude app: the download link, and Choose location for an install Relay
 * does not know (on Linux every build is a community package, so this is often the way).
 */
export function ClaudeAppActions({ download = true }: { download?: boolean }) {
  const relay = useRelay();
  const { t } = useI18n();
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {download && (
        <ExternalLink href={EXTERNAL_LINKS.claudeDownload}>
          {t("İndir", "Download")}
        </ExternalLink>
      )}
      <Button
        variant="outline"
        size="sm"
        disabled={!!relay.busy}
        onClick={() => chooseClaudeApp(relay)}
      >
        {t("Konumu seç", "Choose location")}
      </Button>
    </span>
  );
}
