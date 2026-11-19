import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Private } from "@/components/Private";
import { useI18n, type Language, type T } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { cn } from "@/lib/utils";
import { limitHeadline } from "../../shared/quota-windows";
import type { Account, AntigravityAppResult, AntigravityAppState } from "../../shared/types";
import { headlineWords } from "./ToolList";

/** How long the last switch's outcome stays under the Antigravity row. */
const RESULT_MS = 5 * 60_000;

/** The last switch's or sign-in's outcome, in one sentence; undefined once it is old. */
export function antigravityResultText(
  app: AntigravityAppState | undefined,
  accounts: Account[],
  t: T,
  now: number,
): { text: string; bad: boolean } | undefined {
  const result: AntigravityAppResult | undefined = app?.result;
  if (!result || app?.busy || now - result.at > RESULT_MS) return undefined;
  const name = accounts.find((a) => a.id === result.accountId)?.name ?? t("hesap", "the account");
  switch (result.kind) {
    case "switched": {
      const agy = result.agyRunning
        ? t(
            ` ${result.agyRunning} açık agy oturumu eski hesapla sürüyor; yeniden başlat.`,
            ` ${result.agyRunning} running agy ${result.agyRunning === 1 ? "session stays" : "sessions stay"} on the old account; restart ${result.agyRunning === 1 ? "it" : "them"}.`,
          )
        : "";
      return { text: t(`Antigravity ${name} hesabında.${agy}`, `Antigravity is on ${name}.${agy}`), bad: false };
    }
    case "saved":
      return { text: t(`${name} girişi kaydedildi.`, `${name}'s sign-in is saved.`), bad: false };
    case "saved-other":
      return { text: t(`${name} ile girildi; giriş o hesap için kaydedildi.`, `Signed in with ${name}; saved for that account.`), bad: false };
    case "other":
      return {
        text: t("Relay'de olmayan bir Google hesabıyla girildi; kaydedilmedi.", "Signed in with a Google account Relay does not have; not saved."),
        bad: true,
      };
    case "cancelled":
      return { text: t("Vazgeçildi; önceki giriş geri kondu.", "Cancelled; the earlier sign-in is back."), bad: false };
    case "failed": {
      const why: Record<NonNullable<AntigravityAppResult["reason"]>, [string, string]> = {
        "still-running": [
          "Antigravity kapanmadı (bir onay sorusu açık olabilir). Kendin kapatıp yeniden dene.",
          "Antigravity did not close (a confirmation may be open). Close it yourself and try again.",
        ],
        "not-saved": ["Bu hesabın Antigravity girişi kayıtlı değil.", "This account's Antigravity sign-in is not saved."],
        keychain: ["Keychain'e yazılamadı; geçiş yapılmadı.", "The Keychain could not be written; nothing moved."],
        "verify-failed": ["Giriş yazıldı ama geri okunamadı; geçiş doğrulanamadı.", "The sign-in was written but did not read back; the switch is unconfirmed."],
        busy: ["Başka bir Antigravity işlemi sürüyor.", "Another Antigravity step is under way."],
        timeout: ["10 dakikada giriş yapılmadı; önceki giriş geri kondu.", "No sign-in within 10 minutes; the earlier one is back."],
        save: ["Mevcut giriş Relay'e kaydedilemedi; hiçbir şeye dokunulmadı.", "The current sign-in could not be saved in Relay; nothing was touched."],
        launch: ["Giriş değişti ama Antigravity yeniden açılamadı; kendin aç.", "The sign-in moved, but Antigravity did not open again; open it yourself."],
        cancelled: ["Vazgeçildi.", "Cancelled."],
      };
      return { text: t(...why[result.reason ?? "keychain"]), bad: true };
    }
  }
}

/**
 * The Antigravity app's accounts, to move it and `agy` to another (macOS). A saved sign-in moves with
 * one confirmed click: Relay closes the app, puts that sign-in in place and opens it again. One not
 * saved yet is made in the official app: Relay takes the current sign-in off this Mac (it stays saved,
 * and Google is not signed out), opens the app on its sign-in screen and keeps what the user signs in
 * with. Google does not support automated rotation, so nothing here moves by itself.
 */
