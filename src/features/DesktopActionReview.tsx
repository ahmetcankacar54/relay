import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Panda } from "@/components/Panda";
import { ArrowLeftRight, LoaderCircle, X } from "lucide-react";
import { RefreshIcon } from "@/components/icons";
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
  "macOS Mac parolanı isterse (Relay Safe Storage) “Her Zaman İzin Ver”i seç.",
  "If macOS asks for your Mac password (Relay Safe Storage), select “Always Allow”.",
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
  fullLimit,
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
  /** A switch to an account whose limit is full: what that means, said before the switch. */
  fullLimit?: string;
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
      ? t(`${account?.name} hesabına geçiliyor`, `Relay switches to ${account?.name}`)
      : kind === "history"
        ? t("Ortak geçmiş birleştiriliyor", "Relay merges the shared history")
        : kind === "cancel" || kind === "recover"
          ? t("Yedek geri yükleniyor", "Relay restores the backup")
          : kind === "capture"
            ? t("Açık hesap kaydediliyor", "Relay saves the open account")
            : t(
                "Claude uygulamasında giriş ekranı açılıyor",
                "The Claude app opens its sign-in screen",
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
          {active?.name ?? t("Açık hesap", "Current account")}
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
            {t("Claude uygulaması kapanıp yeniden açılıyor…", "The Claude app restarts…")}
          </p>
        </div>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {kind === "history"
              ? t(
                  "Seçilen hesapların yerel Code oturumları ve projeleri açık hesapla birleştirilir. Claude uygulaması yeniden başlar; hesap değişmez.",
                  "Relay merges the local Code sessions and projects of the selected accounts into the current account. The Claude app restarts. The account does not change.",
                )
              : kind === "cancel" || kind === "recover"
                ? t(
                    "Önceki Claude uygulaması girişi yedekten geri yüklenir. Claude uygulaması yeniden başlar; açık işler durabilir.",
                    "Relay restores your previous Claude app sign-in from the backup. The Claude app restarts, and active work can stop.",
                  )
                : kind === "switch"
                  ? t(
                      "Claude uygulaması bu hesapla yeniden başlar. Açık yanıtlar ve arka plan görevleri durabilir.",
                      "The Claude app restarts with this account. Active responses and background tasks can stop.",
                    )
                  : kind === "capture"
                    ? t(
                        "Claude uygulamasında açık hesap bu profile kaydedilir. Claude uygulaması yeniden başlar.",
                        "Relay saves the account open in the Claude app to this profile. The Claude app restarts.",
                      )
                    : t(
                        "Claude uygulaması giriş ekranıyla yeniden başlar. Bu profilin hesabıyla giriş yap, sonra Code’u aç. Relay girişi kaydeder ve Claude uygulamasını bir kez daha yeniden başlatır.",
                        "The Claude app restarts on its sign-in screen. Sign in with this profile’s account. Then open Code. Relay saves the sign-in and restarts the Claude app again.",
                      )}
          </p>
          {kind === "switch" && fullLimit && (
            <p
              data-slot="switch-full-limit"
              className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn-foreground"
            >
              {fullLimit}
            </p>
          )}
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
              "İşlerimi bitirdim; Claude uygulaması yeniden başlayabilir.",
              "My work is finished. The Claude app can restart.",
            )}
          </label>
        </>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" disabled={!ready || busy} onClick={confirm}>
          {busy ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <RefreshIcon />
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
