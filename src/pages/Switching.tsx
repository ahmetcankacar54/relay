import type { ReactNode } from "react";
import { ArrowRight, Code2, Lightbulb, PencilLine, PanelsTopLeft } from "lucide-react";
import { PageFrame } from "@/app/PageFrame";
import { UsageRing } from "@/components/UsageRing";
import { useExtensionStatus } from "@/data/useExtension";
import { formatPercent, percentUsed } from "@/lib/meter";
import { useAutomation } from "../features/useAutomation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Note, SectionHeading, SettingRow } from "@/components/SettingRow";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import {
  DraftRetypePreference,
  SharedHistoryPreferences,
} from "../features/SwitchPreferences";
import { ExtensionPreference } from "../features/ExtensionPreference";
import { ContinuationSettings } from "../features/ContinuationSettings";
import { AutomationSettings, MODE_TITLE } from "../features/AutomationControl";

const cardClass = "gap-0 px-5 py-4";

/** An account as the switch sees it: a ring for its five hours, its name above a caption. */
function Side({ name, caption, percent, align }: { name: string; caption: string; percent?: number; align?: "end" }) {
  const { language } = useI18n();
  return (
    <div className={align === "end" ? "flex flex-row-reverse items-center gap-3 text-right" : "flex items-center gap-3"}>
      <UsageRing outer={percent} size={60} label={`${name} ${percent === undefined ? "" : formatPercent(percentUsed(percent), language)}`}>
        <span className="text-[13px] font-bold tabular-nums">
          {percent === undefined ? "—" : formatPercent(percentUsed(percent), language)}
        </span>
      </UsageRing>
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground">{caption}</div>
        <div className="truncate text-[15px] font-bold">{name}</div>
      </div>
    </div>
  );
}

/** What a switch brings along: one card per part, its state, and a jump to its settings. */
function Carry({ icon, title, value, href }: { icon: ReactNode; title: string; value: string; href: string }) {
  return (
    <a
      href={href}
      className="flex flex-col gap-2 rounded-xl border bg-card p-4 text-inherit no-underline outline-none hover:border-foreground/20 focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <span aria-hidden="true" className="grid size-8 place-items-center rounded-lg bg-muted text-foreground/80 [&_svg]:size-4">
        {icon}
      </span>
      <span className="text-sm font-semibold">{title}</span>
      <span className="text-[12.5px] text-muted-foreground">{value}</span>
    </a>
  );
}

