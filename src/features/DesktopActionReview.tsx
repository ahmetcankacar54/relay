import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Panda } from "@/components/Panda";
import { ArrowLeftRight, LoaderCircle, RefreshCw, X } from "lucide-react";
import type { Account } from "../../shared/types";

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

/**
 * Saving a Claude app sign-in is when Relay first uses its Keychain key, and a new Relay build
 * asks again: said wherever a sign-in is saved, and on a switch, which unseals the saved one
 * (most likely the first use after an update).
 */
export const KEYCHAIN_HINT = [
  "macOS bir kez Mac parolanı isteyebilir (Relay Safe Storage); “Her Zaman İzin Ver”i seç.",
  "macOS may ask for your Mac password once (Relay Safe Storage); choose “Always Allow”.",
] as const;

export function DesktopActionReview({
  account,
  active,
  kind,
  busy,
  t,
  confirm,
  cancel,
  historyAccounts = [],
  running = false,
}: {
  account?: Account;
  active?: Account;
  kind: DesktopActionKind;
  busy: boolean;
  t: (tr: string, en: string) => string;
  confirm: () => void;
  cancel: () => void;
  historyAccounts?: Account[];
  /** Confirmed here and still running: the panda replaces the confirmation. */
  running?: boolean;
}) {
  const [ready, setReady] = useState(false);
  const title =
    kind === "history"
      ? t("Ortak Code geçmişini birleştir", "Merge shared Code history")
      : kind === "recover"
        ? t("Yedeği geri yükle", "Restore backup")
        : kind === "cancel"
          ? t(
              "Girişi iptal et ve önceki hesaba dön",
              "Cancel sign-in and return to the previous account",
            )
          : kind === "switch"
            ? t("Claude uygulamasında başka hesaba geç", "Switch the Claude app to another account")
            : kind === "capture"
              ? t(
                  "Claude uygulamasında açık hesabı kaydet",
                  "Save the account open in the Claude app",
                )
              : t(
                  "Claude uygulamasına giriş yap",
                  "Sign in to the Claude app",
                );
  const progress =
    kind === "switch"
      ? t(`${account?.name} hesabına geçiliyor`, `Switching to ${account?.name}`)
      : kind === "history"
        ? t("Ortak geçmiş birleştiriliyor", "Merging shared history")
        : kind === "cancel" || kind === "recover"
          ? t("Yedek geri yükleniyor", "Restoring the backup")
          : kind === "capture"
            ? t("Açık hesap kaydediliyor", "Saving the open account")
            : t(
                "Claude uygulamasında giriş ekranı açılıyor",
                "Opening sign-in in the Claude app",
              );
  return (
    <section
      className="grid gap-3"
      aria-label={title}
      aria-live="polite"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-display text-base font-semibold">{title}</h3>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={busy}
          aria-label={t("İşlemi iptal et", "Cancel action")}
          onClick={cancel}
        >
          <X />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
        <span className="text-muted-foreground">
          {active?.name ?? t("Açık Claude hesabı", "Current Claude account")}
        </span>
        <ArrowLeftRight size={15} className="shrink-0 text-muted-foreground" />
        <strong className="font-semibold">
          {kind === "cancel" || kind === "recover"
            ? t(
                "Önceki Claude uygulaması girişi",
                "Previous Claude app sign-in",
              )
            : account?.name}
        </strong>
      </div>
      {running ? (
        <div className="grid justify-items-center gap-1 py-1 text-center">
          <Panda scene="travel" size={110} />
          <p className="text-sm font-semibold">{progress}</p>
          <p className="text-xs text-muted-foreground">
            {t("Claude uygulaması kapanıp yeniden açılıyor…", "The Claude app is quitting and reopening…")}
          </p>
        </div>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {kind === "history"
              ? t(
                  "Seçilen hesapların yerel Code oturumları ve proje kayıtları açık hesapla birleştirilir. Claude uygulaması yeniden başlatılır; hesap değişmez.",
                  "Local Code sessions and project records from the chosen accounts are merged into the current account. The Claude app restarts; the account stays the same.",
                )
              : kind === "cancel" || kind === "recover"
                ? t(
                    "Önceki Claude uygulaması girişi yedekten geri yüklenir. Claude uygulaması yeniden başlatılır; açık işler durabilir.",
                    "Your previous Claude app sign-in is restored from the backup. The Claude app restarts; active work may stop.",
                  )
                : kind === "switch"
                  ? t(
                      "Claude uygulamasına bu hesabın kayıtlı girişi yüklenir. Claude uygulaması yeniden başlar; açık yanıtlar ve alt görevler durabilir.",
                      "This account’s saved Claude app sign-in is put in place. The Claude app restarts; active responses and background tasks may stop.",
                    )
                  : kind === "capture"
                    ? t(
                        "Claude uygulamasında açık olan hesap bu profile kaydedilir. Kaydetmek için Claude uygulaması yeniden başlatılır.",
                        "The account currently open in the Claude app is saved to this profile. Saving restarts the Claude app.",
                      )
                    : t(
                        "Claude uygulaması yeniden başlatılır ve giriş ekranı açılır. Bu profilin hesabıyla giriş yaptıktan sonra Relay’e dön ve girişi kaydet.",
                        "The Claude app restarts and opens sign-in. Sign in with this profile’s account, then return to Relay to save the sign-in.",
                      )}
          </p>
          {(kind === "capture" ||
            kind === "login" ||
            kind === "reconnect" ||
            kind === "switch") && (
            <p className="text-xs text-muted-foreground">
              {t(...KEYCHAIN_HINT)}
            </p>
          )}
          {(kind === "history" || kind === "switch") &&
            historyAccounts.length > 0 && (
              <p className="text-sm">
                <strong>
                  {t("Geçmiş alınacak hesaplar", "History sources")}:{" "}
                </strong>
                {historyAccounts.map((a) => a.name).join(", ")}
              </p>
            )}
          <label className="flex items-start gap-2 text-sm">
            <input
              className="mt-0.5 size-4 shrink-0 accent-primary"
              type="checkbox"
              checked={ready}
              disabled={busy}
              onChange={(e) => setReady(e.target.checked)}
            />
            {t(
              "Çalışan işlerimi bitirdim; Claude uygulaması yeniden başlatılabilir.",
              "My running work is finished; the Claude app can restart.",
            )}
          </label>
        </>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" disabled={!ready || busy} onClick={confirm}>
          {busy ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <RefreshCw />
          )}
          {kind === "history"
            ? t("Birleştir ve yeniden başlat", "Merge and restart")
            : kind === "cancel" || kind === "recover"
              ? t("Geri yükle ve yeniden başlat", "Restore and restart")
              : kind === "switch"
                ? t("Yeniden başlat ve geç", "Restart and switch")
                : kind === "capture"
                  ? t("Kaydet ve yeniden başlat", "Save and restart")
                  : t("Yeniden başlat ve giriş ekranını aç", "Restart and open sign-in")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={cancel}
        >
          {t("Vazgeç", "Cancel")}
        </Button>
      </div>
    </section>
  );
}
