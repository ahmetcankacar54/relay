import { Private } from "@/components/Private";
import { ListSkeleton } from "@/components/ListCard";
import { PlusIcon } from "@/components/icons";
import { freshUsage } from "../../../shared/usage";
import { formatUsed } from "@/lib/meter";
import { offerAfter, usePrank } from "@/pranks/PrankStage";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { AccountDot } from "@/components/AccountDot";
import { StatusLabel } from "@/components/StatusLabel";
import { AccountLimits } from "@/features/Providers";
import { accountHealth } from "@/lib/account-health";
import { accountStatus } from "@/lib/account-status";
import { Panda } from "@/components/Panda";
import { StatusDot } from "@/components/StatusDot";
import { ProviderBadge } from "@/components/ProviderBadge";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { pendingFlow } from "@/data/selectors";
import { intentHash, type Destination } from "@/app/routes";
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
  // Until the first snapshot the card holds placeholders, not the onboarding for an empty app.
  if (relay.data === undefined)
    return (
      <div data-slot="active-account-skeleton" className="overflow-hidden rounded-lg border bg-card">
        <ListSkeleton rows={2} />
      </div>
    );
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
  const health = accountHealth(
    active,
    usage,
    { active: true, desktopRunning: running, waiting: pendingFlow(authFlow), platform: relay.data?.diagnostics?.platform, language },
    t,
  );
  // Closed, the Claude app uses no account: that is the state, before any limit.
  const status = running
    ? accountStatus({ account: active, usage, health, inUse: true, now, t })
    : { tone: "off" as const, text: t("common.claudeClosed") };
  const header = (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
      <AccountDot color={active.color} size="md" />
      <span className="truncate text-base font-semibold">{active.name}</span>
      <ProviderBadge provider={active.provider} detail={plan?.label} title={plan ? planTitle(active, plan, t) : undefined} />
      {/* Which sign-in it is, quietly: two accounts may share a name. */}
      {/* It gives way (basis 0) instead of pushing the status onto a line of its own. */}
      {identity && (
        <span className="min-w-0 flex-1 basis-0 truncate text-xs text-muted-foreground">
          <Private>{identity}</Private>
        </span>
      )}
      <span className="ml-auto shrink-0">
        <StatusLabel status={status} />
      </span>
    </div>
  );
  return (
    <section aria-label={t("activeAccountCard.openInTheClaudeApp")} className="grid content-start">
      <div data-slot="active-account" className="overflow-hidden rounded-lg border bg-card">
        <div className="grid gap-3 px-4 pt-3.5 pb-3.5">
          {header}
          {freshUsage(usage, now) ? (
            <AccountLimits usage={usage} now={now} max={8} layout="grid" />
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
              appSignIn={!!active.desktop}
            />
          )}
        </div>
        {suggestion && (
          <div data-slot="suggestion" className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-t px-4 py-2.5 text-sm">
            <span className="text-xs text-muted-foreground">{t("activeAccountCard.next")}</span>
            <AccountDot color={suggestion.color} />
            <span className="font-semibold">{suggestion.name}</span>
            {suggestedUsage?.fiveHour && (
              <span className="text-xs text-muted-foreground">
                {t("activeAccountCard.n5Hours", { formatUsed: formatUsed(suggestedUsage.fiveHour.usedPercent, language) })}
              </span>
            )}
            <Button
              size="sm"
              className="ml-auto"
              disabled={switchBlocked}
              title={switchReason}
              aria-label={t("activeAccountCard.switchTo", { suggestionName: suggestion.name })}
              onClick={(e) =>
                offerAfter(prank, "nibble-cursor", e, () =>
                  relay.requestDesktop(suggestion, "switch"),
                )
              }
            >
              {t("common.switch")}
            </Button>
            {switchReason && (
              <p data-slot="switch-reason" className="basis-full text-right text-xs text-muted-foreground">
                {switchReason}
              </p>
            )}
          </div>
        )}
        {gateway && (
          <div data-slot="gateway-line" className="flex items-center gap-2 border-t px-3 py-2 text-xs">
            <StatusDot tone={gateway.tone} />
            <span className="min-w-0 flex-1 text-muted-foreground">{gateway.text}</span>
            <Button size="xs" variant="ghost" onClick={() => go("proxy")}>
              {t("common.gateway")}
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
                ? t("activeAccountCard.addYourFirstAccount")
                : unlinked
                  ? t("activeAccountCard.claudeAppAccountNotLinked")
                  : t("activeAccountCard.connectYourFirstAccount")}
            </div>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {unlinked
                ? t("activeAccountCard.linkTheAccountOpenInThe")
                : t("activeAccountCard.connectEachAccountOneTimeThen")}
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
              ? t("activeAccountCard.linkAccount")
              : t("common.addAccount")}
          </Button>
          {reason && (
            <p className="text-right text-xs text-muted-foreground">{reason}</p>
          )}
        </div>
      </div>
    </Card>
  );
}
