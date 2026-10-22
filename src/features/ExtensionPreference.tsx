import { useState } from "react";
import { DEFAULT_EXTENSION } from "../../shared/browser-extension";
import type { ExtensionMode, ExtensionStatus } from "../../shared/types";
import { extensionLine } from "../../shared/extension-text";
import { Button } from "@/components/ui/button";
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
          `Eklenti girişi ve claude.ai oturumu ikisi de kayıtlı: ${list(paired)}.`,
          `Extension sign-in and claude.ai login both saved: ${list(paired)}.`,
        )
      : t("Henüz ikisi birden kayıtlı hesap yok.", "No account has both saved yet."),
    half.length
      ? t(
          `Eksik kaydı olanlar: ${list(half)}. O hesapla claude.ai'ye girip eklentiyi açtıktan sonra Kontrol et.`,
          `Missing one of the two: ${list(half)}. Sign in to claude.ai with it, open the extension, then Check.`,
        )
      : "",
  ];
  return parts.filter(Boolean).join(" ");
}

/**
 * What Relay does with the Claude browser extension's sign-in at a switch: the mode, the browser
 * profile when several have the extension, and "Sync now". Hidden where the step does not run.
 */
export function ExtensionPreference({
  initialStatus,
}: {
  /** For static rendering; otherwise read on mount. */
  initialStatus?: ExtensionStatus;
}) {
  const { api, settings, busy, desktop, action, accounts } = useRelay();
  const { t } = useI18n();
  // undefined: not read yet. null: this Mac does not run the step.
  const { status, checking, check, reload } = useExtensionStatus({
    check: true,
    initial: initialStatus,
  });
  const [result, setResult] = useState<string>();
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
        ? t(`Eklenti şu an ${on.name} hesabında · bağlı`, `The extension is on ${on.name} now · linked`)
        : t("Eklenti Relay'de olmayan bir hesapta.", "The extension is on an account Relay does not have.")
      : current.state === "signed-out"
        ? t("Eklentide giriş yok.", "The extension is signed out.")
        : t("Eklentinin girişi okunamadı.", "Could not read the extension's sign-in.");
  const setting = settings.claudeExtension ?? DEFAULT_EXTENSION;
  const disabled = !!busy || !!desktop?.busy;
  const update = (next: typeof setting) =>
    void action("settings", () => api.updateSettings({ claudeExtension: next }));
  const startup = startupLine(status, t);
  return (
    <div className="grid gap-1">
      <SectionHeading
        title={t("Claude tarayıcı eklentisi", "Claude browser extension")}
        description={t(
          "Eklenti, tarayıcıdaki claude.ai oturumuyla giriş yapar. Hesabı izlemesi için Relay o oturumu da değiştirebilir; bunu sen seçmedikçe hiçbir şeyi değiştirmez.",
          "The extension signs in through the browser's claude.ai login. To make it follow the account, Relay can change that login too; it changes nothing unless you choose it.",
        )}
      />
      <SettingRow
        label={t("Hesap değişince eklentiye ne yapılsın?", "What to do with the extension when the account changes")}
        htmlFor="extension-mode"
        description={modeSentence(setting.mode, t)}
      >
        <OptionSelect<ExtensionMode>
          id="extension-mode"
          value={setting.mode}
          options={modeOptions(t)}
          className="w-64"
          disabled={disabled}
          onChange={(mode) => update({ ...setting, mode })}
        />
      </SettingRow>
      {status.instances.length > 1 && (
        <SettingRow
          label={t("Eklentinin tarayıcı profili", "The extension's browser profile")}
          htmlFor="extension-instance"
          description={
            status.picked === "recent"
              ? t(
                  "Seçilmediği için en son kullanılan izleniyor. Relay yalnızca bunun girişini yönetir.",
                  "None chosen, so the one used last is followed. Relay manages the sign-in of this one only.",
                )
              : t(
                  "Relay yalnızca bunun girişini yönetir.",
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
        description={startup}
      >
        <Button
          variant="outline"
          disabled={disabled || setting.mode === "off" || !status.target}
          onClick={() =>
            void action("extension-sync", async () => {
              const outcome = await api.syncExtension();
              setResult(
                extensionLine(outcome, t) ??
                  t("Eklentide değiştirilecek bir şey yok.", "Nothing to change in the extension."),
              );
              void reload();
            })
          }
        >
          {t("Şimdi eşitle", "Sync now")}
        </Button>
      </SettingRow>
      {status.target && setting.mode !== "off" && (
        <SettingRow
          label={currentLine ?? t("Eklenti kontrol ediliyor…", "Checking the extension…")}
          description={t(
            "Eklentiye bir hesapla giriş yapınca Kontrol et; o hesap bağlanır. Tarayıcı kapanmaz.",
            "After signing in to the extension with an account, press Check and that account is linked. The browser stays open.",
          )}
        >
          <Button variant="outline" disabled={checking} onClick={() => void check()}>
            {t("Kontrol et", "Check")}
          </Button>
        </SettingRow>
      )}
      {status.target && setting.mode !== "off" && (
        <SettingRow
          label={t("Kayıtlı hesaplar", "Saved accounts")}
          description={pairLine(status, accounts, t)}
        >
          <span />
        </SettingRow>
      )}
      {result && (
        <p role="status" className="text-[13px]">
          {result}
        </p>
      )}
      {status.last && !result && (
        <Note>{extensionLine(status.last, t) ?? ""}</Note>
      )}
    </div>
  );
}
