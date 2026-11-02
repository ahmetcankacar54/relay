import { useState } from "react";
import { ArrowRight, ListTree } from "lucide-react";
import { UsageRing } from "@/components/UsageRing";
import { formatPercent, percentUsed } from "@/lib/meter";
import {
  copySidebarRecipeAction,
  sidebarActionKeys,
  sidebarGapLine,
  sidebarRecipeHint,
} from "@/lib/sidebar-recipe";
import { useAutomation } from "../../features/useAutomation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Note, SectionHeading, SettingRow } from "@/components/SettingRow";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import {
  DraftRetypePreference,
  SharedHistoryPreferences,
} from "../../features/SwitchPreferences";
import { ExtensionPreference } from "../../features/ExtensionPreference";
import { TerminalPreference } from "../../features/TerminalPreference";
import { ContinuationSettings } from "../../features/ContinuationSettings";
import { AutomationSettings, MODE_TITLE } from "../../features/AutomationControl";

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

/** What the tabs below need from Relay, read once per tab. */
function useSwitching() {
  const relay = useRelay();
  const { api, data, desktop, busy, action } = relay;
  const disabled = !!busy || !!desktop?.busy;
  // The extension, terminal and drafts come along on macOS only; Windows and Linux bring Code history.
  const macOS = ["darwin", "preview"].includes(data?.diagnostics?.platform ?? "");
  const update = (patch: Partial<typeof relay.settings>) =>
    void action("settings", () => api.updateSettings(patch));
  return { relay, disabled, macOS, update };
}

/**
 * Settings → Automation: who is open and who comes next, when Relay switches by itself, and the
 * account suggestion near the limit. Each setting once.
 */
export function AutomationTab() {
  const { relay, disabled, macOS, update } = useSwitching();
  const { t } = useI18n();
  const { api, data, desktop, accounts, active, settings, desktopBusy, pendingDesktop, action, setData } = relay;
  const continuation = data?.continuation;
  const automation = useAutomation();
  const target =
    accounts.find((a) => a.id === automation.status.switchTo) ??
    (relay.suggestion && accounts.find((a) => a.id === relay.suggestion?.id)) ??
    undefined;
  const requestAccessibility = () =>
    void action("continuation-permission", () =>
      api.requestDesktopAccessibility(),
    );
  const accessibilityNeeded =
    continuation?.enabled &&
    (continuation.observationReason === "accessibility-permission-required" ||
      continuation.reason === "accessibility-permission-required");
  return (
    <div className="grid gap-5">
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
                {macOS
                  ? t("Code geçmişi, eklenti, terminal ve taslaklar da gelir", "Code history, the extension, the terminal and drafts come along")
                  : t("Code geçmişi de gelir", "Code history comes along")}
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
  );
}

/** The Code sidebar sections the open account lacks, with Copy recipe as in the menu bar panel. */
function SidebarSections() {
  const relay = useRelay();
  const { t } = useI18n();
  const [copiedId, setCopiedId] = useState<string>();
  const gap = relay.data?.sidebar;
  return (
    <Card id="gecis-kenar" className={cardClass}>
      <SectionHeading
        icon={<ListTree />}
        title={t("Kenar çubuğu bölümleri", "Sidebar sections")}
        description={t(
          "Geçtiğin hesapta eksik bölümleri bir Code oturumu talimatla kurar.",
          "A Code session sets up the sections the new account lacks, from a recipe.",
        )}
      />
      <SettingRow
        label={
          gap
            ? `${sidebarGapLine(gap, t)}. ${sidebarRecipeHint(gap, copiedId === gap.id, t)}`
            : t("Açık hesapta eksik bölüm yok.", "The open account has every section.")
        }
      >
        {gap ? (
          <Button
            size="sm"
            variant="outline"
            disabled={sidebarActionKeys(gap.id).includes(relay.busy)}
            onClick={() => void copySidebarRecipeAction(relay, gap.id, () => setCopiedId(gap.id))}
          >
            {t("Talimatı kopyala", "Copy recipe")}
          </Button>
        ) : (
          <span />
        )}
      </SettingRow>
    </Card>
  );
}

/**
 * Settings → What comes along: Code history, and on macOS the browser extension, the terminal's
 * Claude Code and unsent drafts, then the sidebar sections. One card each, each setting once.
 */
export function CarryTab() {
  const { relay, disabled, macOS, update } = useSwitching();
  const { t } = useI18n();
  const { desktop, accounts, active, settings, desktopBusy, pendingDesktop } = relay;
  return (
    <div className="grid gap-5">
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
        {/* macOS only: elsewhere these steps do not run, and their cards would stand empty. */}
        {macOS && (
          <>
            <Card id="gecis-eklenti" className={cardClass}>
              <ExtensionPreference />
            </Card>
            <Card id="gecis-terminal" className={cardClass}>
              <TerminalPreference />
            </Card>
            <Card id="gecis-taslak" className={cardClass}>
              <DraftRetypePreference
                value={settings}
                update={update}
                disabled={disabled}
                t={t}
              />
            </Card>
          </>
        )}
        <SidebarSections />
    </div>
  );
}

