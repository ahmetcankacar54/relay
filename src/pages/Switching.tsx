import { PageFrame } from "@/app/PageFrame";
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
import { ContinuationSettings } from "../features/ContinuationSettings";
import { AutomationSettings } from "../features/AutomationControl";

const cardClass = "gap-0 px-5 py-4";

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
        "Otomatik geçiş, ortak geçmiş ve hesap önerileri",
        "Automatic switching, shared history and account suggestions",
      )}
    >
      <div className="grid gap-3 px-6 pb-6">
        <Card className={cardClass}>
          <AutomationSettings />
        </Card>
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
                    "Claude’un kota zamanlayıcısı devralındıysa, işlemi iptal etmek bu zamanlayıcıyı yeniden açmaz. Claude’daki ‘limit yenilenince devam et’ seçeneğini kontrol et.",
                    "If Claude’s quota timer was taken over, cancelling this handoff does not re-enable it. Check Claude’s ‘continue when limits reset’ option.",
                  )}
                </Note>
              </div>
            )}
          </Card>
        )}
        <Card className={cardClass}>
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
        <Card className={cardClass}>
          <DraftRetypePreference
            value={settings}
            update={update}
            disabled={disabled}
            t={t}
          />
        </Card>
        <Card className={cardClass}>
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
              "Geçmiş kapsamındaki, iki limiti de uygun olan Desktop hesabını önerir. Geçişi sen başlatırsın.",
              "Suggests a Desktop account in the history scope with room in both limits. You start the switch.",
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
