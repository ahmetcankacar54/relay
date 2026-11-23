import { LimitLine, countdown } from "@/components/LimitLine";
import { MeterLogo } from "@/components/MeterLogo";
import { PageSection } from "@/components/PageSection";
import { useI18n, type T } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { formatPercent } from "@/lib/meter";
import { formatRelative } from "@/lib/time";
import { FORMAT_LOCALE, type Locale } from "../../../shared/i18n/locales";
import { METER_NAMES, type MeterIssue, type MeterReading, type MeterWindow, type MeterWindowName } from "../../../shared/meters";

const WINDOW_NAMES = {
  premium: "meters.windowPremium",
  chat: "meters.windowChat",
  completions: "meters.windowCompletions",
  included: "meters.windowIncluded",
  auto: "meters.windowAuto",
  api: "meters.windowApi",
  "on-demand": "meters.windowOnDemand",
  requests: "meters.windowRequests",
  pro: "meters.windowPro",
  flash: "meters.windowFlash",
  "flash-lite": "meters.windowFlashLite",
} as const satisfies Record<MeterWindowName, string>;

const ISSUES = {
  "not-signed-in": "meters.issueNotSignedIn",
  expired: "meters.issueExpired",
  encrypted: "meters.issueEncrypted",
  "not-available": "meters.issueNotAvailable",
  "unsupported-auth": "meters.issueUnsupportedAuth",
  "rate-limited": "meters.issueRateLimited",
  unavailable: "meters.issueUnavailable",
  unsupported: "meters.issueUnsupported",
} as const satisfies Record<MeterIssue, string>;

/** Why a meter has no current reading, in one short line. Gemini CLI's refusal says whom it leaves out. */
export function meterIssueText(reading: MeterReading, t: T): string | undefined {
  const issue = reading.error?.issue;
  if (!issue) return;
  if (issue === "not-available" && reading.provider === "gemini-cli") return t("meters.issueNotAvailableGemini");
  return t(ISSUES[issue], { tool: METER_NAMES[reading.provider] });
}

/** "186 of 300", or "$18.20 of $20.00" for a budget. */
function amount(window: MeterWindow, t: T, language: Locale): string | undefined {
  if (window.used === undefined || window.limit === undefined) return;
  const format = new Intl.NumberFormat(
    FORMAT_LOCALE[language],
    window.unit === "$" ? { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol" } : { maximumFractionDigits: 0 },
  );
  return t("meters.usedOf", { used: format.format(window.used), limit: format.format(window.limit) });
}

/**
 * Where the meter's figures came from and when, worded as a limit line's tooltip is
 * (`limitLine.source*`): "Source: Unofficial endpoint · 4 min ago".
 */
export function meterOriginText(reading: MeterReading, now: number, t: T, language: Locale): string {
  const source = t(reading.source === "official" ? "limitLine.sourceOfficial" : "meters.sourceUnofficial");
  return reading.readAt
    ? t("limitLine.sourceAge", { source, age: formatRelative(reading.readAt, now, language) })
    : t("limitLine.source", { source });
}

function MeterRow({ reading, now }: { reading: MeterReading; now: number }) {
  const { t, language } = useI18n();
  const origin = meterOriginText(reading, now, t, language);
  const issue = meterIssueText(reading, t);
  const windows = reading.windows.filter((w) => w.usedPercent !== undefined);
  return (
    <div data-slot="meter-row" data-meter={reading.provider} className="grid gap-2 px-4 py-3">
      <div className="flex min-w-0 items-center gap-1.5 text-sm" title={origin}>
        <MeterLogo provider={reading.provider} />
        <span className="font-medium">{METER_NAMES[reading.provider]}</span>
        {reading.label && <span className="truncate text-muted-foreground">· {reading.label}</span>}
      </div>
      {issue && (
        <p data-slot="meter-issue" data-issue={reading.error?.issue} className="text-xs text-warn-foreground">
          {issue}
        </p>
      )}
      {windows.length > 0 ? (
        <div className="grid gap-x-6 gap-y-2 @lg:grid-cols-2 @3xl:grid-cols-3">
          {windows.map((w) => {
            const label = t(WINDOW_NAMES[w.name]);
            const used = amount(w, t, language);
            const reset = countdown(w.resetsAt, now, t);
            const figure = [label, used, reset ? `${formatPercent(w.usedPercent, language)} · ${reset}` : formatPercent(w.usedPercent, language)]
              .filter(Boolean)
              .join(" ");
            return (
              <LimitLine
                key={w.name}
                label={label}
                usedPercent={w.usedPercent!}
                resetsAt={w.resetsAt}
                now={now}
                t={t}
                // Read before the last attempt failed: still shown, but quieter.
                faded={!!issue}
                title={`${figure}\n${origin}`}
              />
            );
          })}
        </div>
      ) : (
        !issue && <p className="text-xs text-muted-foreground">{t(reading.readAt ? "meters.noLimits" : "meters.notReadYet")}</p>
      )}
    </div>
  );
}

/**
 * The other tools' usage on the Overview: one row per meter turned on in Settings → Other tools,
 * its plan, a bar per limit with its own reset, and why the last read failed when it did. Hidden
 * while no meter is on.
 */
export function MetersCard({ now }: { now: number }) {
  const { data } = useRelay();
  const { t } = useI18n();
  const readings = data?.meters ?? [];
  if (!readings.length) return null;
  return (
    <PageSection title={t("meters.otherTools")} slot="meters">
      <div className="@container divide-y overflow-hidden rounded-lg border bg-card">
        {readings.map((reading) => (
          <MeterRow key={reading.provider} reading={reading} now={now} />
        ))}
      </div>
    </PageSection>
  );
}
