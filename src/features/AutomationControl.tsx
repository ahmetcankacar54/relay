import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Banner } from "@/components/Banner";
import { Note, SectionHeading } from "@/components/SettingRow";
import { StatusDot } from "@/components/StatusDot";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import {
  AUTOMATION_MODES,
  type AutomationMode,
} from "../../shared/automation-mode";
import {
  switchNowLabel,
  type AutomationStatus,
} from "../../shared/automation-status";
import { AccountSelection } from "./SwitchPreferences";
import {
  AUTOMATION_DOT,
  automationModeCopy,
  useAutomation,
} from "./useAutomation";

/** "Şimdi <hesap>’e geç": opens the confirmed switch review for the target. */
function SwitchNowButton({
  status,
  size,
}: {
  status: AutomationStatus;
  size: "xs" | "sm";
}) {
  const relay = useRelay();
  const { t } = useI18n();
  const target = relay.accounts.find((a) => a.id === status.switchTo);
  if (!target) return null;
  return (
    <Button
      type="button"
      variant="outline"
      size={size}
      className="shrink-0"
      disabled={
        relay.desktopBusy ||
        !!relay.pendingDesktop ||
        !!relay.desktop?.recoveryRequired
      }
      onClick={() => relay.requestDesktop(target, "switch")}
    >
      {t(...switchNowLabel(target.name))}
    </Button>
  );
}

/**
 * The status sentence with its "<account> %n kaldı · " prefix outside the live
 * region, so a usage refresh alone is not announced again.
 */
function StatusText({ status }: { status: AutomationStatus }) {
  const { t } = useI18n();
  const prefix = t(...status.prefix);
  return (
    <>
      {prefix}
      <span role="status" aria-live="polite">
        {t(...status.text).slice(prefix.length)}
      </span>
    </>
  );
}

/** What automatic switching is doing, in one sentence, with switch-now when offered. */
export function AutomationStatusLine({
  status,
  compact,
}: {
  status: AutomationStatus;
  /** Overview: smaller text that wraps, no box. */
  compact?: boolean;
}) {
  return (
    <div
      className={
        compact
          ? "flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
          : "flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-[13px]"
      }
    >
      <p className="flex min-w-0 flex-1 basis-48 items-start gap-2">
        <StatusDot
          tone={AUTOMATION_DOT[status.tone]}
          className={compact ? "mt-1" : "mt-1.5"}
        />
        <span>
          <StatusText status={status} />
        </span>
      </p>
      {status.switchTo && (
        <SwitchNowButton status={status} size={compact ? "xs" : "sm"} />
      )}
    </div>
  );
}

/** The Switching page card: one choice, what it does, and its status. */
export function AutomationSettings() {
  const relay = useRelay();
  const { t } = useI18n();
  const { mode, status, locked, supported, setMode } = useAutomation();
  const { api, accounts, settings, action } = relay;
  const disabled = !!relay.busy || !!relay.desktop?.busy;
  const fleet = relay.data?.fleet;
  return (
    <section aria-labelledby="automation-title" className="grid gap-3">
      <SectionHeading
        id="automation-title"
        icon={<ShieldCheck size={18} aria-hidden="true" />}
        title={t("Otomatik geçiş", "Automatic switching")}
      />
      <div className="grid justify-items-start gap-1.5">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          aria-labelledby="automation-title"
          value={mode}
          disabled={locked}
          onValueChange={(v) => v && setMode(v as AutomationMode)}
        >
          {AUTOMATION_MODES.map((m) => (
            <ToggleGroupItem
              key={m.value}
              value={m.value}
              disabled={m.value !== "off" && !supported}
            >
              {t(...m.label)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <p className="text-[13px] text-muted-foreground">
          {t(...automationModeCopy(mode).description)}
        </p>
      </div>
      <AutomationStatusLine status={status} />
      {!supported && (
        <Note>
          {t(
            "Otomatik geçiş bu sürümde macOS’ta kullanılabilir.",
            "Automatic switching is available on macOS in this release.",
          )}
        </Note>
      )}
      {mode === "after-exit" && (
        <div className="grid gap-1">
          <AccountSelection
            accounts={accounts}
            selected={settings.autoSwitchAccounts}
            update={(ids) =>
              void action("settings", () =>
                api.updateSettings({ autoSwitchAccounts: ids }),
              )
            }
            disabled={disabled}
            label={t(
              "Otomatik geçişe dahil hesaplar",
              "Accounts eligible for automatic switching",
            )}
            t={t}
          />
          <Note>
            {t(
              "Açık ve hedef hesapları seç. Hedefte en az %10 limit kalmalı.",
              "Select the current and target accounts. The target needs at least 10% quota left.",
            )}
          </Note>
          {settings.usageRefreshMinutes === 0 && (
            <Note>
              {t(
                "Otomatik geçiş için düzenli limit yenilemeyi aç.",
                "Enable regular usage refresh for automatic switching.",
              )}
            </Note>
          )}
        </div>
      )}
      {mode === "quota" && (
        <div className="grid justify-items-start gap-2">
          {fleet?.reason === "accessibility-permission-required" && (
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={() =>
                void action("continuation-permission", () =>
                  api.requestDesktopAccessibility(),
                )
              }
            >
              {t(
                "macOS Erişilebilirlik iznini aç",
                "Open macOS Accessibility permission",
              )}
            </Button>
          )}
          <Note>
            {t(
              "Relay açık kalmalı. Çalışan iş bitmeden Claude uygulaması yeniden başlatılmaz; her konuşmaya en fazla bir devam mesajı gider.",
              "Relay must stay open. The Claude app is not restarted while work is running; each conversation gets at most one continue message.",
            )}
          </Note>
        </div>
      )}
    </section>
  );
}

/** The page-top line, only when automatic switching needs a look or offers a switch. */
export function AutomationBanner() {
  const { t } = useI18n();
  const { status } = useAutomation();
  if (!status.banner) return null;
  return (
    <Banner
      tone={status.tone === "attention" ? "warn" : "info"}
      action={
        status.switchTo ? (
          <SwitchNowButton status={status} size="sm" />
        ) : undefined
      }
    >
      <span>
        {`${t("Otomatik geçiş", "Automatic switching")} · `}
        <StatusText status={status} />
      </span>
    </Banner>
  );
}
