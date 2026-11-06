import { Plus, TriangleAlert } from "lucide-react";
import { freshUsage } from "../../../shared/usage";
import { Badge } from "@/components/ui/badge";
import { formatUsed } from "@/lib/meter";
import { offerAfter, usePrank } from "@/pranks/PrankStage";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { LimitRings } from "@/components/LimitRings";
import { Panda } from "@/components/Panda";
import { StatusDot } from "@/components/StatusDot";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { pendingFlow } from "@/data/selectors";
import { intentHash, type Destination } from "@/app/routes";
import { ringState } from "@/lib/account-row";
import { blockReason, desktopBlock } from "@/lib/onboarding";
import { UsageCard } from "../../features/UsageCard";
import { planColumn } from "../accounts/accountLabels";

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
  // As in the Accounts table: the plan picked for planning, else the subscription the sign-in reported.
  const plan = planColumn(active);
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
  const header = (
    <div className="grid gap-1">
      <div className="text-xs font-medium text-muted-foreground">
        {t("Claude uygulamasında açık", "Open in the Claude app")}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xl font-semibold">{active.name}</span>
        {plan && (
          <Badge
            variant="secondary"
            title={
              plan.source === "planning"
                ? undefined
                : t(
                    "Abonelik · planlama için plan seçilmedi",
                    "Subscription · no plan picked for planning",
                  )
            }
          >
            {plan.label}
          </Badge>
        )}
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <StatusDot tone={running ? "ok" : "off"} hollow={!running} />
          {running ? t("Çalışıyor", "Running") : t("Kapalı", "Closed")}
        </span>
      </div>
      {identity && <div className="truncate text-xs text-muted-foreground">{identity}</div>}
    </div>
  );
  return (
    <Card className="flex-row flex-wrap items-center gap-5 px-4 py-4">
      {freshUsage(usage, now) ? (
        <LimitRings
          className="min-w-0 flex-1"
          usage={usage}
          now={now}
          zone={relay.settings.planning.timeZone}
          size={104}
          state={ringState(usage, now)}
          aside={header}
        />
      ) : (
        <div className="grid min-w-0 flex-1 gap-3">
          {header}
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
        </div>
      )}
      {suggestion && (
        <div
          data-slot="suggestion"
          className="flex w-52 shrink-0 flex-col gap-2 border-l pl-5"
        >
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-warn-foreground">
            <TriangleAlert aria-hidden="true" className="size-3.5" />
            {t("Limit dolmak üzere", "Near the limit")}
          </span>
          <p className="text-sm leading-snug">
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
          <Button
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
            <p className="text-xs text-muted-foreground">{switchReason}</p>
          )}
        </div>
      )}
    </Card>
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
            <Plus />
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
