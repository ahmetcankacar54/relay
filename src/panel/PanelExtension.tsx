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
    return t("panelExtension.theExtensionIsStillOn", { offerOn: offer.on });
  if (offer.signedOut)
    return t("panelExtension.theExtensionIsSignedOut");
  if (offer.reconnect)
    return t("panelExtension.theExtensionCannotSignInTo", { offerTo: offer.to });
  if (offer.expired)
    return t("panelExtension.theExtensionSSignInExpired");
  return t("panelExtension.theExtensionDidNotSwitchTo", { offerTo: offer.to });
}

/** What bringing it along does, before and while the user confirms. */
export function extensionOfferHint(
  offer: ExtensionOffer,
  confirming: boolean,
  t: T,
): string {
  if (offer.reconnect)
    return t("panelExtension.signInToClaudeAiWith", { offerTo: offer.to });
  if (offer.expired)
    return confirming
      ? t("panelExtension.quitsAndReopensWithItsTabs", { offerBrowser: offer.browser, offerTo: offer.to })
      : t("panelExtension.claudeSBrowserToolsDoNot");
  return confirming
    ? t("panelExtension.quitsAndReopensWithItsTabs2", { offerBrowser: offer.browser, offerTo: offer.to })
    : t("panelExtension.sExtensionSignInIsSaved", { offerTo: offer.to });
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
        {t("panelExtension.browserExtension")}
      </div>
      <div
        // While confirming, the longer sentence takes the width and the buttons go under it.
        className={`${panelCard} grid ${confirming ? "grid-cols-1" : "grid-cols-[1fr_auto]"} items-center gap-2 px-2 py-1.5`}
      >
        <div className="min-w-0">
          <div className="min-w-0 font-semibold">
            {offer
              ? extensionOfferLine(offer, t)
              : t("panelExtension.theExtensionDidNotSwitch")}
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
              onClick={() => void relay.report(() => relay.api.openExtensionSettings())}
            >
              {t("panelExtension.reconnect")}
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
              {offer.expired ? t("panelExtension.fix") : t("panelExtension.switch")}
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
                {offer.expired ? t("panelExtension.yesFix") : t("panelExtension.yesSwitch")}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={running}
                onClick={() => setConfirming(false)}
              >
                {t("common.cancel")}
              </Button>
            </>
          )}
          {!offer && result && (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setResult(undefined)}
            >
              {t("common.dismiss")}
            </Button>
          )}
        </span>
      </div>
    </section>
  );
}
