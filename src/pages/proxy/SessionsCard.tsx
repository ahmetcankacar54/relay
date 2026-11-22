import { ArrowRight } from "lucide-react";
import { PageSection } from "@/components/PageSection";
import { StatusDot } from "@/components/StatusDot";
import { Card } from "@/components/ui/card";
import { useI18n } from "@/data/i18n";
import { sessionCacheLine } from "@/lib/proxy-ui";
import type { ProxyStatus } from "../../../shared/types";

/** The sessions heard from lately: whose account holds their cache, and whether it is still warm. */
export function SessionsCard({ status }: { status: ProxyStatus }) {
  const { t, language } = useI18n();
  const locale = language === "tr" ? "tr-TR" : "en-US";
  const now = Date.now();
  const name = (id: string) => status.accounts.find((a) => a.id === id)?.name ?? "—";
  return (
    <PageSection
      slot="sessions"
      title={t("Oturumlar", "Sessions")}
      info={t(
        "Oturumun önbelleği hesabındadır. Sıcakken dönmek ucuzdur; soğuyunca ya da hesap değişince bütün istem yeniden yazılır.",
        "A session's cache lives on its account. Coming back while it is warm is cheap; once cold, or on another account, the whole prompt is written again.",
      )}
    >
      <Card padded>
        <ol aria-label={t("Oturumlar", "Sessions")} className="grid">
          {(status.sessions ?? []).map((session) => {
            const line = sessionCacheLine(session, now, t, locale);
            return (
              <li
                key={session.id}
                data-warm={line.warm}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 border-t py-1.5 text-xs first:border-t-0"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="font-mono text-2xs text-muted-foreground">{session.id}</span>
                  <ArrowRight aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
                  <span className="truncate">{name(session.accountId)}</span>
                </span>
                <span className="flex items-center gap-1.5 tabular-nums">
                  <StatusDot tone={line.warm ? "ok" : "off"} hollow={!line.warm} />
                  {line.state}
                </span>
                <span className="col-span-2 truncate text-2xs text-muted-foreground tabular-nums">{line.detail}</span>
              </li>
            );
          })}
        </ol>
      </Card>
    </PageSection>
  );
}
