import { useState } from "react";
import type {
  Account,
  AccountPlanning,
  AccountUsage,
  AutoSwitchState,
  FleetContinuationState,
  KeeperSnapshot,
  PlanningSettings,
  RelaySettings,
} from "../shared/types";
import type { AccountUsageStatistics } from "../shared/usage-statistics";
import { SwitchPreferences } from "./SwitchPreferences";
import { UsageStatistics } from "./UsageStatistics";
import { PlanningPanel } from "./PlanningPanel";
import { ContinuationSettings } from "./ContinuationSettings";
import { FleetSettings } from "./FleetSettings";
import type { DesktopContinuationSnapshot } from "../electron/core/desktop-continuation";
export function Preferences({
  value,
  update,
  disabled,
  t,
  accounts,
  active,
  autoSwitch,
  platform,
  sync,
  syncDisabled,
  usage,
  statistics,
  keeper,
  updatePlanning,
  updateAccount,
  continuation,
  inspectContinuation,
  armContinuation,
  disarmContinuation,
  requestAccessibility,
  reconcileContinuation,
  abandonContinuation,
  fleet,
  setFleet,
  only,
}: {
  value: RelaySettings;
  accounts: Account[];
  active?: Account;
  autoSwitch?: AutoSwitchState;
  platform: string;
  sync: () => void;
  syncDisabled: boolean;
  usage: Record<string, AccountUsage>;
  statistics: Record<string, AccountUsageStatistics>;
  keeper?: KeeperSnapshot;
  updatePlanning: (patch: Partial<PlanningSettings>) => void;
  updateAccount: (id: string, input: AccountPlanning) => void;
  continuation?: DesktopContinuationSnapshot;
  inspectContinuation: () => void;
  armContinuation: () => void;
  disarmContinuation: () => void;
  requestAccessibility: () => void;
  reconcileContinuation: () => void;
  abandonContinuation: () => void;
  fleet?: FleetContinuationState;
  setFleet: (enabled: boolean) => void;
  update: (patch: Partial<RelaySettings>) => void;
  disabled: boolean;
  t: (tr: string, en: string) => string;
  /** Render just this section without the tab bar (used by the sidebar pages). */
  only?: "switch" | "usage" | "planning";
}) {
  const [selected, setTab] = useState<"switch" | "usage" | "planning">(
    "switch",
  );
  const tab = only ?? selected;
  return (
    <div className="preferences">
      {!only && (
        <nav
          className="preferences-tabs"
          aria-label={t("Tercih bölümleri", "Preference sections")}
        >
          {(["switch", "usage", "planning"] as const).map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={tab === key}
              onClick={() => setTab(key)}
            >
              <strong>
                {key === "switch"
                  ? t("Hesap geçişi", "Account switching")
                  : key === "usage"
                    ? t("Kullanım", "Usage")
                    : t("Planlama", "Planning")}
              </strong>
              <small>
                {key === "switch"
                  ? t("Desktop ve ortak geçmiş", "Desktop and shared history")
                  : key === "usage"
                    ? t("İstatistikler ve uyarılar", "Statistics and warnings")
                    : t("Otomatik başlatma", "Automatic start")}
              </small>
            </button>
          ))}
        </nav>
      )}
      {tab === "planning" && (
        <PlanningPanel
          settings={value.planning}
          keeper={keeper}
          accounts={accounts}
          usage={usage}
          disabled={disabled}
          t={t}
          update={updatePlanning}
          updateAccount={updateAccount}
        />
      )}
      {tab === "switch" && (
        <>
          <p className="preference-footnote">
            {t(
              "Menü çubuğundan bir hesap seçip tek onayla geçebilirsin. Pencere kapanınca Relay menü çubuğunda çalışmaya devam eder.",
              "Pick an account in the menu bar to switch after one confirmation. Relay keeps running there when its window closes.",
            )}
          </p>
          <SwitchPreferences
            value={value}
            accounts={accounts}
            active={active}
            autoSwitch={autoSwitch}
            platform={platform}
            update={update}
            disabled={disabled}
            sync={sync}
            syncDisabled={syncDisabled}
            t={t}
          />
          <FleetSettings
            value={fleet}
            accounts={accounts}
            busy={disabled}
            t={t}
            onToggle={setFleet}
            requestAccessibility={requestAccessibility}
          />
          {/* A single-conversation watch from earlier versions stays visible until it is off. */}
          {(continuation?.enabled ||
            continuation?.status === "reconciliation-required") && (
            <ContinuationSettings
              accounts={accounts}
              active={active}
              value={continuation}
              busy={disabled}
              canArm={continuation?.canArm}
              blockingReason={continuation?.observationReason}
              onRefresh={inspectContinuation}
              onArm={armContinuation}
              onDisable={disarmContinuation}
              t={t}
              usage={usage}
              settings={value}
            />
          )}
          {continuation?.enabled &&
            (continuation?.observationReason ===
              "accessibility-permission-required" ||
              continuation?.reason === "accessibility-permission-required") && (
              <button
                className="secondary"
                disabled={disabled}
                onClick={requestAccessibility}
              >
                {t(
                  "macOS Erişilebilirlik iznini aç",
                  "Open macOS Accessibility permission",
                )}
              </button>
            )}
          {continuation?.status === "reconciliation-required" && (
            <>
              <div className="continuation-actions">
                <button
                  className="secondary"
                  disabled={disabled}
                  onClick={reconcileContinuation}
                >
                  {t(
                    "Yarım kalan geçişi sürdür ve doğrula",
                    "Resume and reconcile interrupted handoff",
                  )}
                </button>
                <button
                  className="secondary"
                  disabled={disabled}
                  onClick={abandonContinuation}
                >
                  {t(
                    "Gönderilmemiş işlemi iptal et",
                    "Cancel an unsent handoff",
                  )}
                </button>
              </div>
              <p className="preference-footnote">
                {t(
                  "Claude’un kota zamanlayıcısı devralındıysa, işlemi iptal etmek bu zamanlayıcıyı yeniden açmaz. Claude’daki ‘limit yenilenince devam et’ seçeneğini kontrol et.",
                  "If Claude’s quota timer was taken over, cancelling this handoff does not re-enable it. Check Claude’s ‘continue when limits reset’ option.",
                )}
              </p>
            </>
          )}
        </>
      )}
      {tab === "usage" && (
        <>
          <UsageStatistics accounts={accounts} value={statistics} t={t} />
          <div className="preference-section-heading">
            <h4>{t("Kullanım ve bildirimler", "Usage and notifications")}</h4>
          </div>
          <div className="preference-row">
            <div>
              <label htmlFor="usage-interval">
                {t("Kullanım limitlerini yenile", "Refresh usage limits")}
              </label>
              <p>
                {t(
                  "Yalnızca kullanım verisi okunur; Claude çalışmaya devam eder.",
                  "Reads usage data while Claude keeps running.",
                )}
              </p>
            </div>
            <select
              id="usage-interval"
              value={value.usageRefreshMinutes}
              disabled={disabled}
              onChange={(e) =>
                update({
                  usageRefreshMinutes: Number(
                    e.target.value,
                  ) as RelaySettings["usageRefreshMinutes"],
                })
              }
            >
              <option value={0}>{t("Elle", "Manually")}</option>
              {[5, 15, 30].map((n) => (
                <option key={n} value={n}>
                  {n} {t("dakika", "minutes")}
                </option>
              ))}
            </select>
          </div>
          <div className="preference-row">
            <div>
              <label htmlFor="usage-warnings">
                {t("Limit uyarıları", "Usage warnings")}
              </label>
              <p>
                {t(
                  "Eşiğe ulaşan hesapları bu panelde işaretle.",
                  "Highlight accounts approaching their limit in this panel.",
                )}
              </p>
            </div>
            <input
              id="usage-warnings"
              type="checkbox"
              checked={value.usageWarnings}
              disabled={disabled}
              onChange={(e) => update({ usageWarnings: e.target.checked })}
            />
          </div>
          <div className="preference-row">
            <div>
              <label htmlFor="usage-threshold">
                {t("Uyarı eşiği", "Warning threshold")}
              </label>
              <p>
                {t(
                  "Beş saatlik veya haftalık kullanım için geçerli.",
                  "Applies to either the 5-hour or weekly usage window.",
                )}
              </p>
            </div>
            <select
              id="usage-threshold"
              disabled={disabled || !value.usageWarnings}
              value={value.usageWarningPercent}
              onChange={(e) =>
                update({
                  usageWarningPercent: Number(
                    e.target.value,
                  ) as RelaySettings["usageWarningPercent"],
                })
              }
            >
              {[80, 90, 95].map((n) => (
                <option key={n} value={n}>
                  {100 - n}% {t("kalınca", "remaining")}
                </option>
              ))}
            </select>
          </div>
          <details className="planning-help usage-source-details">
            <summary>
              {t("Veri kaynağı ve sınırlar", "Data source and limits")}
            </summary>
            <p className="usage-source-note">
              {t(
                "Kullanım sorgusu deneysel Anthropic OAuth servisini kullanır. Relay’de bağlı CLI profili okunur; gerektiğinde bağlantıyı sen yenilersin. Bu işlem yalnız Relay profilini günceller, açık Claude’a dokunmaz. Kalan yüzde mesaj sayısı veya süre garantisi değildir.",
                "Usage comes from an experimental Anthropic OAuth endpoint. Relay reads its connected CLI profile; you can renew the connection when needed. Renewal updates only the Relay profile and leaves the open Claude app untouched. Remaining percentage is not a message count or time guarantee.",
              )}
            </p>
          </details>
        </>
      )}
    </div>
  );
}
