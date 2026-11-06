import { useState } from "react";
import { Download } from "lucide-react";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { UPDATE_INSTALL_KEY, updateHint, updateShown, updateTitle } from "@/lib/update-text";

/** The version the user put off with "Later"; its banner stays hidden until a newer one. */
const LATER_KEY = "relay.update.later";
function readLater(): string | undefined {
  try {
    return localStorage.getItem(LATER_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}
function writeLater(version: string) {
  try {
    localStorage.setItem(LATER_KEY, version);
  } catch {
    // Without storage the banner only stays hidden until the window reloads.
  }
}

/** A newer Relay: ready to install, downloading, installing, or to be downloaded by hand. */
export function UpdateBanner() {
  const relay = useRelay();
  const { t } = useI18n();
  const [later, setLater] = useState(readLater);
  const update = relay.data?.update;
  if (!updateShown(update)) return null;
  const { version, status } = update;
  // Put off for later until a newer version, except while it installs.
  if (later === version && status !== "installing") return null;
  const busy = !!relay.busy || !!relay.desktop?.busy;
  const notes = (
    <Button size="sm" variant="ghost" onClick={() => void relay.api.openUpdateNotes()}>
      {status === "manual" ? t("İndirme sayfası", "Download page") : t("Sürüm notları", "Release notes")}
    </Button>
  );
  const hint = updateHint(update, t);
  return (
    <Banner
      tone={status === "manual" ? "warn" : "info"}
      role="status"
      onDismiss={
        status === "installing"
          ? undefined
          : () => {
              writeLater(version);
              setLater(version);
            }
      }
      dismissLabel={t("Sonra hatırlat", "Remind me later")}
      action={
        status === "ready" ? (
          <>
            {notes}
            <Button
              size="sm"
              disabled={busy}
              title={relay.desktop?.busy ? t("Claude uygulamasındaki işlem bitince güncelle.", "Update once the Claude app action ends.") : undefined}
              onClick={() => void relay.action(UPDATE_INSTALL_KEY, () => relay.api.installUpdate())}
            >
              {t("Güncelle", "Update")}
            </Button>
          </>
        ) : status === "manual" ? (
          notes
        ) : undefined
      }
    >
      <Download className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0">
        <span className="font-medium">{updateTitle(update, t)}</span>
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
    </Banner>
  );
}
