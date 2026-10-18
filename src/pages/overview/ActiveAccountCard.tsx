import { ArrowUpRight, Plus } from "lucide-react";
import { freshUsage } from "../../../shared/usage";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { LimitMeter } from "@/components/LimitMeter";
import { Panda } from "@/components/Panda";
import { StatusDot } from "@/components/StatusDot";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { pendingFlow, usageWindowRows } from "@/data/selectors";
import { formatReset } from "@/lib/time";
import { intentHash, type PageId } from "@/app/routes";
import { blockReason, desktopBlock } from "@/lib/onboarding";
import { UsageCard } from "../../features/UsageCard";
import { planLabel } from "../accounts/accountLabels";


const eyebrow =
  "text-xs font-semibold tracking-wider text-muted-foreground uppercase";

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
            {t("CLAUDE UYGULAMASINDA AÇIK", "OPEN IN THE CLAUDE APP")}
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
            ? t("Claude uygulamasını öne getir", "Bring the Claude app to front")
            : t("Claude uygulamasını aç", "Open the Claude app")}
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
                  ? formatReset(
                      row.resetsAt,
                      now,
                      language,
                      relay.settings.planning.timeZone,
                    )
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
    <Card className="gap-0 px-4 py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Panda scene={first ? "welcome" : "lookout"} size={first ? 120 : 72} playful />
          <div className="min-w-0">
            <div className={eyebrow}>{t("CLAUDE UYGULAMASI", "THE CLAUDE APP")}</div>
            <div className="mt-0.5 text-lg font-bold">
              {first
                ? t("Merhaba, ben Relay’in kuryesiyim", "Hi, I’m Relay’s courier")
                : unlinked
                  ? t("Claude uygulaması hesabı eşleştirilmedi", "Claude app account not linked")
                  : t("İlk hesabını bağla", "Connect your first account")}
            </div>
            {first && (
              <p className="mt-0.5 text-sm font-medium">
                {t(
                  "Claude hesapların arasında tek tıkla geç; Code konuşmaların seninle gelsin.",
                  "Switch between your Claude accounts in one click; your Code conversations come with you.",
                )}
              </p>
            )}
            <p className="mt-0.5 text-sm text-muted-foreground">
              {unlinked
                ? t(
                    "Claude uygulamasında açık hesabı bir Relay profiliyle eşleştir. Limit okuma girişi bu adımı tamamlamaz.",
                    "Link the account open in the Claude app to a Relay profile. The usage sign-in does not complete this step.",
                  )
                : first
                  ? t(
                      "İlk hesabını bağlayalım. Claude uygulamasındaki her hesabı bir kez bağla; sonrasında buradan değiştir.",
                      "Let’s connect your first account. Connect each Claude app account once; switch between them here.",
                    )
                  : t(
                      "Claude uygulamasındaki her hesabı bir kez bağla. Sonrasında buradan değiştir.",
                      "Connect each Claude app account once. Switch between them here.",
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
