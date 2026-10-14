import { useEffect, useState } from "react";
import type { Account, DesktopHistorySummary, RelayAPI } from "../shared/types";
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
          ? t("Geçmiş bilgisi okunamadı.", "Could not read history metadata.")
          : value
            ? t(
                `${value.indexed} oturum · ${value.projects} yerel proje · ${value.archived} arşivlenmiş`,
                `${value.indexed} sessions · ${value.projects} local projects · ${value.archived} archived`,
              )
            : t("Yerel kayıtlar kontrol ediliyor…", "Checking local records…")}
      </p>
      {value && (
        <p className="text-muted-foreground">
          {t(
            `${value.transcriptsFound} konuşma dosyası bulundu; ${value.missingTranscripts} eksik, ${value.unknownTranscripts} konumu doğrulanamadı.`,
            `${value.transcriptsFound} conversation files found; ${value.missingTranscripts} missing, ${value.unknownTranscripts} locations unverified.`,
          )}
        </p>
      )}
      {value && value.duplicates > 0 && (
        <p className="text-muted-foreground">
          {t(
            `${value.duplicates} yinelenen kart sonraki geçiş veya birleştirmede temizlenecek.`,
            `${value.duplicates} duplicate cards will be removed on the next switch or merge.`,
          )}
        </p>
      )}
      <small className="text-xs text-muted-foreground">
        {sources.length
          ? t(
              `Sonraki birleştirmede: ${sources.map((a) => a.name).join(", ")}.`,
              `Sources on next merge: ${sources.map((a) => a.name).join(", ")}.`,
            )
          : t(
              "Paylaşılacak başka hesap seçili değil.",
              "No other account is selected as a sharing source.",
            )}
      </small>
      <small className="text-xs text-muted-foreground">
        {t(
          "Dosyanın bulunması, başka hesabın konuşmayı sürdürebileceğini tek başına doğrulamaz.",
          "Finding a file alone does not verify that another account can resume the conversation.",
        )}
      </small>
    </div>
  );
}
