import { TriangleAlert } from "lucide-react";
import { Private } from "@/components/Private";
import { PlusIcon } from "@/components/icons";
import { freshUsage } from "../../../shared/usage";
import { Badge } from "@/components/ui/badge";
import { formatUsed } from "@/lib/meter";
import { offerAfter, usePrank } from "@/pranks/PrankStage";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { LimitBars } from "@/components/LimitBars";
import { Panda } from "@/components/Panda";
import { StatusDot } from "@/components/StatusDot";
import { ProviderBadge } from "@/components/ProviderBadge";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { pendingFlow } from "@/data/selectors";
import { intentHash, type Destination } from "@/app/routes";
import { ringState } from "@/lib/account-row";
import { blockReason, desktopBlock } from "@/lib/onboarding";
import { UsageCard } from "../../features/UsageCard";
import { gatewayLine } from "@/lib/proxy-ui";
import { accountPlan, planTitle } from "../accounts/accountLabels";

export function ActiveAccountCard({
  go,
  now,
}: {
  go: (to: Destination) => void;
  now: number;
}) {
  const relay = useRelay();
  const prank = usePrank();
  const { t, language } = useI18n();
  const { active, desktop, desktopBusy } = relay;
  if (!active) return <Onboarding go={go} />;
  const usage = relay.data?.usage[active.id];
  const running = !!desktop?.running;
  // Named as in the Accounts table and the account's page.
  const plan = accountPlan(active);
  const email = active.desktop?.email ?? active.auth?.email;
  const identity = [email, active.auth?.orgName].filter(Boolean).join(" · ");
  const authFlow = relay.data?.authFlows?.find(
    (f) => f.accountId === active.id,
  );
  const suggestion = relay.suggestion;
  const suggestedUsage = suggestion && relay.data?.usage[suggestion.id];
  const switchBlocked = desktopBusy || !!relay.pendingDesktop || !!desktop?.recoveryRequired;
  // Why the switch is disabled, in the words of the add-account wizard's lock.
  const switchReason = switchBlocked ? blockReason(desktopBlock(relay), t) : undefined;
  // Terminal tools bound to the gateway do not follow this account: say where they go.
  const gateway = gatewayLine(desktop?.proxyStatus, t, now);
  const header = (
    <div className="flex min-w-0 items-center gap-3">
      <span
        aria-hidden="true"
        className="grid size-8 shrink-0 place-items-center rounded-full bg-secondary text-sm font-semibold"
      >
        {active.name.slice(0, 1).toLocaleUpperCase(language)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="truncate text-sm font-semibold">{active.name}</span>
          <ProviderBadge provider={active.provider} />
          {plan && (
            <Badge variant="secondary" title={planTitle(active, plan, t)}>
              {plan.label}
            </Badge>
          )}
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <StatusDot tone={running ? "ok" : "off"} hollow={!running} />
            {running ? t("Çalışıyor", "Running") : t("Kapalı", "Closed")}
          </span>
        </div>
        {identity && (
          <div className="truncate text-xs text-muted-foreground">
            <Private>{identity}</Private>
          </div>
        )}
      </div>
    </div>
  );
  return (
    <section aria-labelledby="active-account-title" className="grid content-start gap-1.5">
      <h2 id="active-account-title" className="px-1 text-xs font-semibold text-muted-foreground">
        {t("Claude uygulamasında açık", "Open in the Claude app")}
      </h2>
      <div data-slot="active-account" className="overflow-hidden rounded-lg border bg-card">
        <div className="px-3 py-2.5">{header}</div>
        <div className="border-t px-3 py-3">
          {freshUsage(usage, now) ? (
            <LimitBars
              usage={usage}
              now={now}
              zone={relay.settings.planning.timeZone}
              state={ringState(usage, now)}
            />
          ) : (
            <UsageCard
              usage={usage}
              busy={relay.usageBusy.has(active.id)}
              connectBusy={!!relay.busy || pendingFlow(authFlow)}
              settings={relay.settings}
              t={t}
              language={language}
              now={now}
              refresh={(allowPrompt) =>
                void relay.refreshUsage(active, allowPrompt)
              }
              connect={() => void relay.startCli(active)}
            />
          )}
        </div>
        {suggestion && (
          <div
            data-slot="suggestion"
            className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-t px-3 py-2.5"
          >
            <TriangleAlert aria-hidden="true" className="size-4 shrink-0 text-warn" />
            <div className="min-w-0">
              <span className="text-sm font-medium">{t("Limit dolmak üzere", "Near the limit")}</span>
              <p className="text-xs text-muted-foreground [&_b]:font-medium [&_b]:text-foreground">
                {language === "tr" ? (
                  <>
                    En uygun hesap <b>{suggestion.name}</b>
                    {suggestedUsage?.fiveHour
                      ? `: ${formatUsed(suggestedUsage.fiveHour.usedPercent, language)}.`
                      : "."}
                  </>
                ) : (
                  <>
                    The best account is <b>{suggestion.name}</b>
                    {suggestedUsage?.fiveHour
                      ? `: ${formatUsed(suggestedUsage.fiveHour.usedPercent, language)}.`
                      : "."}
                  </>
                )}
              </p>
            </div>
            <Button
              size="sm"
              disabled={switchBlocked}
              onClick={(e) =>
                offerAfter(prank, "nibble-cursor", e, () =>
                  relay.requestDesktop(suggestion, "switch"),
                )
              }
            >
              {t(`${suggestion.name} hesabına geç`, `Switch to ${suggestion.name}`)}
            </Button>
            {switchReason && (
              <p data-slot="switch-reason" className="col-span-3 text-right text-xs text-muted-foreground">
                {switchReason}
              </p>
            )}
          </div>
        )}
        {gateway && (
          <div data-slot="gateway-line" className="flex items-center gap-2 border-t px-3 py-2 text-xs">
            <StatusDot tone={gateway.tone} />
            <span className="min-w-0 flex-1 text-muted-foreground">{gateway.text}</span>
            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => go("proxy")}>
              {t("Ağ geçidi", "Gateway")}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

function Onboarding({ go }: { go: (to: Destination) => void }) {
  const relay = useRelay();
  const { t } = useI18n();
  const { accounts, hasUnclaimedDesktop } = relay;
  const first = !accounts.length;
  // The account open in Claude belongs to no profile yet.
  const unlinked = hasUnclaimedDesktop && !first;
  // The button links it only to a profile without a Claude app sign-in; otherwise it is added
  // (and linked in the dialog). The label and the click both follow this.
  const linking = hasUnclaimedDesktop && accounts.some((a) => !a.desktop);
  const block = desktopBlock(relay);
  const reason = blockReason(block, t);
  return (
    <Card className="gap-0 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Panda scene={first ? "welcome" : "lookout"} size={first ? 88 : 56} playful />
          <div className="min-w-0">
            <div className="text-lg font-semibold">
              {first
                ? t("İlk hesabını ekle", "Add your first account")
                : unlinked
                  ? t("Claude uygulaması hesabı eşleştirilmedi", "Claude app account not linked")
                  : t("İlk hesabını bağla", "Connect your first account")}
            </div>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {unlinked
                ? t(
                    "Claude uygulamasında açık hesabı bir Relay profiliyle eşleştir.",
                    "Link the account open in the Claude app to a Relay profile.",
                  )
                : t(
                    "Her hesabı bir kez bağla. Sonra buradan geç.",
                    "Connect each account one time. Then switch here.",
                  )}
            </p>
          </div>
        </div>
        <div className="grid max-w-64 justify-items-end gap-1">
          <Button
            disabled={!!block}
            onClick={() => {
              // The Accounts page opens the matching dialog for the query.
              window.location.hash = linking
                ? "#/hesaplar?eslestir"
                : intentHash("hesaplar", "ekle");
            }}
          >
            <PlusIcon />
            {linking
              ? t("Hesabı eşleştir", "Link account")
              : t("Hesap ekle", "Add account")}
          </Button>
          {reason && (
            <p className="text-right text-xs text-muted-foreground">{reason}</p>
          )}
        </div>
      </div>
    </Card>
  );
}
