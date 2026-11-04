import { Button } from "@/components/ui/button";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { UPDATE_INSTALL_KEY, updateShown, updateTitle } from "@/lib/update-text";
import { panelCard } from "./PanelActiveCard";

/** A newer Relay, in one row at the top of the menu bar panel: Update, or the download page. */
export function PanelUpdate() {
  const relay = useRelay();
  const { t } = useI18n();
  const update = relay.data?.update;
  if (!updateShown(update)) return null;
  const busy = !!relay.busy || !!relay.desktop?.busy;
  return (
    <section className="px-3 pt-1.5">
      <div className={`${panelCard} flex items-center justify-between gap-2 px-2 py-1.5`} role="status">
        <span className="min-w-0 truncate font-semibold">{updateTitle(update, t)}</span>
        {update.status === "ready" && (
          <Button
            size="xs"
            disabled={busy}
            onClick={() => void relay.action(UPDATE_INSTALL_KEY, () => relay.api.installUpdate())}
          >
            {t("Güncelle", "Update")}
          </Button>
        )}
        {update.status === "manual" && (
          <Button size="xs" variant="outline" onClick={() => void relay.api.openUpdateNotes()}>
            {t("İndir", "Download")}
          </Button>
        )}
      </div>
    </section>
  );
}
