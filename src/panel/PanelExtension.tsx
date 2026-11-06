import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useI18n, type T } from "@/data/i18n";
import { useRelay, type Relay } from "@/data/relay-context";
import type { ExtensionOffer } from "../../shared/types";
import { extensionLine } from "../../shared/extension-text";
import { panelCard, panelEyebrow } from "./PanelActiveCard";

export const EXTENSION_SYNC_KEY = "extension-sync";

/** Where the extension was left: on another account, signed out, or somewhere Relay cannot name. */
export function extensionOfferLine(offer: ExtensionOffer, t: T): string {
  if (offer.on)
    return t(
      `Eklenti ${offer.on} hesabında kaldı`,
      `The extension is still on ${offer.on}`,
    );
  if (offer.signedOut)
    return t("Eklentide giriş yok", "The extension is signed out");
  if (offer.reconnect)
    return t(
      `Eklenti ${offer.to} hesabına giriş yapamıyor`,
      `The extension cannot sign in to ${offer.to}`,
    );
  if (offer.expired)
    return t("Eklenti girişinin süresi doldu", "The extension’s sign-in expired");
  return t(
    `Eklenti ${offer.to} hesabına geçmedi`,
    `The extension did not switch to ${offer.to}`,
  );
}

/** What bringing it along does, before and while the user confirms. */
export function extensionOfferHint(
  offer: ExtensionOffer,
  confirming: boolean,
  t: T,
): string {
  if (offer.reconnect)
    return t(
      `claude.ai’de ${offer.to} ile giriş yap, sonra eklentide “Log in”e bas.`,
      `Sign in to claude.ai with ${offer.to}, then select “Log in” in the extension.`,
    );
  if (offer.expired)
    return confirming
      ? t(
          `${offer.browser} kapanıp sekmeleriyle yeniden açılacak; eklenti ${offer.to} ile yeniden giriş yapacak.`,
          `${offer.browser} quits and reopens with its tabs; the extension signs in to ${offer.to} again.`,
        )
      : t(
          "Claude’un tarayıcı araçları çalışmıyor. Düzelt işe yaramazsa eklentinin yan panelinden giriş yap.",
          "Claude’s browser tools do not work. If Fix does not help, sign in from the extension’s side panel.",
        );
  return confirming
    ? t(
        `${offer.browser} kapanıp sekmeleriyle yeniden açılacak, claude.ai oturumu da ${offer.to} olacak.`,
        `${offer.browser} quits and reopens with its tabs; its claude.ai login changes to ${offer.to}.`,
      )
    : t(
        `${offer.to} hesabının eklenti girişi kayıtlı.`,
        `${offer.to}’s extension sign-in is saved.`,
      );
}

/** Runs the extension step for Desktop's account; says what happened unless it simply switched. */
export const syncExtensionAction = (
  relay: Relay,
  t: T,
  say: (line: string | undefined) => void,
) =>
  relay.action(EXTENSION_SYNC_KEY, async () => {
    const outcome = await relay.api.syncExtension();
    say(outcome.result === "switched" ? undefined : extensionLine(outcome, t));
  });

/**
 * The Claude browser extension left on another account than Desktop's, after a switch that did
 * not change it (mode "guide", or "closed" with the browser open) or a check: Switch, confirmed
 * first because it quits the browser and changes its claude.ai login too.
 */
export function PanelExtension() {
  const relay = useRelay();
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<string>();
  const offer = relay.data?.extension;
  if (!offer && !result) return null;
  const running = relay.busy === EXTENSION_SYNC_KEY;
  const disabled = running || !!relay.busy || !!relay.desktop?.busy;
  return (
    <section className="px-3 py-1.5">
      <div className={panelEyebrow}>
        {t("Tarayıcı eklentisi", "Browser extension")}
      </div>
      <div
        // While confirming, the longer sentence takes the width and the buttons go under it.
        className={`${panelCard} grid ${confirming ? "grid-cols-1" : "grid-cols-[1fr_auto]"} items-center gap-2 px-2 py-1.5`}
      >
        <div className="min-w-0">
          <div className="min-w-0 font-semibold">
            {offer
              ? extensionOfferLine(offer, t)
              : t("Eklenti geçirilemedi", "The extension did not switch")}
          </div>
          <div
            className="min-w-0 text-xs text-muted-foreground"
            role={result ? "status" : undefined}
          >
            {result ?? (offer ? extensionOfferHint(offer, confirming, t) : "")}
          </div>
        </div>
        <span
          className={`flex shrink-0 gap-1 ${confirming ? "justify-end" : ""}`}
        >
          {offer?.reconnect && (
            // Nothing is quit or written: it opens the steps in Settings.
            <Button
              size="xs"
              disabled={disabled}
              onClick={() => void relay.api.openExtensionSettings()}
            >
              {t("Yeniden bağla", "Reconnect")}
            </Button>
          )}
          {offer && !offer.reconnect && !confirming && (
            <Button
              size="xs"
              disabled={disabled}
              onClick={() => {
                setResult(undefined);
                setConfirming(true);
              }}
            >
              {offer.expired ? t("Düzelt", "Fix") : t("Geçir", "Switch")}
            </Button>
          )}
          {offer && confirming && (
            <>
              <Button
                size="xs"
                disabled={disabled}
                onClick={() =>
                  void syncExtensionAction(relay, t, setResult).finally(() =>
                    setConfirming(false),
                  )
                }
              >
                {offer.expired ? t("Evet, düzelt", "Yes, fix") : t("Evet, geçir", "Yes, switch")}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={running}
                onClick={() => setConfirming(false)}
              >
                {t("Vazgeç", "Cancel")}
              </Button>
            </>
          )}
          {!offer && result && (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setResult(undefined)}
            >
              {t("Kapat", "Dismiss")}
            </Button>
          )}
        </span>
      </div>
    </section>
  );
}