export function Switching() {
  const relay = useRelay();
  const { t } = useI18n();
  const {
    api,
    data,
    desktop,
    accounts,
    active,
    settings,
    busy,
    desktopBusy,
    pendingDesktop,
    action,
    setData,
  } = relay;
  const disabled = !!busy || !!desktop?.busy;
  const continuation = data?.continuation;
  const automation = useAutomation();
  const target =
    accounts.find((a) => a.id === automation.status.switchTo) ??
    (relay.suggestion && accounts.find((a) => a.id === relay.suggestion?.id)) ??
    undefined;
  const historyValue = {
    off: t("Paylaşılmıyor", "Not shared"),
    all: t("Tüm hesaplarda görünür", "Visible in all accounts"),
    "same-group": t("Aynı gruptaki hesaplarda görünür", "Visible in the same group"),
    selected: t("Seçili hesaplarda görünür", "Visible in selected accounts"),
  }[settings.desktopHistoryTransfer];
  const extension = useExtensionStatus().status;
  const extensionValue = !extension
    ? t("Bu Mac'te yok", "Not on this Mac")
    : extension.setting.mode === "off"
      ? t("Kapalı", "Off")
      : t(`${extension.saved.length} hesap bağlı`, `${extension.saved.length} accounts linked`);
  const update = (patch: Partial<typeof settings>) =>
    void action("settings", () => api.updateSettings(patch));
  const requestAccessibility = () =>
    void action("continuation-permission", () =>
      api.requestDesktopAccessibility(),
    );
  const accessibilityNeeded =
    continuation?.enabled &&
    (continuation.observationReason === "accessibility-permission-required" ||
      continuation.reason === "accessibility-permission-required");
  return (
    <PageFrame
      automationInline
      title={t("Geçiş", "Switching")}
      description={t(
        "Ne zaman geçilir, yanında neler gelir",
        "When to switch, and what comes along",
      )}
    >
      <div className="grid gap-5 px-6 pb-6">
        {active && (
          <Card data-slot="switch-status" className="flex-row flex-wrap items-center gap-6 px-6 py-5">
            <Side
              name={active.name}
              caption={t("Şu an", "Now")}
              percent={data?.usage[active.id]?.fiveHour?.usedPercent}
            />
            <div className="flex min-w-40 flex-1 flex-col items-center gap-1.5 text-center">
              <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium">
                {t(...MODE_TITLE[automation.mode])}
              </span>
              <span aria-hidden="true" className="flex w-full items-center gap-1 text-muted-foreground/60">
                <span className="h-px flex-1 border-t-2 border-dashed border-current" />
                <ArrowRight className="size-4" />
              </span>
              <span className="text-xs text-muted-foreground">
                {t("Code geçmişi, eklenti ve taslaklar da gelir", "Code history, the extension and drafts come along")}
              </span>
            </div>
            {target ? (
              <Side
                align="end"
                name={target.name}
                caption={t("Sıradaki", "Next")}
                percent={data?.usage[target.id]?.fiveHour?.usedPercent}
              />
            ) : (
              <div className="text-sm text-muted-foreground">{t("Geçilecek hesap yok", "No account to switch to")}</div>
            )}
            {target && (
              <div className="flex w-40 flex-col gap-1.5 border-l pl-6">
                <Button
                  disabled={desktopBusy || !!pendingDesktop || !!desktop?.recoveryRequired}
                  onClick={() => relay.requestDesktop(target, "switch")}
                >
                  {t("Şimdi geç", "Switch now")}
                </Button>
                <span className="text-center text-[11.5px] text-muted-foreground">
                  {t("Claude ~15 sn kapalı kalır", "Claude closes for ~15 s")}
                </span>
              </div>
            )}
          </Card>
        )}
        <AutomationSettings />
        <section className="grid gap-3" aria-labelledby="carry-title">
          <h2 id="carry-title" className="flex items-center gap-2 text-sm font-semibold">
            <span aria-hidden="true" className="grid size-5 place-items-center rounded-full bg-foreground text-[11px] text-background">
              2
            </span>
            {t("Geçişte neler gelir?", "What comes along?")}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Carry
              icon={<Code2 />}
              title={t("Code geçmişi", "Code history")}
              value={historyValue}
              href="#gecis-gecmis"
            />
            <Carry
              icon={<PanelsTopLeft />}
              title={t("Tarayıcı eklentisi", "Browser extension")}
              value={extensionValue}
              href="#gecis-eklenti"
            />
            <Carry
              icon={<PencilLine />}
              title={t("Yarım mesajlar", "Unsent drafts")}
              value={
                settings.draftRetype
                  ? t("Konuşmaya yeniden yazılır", "Typed back into the conversation")
                  : t("Panelde Kopyala ile sunulur", "Offered to copy in the panel")
              }
              href="#gecis-taslak"
            />
            <Carry
              icon={<Lightbulb />}
              title={t("Hesap önerisi", "Account suggestion")}
              value={settings.suggestAccounts ? t("Limit yaklaşınca önerir", "Suggests near the limit") : t("Kapalı", "Off")}
              href="#gecis-oneri"
            />
          </div>
        </section>
        <h2 className="mt-2 px-1 text-[13px] font-semibold text-muted-foreground">{t("Ayrıntılar", "Details")}</h2>
        {/* A single-conversation watch from earlier versions stays visible until it is off. */}
        {(continuation?.enabled ||
          continuation?.status === "reconciliation-required") && (
          <Card className={cardClass}>
            <ContinuationSettings
              accounts={accounts}
              active={active}
              value={continuation}
              busy={disabled}
              canArm={continuation?.canArm}
              blockingReason={continuation?.observationReason}
              onRefresh={() =>
                void action("continuation-check", async () => {
                  const checked = await api.inspectContinuation();
                  setData((current) =>
                    current ? { ...current, continuation: checked } : current,
                  );
                })
              }
              onArm={() =>
                void action("continuation-arm", () =>
                  api.armContinuation(
                    "automatic",
                    "guarded-native-at-most-once",
                  ),
                )
              }
              onDisable={() =>
                void action("continuation-disarm", () =>
                  api.disarmContinuation(),
                )
              }
              t={t}
              usage={data?.usage ?? {}}
              settings={settings}
            />
            {accessibilityNeeded && (
              <Button
                variant="outline"
                className="mt-3 w-fit"
                disabled={disabled}
                onClick={requestAccessibility}
              >
                {t(
                  "macOS Erişilebilirlik iznini aç",
                  "Open macOS Accessibility permission",
                )}
              </Button>
            )}
            {continuation?.status === "reconciliation-required" && (
              <div className="mt-3 grid gap-2">
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    disabled={disabled}
                    onClick={() =>
                      void action("continuation-reconcile", () =>
                        api.reconcileContinuation(),
                      )
                    }
                  >
                    {t(
                      "Yarım kalan geçişi sürdür ve doğrula",
                      "Resume and reconcile interrupted handoff",
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={disabled}
                    onClick={() =>
                      void action("continuation-abandon", () =>
                        api.abandonContinuation(),
                      )
                    }
                  >
                    {t(
                      "Gönderilmemiş işlemi iptal et",
                      "Cancel an unsent handoff",
                    )}
                  </Button>
                </div>
                <Note>
                  {t(
                    "Claude uygulamasının kota zamanlayıcısı devralındıysa, işlemi iptal etmek bu zamanlayıcıyı yeniden açmaz. Claude uygulamasındaki ‘limit yenilenince devam et’ seçeneğini kontrol et.",
                    "If the Claude app’s quota timer was taken over, cancelling this handoff does not re-enable it. Check the Claude app’s ‘continue when limits reset’ option.",
                  )}
                </Note>
              </div>
            )}
          </Card>
        )}
        <Card id="gecis-gecmis" className={cardClass}>
          <SharedHistoryPreferences
            value={settings}
            accounts={accounts}
            active={active}
            update={update}
            disabled={disabled}
            syncDisabled={
              !!desktopBusy || !!pendingDesktop || !!desktop?.recoveryRequired
            }
            sync={() => relay.requestDesktop(active, "history")}
            t={t}
          />
        </Card>
        <Card id="gecis-eklenti" className={cardClass}>
          <ExtensionPreference />
        </Card>
        <Card id="gecis-taslak" className={cardClass}>
          <DraftRetypePreference
            value={settings}
            update={update}
            disabled={disabled}
            t={t}
          />
        </Card>
        <Card id="gecis-oneri" className={cardClass}>
          <SectionHeading
            title={t(
              "Limit yaklaşınca hesap öner",
              "Suggest an account near the limit",
            )}
          />
          <SettingRow
            label={t("Geçilecek hesabı öner", "Suggest another account")}
            htmlFor="usage-suggestions"
            description={t(
              "Geçmiş kapsamındaki, iki limiti de uygun olan hesabı önerir. Geçişi sen başlatırsın.",
              "Suggests an account in the history scope with room in both limits. You start the switch.",
            )}
          >
            <Switch
              id="usage-suggestions"
              checked={settings.suggestAccounts}
              disabled={disabled || !settings.usageWarnings}
              onCheckedChange={(suggestAccounts) => update({ suggestAccounts })}
            />
          </SettingRow>
          {!settings.usageWarnings && (
            <Note>
              {t(
                "Limit uyarıları kapalıyken öneri yapılmaz.",
                "Suggestions are off while usage warnings are off.",
              )}
            </Note>
          )}
        </Card>
      </div>
    </PageFrame>
  );
}
