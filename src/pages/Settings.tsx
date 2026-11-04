import { useEffect, useState } from "react";
import { Check, CircleAlert } from "lucide-react";
import { PageFrame } from "@/app/PageFrame";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Note,
  OptionSelect,
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
import { WarningThreshold } from "./Usage";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { routeHash, settingsTab, SETTINGS_TABS, type SettingsTab } from "@/app/routes";
import { AutomationTab, CarryTab } from "./settings/SwitchingTabs";
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
        label={t("Claude’u HTTP/3 olmadan aç", "Open Claude without HTTP/3")}
        htmlFor="claude-quic-off"
        description={t(
          "Claude gri ekranda kalıyorsa onu HTTP/2 ile başlatır.",
          "Starts Claude over HTTP/2 when it stays on a grey screen.",
        )}
      >
        <Switch
          id="claude-quic-off"
          checked={choice?.quicOff === true}
          disabled={choice === undefined}
          onCheckedChange={(quicOff) => change({ quicOff })}
        />
      </SettingRow>
      <div className="pb-3">
        <Disclosure title={t("Nasıl çalışır?", "How does it work?")}>
          <Note>
            {t(
              "Bazı ağlarda claude.ai’nin HTTP/3 aktarımları takılır. Bir geçişte sayfa takılıp HTTP/2 ile açılırsa Relay bunu kendisi açar. Yalnızca Relay’in başlattığı Claude için geçerlidir; Dock’tan açılan Claude HTTP/3 kullanır.",
              "On some networks claude.ai’s HTTP/3 transfers stall. If a page sticks at a switch and loads over HTTP/2, Relay turns this on itself. It applies only to a Claude that Relay starts; a Claude opened from the Dock uses HTTP/3.",
            )}
          </Note>
        </Disclosure>
      </div>
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
        label={t("Ayrı Claude pencereleri (deneysel)", "Separate Claude windows (experimental)")}
        htmlFor="separate-windows"
        description={t(
          "Bir hesabı kendi Claude penceresinde, ana Claude’un yanında açar.",
          "Opens an account in its own Claude window, next to the main Claude.",
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
              "Hesabın ⋯ menüsündeki “Ayrı pencerede aç”, o hesabı kendi veri klasörüyle ikinci bir Claude’da açar; giriş Relay’in kaydından gelir, pencere kapanınca geri kaydedilir. Pencere açıkken ana Claude o hesaba geçemez, Relay kendiliğinden geçiş yapmaz ve konuşmaları sürdürmez. Claude in Chrome yalnızca ana Claude’da çalışır; claude:// bağlantıları hangi Claude’a gideceğini macOS seçer. Claude bunu resmi olarak desteklemez, bir güncelleme bozabilir.",
              "“Open in a separate window” in an account’s ⋯ menu opens it in a second Claude with its own data folder; it signs in with Relay’s saved sign-in, which is saved back when the window closes. While the window is open the main Claude cannot switch to that account, and Relay neither switches nor continues conversations by itself. Claude in Chrome works only in the main Claude, and macOS picks which Claude a claude:// link goes to. Claude does not officially support this, and an update may break it.",
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
      ? t("Kontrol ediliyor…", "Checking…")
      : update.status === "error"
        ? `${t("Kontrol edilemedi", "Could not check")}: ${localizeError(update.error ?? "", language)}`
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
          "Açılışta ve altı saatte bir bakar; yeni sürümü indirip hazırlar, kurmak için senin onayını bekler.",
          "Looks at start and every six hours; downloads and readies a new version, then waits for you to install it.",
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
    otomasyon: t("Otomasyon", "Automation"),
    tasinanlar: t("Geçişte taşınanlar", "What comes along"),
    planlama: t("Planlama", "Planning"),
    bildirimler: t("Bildirimler", "Notifications"),
    gorunum: t("Görünüm", "Appearance"),
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
 * Every setting in one place, in six tabs: when Relay switches, what comes along, planning,
 * notifications, appearance, and the technical rest. Each setting appears once.
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
      description={t(
        "Otomasyon, geçişte taşınanlar, planlama ve uygulama ayarları",
        "Automation, what comes along, planning and app settings",
      )}
    >
      <Tabs value={tab} onValueChange={(v) => setTab(v as SettingsTab)} className="grid gap-5 px-6 pb-8">
        <TabsList aria-label={t("Ayar bölümleri", "Settings sections")} className="h-auto w-fit flex-wrap justify-start">
          {SETTINGS_TABS.map((id) => (
            <TabsTrigger key={id} value={id}>
              {settingsTabTitle(id, t)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="otomasyon">
          <AutomationTab />
        </TabsContent>
        <TabsContent value="tasinanlar">
          <CarryTab />
        </TabsContent>
        <TabsContent value="planlama">
          <PlanningTab />
        </TabsContent>
        <TabsContent value="bildirimler">
          <div className="grid max-w-2xl gap-6">
            <SettingGroup id="settings-notifications" title={t("Limit uyarıları", "Usage warnings")}>
              <SettingRow
                label={t("Limite yaklaşan hesabı işaretle", "Mark accounts near their limit")}
                htmlFor="usage-warnings"
                description={t(
                  "Eşiğe ulaşan hesap panelde ve listelerde işaretlenir; hesap önerisi de buna bağlıdır.",
                  "An account at the threshold is marked in the panel and lists; account suggestions depend on it.",
                )}
              >
                <Switch
                  id="usage-warnings"
                  checked={settings.usageWarnings}
                  disabled={disabled}
                  onCheckedChange={(usageWarnings) => update({ usageWarnings })}
                />
              </SettingRow>
              <SettingRow
                label={<span id="settings-threshold-label">{t("Uyarı eşiği", "Warning threshold")}</span>}
                description={t(
                  "Beş saatlik veya haftalık kullanım bu paya ulaşınca.",
                  "When 5-hour or weekly usage reaches this share.",
                )}
              >
                <WarningThreshold labelledBy="settings-threshold-label" short />
              </SettingRow>
              <SettingRow
            label={t("Limitleri otomatik yenile", "Refresh limits automatically")}
            htmlFor="usage-interval"
            description={t(
              "Yalnızca kullanım verisi okunur; Claude uygulaması çalışmaya devam eder.",
              "Reads usage data while the Claude app keeps running.",
            )}
          >
            <OptionSelect
              id="usage-interval"
              value={String(settings.usageRefreshMinutes)}
              disabled={disabled}
              options={[
                { value: "0", label: t("Elle", "Manually") },
                ...[5, 15, 30].map((n) => ({
                  value: String(n),
                  label: t(`${n} dakikada bir`, `Every ${n} minutes`),
                })),
              ]}
              onChange={(v) =>
                update({
                  usageRefreshMinutes: Number(
                    v,
                  ) as RelaySettings["usageRefreshMinutes"],
                })
              }
            />
          </SettingRow>
            </SettingGroup>
            <details className="px-1">
              <summary className="cursor-pointer text-sm font-medium">
                {t("Limitler nereden okunur?", "Where do the limits come from?")}
              </summary>
              <Note className="mt-1">
                {t(
                  "Limitler, Anthropic’in deneysel bir kullanım servisinden, hesabın limit izniyle okunur. Gerektiğinde izni yenilersin; bu yalnızca Relay’deki kopyayı günceller, açık Claude uygulamasına dokunmaz. Kullanılan yüzde, mesaj sayısı ya da süre garantisi değildir.",
                  "Usage comes from an experimental Anthropic endpoint, read with the account’s usage access. You renew that access when needed; it updates only Relay’s copy and leaves the open Claude app untouched. The percentage used is not a message count or time guarantee.",
                )}
              </Note>
            </details>
          </div>
        </TabsContent>
        <TabsContent value="gorunum">
          <div className="grid max-w-2xl gap-6">
        <SettingGroup id="settings-appearance" title={t("Görünüm", "Appearance")}>
          <SettingRow
            label={<span id="appearance-label">{t("Tema", "Theme")}</span>}
            description={t(
              "Sistem seçeneği macOS görünümünü izler.",
              "System follows the macOS appearance.",
            )}
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
          <SettingRow
            label={
              <span id="panda-pranks-label">
                {t("Panda şakaları", "Panda pranks")}
              </span>
            }
            description={t(
              "Seyrek şakalar; imleci kısa süre saklayabilir.",
              "Rare pranks; it may briefly hide the cursor.",
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
          <SettingRow
            label={
              <span id="language-label">
                {t("Arayüz dili", "Interface language")}
              </span>
            }
            description={t(
              "Menü çubuğu da bu dili izler.",
              "The menu bar follows this language.",
            )}
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
        </SettingGroup>
        {/* The menu bar panda and the switch window are macOS-only; other platforms keep the R icon. */}
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
            <SettingRow
              label={
                <span id="menu-bar-animation-label">
                  {t("Panda animasyonları", "Panda animations")}
                </span>
              }
              description={t(
                "Kapalıyken panda yalnızca ifade değiştirir.",
                "When off, the panda only changes expression.",
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
                  {t("Geçişte panda penceresini göster", "Show the panda window when switching")}
                </span>
              }
              description={t(
                "Claude uygulaması yeniden başlarken menü çubuğunun altında kısa bir sahne oynar.",
                "A short scene plays under the menu bar while the Claude app restarts.",
              )}
            >
              <Switch
                aria-labelledby="switch-window-label"
                checked={settings.switchWindow !== false}
                disabled={disabled}
                onCheckedChange={(checked) => update({ switchWindow: checked })}
              />
            </SettingRow>
          </SettingGroup>
        )}
          </div>
        </TabsContent>
        <TabsContent value="gelismis">
          <div className="grid max-w-2xl gap-6">
        <SettingGroup id="settings-system" title={t("Sistem", "System")}>
          {/* An install Relay does not look for (every Linux build) is chosen here: Konumu seç. */}
          <SettingRow label="Claude Desktop">
            <span className="flex items-center gap-3">
              <Status ok={!!desktop?.available}>
                {desktop?.available
                  ? t("Bulundu", "Detected")
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
          {/* The missing-CLI error names this path: Ayarlar → Claude Code CLI → Dosyayı seç. */}
          <SettingRow
            label="Claude Code CLI"
            description={
              data?.diagnostics.source === "claude-app"
                ? t(
                    "Claude uygulamasının Code için indirdiği kopya kullanılıyor; ayrıca kurman gerekmez.",
                    "Using the copy the Claude app downloaded for Code; no separate install needed.",
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
              "Yalnızca draft-events.json ve usage-issues.json dosyalarını gönder; klasörün geri kalanında kayıtlı girişlerin var.",
              "Send only draft-events.json and usage-issues.json; the rest of the folder holds your saved sign-ins.",
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
          <ClaudeLaunchRow api={api} action={action} data={data} t={t} />
          <SeparateWindowsRow api={api} action={action} data={data} t={t} />
        </SettingGroup>
        <UpdatesGroup api={api} action={action} data={data} busy={busy} t={t} language={language} />
        <div id="settings-privacy" className="px-1">
          <Disclosure title={t("Gizlilik ve güvenlik", "Privacy and security")}>
            <PrivacyNotes t={t} />
          </Disclosure>
        </div>
        <p className="px-1 text-center text-xs text-muted-foreground">
          {t(
            "Yerelde saklanır. Kontrol sende.",
            "Stored locally. You stay in control.",
          )}{" "}
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
          "Claude uygulaması girişleri bu cihazda işletim sistemi şifrelemesiyle saklanır. Her geçişten önce yedek alınır. Limit okuma girişi resmi Claude Code üzerinden tamamlanır.",
          "Claude app sign-ins are encrypted on this device using the operating system. Every switch creates a backup. The usage sign-in uses the official Claude Code.",
        )}
      </Note>
      <Note>
        {t(
          "Relay kayıtlı girişleri macOS Anahtarlık’ta tuttuğu bir anahtarla şifreler. Yeni bir Relay sürümünden sonra macOS parolanı bir kez sorabilir; “Her Zaman İzin Ver”i seç.",
          "Relay encrypts saved sign-ins with a key it keeps in the macOS Keychain. After a new Relay version, macOS may ask for your password once; choose “Always Allow”.",
        )}
      </Note>
      <Note>
        {t(
          "Hesap geçişi, Claude uygulamasının yerel dosya biçimine bağlı deneysel bir entegrasyondur. Code oturumları ve yerel proje kayıtları seçtiğin paylaşım kapsamında birleştirilir. Chat geçmişi ve sunucudaki proje grupları hesaplarına bağlı kalır.",
          "Switching accounts is an experimental integration with the Claude app’s local file format. Code sessions and local project records merge within your chosen sharing scope. Chat history and server-managed project groups remain account-specific.",
        )}
      </Note>
    </>
  );
}
