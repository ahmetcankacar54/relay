import { useEffect, useState } from "react";
import { Check, ChevronDown, ChevronUp, CircleAlert } from "lucide-react";
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
  MenuBarItem,
  MenuBarNow,
  PrankLevel,
  RelaySettings,
} from "../../shared/types";
import {
  DEFAULT_MENU_BAR_ITEMS,
  MENU_BAR_ITEMS,
  MENU_BAR_MAX_ITEMS,
  menuBarPreview,
} from "../../shared/tray";
import { chooseCliFile } from "../features/CliSetup";
import { chooseClaudeApp } from "../features/ClaudeAppSetup";
import { WarningThreshold } from "./Usage";

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
    <SettingRow
      label={t("Claude’u HTTP/3 olmadan aç", "Open Claude without HTTP/3")}
      htmlFor="claude-quic-off"
      description={t(
        "Bazı ağlarda claude.ai’nin HTTP/3 aktarımları takılır ve Claude uygulaması gri ekranda kalır. Açıkken Relay, Claude uygulamasını HTTP/2 ile başlatır. Bir geçişte sayfa takılıp HTTP/2 ile açılırsa Relay bunu kendisi açar. Yalnızca Relay’in başlattığı Claude için geçerlidir; Dock’tan açılan Claude HTTP/3 kullanır.",
        "On some networks claude.ai’s HTTP/3 transfers stall and the Claude app stays on a grey screen. While on, Relay starts the Claude app over HTTP/2. If a page sticks at a switch and loads over HTTP/2, Relay turns this on itself. It applies only to a Claude that Relay starts; a Claude opened from the Dock uses HTTP/3.",
      )}
    >
      <Switch
        id="claude-quic-off"
        checked={choice?.quicOff === true}
        disabled={choice === undefined}
        onCheckedChange={(quicOff) => change({ quicOff })}
      />
    </SettingRow>
  );
}

/** Why an item shows nothing for the account open in the Claude app now. */
const MENU_BAR_ITEM_MISSING: Record<MenuBarItem, readonly [tr: string, en: string]> = {
  "five-hour": ["şu an limit verisi yok", "no usage data now"],
  week: ["bu hesap haftalık limit bildirmiyor", "this account reports no weekly limit"],
  reset: ["5 saatlik dönem henüz başlamadı", "the 5-hour period has not started"],
  tokens: ["bugünün toplamı henüz hazır değil", "today’s total is not ready yet"],
  cost: ["bugünün toplamı henüz hazır değil", "today’s total is not ready yet"],
  account: ["Claude uygulamasında açık hesap yok", "no account open in the Claude app"],
};

/** Each menu bar item's name in Settings. */
const MENU_BAR_ITEM_LABELS: Record<MenuBarItem, readonly [tr: string, en: string]> = {
  "five-hour": ["5 saatlik kullanım", "5-hour usage"],
  week: ["Haftalık kullanım", "Weekly usage"],
  reset: ["5 saatlik dönemin kalan süresi", "Time left in the 5-hour period"],
  tokens: ["Bugünkü token", "Tokens today"],
  cost: ["Bugünkü API karşılığı", "API value today"],
  account: ["Hesap adı", "Account name"],
};

/** The items of `order` that are in `chosen`, in `order`'s order. */
const chosenIn = (order: readonly MenuBarItem[], chosen: readonly MenuBarItem[]) =>
  order.filter((item) => chosen.includes(item));

/**
 * What the menu bar title shows: each item on or off, with a preview of the title. The title reads
 * the switched-on rows from top to bottom; a row moves only by its arrows, past the switched-on row
 * before or after it, never when switched, so the next switch is still under the pointer. The choice
 * lives outside the registry, so these rows read and save it themselves; main redraws the title at once.
 */
