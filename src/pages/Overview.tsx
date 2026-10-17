import { LoaderCircle, RefreshCw } from "lucide-react";
import { maxUsedPercent } from "../../shared/usage";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { formatRelative } from "@/lib/time";
import { formatPercent } from "@/lib/meter";
import { PageFrame } from "@/app/PageFrame";
import { offerAfter, usePrank } from "@/pranks/PrankStage";
import { Banner } from "@/components/Banner";
import type { PageId } from "@/app/routes";
import { useAutomation } from "../features/useAutomation";
import { ActiveAccountCard } from "./overview/ActiveAccountCard";
import { AccountsCard } from "./overview/AccountsCard";
import { TodayCard } from "./overview/TodayCard";
import { AutomationCard } from "./overview/AutomationCard";

export function Overview({
  go,
  now = Date.now(),
}: {
  go: (page: PageId) => void;
  /** Injected by tests; the page re-renders with the snapshot poll. */
  now?: number;
}) {
  const relay = useRelay();
  const prank = usePrank();
  const { t, language } = useI18n();
  const { active, suggestion, accounts, usageBusy } = relay;
  const usage = relay.data?.usage ?? {};
  const date = new Intl.DateTimeFormat(language === "tr" ? "tr-TR" : "en-GB", {
    timeZone: relay.settings.planning.timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(now));
  const latest = Object.values(usage)
    .map((u) => u.checkedAt)
    .filter((c): c is string => !!c && Number.isFinite(Date.parse(c)))
    .sort()
    .at(-1);
  const description = latest
    ? `${date} · ${t("güncellendi", "updated")} ${formatRelative(latest, now, language)}`
    : date;
  const refreshing = usageBusy.size > 0;
  const suggestedUse = suggestion && maxUsedPercent(usage[suggestion.id]);
  // One offer at a time: automatic switching's switch-now wins over the suggestion.
  const automationOffer = !!useAutomation(now).status.switchTo;
  return (
    <PageFrame
      automationInline
      title={t("Genel bakış", "Overview")}
      description={description}
      actions={
        <Button
          variant="outline"
          disabled={refreshing || !accounts.length}
          onClick={(e) =>
            offerAfter(prank, "wheel", e, () => {
              for (const a of accounts) void relay.refreshUsage(a);
            })
          }
        >
          {refreshing ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <RefreshCw />
          )}
          {t("Limitleri yenile", "Refresh limits")}
        </Button>
      }
    >
      <div className="grid gap-3 px-6 pb-6">
        <ActiveAccountCard go={go} now={now} />
        {suggestion && active && !automationOffer && (
          <Banner
            tone="warn"
            action={
              <Button
                size="sm"
                variant="outline"
                onClick={(e) =>
                  offerAfter(prank, "nibble-cursor", e, () =>
                    relay.requestDesktop(suggestion, "switch"),
                  )
                }
              >
                {t("Geçişi incele", "Review switch")}
              </Button>
            }
          >
            <span>
              {t(
                `${active.name} limiti uyarı eşiğini geçti. Önerilen: `,
                `${active.name} passed the warning threshold. Suggested: `,
              )}
              <b>{suggestion.name}</b>
              {suggestedUse !== undefined
                ? ` (${formatPercent(suggestedUse, language)})`
                : ""}
              .
            </span>
          </Banner>
        )}
        <div className="grid gap-3 lg:grid-cols-[1.35fr_1fr]">
          <AccountsCard go={go} now={now} />
          <div className="grid content-start gap-3">
            <TodayCard go={go} now={now} />
            <AutomationCard go={go} now={now} />
          </div>
        </div>
      </div>
    </PageFrame>
  );
}
