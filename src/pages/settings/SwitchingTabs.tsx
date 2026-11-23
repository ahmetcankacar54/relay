import { useState } from "react";
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
          <Card padded>
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
                {t("switchingTabs.openMacosAccessibilityPermission")}
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
                    {t("switchingTabs.continueAndVerifyTheInterruptedSwitch")}
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
                    {t("switchingTabs.cancelTheUnsentContinuation")}
                  </Button>
                </div>
                <Note>
                  {t("switchingTabs.cancelDoesNotTurnAutoContinue")}
                </Note>
              </div>
            )}
          </Card>
        )}
        <PageSection
          slot="gecis-birlikte"
          title={t("switchingTabs.whatSwitchesAlong")}
          info={
            browserSteps
              ? t("switchingTabs.whenTheClaudeAppChangesAccount")
              : t("switchingTabs.whenTheClaudeAppChangesAccount2")
          }
        >
          {/* One card, one row each: the name, where it stands now, its choice and its check. */}
          <Card padded data-slot="switch-along">
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
          title={t("switchingTabs.nearTheLimit")}
          info={t("switchingTabs.relayMarksAccountsNearTheirLimit")}
        >
        <Card id="gecis-oneri" padded>
          <SettingRow
            label={t("switchingTabs.markAccountsNearTheirLimit")}
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
            label={<span id="settings-threshold-label">{t("switchingTabs.warningThreshold")}</span>}
            description={t("switchingTabs.forThe5HourAndWeekly")}
          >
            <WarningThreshold labelledBy="settings-threshold-label" short />
          </SettingRow>
          <SettingRow
            label={t("switchingTabs.suggestAnotherAccount")}
            htmlFor="usage-suggestions"
            description={
              settings.usageWarnings
                ? t("switchingTabs.suggestsAnAccountWithSharedCode")
                : t("switchingTabs.firstTurnOnMarkingAccountsNear")
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
      <SectionHeading title={t("switchingTabs.sidebarSections")} />
      <SettingRow
        label={
          gap
            ? `${sidebarGapLine(gap, t)}. ${sidebarRecipeHint(gap, copiedId === gap.id, t)}`
            : t("switchingTabs.theOpenAccountHasAllSections")
        }
      >
        {gap ? (
          <Button
            size="sm"
            variant="outline"
            disabled={sidebarActionKeys(gap.id).includes(relay.busy)}
            onClick={() => void copySidebarRecipeAction(relay, gap.id, () => setCopiedId(gap.id))}
          >
            {t("switchingTabs.copyRecipe")}
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
        title={t("common.rescuedDrafts")}
        description={t("switchingTabs.atASwitchWhileTheClaude")}
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
                ? t("switchingTabs.newSession")
                : draft.title.trim() || t("switchingTabs.untitledConversation")
            }
            description={
              draft.state === "pending"
                ? t("switchingTabs.waiting")
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
                {t("common.copy")}
              </Button>
              {draft.state === "needs-copy" && (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={running}
                  onClick={() => void dismissDraftAction(relay, draft.id)}
                >
                  {t("common.dismiss")}
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
      label={t("switchingTabs.refreshLimitsAutomatically")}
      htmlFor="usage-interval"
    >
      <OptionSelect
        id="usage-interval"
        value={String(relay.settings.usageRefreshMinutes)}
        disabled={disabled}
        options={[
          { value: "0", label: t("switchingTabs.manually") },
          ...[5, 15, 30].map((n) => ({
            value: String(n),
            label: t("switchingTabs.everyMin", { n }),
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
