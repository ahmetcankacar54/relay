import { cva } from "class-variance-authority";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Private } from "@/components/Private";
import { Trans, useI18n, type MessageId, type T } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { cn } from "@/lib/utils";
import type { Account, AntigravityAppResult, AntigravityAppState } from "../../shared/types";

/**
 * Where an Antigravity account stands with the Antigravity app: `current` (the app and agy use it),
 * `saved` (Relay keeps its app sign-in: one click moves there), `unsaved` (its sign-in is made once in
 * the app), `waiting` (Relay waits for that sign-in), `unavailable` (Relay cannot move the app here:
 * not macOS, or the app is not installed).
 */
export type AntigravityAccountState = "current" | "saved" | "unsaved" | "waiting" | "unavailable";

export function antigravityAccountState(app: AntigravityAppState | undefined, accountId: string): AntigravityAccountState {
  if (!app?.installed || !app.canSwitch) return app?.installed && app.accountId === accountId ? "current" : "unavailable";
  if (app.busy === "signing-in" && app.signInFor === accountId) return "waiting";
  if (app.accountId === accountId) return "current";
  return app.saved?.includes(accountId) ? "saved" : "unsaved";
}

/** A step the user asked for and confirms next: move the app there, or save that account's sign-in. */
export interface AntigravityAsk {
  accountId: string;
  step: "switch" | "save";
}

/**
 * The one button an Antigravity account has, wherever it is listed: "Geç" for a saved sign-in,
 * "Girişi kaydet" for one not saved yet. Nothing for the account in use, or where Relay cannot move
 * the app. It only asks; `AntigravityPrompt` confirms.
 */
export function AntigravityAction({
  account,
  onAsk,
  primary,
}: {
  account: Account;
  onAsk: (ask: AntigravityAsk) => void;
  /** The suggested move (the account in use is full): the filled button. */
  primary?: boolean;
}) {
  const relay = useRelay();
  const { t } = useI18n();
  const app = relay.data?.antigravity;
  const state = antigravityAccountState(app, account.id);
  if (state !== "saved" && state !== "unsaved") return null;
  const busy = !!app?.busy || !!relay.busy;
  return state === "saved" ? (
    <Button
      size="xs"
      variant={primary ? "default" : "outline"}
      disabled={busy}
      aria-label={t("antigravityAccount.moveAntigravityTo", { accountName: account.name })}
      onClick={() => onAsk({ accountId: account.id, step: "switch" })}
    >
      {t("common.switch")}
    </Button>
  ) : (
    <Button
      size="xs"
      variant="outline"
      disabled={busy}
      aria-label={t("antigravityAccount.saveSAntigravitySignIn", { accountName: account.name })}
      onClick={() => onAsk({ accountId: account.id, step: "save" })}
    >
      {t("common.saveSignIn")}
    </Button>
  );
}

/** How long the last switch's outcome stays shown. */
const RESULT_MS = 5 * 60_000;

/** The last switch's or sign-in's outcome, in one short sentence; undefined once it is old. */
export function antigravityResultText(
  app: AntigravityAppState | undefined,
  accounts: Account[],
  t: T,
  now: number,
): { text: string; bad: boolean } | undefined {
  const result: AntigravityAppResult | undefined = app?.result;
  if (!result || app?.busy || now - result.at > RESULT_MS) return undefined;
  const name = accounts.find((a) => a.id === result.accountId)?.name ?? t("antigravityAccount.theAccount");
  switch (result.kind) {
    case "switched":
      return {
        text: result.agyRunning
          ? t("antigravityAccount.movedToRunningAgyOnThe", { name, resultAgyRunning: result.agyRunning })
          : t("antigravityAccount.movedTo", { name }),
        bad: false,
      };
    case "saved":
      return { text: t("antigravityAccount.sSignInIsSaved", { name }), bad: false };
    case "saved-other":
      return { text: t("antigravityAccount.signedInWithSavedThere", { name }), bad: false };
    case "other":
      return { text: t("antigravityAccount.signedInWithAnAccountRelay"), bad: true };
    case "cancelled":
      return { text: t("antigravityAccount.cancelledTheEarlierSignInIs"), bad: false };
    case "failed": {
      const why: Record<NonNullable<AntigravityAppResult["reason"]>, MessageId> = {
        "still-running": "antigravityAccount.antigravityDidNotClose",
        "not-saved": "antigravityAccount.thisAccountSSignInIs",
        keychain: "antigravityAccount.theKeychainCouldNotBe",
        "verify-failed": "antigravityAccount.theSignInWasWritten",
        busy: "antigravityAccount.anotherAntigravityStepIsRunning",
        timeout: "antigravityAccount.noSignInIn10",
        save: "antigravityAccount.theCurrentSignInCould",
        launch: "antigravityAccount.theSignInMovedBut",
        cancelled: "antigravityAccount.cancelled",
        unexpected: "antigravityAccount.theSwitchDidNotFinish",
      };
      return { text: t(why[result.reason ?? "unexpected"]), bad: true };
    }
  }
}

