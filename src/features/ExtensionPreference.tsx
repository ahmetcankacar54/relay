import { ExternalLink } from "@/components/ExternalLink";
import { EXTERNAL_LINKS } from "../../shared/external-links";
import { useEffect, useState } from "react";
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
  reconnectGuide,
  startupLine,
  accountUuids,
} from "@/lib/extension-ui";

/** While the extension waits to be reconnected, Relay looks this often whether it signed in. */
const RECONNECT_CHECK_MS = 5_000;

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
          `Extension sign-in and claude.ai login saved: ${list(paired)}.`,
        )
      : t("İkisi de kayıtlı olan bir hesap henüz yok.", "No account has both saved yet."),
    half.length
      ? t(
          `Kaydı eksik olanlar: ${list(half)}. Her biri için o hesapla claude.ai’ye gir, eklentiyi aç, sonra “Kontrol et”e bas.`,
          `One of the two is missing: ${list(half)}. For each one, sign in to claude.ai with that account and open the extension. Then select “Check”.`,
        )
      : "",
  ];
  return parts.filter(Boolean).join(" ");
}

/**
 * What Relay does with the Claude browser extension's sign-in at a switch: on top the mode, one
 * status line and Check; under Ayrıntılar the browser profile, "Sync now" and the saved accounts.
 * Hidden where the step does not run.
 */
export function ExtensionPreference({
  initialStatus,
  openDetails,
}: {
  /** For static rendering; otherwise read on mount. */
  initialStatus?: ExtensionStatus;
  /** For static rendering: Ayrıntılar drawn open. */
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
  const reconnect = status ? reconnectGuide(status, accounts, t) : undefined;
  // The user signs in in the browser; the line goes as soon as a check sees it worked.
  const waiting = !!reconnect;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void check();
    }, RECONNECT_CHECK_MS);
    return () => clearInterval(timer);
    // `check` is a new function each render; the interval follows `waiting` only.
  }, [waiting]);
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
        ? current.expired
          ? t(
              `Eklenti ${on.name} hesabında ama girişi düşmüş; Claude’un tarayıcı araçları çalışmaz.`,
              `The extension is on ${on.name}, but its sign-in expired. Claude’s browser tools do not work.`,
            )
          : t(`Eklenti şu an ${on.name} hesabında.`, `The extension is on ${on.name} now.`)
        : t("Eklenti Relay’de olmayan bir hesapta.", "The extension is on an account Relay does not have.")
      : current.state === "signed-out"
        ? t("Eklentide giriş yok.", "The extension is signed out.")
        : t("Eklentinin girişi okunamadı.", "Relay cannot read the extension sign-in.");
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
        : (currentLine ?? t("Eklenti kontrol ediliyor…", "Extension check in progress…"));
  return (
    <div className="grid gap-1">
      <SectionHeading title={t("Claude tarayıcı eklentisi", "Claude browser extension")} />
      <SettingRow
        label={t("Geçişte", "At a switch")}
        htmlFor="extension-mode"
        description={
          !status.instances.length && status.denied?.length ? (
            <>
              {statusLine}{" "}
              <ExternalLink href={EXTERNAL_LINKS.fullDiskAccess}>
                {t("Tam Disk Erişimi’ni aç", "Open Full Disk Access")}
              </ExternalLink>
            </>
          ) : (
            statusLine
          )
        }
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
      {reconnect && (
        <SettingRow
          label={reconnect.title}
          description={
            <span className="grid gap-1">
              <span>{reconnect.why}</span>
              {reconnect.canSync && (
                <span>
                  {t(
                    "Önce Ayrıntılar’daki “Şimdi eşitle”yi dene. Olmazsa:",
                    "First, try “Sync now” under Details. If that does not help:",
                  )}
                </span>
              )}
              <ol className="list-decimal pl-4">
                {reconnect.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </span>
          }
        >
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() => void action("extension-web", () => api.openClaudeWeb())}
          >
            {t("claude.ai’yi aç", "Open claude.ai")}
          </Button>
        </SettingRow>
      )}
      {leftBehind && (
        <SettingRow
          label={t(
            `Claude’un tarayıcı araçları ${active!.name} ile çalışmaz`,
            `Claude’s browser tools do not work with ${active!.name}`,
          )}
          description={t(
            "Eklenti Claude uygulamasıyla aynı hesapta olmalı. Relay her geçişte onu da taşıyabilir.",
            "The extension must be on the same account as the Claude app. Relay can move it at each switch.",
          )}
        >
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() => update({ ...setting, mode: "restart" })}
          >
            {t("Her geçişte taşı", "Move it at each switch")}
          </Button>
        </SettingRow>
      )}
      <Disclosure
        title={t("Ayrıntılar", "Details")}
        // A profile has to be chosen before anything else works, so the section opens for it; a
        // reconnect that Sync now may do opens it for that button.
        defaultOpen={openDetails || choose || !!reconnect?.canSync}
        openKey={choose ? "choose-profile" : reconnect?.canSync ? "extension-expired" : undefined}
      >
        {setting.mode !== "off" && <Note>{modeSentence(setting.mode, t)}</Note>}
        {status.instances.length > 1 && (
          <SettingRow
            label={t("Eklentinin tarayıcı profili", "Extension browser profile")}
            htmlFor="extension-instance"
            description={
              status.picked === "recent"
                ? t(
                    "Profil seçilmedi; en son kullanılan profil izleniyor. Relay yalnızca bu profildeki girişi yönetir.",
                    "No profile selected, so Relay uses the last used one. Relay manages only the sign-in in this profile.",
                  )
                : t(
                    "Relay yalnızca bu profildeki girişi yönetir.",
                    "Relay manages only the sign-in in this profile.",
                  )
            }
          >
            <OptionSelect
              id="extension-instance"
              // A select item's value is never "": "none" stands for nothing chosen yet.
              value={status.target ? instanceValue(status.target) : "none"}
              options={[
                ...(status.target ? [] : [{ value: "none", label: t("Profil seç", "Select a profile") }]),
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
                  `${BROWSERS[status.target.app].name} açıksa kapanıp sekmeleriyle yeniden açılır. Eklenti ve claude.ai oturumu Claude uygulamasının hesabına geçer.`,
                  `If ${BROWSERS[status.target.app].name} is open, it closes and opens again with its tabs. The extension and the claude.ai login move to the account of the Claude app.`,
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
              "After you sign in to the extension, select “Check” to link that account. The browser stays open.",
            )}
          </Note>
        )}
        {status.last && <Note>{extensionLine(status.last, t) ?? ""}</Note>}
      </Disclosure>
      {result && (
        <p role="status" className="text-sm">
          {result}
        </p>
      )}
    </div>
  );
}
