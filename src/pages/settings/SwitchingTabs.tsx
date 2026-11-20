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
import { PageSection } from "@/components/PageSection";
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
import { copyDraftAction, dismissDraftAction, draftReason } from "../../panel/PanelDrafts";
import { ContinuationSettings } from "../../features/ContinuationSettings";
import { AutomationSettings } from "../../features/AutomationControl";
import { WarningThreshold } from "../Usage";
import type { RelaySettings } from "../../../shared/types";


const cardClass = "gap-0 px-4 py-3.5";
/** A row of the "what switches along" card: the card draws the line between rows. */
const partClass = "border-t py-2 first:border-t-0 first:pt-0 last:pb-0";
/** A part inside Advanced → Experimental's group, divided from the one above it. */
const rowClass = "border-t py-3 first:border-t-0";

/** What the tabs below need from Relay, read once per tab. */
function useSwitching() {
  const relay = useRelay();
  const { api, data, desktop, busy, action } = relay;
  const disabled = !!busy || !!desktop?.busy;
  // The extension, terminal and drafts come along on macOS only; Windows and Linux bring Code history.
  const macOS = ["darwin", "preview"].includes(data?.diagnostics?.platform ?? "");
  // The extension and the terminal come along on Linux too.
  const browserSteps = macOS || data?.diagnostics?.platform === "linux";
  const update = (patch: Partial<typeof relay.settings>) =>
    void action("settings", () => api.updateSettings(patch));
  return { relay, disabled, macOS, browserSteps, update };
}

/**
 * Settings → Switching: when Relay switches, what switches along with the Claude app, and what
 * happens near the limit. Preferences only: switching itself is on the Overview and in the panel.
 */
export function SwitchingTab() {
  const { relay, disabled, browserSteps, update } = useSwitching();
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
        <PageSection
          slot="gecis-birlikte"
          title={t("Geçişte birlikte değişenler", "What switches along")}
          info={
            browserSteps
              ? t(
                  "Claude uygulaması hesap değiştirince bunlar da değişebilir. Eklenti ve terminal isteğe bağlıdır.",
                  "When the Claude app changes account, these can change too. The extension and the terminal are optional.",
                )
              : t(
                  "Claude uygulaması hesap değiştirince Code geçmişin de gelebilir.",
                  "When the Claude app changes account, your Code history can come along.",
                )
          }
        >
          {/* One card, one row each: the name, where it stands now, its choice and its check. */}
          <Card className={cardClass} data-slot="switch-along">
            <div id="gecis-gecmis" className={partClass}>
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
            </div>
            {/* macOS and Linux: elsewhere these steps do not run, and their rows would stand empty. */}
            {browserSteps && (
              <>
                <div id="gecis-eklenti" className={partClass}>
                  <ExtensionPreference />
                </div>
                <div id="gecis-terminal" className={partClass}>
                  <TerminalPreference />
                </div>
              </>
            )}
          </Card>
        </PageSection>
        <PageSection
          title={t("Limite yaklaşınca", "Near the limit")}
          info={t(
            "Relay limite yaklaşan hesabı işaretler ve istersen geçilecek hesabı önerir.",
            "Relay marks accounts near their limit and, if you want, suggests one to switch to.",
          )}
        >
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
        </PageSection>
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
 * Linux's rescued drafts, as there is no menu bar panel: captured at a switch while the Claude
 * app is closed, then left for Copy, since re-typing them into Claude needs macOS.
 */
function RescuedDrafts() {
  const relay = useRelay();
  const { t } = useI18n();
  const drafts = (relay.data?.drafts ?? []).filter(
    (d) => d.state === "pending" || d.state === "needs-copy",
  );
  return (
    <div id="gecis-taslak" className={rowClass}>
      <SectionHeading
        title={t("Kurtarılan taslaklar", "Rescued drafts")}
        description={t(
          "Geçişte, Claude uygulaması kapalıyken gönderilmemiş taslaklar kurtarılır. Buradan kopyalayıp yapıştır; Claude uygulamasına yeniden yazmak yalnızca macOS’ta.",
          "At a switch, while the Claude app is closed, Relay rescues unsent drafts. Copy them here and paste; re-typing them into the Claude app is macOS only.",
        )}
      />
      {drafts.map((draft) => {
        const running = [`draft-copy:${draft.id}`, `draft-dismiss:${draft.id}`].includes(
          relay.busy,
        );
        return (
          <SettingRow
            key={draft.id}
            label={
              draft.newSession
                ? t("Yeni oturum", "New session")
                : draft.title.trim() || t("Adsız konuşma", "Untitled conversation")
            }
            description={
              draft.state === "pending"
                ? t("Bekliyor", "Waiting")
                : draftReason(draft.reason, t, draft.newSession)
            }
          >
            <span className="flex shrink-0 gap-1">
              <Button
                size="xs"
                variant="outline"
                disabled={running}
                onClick={() => void copyDraftAction(relay, draft.id)}
              >
                {t("Kopyala", "Copy")}
              </Button>
              {draft.state === "needs-copy" && (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={running}
                  onClick={() => void dismissDraftAction(relay, draft.id)}
                >
                  {t("Kapat", "Dismiss")}
                </Button>
              )}
            </span>
          </SettingRow>
        );
      })}
    </div>
  );
}

/**
 * Settings → Advanced → Experimental, the switch's part: re-typing rescued drafts and the Code
 * sidebar sections recipe, drawn inside that group. Re-typing is macOS only; Linux captures the
 * drafts too and offers them for Copy here.
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
      {relay.data?.diagnostics?.platform === "linux" && <RescuedDrafts />}
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
