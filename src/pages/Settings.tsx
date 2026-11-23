import { useEffect, useState } from "react";
import { Check, CircleAlert } from "lucide-react";
import { PageBody, PageFrame } from "@/app/PageFrame";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { usePrivacyBlur } from "@/components/Private";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Note,
  OptionSelect,
  SettingGroup,
  SettingRow,
} from "@/components/SettingRow";
import { systemLocale, useI18n, type LanguagePref } from "@/data/i18n";
import { FORMAT_LOCALE, LOCALE_NAMES, LOCALES, type Locale } from "../../shared/i18n/locales";
import { useRelay } from "@/data/relay-context";
import type {
  ClaudeLaunchChoice,
  PrankLevel,
  RelaySettings,
} from "../../shared/types";
import { MenuBarTitleRows } from "./settings/MenuBarItems";
import { NotificationGroup } from "./settings/NotificationSettings";
import { ShortcutGroup } from "./settings/ShortcutSettings";
import { Disclosure } from "@/components/Disclosure";
import { localizeError } from "../../shared/error-text";
import { updateShown, updateTitle } from "@/lib/update-text";
import { chooseCliFile } from "../features/CliSetup";
import { chooseClaudeApp } from "../features/ClaudeAppSetup";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { routeHash, settingsTab, SETTINGS_TABS, type SettingsTab } from "@/app/routes";
import { ExperimentalSwitchRows, RefreshIntervalRow, SwitchingTab } from "./settings/SwitchingTabs";
import { PlanningScreen } from "./Planning";
import { macWording, usePlatform } from "@/data/platform";

/** Shows the diagnosis logs in Finder; main picks the files, the page passes no path. */
export const showDiagnostics = ({
  api,
  action,
}: Pick<ReturnType<typeof useRelay>, "api" | "action">) =>
  action("diagnostics", () => api.showDiagnostics());

/** Saves the redacted diagnostics zip where the user picks; main builds it, the page passes no path. */
export const exportDiagnostics = ({
  api,
  action,
}: Pick<ReturnType<typeof useRelay>, "api" | "action">) =>
  action("export-diagnostics", () => api.exportDiagnostics());

/**
 * How Relay starts Claude: without HTTP/3. The choice lives outside the registry, so this row
 * reads it itself, again after each Relay change (Relay turns HTTP/3 off itself after a stuck
 * start).
 */
function ClaudeLaunchRow({
  api,
  action,
  data,
  t,
}: Pick<ReturnType<typeof useRelay>, "api" | "action" | "data"> & {
  t: ReturnType<typeof useI18n>["t"];
}) {
  const [choice, setChoice] = useState<ClaudeLaunchChoice>();
  useEffect(() => {
    let live = true;
    api
      .claudeLaunch()
      .then((value) => live && setChoice(value))
      .catch(() => live && setChoice({ quicOff: false }));
    return () => {
      live = false;
    };
  }, [api, data]);
  const change = (patch: Partial<ClaudeLaunchChoice>) =>
    void action("claude-launch", async () => setChoice(await api.setClaudeLaunch(patch)));
  return (
    <>
      <SettingRow
        label={t("settings.ifTheClaudeAppStaysOn")}
        htmlFor="claude-quic-off"
        description={t("settings.opensTheClaudeAppWithoutHttp")}
      >
        <Switch
          id="claude-quic-off"
          checked={choice?.quicOff === true}
          disabled={choice === undefined}
          onCheckedChange={(quicOff) => change({ quicOff })}
        />
      </SettingRow>
    </>
  );
}

/**
 * Separate Claude windows: each account's ⋯ menu can open it in its own Claude, beside the main
 * one. macOS and Linux; off until turned on here. Read from the snapshot, which says which are open.
 */
