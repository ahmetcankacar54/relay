import { useState } from "react";
import { ListTree } from "lucide-react";
import {
  copySidebarRecipeAction,
  sidebarActionKeys,
  sidebarGapLine,
  sidebarRecipeHint,
} from "@/lib/sidebar-recipe";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Note, OptionSelect, SectionHeading, SettingRow } from "@/components/SettingRow";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import {
  DraftRetypePreference,
  SharedHistoryPreferences,
} from "../../features/SwitchPreferences";
import { ExtensionPreference } from "../../features/ExtensionPreference";
import { TerminalPreference } from "../../features/TerminalPreference";
import { ContinuationSettings } from "../../features/ContinuationSettings";
import { AutomationSettings } from "../../features/AutomationControl";
import { WarningThreshold } from "../Usage";
import type { RelaySettings } from "../../../shared/types";


const cardClass = "gap-0 px-4 py-3.5";
/** A part inside Advanced → Experimental's group, divided from the one above it. */
const rowClass = "border-t py-3 first:border-t-0";

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

/** A section's title on the Switching tab: a plain heading with one line under it. */
function TabSection({ id, title, description }: { id: string; title: string; description: string }) {
  return (
    <div className="grid gap-0.5 px-1 pt-2">
      <h2 id={id} className="text-sm font-semibold">
        {title}
      </h2>
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  );
}

/**
 * Settings → Switching: when Relay switches, what switches along with the Claude app, and what
 * happens near the limit. Preferences only: switching itself is on the Overview and in the panel.
 */
export function SwitchingTab() {
  const { relay, disabled, macOS, update } = useSwitching();
  const { t } = useI18n();
  const { api, data, accounts, active, settings, desktop, desktopBusy, pendingDesktop, action, setData } = relay;
  const continuation = data?.continuation;
  const requestAccessibility = () =>
    void action("continuation-permission", () =>
      api.requestDesktopAccessibility(),
    );
  const accessibilityNeeded =
    continuation?.enabled &&
    (continuation.observationReason === "accessibility-permission-required" ||
      continuation.reason === "accessibility-permission-required");
  return (
    <div className="grid max-w-3xl gap-4">
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
                      "Continue and verify the interrupted switch",
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
                    "İptal, Claude uygulamasındaki “Auto-continue when limits reset” seçeneğini yeniden açmaz. Bu seçeneği Claude uygulamasında kontrol et.",
                    "Cancel does not turn “Auto-continue when limits reset” back on in the Claude app. Check this option in the Claude app.",
                  )}
                </Note>
              </div>
            )}
          </Card>
        )}
        <TabSection
          id="gecis-birlikte"
          title={t("Geçişte birlikte değişenler", "What switches along")}
          description={
            macOS
              ? t(
                  "Claude uygulaması hesap değiştirince bunlar da değişebilir. Eklenti ve terminal isteğe bağlıdır.",
                  "When the Claude app changes account, these can change too. The extension and the terminal are optional.",
                )
              : t(
                  "Claude uygulaması hesap değiştirince Code geçmişin de gelebilir.",
                  "When the Claude app changes account, your Code history can come along.",
                )
          }
        />
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
          </>
        )}
        <TabSection
          id="gecis-limit"
          title={t("Limite yaklaşınca", "Near the limit")}
          description={t(
            "Relay limite yaklaşan hesabı işaretler ve istersen geçilecek hesabı önerir.",
            "Relay marks accounts near their limit and, if you want, suggests one to switch to.",
          )}
        />
        <Card id="gecis-oneri" className={cardClass}>
          <SettingRow
            label={t("Limite yaklaşan hesabı işaretle", "Mark accounts near their limit")}
            htmlFor="usage-warnings"
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
              "5 saatlik ve haftalık dönem için.",
              "For the 5-hour and weekly periods.",
            )}
          >
            <WarningThreshold labelledBy="settings-threshold-label" short />
          </SettingRow>
          <SettingRow
            label={t("Geçilecek hesabı öner", "Suggest another account")}
            htmlFor="usage-suggestions"
            description={
              settings.usageWarnings
                ? t(
                    "Code geçmişini paylaşan ve iki limitinde de yer olan bir hesap önerir. Geçişi sen başlatırsın.",
                    "Suggests an account with shared Code history and room in both limits. You start the switch.",
                  )
                : t(
                    "Önce limite yaklaşan hesabı işaretlemeyi aç.",
                    "First, turn on marking accounts near their limit.",
                  )
            }
          >
            <Switch
              id="usage-suggestions"
              checked={settings.suggestAccounts}
              disabled={disabled || !settings.usageWarnings}
              onCheckedChange={(suggestAccounts) => update({ suggestAccounts })}
            />
          </SettingRow>
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
    <div id="gecis-kenar" className={rowClass}>
      <SectionHeading
        icon={<ListTree />}
        title={t("Kenar çubuğu bölümleri", "Sidebar sections")}
      />
      <SettingRow
        label={
          gap
            ? `${sidebarGapLine(gap, t)}. ${sidebarRecipeHint(gap, copiedId === gap.id, t)}`
            : t("Açık hesapta eksik bölüm yok.", "The open account has all sections.")
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
    </div>
  );
}

/**
 * Settings → Advanced → Experimental, the switch's part: re-typing rescued drafts and the Code
 * sidebar sections recipe, drawn inside that group. macOS only for the drafts, as the step runs
 * there only.
 */
export function ExperimentalSwitchRows() {
  const { relay, disabled, macOS, update } = useSwitching();
  const { t } = useI18n();
  return (
    <>
      {macOS && (
        <div id="gecis-taslak" className={rowClass}>
          <DraftRetypePreference
            value={relay.settings}
            update={update}
            disabled={disabled}
            t={t}
          />
        </div>
      )}
      <SidebarSections />
    </>
  );
}

/** How often Relay reads the limits by itself: General, as it is not a notification. */
export function RefreshIntervalRow() {
  const { relay, disabled, update } = useSwitching();
  const { t } = useI18n();
  return (
    <SettingRow
      label={t("Limitleri otomatik yenile", "Refresh limits automatically")}
      htmlFor="usage-interval"
    >
      <OptionSelect
        id="usage-interval"
        value={String(relay.settings.usageRefreshMinutes)}
        disabled={disabled}
        options={[
          { value: "0", label: t("Elle", "Manually") },
          ...[5, 15, 30].map((n) => ({
            value: String(n),
            label: t(`${n} dakikada bir`, `Every ${n} min`),
          })),
        ]}
        onChange={(v) =>
          update({
            usageRefreshMinutes: Number(v) as RelaySettings["usageRefreshMinutes"],
          })
        }
      />
    </SettingRow>
  );
}
