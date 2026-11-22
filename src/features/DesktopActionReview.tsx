import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Panda } from "@/components/Panda";
import { ArrowLeftRight, LoaderCircle, X } from "lucide-react";
import { RefreshIcon } from "@/components/icons";
import type { Account } from "../../shared/types";
import { macWording, usePlatform } from "@/data/platform";
import type { MessageId, T } from "../../shared/i18n/translate";

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
 * (most likely the first use after an update). On Linux the desktop's keyring asks instead.
 */
export const keychainHint = (platform?: string): MessageId =>
  macWording(platform)
    ? "desktopActionReview.ifMacosAsksForYourMac"
    : "desktopActionReview.ifYourKeyringKwalletOrSecret";

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
  t: T;
  confirm: () => void;
  cancel: () => void;
  historyAccounts?: Account[];
  /** Confirmed here and still running: the panda replaces the confirmation. */
  running?: boolean;
  /** A switch to an account whose limit is full: what that means, said before the switch. */
  fullLimit?: string;
}) {
  const [ready, setReady] = useState(false);
  const hint = keychainHint(usePlatform());
  const title =
    kind === "history"
      ? t("desktopActionReview.mergeSharedCodeHistory")
      : kind === "recover"
        ? t("desktopActionReview.restoreBackup")
        : kind === "cancel"
          ? t("desktopActionReview.cancelSignInAndReturnTo")
          : kind === "switch"
            ? t("desktopActionReview.switchTheClaudeAppToAnother")
            : kind === "capture"
              ? t("desktopActionReview.saveTheAccountOpenInThe")
              : t("common.signInToTheClaudeApp");
  const progress =
    kind === "switch"
      ? t("desktopActionReview.relaySwitchesTo", { accountName: account?.name })
      : kind === "history"
        ? t("desktopActionReview.relayMergesTheSharedHistory")
        : kind === "cancel" || kind === "recover"
          ? t("desktopActionReview.relayRestoresTheBackup")
          : kind === "capture"
            ? t("desktopActionReview.relaySavesTheOpenAccount")
            : t("desktopActionReview.theClaudeAppOpensItsSign");
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
          aria-label={t("desktopActionReview.cancelAction")}
          onClick={cancel}
        >
          <X />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
        <span className="text-muted-foreground">
          {active?.name ?? t("desktopActionReview.currentAccount")}
        </span>
        <ArrowLeftRight size={15} className="shrink-0 text-muted-foreground" />
        <strong className="font-semibold">
          {kind === "cancel" || kind === "recover"
            ? t("desktopActionReview.previousClaudeAppSignIn")
            : account?.name}
        </strong>
      </div>
      {running ? (
        <div className="grid justify-items-center gap-1 py-1 text-center">
          <Panda scene="travel" size={110} />
          <p className="text-sm font-semibold">{progress}</p>
          <p className="text-xs text-muted-foreground">
            {t("desktopActionReview.theClaudeAppRestarts")}
          </p>
        </div>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {kind === "history"
              ? t("desktopActionReview.relayMergesTheLocalCodeSessions")
              : kind === "cancel" || kind === "recover"
                ? t("desktopActionReview.relayRestoresYourPreviousClaudeApp")
                : kind === "switch"
                  ? t("desktopActionReview.theClaudeAppRestartsWithThis")
                  : kind === "capture"
                    ? t("desktopActionReview.relaySavesTheAccountOpenIn")
                    : t("desktopActionReview.theClaudeAppRestartsOnIts")}
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
              {t(hint)}
            </p>
          )}
          {(kind === "history" || kind === "switch") &&
            historyAccounts.length > 0 && (
              <p className="text-sm">
                <strong>
                  {t("desktopActionReview.historySources")}:{" "}
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
            {t("desktopActionReview.myWorkIsFinishedTheClaude")}
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
            ? t("desktopActionReview.mergeAndRestart")
            : kind === "cancel" || kind === "recover"
              ? t("desktopActionReview.restoreAndRestart")
              : kind === "switch"
                ? t("desktopActionReview.restartAndSwitch")
                : kind === "capture"
                  ? t("desktopActionReview.saveAndRestart")
                  : t("desktopActionReview.restartAndOpenSignIn")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={cancel}
        >
          {t("common.cancel")}
        </Button>
      </div>
    </section>
  );
}