export function AntigravitySwitch({
  preselect,
  compact,
  now,
  onDone,
}: {
  /** The account to confirm at once (the one the row suggests). */
  preselect?: string;
  compact?: boolean;
  now: number;
  onDone: () => void;
}) {
  const relay = useRelay();
  const { t, language } = useI18n();
  const app = relay.data?.antigravity;
  const [pick, setPick] = useState<{ id: string; step: "switch" | "save" } | undefined>(() =>
    preselect ? { id: preselect, step: app?.saved?.includes(preselect) ? "switch" : "save" } : undefined,
  );
  if (!app?.canSwitch) return null;
  const google = relay.accounts.filter((a) => a.provider === "antigravity");
  const saved = new Set(app.saved ?? []);
  const text = compact ? "text-2xs" : "text-xs";
  const disabled = !!relay.busy || !!app.busy;

  if (app.busy === "signing-in") {
    const target = google.find((a) => a.id === app.signInFor);
    return (
      <Frame compact={compact} slot="antigravity-sign-in">
        <p className={cn(text, "text-muted-foreground [&_b]:font-medium [&_b]:text-foreground")}>
          {t("Antigravity giriş ekranında açıldı. ", "Antigravity opened on its sign-in screen. ")}
          {target && (
            <>
              {t("Şu hesapla gir: ", "Sign in with ")}
              <b>{target.name}</b>
              {target.auth?.email && (
                <>
                  {" ("}
                  <Private>{target.auth.email}</Private>
                  {")"}
                </>
              )}
              {". "}
            </>
          )}
          {t("Relay girişi görünce kaydeder.", "Relay keeps the sign-in once it appears.")}
        </p>
        <Button size="xs" variant="outline" className="justify-self-start" onClick={() => void relay.action("antigravity", () => relay.api.cancelAntigravitySignIn())}>
          {t("Vazgeç", "Cancel")}
        </Button>
      </Frame>
    );
  }

  if (pick) {
    const target = google.find((a) => a.id === pick.id);
    if (!target) return null;
    const run = (fn: () => Promise<unknown>) =>
      void relay.action("antigravity", async () => {
        await fn();
        setPick(undefined);
        onDone();
      });
    return (
      <Frame compact={compact} slot={pick.step === "switch" ? "antigravity-confirm" : "antigravity-save"}>
        <p className={cn(text, "text-muted-foreground [&_b]:font-medium [&_b]:text-foreground")}>
          {pick.step === "switch" ? (
            <>
              {t("Antigravity kapanır ve ", "Antigravity closes and opens again on ")}
              <b>{target.name}</b>
              {t(
                " ile yeniden açılır. Uygulamada çalışan işler durur; yeni açılan agy oturumları da bu hesabı kullanır.",
                ". Work running in the app stops; agy sessions started after it use this account too.",
              )}
            </>
          ) : (
            <>
              {t("Relay, Antigravity'deki girişi bu Mac'ten kaldırır (kayıtlı kalır, Google'da çıkış yapılmaz) ve uygulamayı giriş ekranında açar. ", "Relay takes Antigravity's sign-in off this Mac (it stays saved; Google is not signed out) and opens the app on its sign-in screen. ")}
              {t("Orada ", "Sign in there with ")}
              <b>{target.name}</b>
              {t(" ile gir; Relay girişi kaydeder.", "; Relay keeps the sign-in.")}
            </>
          )}
        </p>
        <div className="flex flex-wrap gap-1.5">
          <Button
            size="xs"
            disabled={disabled}
            onClick={() =>
              pick.step === "switch"
                ? run(() => relay.api.switchAntigravity(target.id))
                : run(() => relay.api.saveAntigravitySignIn(target.id))
            }
          >
            {pick.step === "switch" ? t(`${target.name} hesabına geç`, `Switch to ${target.name}`) : t("Başlat", "Start")}
          </Button>
          <Button size="xs" variant="outline" onClick={() => setPick(undefined)}>
            {t("Vazgeç", "Cancel")}
          </Button>
        </div>
      </Frame>
    );
  }

  const others = google.filter((a) => a.id !== app.accountId);
  return (
    <Frame compact={compact} slot="antigravity-accounts">
      <ul className="grid gap-1">
        {others.map((account) => (
          <li key={account.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
            <div className="min-w-0">
              <p className={cn(text, "truncate font-medium")}>{account.name}</p>
              <p className={cn(text, "truncate text-muted-foreground")}>{roomLine(account, relay.data?.usage?.[account.id], t, language, now)}</p>
            </div>
            <Button
              size="xs"
              variant={saved.has(account.id) ? "default" : "outline"}
              disabled={disabled}
              onClick={() => setPick({ id: account.id, step: saved.has(account.id) ? "switch" : "save" })}
            >
              {saved.has(account.id) ? t("Geç", "Switch") : t("Girişi kaydet", "Save sign-in")}
            </Button>
          </li>
        ))}
      </ul>
      <p className={cn(compact ? "text-2xs" : "text-2xs", "text-muted-foreground")}>
        {t(
          "Google otomatik hesap rotasyonunu desteklemiyor; Relay yalnızca senin tıklamanla geçer.",
          "Google does not support automated account rotation; Relay switches only when you click.",
        )}
      </p>
    </Frame>
  );
}

function roomLine(account: Account, usage: Parameters<typeof limitHeadline>[0], t: T, language: Language, now: number) {
  const head = limitHeadline(usage, now);
  return head ? headlineWords(head, t, language, now) : t("Limit verisi yok", "No usage data");
}

function Frame({ compact, slot, children }: { compact?: boolean; slot: string; children: React.ReactNode }) {
  return (
    <div data-slot={slot} className={cn("grid gap-1.5 rounded-md bg-muted/60", compact ? "px-2 py-1.5" : "px-2.5 py-2")}>
      {children}
    </div>
  );
}
