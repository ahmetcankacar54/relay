import { useEffect, useState } from "react";
import type { Account, DesktopHistorySummary, RelayAPI } from "../../shared/types";
import { Button } from "@/components/ui/button";

export function HistorySummary({
  account,
  sources,
  api,
  t,
}: {
  account: Account;
  sources: Account[];
  api: RelayAPI;
  t: (tr: string, en: string) => string;
}) {
  const [value, setValue] = useState<DesktopHistorySummary>();
  const [failed, setFailed] = useState(false);
  const load = () => {
    setFailed(false);
    void api
      .desktopHistorySummary(account.id)
      .then(setValue, () => setFailed(true));
  };
  useEffect(() => {
    let current = true;
    setValue(undefined);
    setFailed(false);
    void api.desktopHistorySummary(account.id).then(
      (v) => {
        if (current) setValue(v);
      },
      () => {
        if (current) setFailed(true);
      },
    );
    return () => {
      current = false;
    };
  }, [account.id, api]);
  return (
    <div className="grid gap-1 rounded-lg border p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <strong className="font-semibold">
          {t("Yerel Code geçmişi", "Local Code history")}
        </strong>
        <Button
          size="sm"
          variant="link"
          className="h-auto px-0"
          onClick={load}
        >
          {t("Kontrol et", "Check")}
        </Button>
      </div>
      <p className="text-muted-foreground">
        {failed
          ? t("Geçmiş okunamadı. Yeniden kontrol et.", "Cannot read the history. Check again.")
          : value
            ? t(
                `${value.indexed} oturum · ${value.projects} yerel proje · ${value.archived} arşivlenmiş`,
                `${value.indexed} ${value.indexed === 1 ? "session" : "sessions"} · ${value.projects} local ${value.projects === 1 ? "project" : "projects"} · ${value.archived} archived`,
              )
            : t("Okunuyor…", "Read in progress…")}
      </p>
      {value && (
        <p className="text-muted-foreground">
          {t(
            `${value.transcriptsFound} konuşma dosyası · ${value.missingTranscripts} eksik · ${value.unknownTranscripts} doğrulanamadı`,
            `${value.transcriptsFound} conversation ${value.transcriptsFound === 1 ? "file" : "files"} · ${value.missingTranscripts} missing · ${value.unknownTranscripts} unverified`,
          )}
        </p>
      )}
      {value && value.duplicates > 0 && (
        <p className="text-muted-foreground">
          {t(
            `Sonraki geçiş veya birleştirmede ${value.duplicates} yinelenen kart kaldırılır.`,
            `Relay removes ${value.duplicates} duplicate ${value.duplicates === 1 ? "card" : "cards"} at the next switch or merge.`,
          )}
        </p>
      )}
      <small className="text-xs text-muted-foreground">
        {sources.length
          ? t(
              `Sonraki birleştirmede geçmiş alınacak hesaplar: ${sources.map((a) => a.name).join(", ")}`,
              `History sources for the next merge: ${sources.map((a) => a.name).join(", ")}`,
            )
          : t("Geçmiş alınacak hesap yok", "No history sources")}
      </small>
    </div>
  );
}
