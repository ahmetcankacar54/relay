import { useEffect, useState } from "react";
import { Check, CircleAlert } from "lucide-react";
import { PageFrame } from "@/app/PageFrame";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Note,
  SettingGroup,
  SettingRow,
} from "@/components/SettingRow";
import { useI18n, type Language } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import type {
  ClaudeLaunchChoice,
  PrankLevel,
  RelaySettings,
} from "../../shared/types";
import { MenuBarTitleRows } from "./settings/MenuBarItems";
import { Disclosure } from "@/components/Disclosure";
import { localizeError } from "../../shared/error-text";
import { updateShown, updateTitle } from "@/lib/update-text";
import { chooseCliFile } from "../features/CliSetup";
import { chooseClaudeApp } from "../features/ClaudeAppSetup";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { routeHash, settingsTab, SETTINGS_TABS, type SettingsTab } from "@/app/routes";
import { ExperimentalSwitchRows, RefreshIntervalRow, SwitchingTab } from "./settings/SwitchingTabs";
import { PlanningTab } from "./Planning";

/** Shows the diagnosis logs in Finder; main picks the files, the page passes no path. */
export const showDiagnostics = ({
  api,
  action,
}: Pick<ReturnType<typeof useRelay>, "api" | "action">) =>
  action("diagnostics", () => api.showDiagnostics());

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
        label={t("Claude uygulaması gri ekranda kalıyorsa", "If the Claude app stays on a grey screen")}
        htmlFor="claude-quic-off"
        description={t(
          "Claude uygulamasını HTTP/3 olmadan açar. Takılan bir geçişten sonra Relay bunu kendisi açar.",
          "Opens the Claude app without HTTP/3. Relay turns this on by itself after a stuck switch.",
        )}
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
 * one. macOS only; off until turned on here. Read from the snapshot, which says which are open.
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
        label={t("Ayrı Claude pencereleri", "Separate Claude windows")}
        htmlFor="separate-windows"
        description={t(
          "Hesabın ⋯ menüsüne “Ayrı pencerede aç” ekler.",
          "Adds “Open in a separate window” to the account ⋯ menu.",
        )}
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
        <Disclosure title={t("Nasıl çalışır?", "How does it work?")}>
          <Note>
            {t(
              "Ayrı pencere açıkken ana Claude uygulaması o hesaba geçemez. Relay kendiliğinden geçmez ve konuşmaları sürdürmez. Claude in Chrome yalnızca ana Claude uygulamasında çalışır. Claude uygulaması bunu resmi olarak desteklemez; bir güncelleme bozabilir.",
              "While the separate window is open, the main Claude app cannot switch to that account. Relay does not switch or continue conversations automatically. Claude in Chrome works only in the main Claude app. The Claude app does not support this officially. An update can break it.",
            )}
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
  language: Language;
}) {
  const update = data?.update;
  if (!update) return null;
  const checked = update.checkedAt
    ? new Date(update.checkedAt).toLocaleString(language === "tr" ? "tr-TR" : "en-US", {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : undefined;
  const status =
    update.status === "checking"
      ? t("Kontrol ediliyor…", "Check in progress…")
      : update.status === "error"
        ? `${t("Kontrol edilemedi", "Check failed")}: ${localizeError(update.error ?? "", language)}`
        : updateShown(update)
          ? updateTitle(update, t)
          : update.status === "up-to-date"
            ? t("Relay güncel.", "Relay is up to date.")
            : "";
  return (
    <SettingGroup id="settings-updates" title={t("Güncellemeler", "Updates")}>
      <SettingRow
        label={t(`Relay ${update.current}`, `Relay ${update.current}`)}
        description={[status, checked && t(`Son kontrol: ${checked}`, `Last checked: ${checked}`)]
          .filter(Boolean)
          .join(" · ")}
      >
        <Button
          variant="outline"
          size="sm"
          disabled={!!busy || update.status === "checking" || update.status === "downloading"}
          onClick={() => void action("update-check", () => api.checkUpdate())}
        >
          {t("Şimdi kontrol et", "Check now")}
        </Button>
      </SettingRow>
      <SettingRow
        label={t("Güncellemeleri kendiliğinden ara", "Check for updates automatically")}
        htmlFor="update-auto"
        description={t(
          "Yeni sürümü indirir; kurmak için onayını bekler.",
          "Downloads a new version. Relay installs it only when you approve.",
        )}
      >
        <Switch
          id="update-auto"
          checked={update.autoCheck}
          onCheckedChange={(enabled) => void action("update-auto", () => api.setUpdateAuto(enabled))}
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
    gecis: t("Geçiş", "Switching"),
    planlama: t("Planlama", "Planning"),
    genel: t("Genel", "General"),
    gelismis: t("Gelişmiş", "Advanced"),
  }[tab];
}

/** The tab the hash names (`#/ayarlar/<tab>`, or a former page such as `#/gecis`), kept in step. */
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

/**
 * Every setting in one place, in four tabs: Switching (when, what switches along, near the
 * limit), Planning, General, and Advanced for everything technical or experimental. Each setting
 * appears once; actions live on the Overview, the account page and the panel.
 */
export function Settings({ tab: initialTab }: { tab?: SettingsTab }) {
  const relay = useRelay();
  const { api, data, desktop, settings, busy, version, action, active } = relay;
  const { t, language, setLanguage } = useI18n();
  const [tab, setTab] = useSettingsTab(initialTab);
  const disabled = !!busy || !!desktop?.busy;
  const update = (patch: Partial<RelaySettings>) =>
    void action("settings", () => api.updateSettings(patch));
  return (
    <PageFrame
      automationInline
      title={t("Ayarlar", "Settings")}
    >
      <Tabs value={tab} onValueChange={(v) => setTab(v as SettingsTab)} className="grid gap-4 px-5 pb-6">
        <TabsList aria-label={t("Ayar bölümleri", "Settings sections")} className="h-auto w-fit flex-wrap justify-start">
          {SETTINGS_TABS.map((id) => (
            <TabsTrigger key={id} value={id}>
              {settingsTabTitle(id, t)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="gecis">
          <SwitchingTab />
        </TabsContent>
        <TabsContent value="planlama">
          <PlanningTab />
        </TabsContent>
        <TabsContent value="genel">
          <div className="grid max-w-2xl gap-4">
            <SettingGroup id="settings-general" title={t("Genel", "General")}>
              <SettingRow
                label={
                  <span id="language-label">
                    {t("Arayüz dili", "Interface language")}
                  </span>
                }
              >
                <ToggleGroup
                  type="single"
                  variant="outline"
                  size="sm"
                  aria-labelledby="language-label"
                  value={language}
                  onValueChange={(v) => v && setLanguage(v as Language)}
                >
                  <ToggleGroupItem value="tr">Türkçe</ToggleGroupItem>
                  <ToggleGroupItem value="en">English</ToggleGroupItem>
                </ToggleGroup>
              </SettingRow>
              <SettingRow
                label={<span id="appearance-label">{t("Tema", "Theme")}</span>}
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
                    {t("Sistem", "System")}
                  </ToggleGroupItem>
                  <ToggleGroupItem value="light">
                    {t("Açık", "Light")}
                  </ToggleGroupItem>
                  <ToggleGroupItem value="dark">
                    {t("Koyu", "Dark")}
                  </ToggleGroupItem>
                </ToggleGroup>
              </SettingRow>
              <RefreshIntervalRow />
            </SettingGroup>
            {/* The menu bar title and the switch window are macOS-only; other platforms keep the R icon. */}
            {data?.diagnostics.platform === "darwin" && (
              <SettingGroup id="settings-menu-bar" title={t("Menü çubuğu", "Menu bar")}>
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
            <SettingGroup id="settings-panda" title="Panda">
              <SettingRow
                label={
                  <span id="panda-pranks-label">
                    {t("Panda şakaları", "Panda pranks")}
                  </span>
                }
                description={t(
                  "İmleci kısa süre saklayabilir.",
                  "Can hide the cursor for a short time.",
                )}
              >
                <ToggleGroup
                  type="single"
                  variant="outline"
                  size="sm"
                  aria-labelledby="panda-pranks-label"
                  value={settings.pranks ?? "sometimes"}
                  disabled={disabled}
                  onValueChange={(v) => v && update({ pranks: v as PrankLevel })}
                >
                  <ToggleGroupItem value="sometimes">
                    {t("Ara sıra", "Sometimes")}
                  </ToggleGroupItem>
                  <ToggleGroupItem value="rarely">
                    {t("Nadiren", "Rarely")}
                  </ToggleGroupItem>
                  <ToggleGroupItem value="off">{t("Kapalı", "Off")}</ToggleGroupItem>
                </ToggleGroup>
              </SettingRow>
              {data?.diagnostics.platform === "darwin" && (
                <>
                  <SettingRow
                    label={
                      <span id="menu-bar-animation-label">
                        {t("Panda animasyonları", "Panda animations")}
                      </span>
                    }
                    description={t(
                      "Menü çubuğunda. Kapalıyken panda yalnızca ifade değiştirir.",
                      "In the menu bar. When off, the panda only changes expression.",
                    )}
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
                        {t("Geçişte panda penceresini göster", "Show the panda window during a switch")}
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
            <p className="px-1 text-sm text-muted-foreground">
              {t(
                "Çoğu kullanıcının burada bir şeyi değiştirmesi gerekmez.",
                "Most people never need to change anything here.",
              )}
            </p>
            <SettingGroup id="settings-system" title={t("Sistem", "System")}>
              {/* An install Relay does not look for (every Linux build) is chosen here: Konumu seç. */}
              <SettingRow label="Claude Desktop">
                <span className="flex items-center gap-3">
                  <Status ok={!!desktop?.available}>
                    {desktop?.available
                      ? t("Bulundu", "Found")
                      : t("Bulunamadı", "Not found")}
                  </Status>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!!busy}
                    onClick={() => chooseClaudeApp({ api, action })}
                  >
                    {t("Konumu seç", "Choose location")}
                  </Button>
                </span>
              </SettingRow>
              {/* The missing-CLI error names this path: Ayarlar → Gelişmiş → Claude Code CLI → Dosyayı seç. */}
              <SettingRow
                label="Claude Code CLI"
                description={
                  data?.diagnostics.source === "claude-app"
                    ? t(
                        "Claude uygulamasının indirdiği kopya kullanılır.",
                        "Uses the copy that the Claude app downloaded.",
                      )
                    : undefined
                }
              >
                <span className="flex items-center gap-3">
                  <Status ok={!!data?.diagnostics.version}>
                    {data?.diagnostics.version ?? t("Bulunamadı", "Not found")}
                  </Status>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!!busy}
                    onClick={() => chooseCliFile({ api, action })}
                  >
                    {t("Dosyayı seç", "Choose file")}
                  </Button>
                </span>
              </SettingRow>
              <SettingRow
                label={t("Tanılama dosyaları", "Diagnostics files")}
                description={t(
                  "Yalnızca draft-events.json ve usage-issues.json dosyalarını gönder. Diğer dosyalarda kayıtlı girişlerin var.",
                  "Send only draft-events.json and usage-issues.json. The other files hold your saved sign-ins.",
                )}
              >
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void showDiagnostics({ api, action })}
                >
                  {t("Finder’da göster", "Show in Finder")}
                </Button>
              </SettingRow>
            </SettingGroup>
            <SettingGroup id="settings-troubleshooting" title={t("Sorun giderme", "Troubleshooting")}>
              <ClaudeLaunchRow api={api} action={action} data={data} t={t} />
            </SettingGroup>
            <SettingGroup id="settings-experimental" title={t("Deneysel", "Experimental")}>
              <p className="py-2 text-xs text-muted-foreground">
                {t(
                  "Deneysel özellikler Claude uygulamasının bir güncellemesiyle bozulabilir.",
                  "Experimental features can break with an update of the Claude app.",
                )}
              </p>
              <SeparateWindowsRow api={api} action={action} data={data} t={t} />
              <ExperimentalSwitchRows />
            </SettingGroup>
            <div id="settings-privacy" className="px-1">
              <Disclosure title={t("Gizlilik ve güvenlik", "Privacy and security")}>
                <PrivacyNotes t={t} />
              </Disclosure>
            </div>
            <p className="px-1 text-center text-xs text-muted-foreground">
              {t("Yerelde saklanır.", "Stored locally.")}{" "}
              {t("Bağımsız araç", "Independent tool")} · {version}
            </p>
          </div>
        </TabsContent>
      </Tabs>
    </PageFrame>
  );
}

/** How Relay keeps sign-ins, the Keychain prompt, and what a switch merges: the privacy section. */
export function PrivacyNotes({ t }: { t: ReturnType<typeof useI18n>["t"] }) {
  return (
    <>
      <Note>
        {t(
          "Claude uygulaması girişleri bu cihazda, işletim sistemi şifrelemesiyle saklanır. Her geçişten önce yedek alınır. Limit okuma girişi resmi Claude Code ile yapılır.",
          "Relay keeps Claude app sign-ins on this device, encrypted by the operating system. Relay makes a backup before each switch. The usage sign-in uses the official Claude Code.",
        )}
      </Note>
      <Note>
        {t(
          "Relay şifreleme anahtarını macOS Anahtarlık’ta tutar. Relay güncellendikten sonra macOS parolanı bir kez sorabilir; “Her Zaman İzin Ver”i seç.",
          "Relay keeps the encryption key in the macOS Keychain. After a Relay update, macOS can ask for your password once. Select “Always Allow”.",
        )}
      </Note>
      <Note>
        {t(
          "Geçiş deneyseldir ve Claude uygulamasının yerel dosya biçimine bağlıdır. Code oturumları ve yerel projeler seçtiğin paylaşım kapsamında birleşir. Chat geçmişi ve sunucudaki projeler her hesapta ayrı kalır.",
          "Account switch is experimental and depends on the Claude app’s local file format. Code sessions and local projects merge within the sharing scope you set. Chat history and server projects stay with each account.",
        )}
      </Note>
    </>
  );
}
