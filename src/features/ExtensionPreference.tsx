import { useState } from "react";
import { BROWSERS, DEFAULT_EXTENSION } from "../../shared/browser-extension";
import type { ExtensionMode, ExtensionStatus } from "../../shared/types";
import { extensionLine } from "../../shared/extension-text";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/Disclosure";
import { Note, OptionSelect, SectionHeading, SettingRow } from "@/components/SettingRow";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { useExtensionStatus } from "@/data/useExtension";
import {
  instanceFromValue,
  instanceLabel,
  instanceLine,
  instanceValue,
  modeOptions,
  modeSentence,
  pairedAccounts,
  startupLine,
  accountUuids,
} from "@/lib/extension-ui";

/** Which accounts have the extension's sign-in and the browser's claude.ai login saved, and which only one. */
function pairLine(
  status: ExtensionStatus,
  accounts: Parameters<typeof pairedAccounts>[1],
  t: (tr: string, en: string) => string,
): string {
  const { paired, half } = pairedAccounts(status, accounts);
  const list = (names: string[]) => names.join(", ");
  const parts = [
    paired.length
      ? t(
          `Eklenti girişi ve claude.ai oturumu kayıtlı hesaplar: ${list(paired)}.`,
          `Extension sign-in and claude.ai login both saved: ${list(paired)}.`,
        )
      : t("İkisi de kayıtlı olan bir hesap henüz yok.", "No account has both saved yet."),
    half.length
      ? t(
          `Kaydı eksik olanlar: ${list(half)}. Her biri için o hesapla claude.ai’ye gir, eklentiyi aç, sonra “Kontrol et”e bas.`,
          `Missing one of the two: ${list(half)}. For each, sign in to claude.ai with that account, open the extension, then press “Check”.`,
        )
      : "",
  ];
  return parts.filter(Boolean).join(" ");
}

/**
 * What Relay does with the Claude browser extension's sign-in at a switch: on top the mode, one
 * status line and Check; under Gelişmiş the browser profile, "Sync now" and the saved accounts.
 * Hidden where the step does not run.
 */
