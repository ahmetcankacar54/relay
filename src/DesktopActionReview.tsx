import { useState } from "react";
import { ArrowLeftRight, LoaderCircle, RefreshCw, X } from "lucide-react";
import type { Account } from "../shared/types";

export type DesktopActionKind =
  | "switch"
  | "login"
  | "reconnect"
  | "capture"
  | "cancel"
  | "recover"
  | "history";
export interface DesktopActionRequest {
  accountId: string;
  kind: DesktopActionKind;
}

export function DesktopActionReview({
  account,
  active,
  kind,
  busy,
  t,
  confirm,
  cancel,
  historyAccounts = [],
}: {
  account?: Account;
  active?: Account;
  kind: DesktopActionKind;
  busy: boolean;
  t: (tr: string, en: string) => string;
  confirm: () => void;
  cancel: () => void;
  historyAccounts?: Account[];
}) {
  const [ready, setReady] = useState(false);
  const title =
    kind === "history"
      ? t("Ortak Code geçmişini birleştir", "Merge shared Code history")
      : kind === "recover"
        ? t("Desktop yedeğini geri yükle", "Restore Desktop backup")
        : kind === "cancel"
          ? t(
              "Girişi iptal et ve önceki hesaba dön",
              "Cancel sign-in and return to the previous account",
            )
          : kind === "switch"
            ? t("Desktop hesabını değiştir", "Switch Desktop account")
            : kind === "capture"
              ? t(
                  "Açık Desktop hesabını kaydet",
                  "Save the open Desktop account",
                )
              : t("Desktop bağlantısını kur", "Connect Desktop");
  return (
    <section className="desktop-review" aria-label={title} aria-live="polite">
      <div className="form-title">
        <h3>{title}</h3>
        <button
          className="icon"
          disabled={busy}
          aria-label={t("İşlemi iptal et", "Cancel action")}
          onClick={cancel}
        >
          <X size={16} />
        </button>
      </div>
      <div className="switch-route">
        <span>
          {active?.name ?? t("Açık Claude hesabı", "Current Claude account")}
        </span>
        <ArrowLeftRight size={15} />
        <strong>
          {kind === "cancel" || kind === "recover"
            ? t("Önceki Desktop bağlantısı", "Previous Desktop connection")
            : account?.name}
        </strong>
      </div>
      <p>
        {kind === "history"
          ? t(
              "Seçilen hesapların yerel Code oturumları ve proje kayıtları açık hesapla birleştirilir. Claude yeniden başlatılır; hesap değişmez.",
              "Local Code sessions and project records from the chosen accounts are merged into the current account. Claude restarts; the account stays the same.",
            )
          : kind === "cancel" || kind === "recover"
            ? t(
                "Önceki bağlantı yedekten geri yüklenir. Claude yeniden başlatılır; açık işler durabilir.",
                "Your previous connection is restored from backup. Claude restarts; active work may stop.",
              )
            : kind === "switch"
              ? t(
                  "Kaydedilmiş Desktop bağlantısı açılır. Claude yeniden başlar; açık yanıtlar ve alt görevler durabilir.",
                  "Your saved Desktop connection opens. Claude restarts; active responses and background tasks may stop.",
                )
              : kind === "capture"
                ? t(
                    "Claude’da açık olan hesap bu profile kaydedilir. Kaydetmek için Claude yeniden başlatılır.",
                    "The account currently open in Claude is saved to this profile. Saving restarts Claude.",
                  )
                : t(
                    "Claude yeniden başlatılır ve giriş ekranı açılır. Bu profilin hesabıyla giriş yaptıktan sonra Relay’e dönüp bağlantıyı kaydet.",
                    "Claude restarts and opens sign-in. Sign in with this profile’s account, then return to Relay to save the connection.",
                  )}
      </p>
      {(kind === "history" || kind === "switch") &&
        historyAccounts.length > 0 && (
          <p className="review-history-scope">
            <strong>
              {t("Geçmiş alınacak hesaplar", "History sources")}:{" "}
            </strong>
            {historyAccounts.map((a) => a.name).join(", ")}
          </p>
        )}
      <label className="restart-consent">
        <input
          type="checkbox"
          checked={ready}
          disabled={busy}
          onChange={(e) => setReady(e.target.checked)}
        />
        {t(
          "Çalışan işlerimi bitirdim; Claude yeniden başlatılabilir.",
          "My running work is finished; Claude can restart.",
        )}
      </label>
      <div className="panel-actions">
        <button className="primary" disabled={!ready || busy} onClick={confirm}>
          {busy ? (
            <LoaderCircle size={14} className="spin" />
          ) : (
            <RefreshCw size={14} />
          )}
          {kind === "history"
            ? t("Birleştir ve yeniden başlat", "Merge and restart")
            : kind === "cancel" || kind === "recover"
              ? t("Geri yükle ve yeniden başlat", "Restore and restart")
              : kind === "switch"
                ? t("Yeniden başlat ve geç", "Restart and switch")
                : kind === "capture"
                  ? t("Kaydet ve yeniden başlat", "Save and restart")
                  : t("Yeniden başlat ve giriş aç", "Restart and open sign-in")}
        </button>
        <button className="text-button" disabled={busy} onClick={cancel}>
          {t("Vazgeç", "Cancel")}
        </button>
      </div>
    </section>
  );
}
