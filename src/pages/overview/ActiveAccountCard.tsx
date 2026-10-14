import { ArrowUpRight, Plus } from "lucide-react";
import type { Account } from "../../../shared/types";
import { freshUsage } from "../../../shared/usage";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { LimitMeter } from "@/components/LimitMeter";
import { StatusDot } from "@/components/StatusDot";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { pendingFlow, usageWindowRows } from "@/data/selectors";
import { formatReset } from "@/lib/time";
import type { PageId } from "@/app/routes";
import { UsageCard } from "../../UsageCard";

const PLAN_LABELS: Partial<Record<string, string>> = {
  pro: "Pro",
  max5: "Max 5×",
  max20: "Max 20×",
  team: "Team",
};
export const planLabel = (account: Account) =>
  PLAN_LABELS[account.planning?.plan ?? ""];

const eyebrow =
  "text-[11px] font-semibold tracking-wider text-muted-foreground uppercase";

export function ActiveAccountCard({
  go,
  now,
}: {
  go: (page: PageId) => void;
  now: number;
}) {
  const relay = useRelay();
  const { t, language } = useI18n();
  const { active, desktop, desktopBusy } = relay;
  if (!active) return <Onboarding go={go} />;
  const usage = relay.data?.usage[active.id];
  const running = !!desktop?.running;
  const plan = planLabel(active);
  const email = active.desktop?.email ?? active.auth?.email;
  const identity = [email, active.auth?.orgName].filter(Boolean).join(" · ");
  const authFlow = relay.data?.authFlows?.find(
    (f) => f.accountId === active.id,
  );
  return (
    <Card className="gap-0 px-4 py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className={eyebrow}>
            {t("CLAUDE DESKTOP'TA AÇIK", "OPEN IN CLAUDE DESKTOP")}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2">
            <span className="text-lg font-bold">{active.name}</span>
            {plan && <Badge variant="secondary">{plan}</Badge>}
            <Badge variant="outline">
              <StatusDot tone={running ? "ok" : "off"} />
              {running ? t("Çalışıyor", "Running") : t("Kapalı", "Closed")}
            </Badge>
          </div>
          {identity && (
            <div className="mt-0.5 truncate text-sm text-muted-foreground">
              {identity}
            </div>
          )}
        </div>
        <Button
          variant="outline"
          disabled={desktopBusy}
          onClick={() =>
            void relay.action("open", () => relay.api.openDesktop())
          }
        >
          <ArrowUpRight />
          {running
            ? t("Claude'u öne getir", "Bring Claude to front")
            : t("Claude'u aç", "Open Claude")}
        </Button>
      </div>
      {freshUsage(usage, now) ? (
        <div className="mt-3 grid gap-4 sm:grid-cols-3">
          {usageWindowRows(usage).map((row) => (
            <LimitMeter
              key={row.key}
              label={t(row.label.tr, row.label.en)}
              percent={row.usedPercent}
              detail={
                row.resetsAt
                  ? formatReset(row.resetsAt, now, language)
                  : undefined
              }
            />
          ))}
        </div>
      ) : (
        <div className="mt-3">
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
    </Card>
  );
}

function Onboarding({ go }: { go: (page: PageId) => void }) {
  const relay = useRelay();
  const { t } = useI18n();
  const { desktop, accounts, hasUnclaimedDesktop } = relay;
  return (
    <Card className="gap-0 px-4 py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className={eyebrow}>CLAUDE DESKTOP</div>
          <div className="mt-0.5 text-lg font-bold">
            {hasUnclaimedDesktop
              ? t("Desktop hesabı eşleştirilmedi", "Desktop account not linked")
              : t("İlk hesabını bağla", "Connect your first account")}
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {hasUnclaimedDesktop
              ? t(
                  "Claude’da açık hesabı bir Relay profiliyle eşleştir. CLI bağlantısı bu adımı tamamlamaz.",
                  "Link the account open in Claude to a Relay profile. A CLI connection does not complete this step.",
                )
              : t(
                  "Her Desktop hesabını bir kez bağla. Sonrasında buradan değiştir.",
                  "Connect each Desktop account once. Switch between them here.",
                )}
          </p>
        </div>
        <Button
          disabled={
            relay.desktopBusy ||
            !desktop?.available ||
            !!relay.pendingDesktop ||
            desktop?.recoveryRequired
          }
          onClick={() => {
            if (hasUnclaimedDesktop && accounts.some((a) => !a.desktop))
              relay.setSetupId("");
            go("hesaplar");
          }}
        >
          <Plus />
          {hasUnclaimedDesktop
            ? t("Hesabı eşleştir", "Link account")
            : t("Hesap ekle", "Add account")}
        </Button>
      </div>
    </Card>
  );
}
