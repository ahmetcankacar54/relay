import { useEffect, useState } from "react";
import type { Account, DesktopHistorySummary, RelayAPI } from "../shared/types";

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
    <div className="history-summary">
      <div>
        <strong>{t("Yerel Code geçmişi", "Local Code history")}</strong>
        <button className="text-button" onClick={load}>
          {t("Kontrol et", "Check")}
        </button>
      </div>
      <p>
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
        <p>
          {t(
            `${value.transcriptsFound} konuşma dosyası bulundu; ${value.missingTranscripts} eksik, ${value.unknownTranscripts} konumu doğrulanamadı.`,
            `${value.transcriptsFound} conversation files found; ${value.missingTranscripts} missing, ${value.unknownTranscripts} locations unverified.`,
          )}
        </p>
      )}
      {value && value.duplicates > 0 && (
        <p>
          {t(
            `${value.duplicates} yinelenen kart sonraki geçiş veya birleştirmede temizlenecek.`,
            `${value.duplicates} duplicate cards will be removed on the next switch or merge.`,
          )}
        </p>
      )}
      <small>
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
      <small>
        {t(
          "Dosyanın bulunması, başka hesabın konuşmayı sürdürebileceğini tek başına doğrulamaz.",
          "Finding a file alone does not verify that another account can resume the conversation.",
        )}
      </small>
    </div>
  );
}