const promptBox = cva("grid gap-2 rounded-md border", {
  variants: {
    tone: { plain: "bg-muted/60", warn: "border-warn/40 bg-warn/10" },
    size: { sm: "px-2.5 py-2 text-2xs", md: "px-3 py-2.5 text-xs" },
  },
  defaultVariants: { tone: "plain", size: "md" },
});

/**
 * What follows a click on `AntigravityAction`, in one or two short lines: the confirmation of a
 * switch or of a sign-in, the wait for that sign-in (with its cancel), or how the last one ended.
 * On a Mac where Relay cannot move the app, nothing.
 */
export function AntigravityPrompt({
  ask,
  onClose,
  now,
  size = "md",
}: {
  ask?: AntigravityAsk;
  onClose: () => void;
  now: number;
  size?: "sm" | "md";
}) {
  const relay = useRelay();
  const { t } = useI18n();
  const app = relay.data?.antigravity;
  if (!app?.canSwitch) return null;
  const google = relay.accounts.filter((a) => a.provider === "antigravity");
  const named = (id?: string) => google.find((a) => a.id === id);

  if (app.busy === "signing-in") {
    const target = named(app.signInFor);
    return (
      <div data-slot="antigravity-sign-in" role="status" className={promptBox({ size })}>
        <p className="text-muted-foreground [&_b]:font-medium [&_b]:text-foreground">
          <Trans
            id="antigravityAccount.signInWithNameWaiting"
            params={{ name: target?.name ?? t("antigravityAccount.theAccount") }}
            components={{ b: bold, email: emailOf(target) }}
          />
        </p>
        <Button size="xs" variant="outline" className="justify-self-start" onClick={() => void relay.action("antigravity", () => relay.api.cancelAntigravitySignIn())}>
          {t("common.cancel")}
        </Button>
      </div>
    );
  }
  if (app.busy === "switching")
    return (
      <p role="status" className={cn(promptBox({ size }), "text-muted-foreground")}>
        {t("antigravityAccount.antigravityIsSwitching")}
      </p>
    );

  const target = named(ask?.accountId);
  if (ask && target) {
    const run = (fn: () => Promise<unknown>) =>
      void relay.action("antigravity", async () => {
        await fn();
        onClose();
      });
    return (
      <div data-slot={ask.step === "switch" ? "antigravity-confirm" : "antigravity-save"} className={promptBox({ size, tone: "warn" })}>
        <p className="text-warn-foreground [&_b]:font-semibold">
          {ask.step === "switch" ? (
            <Trans id="antigravityAccount.quitsAndOpensOnName" params={{ name: target.name }} components={{ b: bold }} />
          ) : (
            <Trans id="antigravityAccount.opensOnSignInScreenName" params={{ name: target.name }} components={{ b: bold }} />
          )}
        </p>
        <div className="flex flex-wrap gap-1.5">
          <Button
            size="xs"
            disabled={!!relay.busy}
            onClick={() =>
              ask.step === "switch"
                ? run(() => relay.api.switchAntigravity(target.id))
                : run(() => relay.api.saveAntigravitySignIn(target.id))
            }
          >
            {ask.step === "switch" ? t("common.switch") : t("antigravityAccount.start")}
          </Button>
          <Button size="xs" variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
        </div>
      </div>
    );
  }

  const result = antigravityResultText(app, relay.accounts, t, now);
  return result ? (
    <p data-slot="antigravity-result" role="status" className={cn(size === "sm" ? "text-2xs" : "text-xs", result.bad ? "text-crit" : "text-muted-foreground")}>
      {result.text}
    </p>
  ) : null;
}

/** A bold name inside a translated sentence. */
const bold = (chunks: ReactNode[]) => <b>{chunks}</b>;
/** The account's email after its name, " (…)", hidden while private; nothing without one. */
const emailOf = (account: Account | undefined) => () =>
  account?.auth?.email ? (
    <>
      {" ("}
      <Private>{account.auth.email}</Private>
      {")"}
    </>
  ) : null;

/**
 * Where Relay cannot move the app (not macOS): how to move it by hand, in three steps. The app
 * talks to Google with the account it signed in with and reads it only at start.
 */
export function AntigravitySteps({ target, size = "md" }: { target: Account; size?: "sm" | "md" }) {
  const relay = useRelay();
  const { t } = useI18n();
  return (
    <div data-slot="antigravity-steps" className={promptBox({ size })}>
      <ol className="ml-4 list-decimal space-y-0.5 text-muted-foreground [&_b]:font-medium [&_b]:text-foreground">
        <li>{t("antigravityAccount.inAntigravitySignOutFromThe")}</li>
        <li>
          <Trans id="antigravityAccount.signInWithName" params={{ name: target.name }} components={{ b: bold, email: emailOf(target) }} />
        </li>
        <li>{t("antigravityAccount.startANewAgyRunningOnes")}</li>
      </ol>
      {relay.data?.antigravity?.canOpen && (
        <Button size="xs" variant="outline" className="justify-self-start" onClick={() => void relay.action("antigravity", () => relay.api.openAntigravity())}>
          {t("antigravityAccount.openAntigravity")}
        </Button>
      )}
    </div>
  );
}
