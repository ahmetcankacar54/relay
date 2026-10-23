import { useState, type ReactNode } from "react";
import { ArrowRight, Code2, Lightbulb, ListTree, PencilLine, PanelsTopLeft } from "lucide-react";
import { PageFrame } from "@/app/PageFrame";
import { UsageRing } from "@/components/UsageRing";
import { useExtensionStatus } from "@/data/useExtension";
import { extensionGuide } from "@/lib/extension-ui";
import { formatPercent, percentUsed } from "@/lib/meter";
import {
  copySidebarRecipeAction,
  sidebarActionKeys,
  sidebarGapLine,
  sidebarRecipeHint,
} from "@/lib/sidebar-recipe";
import { useAutomation } from "../features/useAutomation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Note, OptionSelect, SectionHeading, SettingRow } from "@/components/SettingRow";
import { StatusDot } from "@/components/StatusDot";
import { useI18n, type T } from "@/data/i18n";
import type { Account, ExtensionStatus } from "../../shared/types";
import { useRelay } from "@/data/relay-context";
import {
  DraftRetypePreference,
  SharedHistoryPreferences,
  historyTransferOptions,
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

/**
 * What a switch brings along: one card per part, its state and its main control. The full
 * settings stay in Details below, which `href` jumps to.
 */
function Carry({
  icon,
  title,
  value,
  tone,
  href,
  children,
}: {
  icon: ReactNode;
  title: string;
  value: string;
  tone?: "ok" | "warn" | "crit" | "off";
  href?: string;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-2 rounded-xl border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <span aria-hidden="true" className="grid size-8 place-items-center rounded-lg bg-muted text-foreground/80 [&_svg]:size-4">
          {icon}
        </span>
        {href && (
          <a
            href={href}
            aria-label={t(`${title} · ayrıntılar`, `${title} · details`)}
            className="rounded-sm text-xs text-muted-foreground no-underline outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {t("Ayrıntılar", "Details")}
          </a>
        )}
      </div>
      <span className="text-sm font-semibold">{title}</span>
      <span className="flex items-start gap-1.5 text-[12.5px] text-muted-foreground">
        {tone && <StatusDot tone={tone} className="mt-1.5" />}
        <span className="min-w-0">{value}</span>
      </span>
      {children && <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">{children}</div>}
    </div>
  );
}

/** The Code sidebar sections the open account lacks, with Copy recipe as in the menu bar panel. */
function SidebarCarry() {
  const relay = useRelay();
  const { t } = useI18n();
  const [copiedId, setCopiedId] = useState<string>();
  const gap = relay.data?.sidebar;
  return (
    <Carry
      icon={<ListTree />}
      title={t("Kenar çubuğu bölümleri", "Sidebar sections")}
      value={
        gap
          ? `${sidebarGapLine(gap, t)}. ${sidebarRecipeHint(gap, copiedId === gap.id, t)}`
          : t("Açık hesapta eksik bölüm yok.", "The open account has every section.")
      }
    >
      {gap && (
        <Button
          size="sm"
          variant="outline"
          disabled={sidebarActionKeys(gap.id).includes(relay.busy)}
          onClick={() => void copySidebarRecipeAction(relay, gap.id, () => setCopiedId(gap.id))}
        >
          {t("Talimatı kopyala", "Copy recipe")}
        </Button>
      )}
    </Carry>
  );
}

/**
 * The extension card's line for the open account, its dot, and whether Check may help. `status`
 * is undefined while loading and null where the extension is not handled.
 */
export function extensionCarry(
  status: ExtensionStatus | null | undefined,
  active: Account | undefined,
  accounts: Account[],
  t: T,
  language: "tr" | "en",
): { value: string; tone?: "ok" | "warn" | "crit" | "off"; check: boolean } {
  if (status === undefined) return { value: t("Kontrol ediliyor…", "Checking…"), check: false };
  if (status === null) return { value: t("Bu Mac’te yok", "Not on this Mac"), check: false };
  if (status.setting.mode === "off") return { value: t("Kapalı", "Off"), tone: "off", check: false };
  const guide = active ? extensionGuide(active, status, accounts, t, language) : undefined;
  const check = guide?.action === "check";
  // Before any check Relay does not know who the extension is on: the count, and Check.
  if (!guide || (check && !status.current))
    return {
      value: t(`${status.saved.length} hesap bağlı`, `${status.saved.length} ${status.saved.length === 1 ? "account" : "accounts"} linked`),
      check,
    };
  return { value: guide.label, tone: guide.tone, check };
}

function ExtensionCarry({ disabled }: { disabled: boolean }) {
  const { accounts, active } = useRelay();
  const { t, language } = useI18n();
  const { status, checking, check } = useExtensionStatus();
  const state = extensionCarry(status, active, accounts, t, language);
  return (
    <Carry
      icon={<PanelsTopLeft />}
      title={t("Tarayıcı eklentisi", "Browser extension")}
      value={state.value}
      tone={state.tone}
      href="#gecis-eklenti"
    >
      {state.check && (
        <Button size="sm" variant="outline" disabled={disabled || checking} onClick={() => void check()}>
          {t("Kontrol et", "Check")}
        </Button>
      )}
    </Carry>
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
                  {t("Claude uygulaması ~15 sn kapalı kalır", "The Claude app closes for ~15 s")}
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
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Carry icon={<Code2 />} title={t("Code geçmişi", "Code history")} value={historyValue} href="#gecis-gecmis">
              <label htmlFor="carry-history" className="sr-only">
                {t("Geçmişi paylaş", "Share history")}
              </label>
              <OptionSelect
                id="carry-history"
                className="w-full min-w-0"
                value={settings.desktopHistoryTransfer}
                disabled={disabled}
                onChange={(desktopHistoryTransfer) => update({ desktopHistoryTransfer })}
                options={historyTransferOptions(t)}
              />
            </Carry>
            <ExtensionCarry disabled={disabled} />
            <Carry
              icon={<PencilLine />}
              title={t("Gönderilmemiş taslaklar", "Unsent drafts")}
              value={
                settings.draftRetype
                  ? t("Konuşmaya yeniden yazılır", "Typed back into the conversation")
                  : t("Panelde kopyalanmaya hazır bekler", "Offered to copy in the panel")
              }
              href="#gecis-taslak"
            >
              <label className="flex items-center gap-2 text-[13px]">
                <input
                  id="carry-retype"
                  type="checkbox"
                  className="size-4 shrink-0 accent-primary"
                  checked={settings.draftRetype === true}
                  disabled={disabled}
                  onChange={(e) => update({ draftRetype: e.target.checked })}
                />
                {t("Konuşmaya yeniden yaz", "Type it back into the conversation")}
                <Badge variant="outline" className="text-muted-foreground">
                  {t("Deneysel", "Experimental")}
                </Badge>
              </label>
            </Carry>
            <Carry
              icon={<Lightbulb />}
              title={t("Hesap önerisi", "Account suggestion")}
              value={
                !settings.usageWarnings
                  ? t("Limit uyarıları kapalı", "Usage warnings are off")
                  : settings.suggestAccounts
                    ? t("Limit yaklaşınca önerir", "Suggests near the limit")
                    : t("Kapalı", "Off")
              }
              href="#gecis-oneri"
            >
              <label className="flex items-center gap-2 text-[13px]">
                <Switch
                  id="carry-suggest"
                  checked={settings.suggestAccounts}
                  disabled={disabled || !settings.usageWarnings}
                  onCheckedChange={(suggestAccounts) => update({ suggestAccounts })}
                />
                {t("Hesap öner", "Suggest accounts")}
              </label>
            </Carry>
            <SidebarCarry />
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
                      "Resume and verify the interrupted switch",
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
                      "Gönderilmemiş devam mesajını iptal et",
                      "Cancel the unsent continuation",
                    )}
                  </Button>
                </div>
                <Note>
                  {t(
                    "Relay, Claude uygulamasındaki “Auto-continue when limits reset” seçeneğini kapattıysa bu işlemi iptal etmek onu yeniden açmaz. Bu seçeneği Claude uygulamasında kontrol et.",
                    "If Relay turned off “Auto-continue when limits reset” in the Claude app, cancelling this handoff does not turn it back on. Check that option in the Claude app.",
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
              "Code geçmişini paylaşan ve iki limitinde de yer olan bir hesap önerir. Geçişi sen başlatırsın.",
              "Suggests an account that shares Code history and has room in both limits. You start the switch.",
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
