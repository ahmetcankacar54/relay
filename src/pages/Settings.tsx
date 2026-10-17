import { PageFrame } from "@/app/PageFrame";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Note,
  OptionSelect,
  SectionHeading,
  SettingRow,
} from "@/components/SettingRow";
import { useI18n, type Language } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import type { PrankLevel, RelaySettings } from "../../shared/types";

const cardClass = "gap-0 px-5 py-4";

export function Settings() {
  const { api, data, desktop, settings, busy, version, action } = useRelay();
  const { t, language, setLanguage } = useI18n();
  const disabled = !!busy || !!desktop?.busy;
  const update = (patch: Partial<RelaySettings>) =>
    void action("settings", () => api.updateSettings(patch));
  return (
    <PageFrame
      title={t("Ayarlar", "Settings")}
      description={t(
        "Görünüm, dil ve teknik bilgiler",
        "Appearance, language and technical details",
      )}
    >
      <div className="grid gap-3 px-6 pb-6">
        <Card className={cardClass}>
          <SectionHeading title={t("Görünüm", "Appearance")} />
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
          {/* The menu bar panda and the switch window are macOS-only; other platforms keep the R icon. */}
          {data?.diagnostics.platform === "darwin" && (
            <>
              <SettingRow
                label={
                  <span id="menu-bar-animation-label">
                    {t("Panda animasyonları", "Panda animations")}
                  </span>
                }
                description={t(
                  "Kapalıyken panda yalnızca ifade değiştirir. macOS’ta Hareketi azalt açıksa animasyon zaten oynamaz.",
                  "When off, the panda only changes expression. With Reduce motion on in macOS it never animates.",
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
                  "Claude yeniden başlarken menü çubuğunun altında kısa bir sahne oynar.",
                  "A short scene plays under the menu bar while Claude restarts.",
                )}
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
          <SettingRow
            label={
              <span id="panda-pranks-label">
                {t("Panda şakaları", "Panda pranks")}
              </span>
            }
            description={t(
              "Seyrek şakalar; hiçbir işlemi geciktirmez.",
              "Rare pranks; they never delay anything.",
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
        </Card>
        <Card className={cardClass}>
          <SectionHeading title={t("Dil", "Language")} />
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
        </Card>
        <Card className={cardClass}>
          <SectionHeading title={t("Limitleri yenileme", "Limit refresh")} />
          <SettingRow
            label={t("Kullanım limitlerini yenile", "Refresh usage limits")}
            htmlFor="usage-interval"
            description={t(
              "Yalnızca kullanım verisi okunur; Claude çalışmaya devam eder.",
              "Reads usage data while Claude keeps running.",
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
                  label: `${n} ${t("dakika", "minutes")}`,
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
        </Card>
        <Card className={cardClass}>
          <SectionHeading
            title={t("Teknik bilgiler", "Technical details")}
            description={t(
              "Claude bağlantısı ve sürüm",
              "Claude connection and version",
            )}
          />
          <SettingRow label="Claude Desktop">
            <span className="text-sm text-muted-foreground">
              {desktop?.available
                ? t("Bulundu", "Detected")
                : t("Bulunamadı / desteklenmiyor", "Not found / unsupported")}
            </span>
          </SettingRow>
          <SettingRow label="Claude Code CLI">
            <span className="text-sm text-muted-foreground">
              {data?.diagnostics.version ?? t("Bulunamadı", "Not found")}
            </span>
          </SettingRow>
          <div className="border-t border-border py-3">
            <Button
              variant="outline"
              size="sm"
              disabled={!!busy}
              onClick={() =>
                void action("executable", () => api.pickExecutable())
              }
            >
              {t("Claude CLI dosyasını seç", "Choose Claude CLI executable")}
            </Button>
          </div>
          <Note className="mb-2">
            {t(
              "Desktop geçişi, Claude’un yerel dosya biçimine bağlı deneysel bir entegrasyondur. Code oturumları ve yerel proje kayıtları seçtiğin paylaşım kapsamında birleştirilir. Chat geçmişi ve sunucudaki proje grupları hesaplarına bağlı kalır.",
              "Desktop switching is an experimental integration with Claude’s local file format. Code sessions and local project records merge within your chosen sharing scope. Chat history and server-managed project groups remain account-specific.",
            )}
          </Note>
          <Note>
            {t(
              "Claude uygulaması girişleri bu cihazda işletim sistemi şifrelemesiyle saklanır. Her geçişten önce yedek alınır. Limit okuma girişi resmi Claude Code üzerinden tamamlanır.",
              "Claude app sign-ins are encrypted on this device using the operating system. Every switch creates a backup. The usage sign-in uses the official Claude Code.",
            )}
          </Note>
          <Note className="mt-2">
            {t(
              "Relay kayıtlı girişleri macOS Anahtarlık’ta şifreler. Yeni bir Relay sürümünden sonra macOS parolanı bir kez sorabilir; “Her Zaman İzin Ver”i seç.",
              "Relay encrypts saved sign-ins in the macOS Keychain. After a new Relay version, macOS may ask for your password once; choose “Always Allow”.",
            )}
          </Note>
        </Card>
        <p className="px-1 text-center text-[13px] text-muted-foreground">
          {t(
            "Yerelde saklanır. Kontrol sende.",
            "Stored locally. You stay in control.",
          )}{" "}
          {t("Bağımsız araç", "Independent tool")} · {version}
        </p>
      </div>
    </PageFrame>
  );
}
