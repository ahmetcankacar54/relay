import { ExternalLink } from "@/components/ExternalLink";
import { EXTERNAL_LINKS } from "../../shared/external-links";
import { useEffect, useState } from "react";
import { BROWSERS, DEFAULT_EXTENSION } from "../../shared/browser-extension";
import type { ExtensionMode, ExtensionStatus } from "../../shared/types";
import { extensionLine } from "../../shared/extension-text";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/Disclosure";
import { Note, OptionSelect, SettingRow } from "@/components/SettingRow";
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
import type { T } from "../../shared/i18n/translate";

/** While the extension waits to be reconnected, Relay looks this often whether it signed in. */
const RECONNECT_CHECK_MS = 5_000;

/** Which accounts have the extension's sign-in and the browser's claude.ai login saved, and which only one. */
function pairLine(
  status: ExtensionStatus,
  accounts: Parameters<typeof pairedAccounts>[1],
  t: T,
): string {
  const { paired, half } = pairedAccounts(status, accounts);
  const list = (names: string[]) => names.join(", ");
  const parts = [
    paired.length
      ? t("extensionPreference.extensionSignInAndClaudeAi", { list: list(paired) })
      : t("extensionPreference.noAccountHasBothSavedYet"),
    half.length
      ? t("extensionPreference.oneOfTheTwoIsMissing", { list: list(half) })
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
  const { api, data, settings, busy, desktop, action, accounts } = useRelay();
  const { t } = useI18n();
  const platform = data?.diagnostics?.platform;
  // undefined: not read yet. null: this computer does not run the step.
  const { status, checking, check, reload } = useExtensionStatus({
    check: true,
    initial: initialStatus,
  });
  const [result, setResult] = useState<string>();
  // Sync now quits the browser in every mode, so it asks once before it does.
  const [confirming, setConfirming] = useState(false);
  const reconnect = status ? reconnectGuide(status, accounts, t, desktop?.currentAccountUuid) : undefined;
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
          ? t("extensionPreference.theExtensionIsOnButIts", { onName: on.name })
          : t("extensionPreference.theExtensionIsOnNow", { onName: on.name })
        : t("extensionPreference.theExtensionIsOnAnAccount")
      : current.state === "signed-out"
        ? t("extensionPreference.theExtensionIsSignedOut")
        : t("extensionPreference.relayCannotReadTheExtensionSign");
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
        ? instanceLine(status, t, platform)
        : (currentLine ?? t("extensionPreference.extensionCheckInProgress"));
  return (
    <div className="grid gap-1">
      <SettingRow
        label={<span className="font-medium">{t("extensionPreference.claudeBrowserExtension")}</span>}
        htmlFor="extension-mode"
        description={
          !status.instances.length && status.denied?.length ? (
            <>
              {statusLine}{" "}
              <ExternalLink href={EXTERNAL_LINKS.fullDiskAccess}>
                {t("extensionPreference.openFullDiskAccess")}
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
              {t("common.check")}
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
                  {t("extensionPreference.firstTrySyncNowUnderDetails")}
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
            {t("extensionPreference.openClaudeAi")}
          </Button>
        </SettingRow>
      )}
      {leftBehind && (
        <SettingRow
          label={t("extensionPreference.claudeSBrowserToolsDoNot", { name: active!.name })}
          description={t("extensionPreference.theExtensionMustBeOnThe")}
        >
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() => update({ ...setting, mode: "restart" })}
          >
            {t("extensionPreference.moveItAtEachSwitch")}
          </Button>
        </SettingRow>
      )}
      <Disclosure
        title={t("extensionPreference.details")}
        // A profile has to be chosen before anything else works, so the section opens for it; a
        // reconnect that Sync now may do opens it for that button.
        defaultOpen={openDetails || choose || !!reconnect?.canSync}
        openKey={choose ? "choose-profile" : reconnect?.canSync ? "extension-expired" : undefined}
      >
        {setting.mode !== "off" && <Note>{modeSentence(setting.mode, t, platform)}</Note>}
        {status.instances.length > 1 && (
          <SettingRow
            label={t("extensionPreference.extensionBrowserProfile")}
            htmlFor="extension-instance"
            description={
              status.picked === "recent"
                ? t("extensionPreference.noProfileSelectedSoRelayUses")
                : t("extensionPreference.relayManagesOnlyTheSignIn")
            }
          >
            <OptionSelect
              id="extension-instance"
              // A select item's value is never "": "none" stands for nothing chosen yet.
              value={status.target ? instanceValue(status.target) : "none"}
              options={[
                ...(status.target ? [] : [{ value: "none", label: t("extensionPreference.selectAProfile") }]),
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
          label={instanceLine(status, t, platform)}
          description={
            confirming && status.target
              ? t("extensionPreference.ifIsOpenItClosesAnd", { name: BROWSERS[status.target.app].name, platform: platform ?? "" })
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
                        t("extensionPreference.nothingToChangeInTheExtension"),
                    );
                    void reload();
                  })
                }
              >
                {t("extensionPreference.yesSync")}
              </Button>
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                {t("common.cancel")}
              </Button>
            </span>
          ) : (
            <Button
              variant="outline"
              disabled={disabled || setting.mode === "off" || !status.target}
              onClick={() => setConfirming(true)}
            >
              {t("extensionPreference.syncNow")}
            </Button>
          )}
        </SettingRow>
        {follows && (
          <SettingRow
            label={t("extensionPreference.savedAccounts")}
            description={pairLine(status, accounts, t)}
          >
            <span />
          </SettingRow>
        )}
        {follows && (
          <Note>
            {t("extensionPreference.afterYouSignInToThe")}
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