export function MenuBarTitleRows({
  api,
  action,
  data,
  name,
  t,
  language,
}: Pick<ReturnType<typeof useRelay>, "api" | "action"> & {
  /** Relay's state; each change reads the menu bar again. */
  data?: unknown;
  /** The account open in the Claude app, for the name item's sample. */
  name?: string;
  t: ReturnType<typeof useI18n>["t"];
  language: Language;
}) {
  const [items, setItems] = useState<MenuBarItem[]>();
  // What the menu bar shows now, for the account open in the Claude app; samples without it.
  const [now, setNow] = useState<MenuBarNow>();
  const readNow = () =>
    Promise.resolve()
      .then(() => api.menuBarNow())
      .then(setNow)
      .catch(() => setNow(undefined));
  useEffect(() => {
    void readNow();
  }, [api, data]);
  // The rows: at first the chosen items in their order, then the others in Settings' order.
  const [order, setOrder] = useState<MenuBarItem[]>([...MENU_BAR_ITEMS]);
  useEffect(() => {
    let live = true;
    const show = (chosen: MenuBarItem[]) => {
      if (!live) return;
      setItems(chosen);
      setOrder([...chosen, ...MENU_BAR_ITEMS.filter((item) => !chosen.includes(item))]);
    };
    api
      .menuBarTitle()
      .then((choice) => show(choice.items))
      .catch(() => show([...DEFAULT_MENU_BAR_ITEMS]));
    return () => {
      live = false;
    };
  }, [api]);
  const save = (next: MenuBarItem[]) =>
    void action("menu-bar-title", async () => {
      setItems((await api.setMenuBarTitle({ items: next })).items);
      await readNow();
    });
  const chosen = chosenIn(order, items ?? []);
  const full = chosen.length >= MENU_BAR_MAX_ITEMS;
  const toggle = (item: MenuBarItem, on: boolean) =>
    save(chosenIn(order, on ? [...chosen, item] : chosen.filter((i) => i !== item)));
  // The row trades places with the switched-on row before or after it; the rows between stay.
  const move = (item: MenuBarItem, by: -1 | 1) => {
    const other = chosen[chosen.indexOf(item) + by];
    if (!other) return;
    const next = order.map((i) => (i === item ? other : i === other ? item : i));
    setOrder(next);
    save(chosenIn(next, chosen));
  };
  const sample = name ?? "Max";
  const preview = items && menuBarPreview(items, language, sample);
  return (
    <div className="border-t border-border py-3 first:border-t-0">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <span id="menu-bar-title-label" className="text-sm font-medium">
            {t("Menü çubuğunda göster", "Show in the menu bar")}
          </span>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            {t(
              `Yüzdeler ve süre, Claude uygulamasında açık hesabın; token ve API karşılığı tüm hesaplarının bugünkü toplamı. En çok ${MENU_BAR_MAX_ITEMS} değer seçebilirsin; sıra menü çubuğundaki sıradır. Limitler okunamazsa son okunan değer başında ~ ile kalır.`,
              `Percents and time are for the account open in the Claude app; tokens and API value are today’s total across all your accounts. Pick up to ${MENU_BAR_MAX_ITEMS}; the order is the menu bar’s. If limits cannot be read, the last reading stays, marked with ~.`,
            )}
          </p>
        </div>
        {items && (
          <span className="flex shrink-0 items-center gap-2">
            {now && (
              <span className="text-xs text-muted-foreground">{t("Şu an", "Now")}</span>
            )}
            <span
              data-slot="menu-bar-preview"
              className="rounded-md border bg-muted/40 px-2 py-0.5 text-sm font-medium whitespace-pre tabular-nums"
              title={now ? t("Menü çubuğunda şu an", "In the menu bar now") : t("Önizleme", "Preview")}
            >
              {(now ? now.title : preview) || t("Yalnızca panda", "Panda only")}
            </span>
          </span>
        )}
      </div>
      <ul aria-labelledby="menu-bar-title-label" className="mt-2 grid gap-0.5">
        {order.map((item) => {
          const on = chosen.includes(item);
          const place = chosen.indexOf(item);
          const [tr, en] = MENU_BAR_ITEM_LABELS[item];
          const label = t(tr, en);
          return (
            <li key={item} data-item={item} className="flex min-h-7 items-center gap-3">
              <Switch
                id={`menu-bar-item-${item}`}
                checked={on}
                disabled={!items || (!on && full)}
                onCheckedChange={(checked) => items && toggle(item, checked)}
              />
              <label htmlFor={`menu-bar-item-${item}`} className="min-w-0 flex-1 truncate text-sm">
                {label}{" "}
                {now && !now.values[item] ? (
                  // Nothing to show for this account now: say why, so a switch that changes nothing is clear.
                  <span data-slot="menu-bar-missing" className="text-muted-foreground italic">
                    {t(...MENU_BAR_ITEM_MISSING[item])}
                  </span>
                ) : (
                  <span className="text-muted-foreground tabular-nums">
                    {now ? now.values[item] : menuBarPreview([item], language, sample)}
                  </span>
                )}
              </label>
              {on && (
                <span className="flex shrink-0 items-center gap-0.5">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t(`${tr}: öne al`, `${en}: move earlier`)}
                    title={t("Öne al", "Move earlier")}
                    disabled={place === 0}
                    onClick={() => move(item, -1)}
                  >
                    <ChevronUp />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t(`${tr}: geriye al`, `${en}: move later`)}
                    title={t("Geriye al", "Move later")}
                    disabled={place === chosen.length - 1}
                    onClick={() => move(item, 1)}
                  >
                    <ChevronDown />
                  </Button>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
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

/**
 * Settings in direction A: one centred column of titled groups (appearance, the menu bar,
 * general, the system Relay works with, privacy), each a bordered box of rows.
 */
export function Settings() {
  const { api, data, desktop, settings, busy, version, action, active } = useRelay();
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
      <div className="mx-auto grid w-full max-w-2xl gap-6 px-6 pb-8">
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
              "Seyrek şakalar; hiçbir işlemi geciktirmez. Panda imleci kısa süre saklayabilir.",
              "Rare pranks; they never delay anything. The panda may briefly hide the cursor.",
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
                "Kapalıyken panda yalnızca ifade değiştirir. macOS’ta “Hareketi azalt” açıksa animasyon zaten oynamaz.",
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
        <SettingGroup id="settings-general" title={t("Genel", "General")}>
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
          {/* The same setting as Kullanım → Uyarılar, where the warnings are switched on and off. */}
          <SettingRow
            label={
              <span id="settings-threshold-label">
                {t("Uyarı eşiği", "Warning threshold")}
              </span>
            }
            description={
              settings.usageWarnings
                ? t(
                    "Beş saatlik veya haftalık kullanım bu paya ulaşınca hesap işaretlenir.",
                    "An account is marked when its 5-hour or weekly usage reaches this share.",
                  )
                : t(
                    "Limit uyarıları kapalı; Kullanım → Uyarılar’dan açılır.",
                    "Usage warnings are off; turn them on in Usage → Warnings.",
                  )
            }
          >
            <WarningThreshold labelledBy="settings-threshold-label" short />
          </SettingRow>
        </SettingGroup>
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
          <SettingRow label="Claude Code CLI">
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
        </SettingGroup>
        <SettingGroup
          id="settings-privacy"
          title={t("Gizlilik ve güvenlik", "Privacy and security")}
          className="grid gap-2 py-3"
        >
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
        </SettingGroup>
        <p className="px-1 text-center text-xs text-muted-foreground">
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