export function ExtensionPreference({
  initialStatus,
  openDetails,
}: {
  /** For static rendering; otherwise read on mount. */
  initialStatus?: ExtensionStatus;
  /** For static rendering: Gelişmiş drawn open. */
  openDetails?: boolean;
}) {
  const { api, settings, busy, desktop, action, accounts } = useRelay();
  const { t } = useI18n();
  // undefined: not read yet. null: this Mac does not run the step.
  const { status, checking, check, reload } = useExtensionStatus({
    check: true,
    initial: initialStatus,
  });
  const [result, setResult] = useState<string>();
  // Sync now quits the browser in every mode, so it asks once before it does.
  const [confirming, setConfirming] = useState(false);
  if (!status) return null;
  const current = status.current;
  const on =
    current?.state === "signed-in" && current.accountUuid
      ? accounts.find((a) => accountUuids(a).includes(current.accountUuid!))
      : undefined;
  const currentLine = !current
    ? undefined
    : current.state === "signed-in"
      ? on
        ? t(`Eklenti şu an ${on.name} hesabında.`, `The extension is on ${on.name} now.`)
        : t("Eklenti Relay’de olmayan bir hesapta.", "The extension is on an account Relay does not have.")
      : current.state === "signed-out"
        ? t("Eklentide giriş yok.", "The extension is signed out.")
        : t("Eklentinin girişi okunamadı.", "Could not read the extension’s sign-in.");
  const setting = settings.claudeExtension ?? DEFAULT_EXTENSION;
  const disabled = !!busy || !!desktop?.busy;
  const update = (next: typeof setting) =>
    void action("settings", () => api.updateSettings({ claudeExtension: next }));
  const startup = startupLine(status, t);
  const follows = !!status.target && setting.mode !== "off";
  const choose = !status.target && status.instances.length > 1;
  // One line on top: what Relay does when off, why it manages nothing, or who the extension is on.
  // Desktop is on another account than the extension and Relay only guides: Claude's browser
  // tools need both on one account, so the one-step way to keep them together is offered here.
  const active = accounts.find((a) => a.id === desktop?.activeProfileId);
  const leftBehind =
    setting.mode === "guide" &&
    !!status.target &&
    !!active &&
    ((!!on && on.id !== active.id) || status.last?.reason === "guide-mismatch");
  const statusLine =
    setting.mode === "off"
      ? modeSentence("off", t)
      : !status.target
        ? instanceLine(status, t)
        : (currentLine ?? t("Eklenti kontrol ediliyor…", "Checking the extension…"));
  return (
    <div className="grid gap-1">
      <SectionHeading title={t("Claude tarayıcı eklentisi", "Claude browser extension")} />
      <SettingRow
        label={t("Eklenti de geçsin", "The extension follows")}
        htmlFor="extension-mode"
        description={statusLine}
      >
        <span className="flex gap-1">
          <OptionSelect<ExtensionMode>
            id="extension-mode"
            value={setting.mode}
            options={modeOptions(t)}
            className="w-52"
            disabled={disabled}
            onChange={(mode) => update({ ...setting, mode })}
          />
          {follows && (
            <Button variant="outline" disabled={checking} onClick={() => void check()}>
              {t("Kontrol et", "Check")}
            </Button>
          )}
        </span>
      </SettingRow>
      {leftBehind && (
        <SettingRow
          label={t(
            `Claude’un tarayıcı araçları ${active!.name} ile çalışmaz`,
            `Claude’s browser tools won’t work with ${active!.name}`,
          )}
          description={t(
            "Eklenti Claude uygulamasıyla aynı hesapta olmalı. Relay her geçişte onu da taşıyabilir.",
            "The extension must be on the Claude app’s account. Relay can move it at every switch.",
          )}
        >
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() => update({ ...setting, mode: "restart" })}
          >
            {t("Her geçişte taşı", "Move it at every switch")}
          </Button>
        </SettingRow>
      )}
      <Disclosure
        title={t("Gelişmiş", "Advanced")}
        // A profile has to be chosen before anything else works, so the section opens for it.
        defaultOpen={openDetails || choose}
        openKey={choose ? "choose-profile" : undefined}
      >
        {setting.mode !== "off" && <Note>{modeSentence(setting.mode, t)}</Note>}
        {status.instances.length > 1 && (
          <SettingRow
            label={t("Eklentinin tarayıcı profili", "The extension’s browser profile")}
            htmlFor="extension-instance"
            description={
              status.picked === "recent"
                ? t(
                    "Profil seçilmediği için en son kullanılan profil izleniyor. Relay yalnızca bu profildeki girişi yönetir.",
                    "None chosen, so the one used last is followed. Relay manages the sign-in of this one only.",
                  )
                : t(
                    "Relay yalnızca bu profildeki girişi yönetir.",
                    "Relay manages the sign-in of this one only.",
                  )
            }
          >
            <OptionSelect
              id="extension-instance"
              // A select item's value is never "": "none" stands for nothing chosen yet.
              value={status.target ? instanceValue(status.target) : "none"}
              options={[
                ...(status.target ? [] : [{ value: "none", label: t("Profil seç", "Choose a profile") }]),
                ...status.instances.map((i) => ({
                  value: instanceValue(i),
                  label: instanceLabel(i),
                })),
              ]}
              disabled={disabled}
              onChange={(value) => {
                const picked = instanceFromValue(status.instances, value);
                if (picked)
                  update({ ...setting, browser: { app: picked.app, profile: picked.profile } });
              }}
            />
          </SettingRow>
        )}
        <SettingRow
          label={instanceLine(status, t)}
          description={
            confirming && status.target
              ? t(
                  `${BROWSERS[status.target.app].name} açıksa kapanıp sekmeleriyle yeniden açılacak; eklenti ve claude.ai oturumu Claude uygulamasının hesabına geçecek.`,
                  `If ${BROWSERS[status.target.app].name} is open it closes and reopens with its tabs; the extension and the claude.ai login move to the Claude app’s account.`,
                )
              : startup
          }
        >
          {confirming ? (
            <span className="flex gap-1">
              <Button
                variant="outline"
                disabled={disabled}
                onClick={() =>
                  void action("extension-sync", async () => {
                    setConfirming(false);
                    const outcome = await api.syncExtension();
                    setResult(
                      extensionLine(outcome, t) ??
                        t("Eklentide değiştirilecek bir şey yok.", "Nothing to change in the extension."),
                    );
                    void reload();
                  })
                }
              >
                {t("Evet, eşitle", "Yes, sync")}
              </Button>
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                {t("Vazgeç", "Cancel")}
              </Button>
            </span>
          ) : (
            <Button
              variant="outline"
              disabled={disabled || setting.mode === "off" || !status.target}
              onClick={() => setConfirming(true)}
            >
              {t("Şimdi eşitle", "Sync now")}
            </Button>
          )}
        </SettingRow>
        {follows && (
          <SettingRow
            label={t("Kayıtlı hesaplar", "Saved accounts")}
            description={pairLine(status, accounts, t)}
          >
            <span />
          </SettingRow>
        )}
        {follows && (
          <Note>
            {t(
              "Eklentiye bir hesapla giriş yaptıktan sonra “Kontrol et”e bas; o hesap bağlanır. Tarayıcı kapanmaz.",
              "After signing in to the extension with an account, press Check and that account is linked. The browser stays open.",
            )}
          </Note>
        )}
        {status.last && <Note>{extensionLine(status.last, t) ?? ""}</Note>}
      </Disclosure>
      {result && (
        <p role="status" className="text-[13px]">
          {result}
        </p>
      )}
    </div>
  );
}
