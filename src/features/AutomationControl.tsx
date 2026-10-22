import { Hand, Power, Zap, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Banner } from "@/components/Banner";
import { Note } from "@/components/SettingRow";
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
 * The status sentence with its "<account> %n kullanıldı · " prefix outside the live
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

/** Each choice's card: an icon and a title that says who acts. */
const MODE_ICON: Record<AutomationMode, LucideIcon> = { off: Hand, "after-exit": Power, quota: Zap };
export const MODE_TITLE: Record<AutomationMode, [tr: string, en: string]> = {
  off: ["Ben geçerim", "I switch"],
  "after-exit": ["Claude'u kapatınca", "When I quit Claude"],
  quota: ["Kota dolunca", "At quota"],
};

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
      <h2 id="automation-title" className="flex items-center gap-2 text-sm font-semibold">
        <span aria-hidden="true" className="grid size-5 place-items-center rounded-full bg-foreground text-[11px] text-background">
          1
        </span>
        {t("Ne zaman geçilsin?", "When to switch?")}
      </h2>
      <div
        role="radiogroup"
        aria-labelledby="automation-title"
        className="grid gap-3 sm:grid-cols-3"
      >
        {AUTOMATION_MODES.map((m) => {
          const Icon = MODE_ICON[m.value];
          const checked = mode === m.value;
          const off = locked || (m.value !== "off" && !supported);
          return (
            <button
              key={m.value}
              type="button"
              role="radio"
              aria-checked={checked}
              disabled={off}
              onClick={() => !checked && setMode(m.value)}
              className={cn(
                "flex flex-col gap-2.5 rounded-xl border bg-card p-4 text-left outline-none transition-colors",
                "hover:border-foreground/20 focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50",
                checked && "border-2 border-primary bg-accent/40 p-[15px]",
              )}
            >
              <span className="flex items-center justify-between">
                <span
                  aria-hidden="true"
                  className={cn(
                    "grid size-8 place-items-center rounded-lg [&_svg]:size-4",
                    checked ? "bg-accent text-accent-foreground" : "bg-muted text-foreground/80",
                  )}
                >
                  <Icon />
                </span>
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-[18px] rounded-full border-[1.5px] border-input bg-card",
                    checked && "border-[5px] border-primary",
                  )}
                />
              </span>
              <span className="text-sm font-semibold">{t(...MODE_TITLE[m.value])}</span>
              <span className="text-[12.5px] leading-snug text-muted-foreground">
                {t(...m.description)}
              </span>
            </button>
          );
        })}
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
              "Açık ve hedef hesapları seç. Hedefte limitin en fazla %90’ı kullanılmış olmalı.",
              "Select the current and target accounts. The target must have used no more than 90% of its quota.",
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