export function SeparateWindowsRow({
  api,
  action,
  data,
  t,
}: Pick<ReturnType<typeof useRelay>, "api" | "action" | "data"> & {
  t: ReturnType<typeof useI18n>["t"];
}) {
  const windows = data?.windows;
  if (!windows?.supported) return null;
  return (
    <>
      <SettingRow
        label={t("settings.separateClaudeWindows")}
        htmlFor="separate-windows"
        description={t("settings.addsOpenInASeparateWindow")}
      >
        <Switch
          id="separate-windows"
          checked={windows.enabled}
          onCheckedChange={(enabled) =>
            void action("separate-windows", () => api.setSeparateWindows(enabled))
          }
        />
      </SettingRow>
      <div className="pb-3">
        <Disclosure title={t("settings.howDoesItWork")}>
          <Note>
            {t("settings.whileTheSeparateWindowIsOpen")}
          </Note>
        </Disclosure>
      </div>
    </>
  );
}

/**
 * Relay's own updates: the running version, the automatic check, a check now, and how the last
 * one went. Read from the snapshot; absent where Relay does not update itself (a dev run).
 */
export function UpdatesGroup({
  api,
  action,
  data,
  busy,
  t,
  language,
}: Pick<ReturnType<typeof useRelay>, "api" | "action" | "data" | "busy"> & {
  t: ReturnType<typeof useI18n>["t"];
  language: Locale;
}) {
  const update = data?.update;
  if (!update) return null;
  const checked = update.checkedAt
    ? new Date(update.checkedAt).toLocaleString(FORMAT_LOCALE[language], {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : undefined;
  const status =
    update.status === "checking"
      ? t("common.checkInProgress")
      : update.status === "error"
        ? `${t("settings.checkFailed")}: ${localizeError(update.error ?? "", language)}`
        : updateShown(update)
          ? updateTitle(update, t)
          : update.status === "up-to-date"
            ? t("settings.relayIsUpToDate")
            : "";
  return (
    <SettingGroup id="settings-updates" title={t("settings.updates")}>
      <SettingRow
        label={t("settings.relay", { updateCurrent: update.current })}
        description={[status, checked && t("settings.lastChecked", { checked })]
          .filter(Boolean)
          .join(" · ")}
      >
        <Button
          variant="outline"
          size="sm"
          disabled={!!busy || update.status === "checking" || update.status === "downloading"}
          onClick={() => void action("update-check", () => api.checkUpdate())}
        >
          {t("settings.checkNow")}
        </Button>
      </SettingRow>
      <SettingRow
        label={t("settings.checkForUpdatesAutomatically")}
        htmlFor="update-auto"
        description={t("settings.downloadsANewVersionRelayInstalls")}
      >
        <Switch
          id="update-auto"
          checked={update.autoCheck}
          onCheckedChange={(enabled) => void action("update-auto", () => api.setUpdateAuto(enabled))}
        />
      </SettingRow>
      <SettingRow
        label={t("settings.getPreReleases")}
        htmlFor="update-beta"
        description={t("settings.getPreReleasesDescription")}
      >
        <Switch
          id="update-beta"
          checked={data?.settings?.updateChannel === "beta"}
          disabled={!!busy}
          onCheckedChange={(beta) =>
            void action("settings", () => api.updateSettings({ updateChannel: beta ? "beta" : "stable" }))
          }
        />
      </SettingRow>
    </SettingGroup>
  );
}

/** A system row's value: a check when it is in place, a mark when it is not. */
function Status({ ok, children }: { ok: boolean; children: string }) {
  const Icon = ok ? Check : CircleAlert;
  return (
    <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
      <Icon
        aria-hidden="true"
        className={ok ? "size-4 text-ok" : "size-4 text-warn"}
      />
      {children}
    </span>
  );
}

/** Settings' tab names, in the tabs' order. */
export function settingsTabTitle(tab: SettingsTab, t: ReturnType<typeof useI18n>["t"]) {
  return {
    genel: t("settings.general"),
    gelismis: t("settings.advanced"),
  }[tab];
}

/** The tab the hash names (`#/ayarlar/<tab>`), kept in step. */
function useSettingsTab(initial?: SettingsTab): [SettingsTab, (tab: SettingsTab) => void] {
  const [tab, setTab] = useState<SettingsTab>(
    () => initial ?? (typeof window === "undefined" ? SETTINGS_TABS[0] : settingsTab(window.location.hash)),
  );
  useEffect(() => {
    if (initial) return;
    const changed = () => setTab(settingsTab(window.location.hash));
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, [initial]);
  const choose = (next: SettingsTab) => {
    setTab(next);
    if (typeof window !== "undefined") window.location.hash = routeHash(`ayarlar/${next}`);
  };
  return [tab, choose];
}

/** Switching (when, what switches along, near the limit) as its own page in the sidebar. */
export function SwitchingPage() {
  const { t } = useI18n();
  return (
    <PageFrame automationInline title={t("common.switching")}>
      <PageBody>
        <SwitchingTab />
      </PageBody>
    </PageFrame>
  );
}

/** Planning as its own page in the sidebar. */
export function PlanningPage() {
  return <PlanningScreen />;
}

/**
 * The remaining settings in two tabs: General, and Advanced for everything technical or
 * experimental. Switching and Planning are pages of their own.
 */
export function Settings({ tab: initialTab }: { tab?: SettingsTab }) {
  const relay = useRelay();
  const { api, data, desktop, settings, busy, version, action, active } = relay;
  const { t, language, pref, setLanguage } = useI18n();
  const [tab, setTab] = useSettingsTab(initialTab);
  const [privacyBlur, setPrivacyBlur] = usePrivacyBlur();
  const disabled = !!busy || !!desktop?.busy;
  const update = (patch: Partial<RelaySettings>) =>
    void action("settings", () => api.updateSettings(patch));
  const mac = macWording(data?.diagnostics.platform);
  return (
    <PageFrame
      automationInline
      title={t("common.settings")}
    >
      <PageBody>
      <Tabs value={tab} onValueChange={(v) => setTab(v as SettingsTab)} className="grid gap-4">
        <TabsList aria-label={t("settings.settingsSections")} className="h-auto w-fit flex-wrap justify-start">
          {SETTINGS_TABS.map((id) => (
            <TabsTrigger key={id} value={id}>
              {settingsTabTitle(id, t)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="genel">
          <div className="grid max-w-2xl gap-4">
            <SettingGroup id="settings-general" title={t("settings.general")}>
              <SettingRow label={t("settings.interfaceLanguage")} htmlFor="language">
                <OptionSelect<LanguagePref>
                  id="language"
                  value={pref}
                  onChange={setLanguage}
                  options={[
                    { value: "system", label: t("settings.systemLanguage", { language: LOCALE_NAMES[systemLocale()] }) },
                    ...LOCALES.map((locale) => ({ value: locale, label: LOCALE_NAMES[locale] })),
                  ]}
                />
              </SettingRow>
              <SettingRow
                label={<span id="appearance-label">{t("settings.theme")}</span>}
              >
                <ToggleGroup
                  type="single"
                  variant="outline"
                  size="sm"
                  aria-labelledby="appearance-label"
                  value={settings.appearance}
                  disabled={disabled}
                  onValueChange={(v) =>
                    v && update({ appearance: v as RelaySettings["appearance"] })
                  }
                >
                  <ToggleGroupItem value="system">
                    {t("settings.system")}
                  </ToggleGroupItem>
                  <ToggleGroupItem value="light">
                    {t("settings.light")}
                  </ToggleGroupItem>
                  <ToggleGroupItem value="dark">
                    {t("settings.dark")}
                  </ToggleGroupItem>
                </ToggleGroup>
              </SettingRow>
              <SettingRow
                label={t("settings.blurAccountDetails")}
                htmlFor="privacy-blur"
                description={t("settings.eMailsAndOrganizationsStayBlurred")}
              >
                <Switch id="privacy-blur" checked={privacyBlur} onCheckedChange={setPrivacyBlur} />
              </SettingRow>
              <SettingRow
                label={t("settings.openAtLogin")}
                htmlFor="launch-at-login"
                description={t("settings.relayStartsHiddenWhenYouLog")}
              >
                <Switch
                  id="launch-at-login"
                  checked={settings.launchAtLogin === true}
                  disabled={disabled}
                  onCheckedChange={(launchAtLogin) => update({ launchAtLogin })}
                />
              </SettingRow>
              <RefreshIntervalRow />
            </SettingGroup>
            <NotificationGroup />
            <ShortcutGroup />
            {/* The menu bar title and the switch window are macOS-only; other platforms keep the R icon. */}
            {data?.diagnostics.platform === "darwin" && (
              <SettingGroup id="settings-menu-bar" title={t("settings.menuBar")}>
                <MenuBarTitleRows
                  data={data}
                  api={api}
                  action={action}
                  name={active?.name}
                  t={t}
                  language={language}
                />
              </SettingGroup>
            )}
            <SettingGroup id="settings-panda" title={t("settings.fun")}>
              <SettingRow
                label={
                  <span id="panda-pranks-label">
                    {t("settings.pandaPranks")}
                  </span>
                }
                description={t("settings.canHideTheCursorForA")}
              >
                <ToggleGroup
                  type="single"
                  variant="outline"
                  size="sm"
                  aria-labelledby="panda-pranks-label"
                  value={settings.pranks ?? "off"}
                  disabled={disabled}
                  onValueChange={(v) => v && update({ pranks: v as PrankLevel })}
                >
                  <ToggleGroupItem value="sometimes">
                    {t("settings.sometimes")}
                  </ToggleGroupItem>
                  <ToggleGroupItem value="rarely">
                    {t("settings.rarely")}
                  </ToggleGroupItem>
                  <ToggleGroupItem value="off">{t("common.off")}</ToggleGroupItem>
                </ToggleGroup>
              </SettingRow>
              {data?.diagnostics.platform === "darwin" && (
                <>
                  <SettingRow
                    label={
                      <span id="menu-bar-animation-label">
                        {t("settings.pandaAnimations")}
                      </span>
                    }
                    description={t("settings.inTheMenuBarWhenOff")}
                  >
                    <Switch
                      aria-labelledby="menu-bar-animation-label"
                      checked={settings.menuBarAnimation !== false}
                      disabled={disabled}
                      onCheckedChange={(checked) => update({ menuBarAnimation: checked })}
                    />
                  </SettingRow>
                  <SettingRow
                    label={
                      <span id="switch-window-label">
                        {t("settings.showThePandaWindowDuringA")}
                      </span>
                    }
                  >
                    <Switch
                      aria-labelledby="switch-window-label"
                      checked={settings.switchWindow !== false}
                      disabled={disabled}
                      onCheckedChange={(checked) => update({ switchWindow: checked })}
                    />
                  </SettingRow>
                </>
              )}
            </SettingGroup>
            <UpdatesGroup api={api} action={action} data={data} busy={busy} t={t} language={language} />
          </div>
        </TabsContent>
        <TabsContent value="gelismis">
          <div className="grid max-w-2xl gap-4">
            <p className="text-sm text-muted-foreground">
              {t("settings.mostPeopleNeverNeedToChange")}
            </p>
            <SettingGroup id="settings-system" title={t("settings.system")}>
              {/* An install Relay does not look for (every Linux build) is chosen here: Konumu seç. */}
              <SettingRow label="Claude Desktop">
                <span className="flex items-center gap-3">
                  <Status ok={!!desktop?.available}>
                    {desktop?.available
                      ? t("settings.found")
                      : t("common.notFound")}
                  </Status>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!!busy}
                    onClick={() => chooseClaudeApp({ api, action })}
                  >
                    {t("settings.chooseLocation")}
                  </Button>
                </span>
              </SettingRow>
              {/* The missing-CLI error names this path: Ayarlar → Gelişmiş → Claude Code CLI → Dosyayı seç. */}
              <SettingRow
                label="Claude Code CLI"
                description={
                  data?.diagnostics.source === "claude-app"
                    ? t("settings.usesTheCopyThatTheClaude")
                    : undefined
                }
              >
                <span className="flex items-center gap-3">
                  <Status ok={!!data?.diagnostics.version}>
                    {data?.diagnostics.version ?? t("common.notFound")}
                  </Status>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!!busy}
                    onClick={() => chooseCliFile({ api, action })}
                  >
                    {t("settings.chooseFile")}
                  </Button>
                </span>
              </SettingRow>
              <SettingRow
                label={t("settings.diagnosticsFiles")}
                description={t("settings.sendOnlyDraftEventsJsonAnd")}
              >
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void showDiagnostics({ api, action })}
                >
                  {mac ? t("settings.showInFinder") : t("settings.showInFolder")}
                </Button>
              </SettingRow>
              <SettingRow
                label={t("settings.diagnosticsForABugReport")}
                description={t("settings.oneZipOfRelaysLogsEmail")}
              >
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void exportDiagnostics({ api, action })}
                >
                  {t("settings.export")}
                </Button>
              </SettingRow>
            </SettingGroup>
            <SettingGroup id="settings-troubleshooting" title={t("settings.troubleshooting")}>
              <ClaudeLaunchRow api={api} action={action} data={data} t={t} />
              <ClaudeAppAccessRow api={api} t={t} />
            </SettingGroup>
            <SettingGroup id="settings-experimental" title={t("settings.experimental")}>
              <p className="py-2 text-xs text-muted-foreground">
                {t("settings.experimentalFeaturesCanBreakWithAn")}
              </p>
              <SeparateWindowsRow api={api} action={action} data={data} t={t} />
              <ExperimentalSwitchRows />
            </SettingGroup>
            <div id="settings-privacy" className="px-1">
              <Disclosure title={t("settings.privacyAndSecurity")}>
                <PrivacyNotes t={t} />
              </Disclosure>
            </div>
            <p className="px-1 text-center text-xs text-muted-foreground">
              {t("settings.storedLocallyIndependentTool", { version })}
            </p>
          </div>
        </TabsContent>
      </Tabs>
      </PageBody>
    </PageFrame>
  );
}

/**
 * Whether Relay may read the Claude app's sign-in ("Claude Safe Storage"): with it Relay reads
 * limits through the app when a Claude Code sign-in ended and renews those sign-ins by itself.
 */
export function ClaudeAppAccessRow({
  api,
  t,
}: Pick<ReturnType<typeof useRelay>, "api"> & { t: ReturnType<typeof useI18n>["t"] }) {
  const [state, setState] = useState<{ supported: boolean; allowed: boolean }>();
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    let live = true;
    // A bridge without it (an older window) leaves the row out.
    void Promise.resolve()
      .then(() => api.claudeAppAccess())
      .then((s) => live && setState(s))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [api]);
  if (!state?.supported) return null;
  return (
    <SettingRow
      label={t("settings.claudeAppAccess")}
      description={t("settings.claudeCodeSignInsEndAfter")}
    >
      {state.allowed ? (
        <Status ok>{t("settings.allowed")}</Status>
      ) : (
        <Button
          variant="outline"
          size="sm"
          disabled={asking}
          onClick={() => {
            setAsking(true);
            void api
              .claudeAppAccess(true)
              .then(setState)
              .catch(() => {})
              .finally(() => setAsking(false));
          }}
        >
          {t("settings.allow")}
        </Button>
      )}
    </SettingRow>
  );
}

/** How Relay keeps sign-ins, the Keychain prompt, and what a switch merges: the privacy section. */
export function PrivacyNotes({ t }: { t: ReturnType<typeof useI18n>["t"] }) {
  const mac = macWording(usePlatform());
  return (
    <>
      <Note>
        {t("settings.relayKeepsClaudeAppSignIns")}
      </Note>
      <Note>
        {mac
          ? t("settings.relayKeepsTheEncryptionKeyIn")
          : t("settings.relayKeepsTheEncryptionKeyIn2")}
      </Note>
      <Note>
        {t("settings.accountSwitchIsExperimentalAndDepends")}
      </Note>
    </>
  );
}
