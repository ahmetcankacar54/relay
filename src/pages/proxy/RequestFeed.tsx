import { ArrowRight } from "lucide-react";
import { PageSection } from "@/components/PageSection";
import { Note } from "@/components/SettingRow";
import { StatusDot } from "@/components/StatusDot";
import { Card } from "@/components/ui/card";
import { useI18n, type T } from "@/data/i18n";
import { agoLabel, classShareLine, pickLine, requestDetail } from "@/lib/proxy-ui";
import type { ProxyRequestLog, ProxyStatus } from "../../../shared/types";
import { FORMAT_LOCALE } from "../../../shared/i18n/locales";

/** A status code as a short word with its tone. */
function statusTone(entry: ProxyRequestLog, t: T): { tone: "ok" | "warn" | "crit"; word: string } {
  if (entry.status === 101) return { tone: "ok", word: t("requestFeed.stream") };
  // Answered, but billed beyond the plan: it cost money.
  if (entry.note === "extra-usage") return { tone: "crit", word: t("requestFeed.extraUsage") };
  if (entry.note === "refused") return { tone: "warn", word: t("requestFeed.turnedDown") };
  if (entry.failover) return { tone: "warn", word: t("requestFeed.next", { status: entry.status }) };
  if (entry.status < 400) return { tone: "ok", word: String(entry.status) };
  if (entry.status === 429) return { tone: "warn", word: t("requestFeed.limit") };
  if (entry.note === "sign-in") return { tone: "crit", word: t("requestFeed.signIn") };
  return { tone: "crit", word: String(entry.status) };
}

/** The latest requests: which account answered, what the upstream said, and failovers. */
export function RequestFeed({ status }: { status: ProxyStatus }) {
  const { t, language } = useI18n();
  const locale = FORMAT_LOCALE[language];
  const recent = status.recent ?? [];
  const name = (id?: string) => status.accounts.find((a) => a.id === id)?.name;
  const ratio = status.stats.cacheHitRate.toLocaleString(locale, { maximumFractionDigits: 1 });
  const now = Date.now();
  return (
    <PageSection
      slot="request-feed"
      title={t("requestFeed.recentRequests")}
      info={t("requestFeed.whenALimitIsHitThe")}
    >
      <Card padded>
        <dl className="grid grid-cols-3 gap-2 pb-2">
          {[
            [t("requestFeed.requests"), status.stats.totalRequests.toLocaleString(locale)],
            [t("requestFeed.now"), status.stats.activeRequests.toLocaleString(locale)],
            [t("common.cache"), t("requestFeed.msg", { ratio })],
          ].map(([label, value]) => (
            <div key={label} className="grid gap-0.5 rounded-md bg-muted/40 px-2.5 py-1.5">
              <dt className="text-2xs text-muted-foreground">{label}</dt>
              <dd className="font-display text-sm font-semibold tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
        {status.classShare?.length ? (
          <p data-slot="class-share" className="pb-2 text-2xs text-muted-foreground tabular-nums">
            {classShareLine(status.classShare, t)}
          </p>
        ) : null}
        {recent.length ? (
          <ol aria-label={t("requestFeed.recentRequests")} className="grid">
            {recent.slice(0, 12).map((entry, index) => {
              const { tone, word } = statusTone(entry, t);
              const to = name(entry.accountId);
              const why = pickLine(entry.pick, name, t);
              const detail = requestDetail(
                entry,
                t,
                locale,
                status.accounts.find((a) => a.id === entry.accountId)?.percentCost?.dollars,
              );
              return (
                <li
                  key={`${entry.at}-${index}`}
                  data-status={entry.status}
                  title={
                    [entry.error ? t("requestFeed.answer", { entryError: entry.error }) : "", why]
                      .filter(Boolean)
                      .join("\n") || undefined
                  }
                  className="grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 border-t py-1.5 text-xs first:border-t-0"
                >
                  <span className="text-2xs text-muted-foreground tabular-nums">{agoLabel(entry.at, now, t)}</span>
                  <span className="flex min-w-0 items-center gap-1 truncate">
                    <span className="truncate font-mono text-2xs">{entry.model || entry.provider || "—"}</span>
                    <ArrowRight aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
                    <span className="truncate">
                      {to ??
                        (entry.note === "no-account"
                          ? t("requestFeed.noAccount")
                          : entry.note === "all-limited"
                            ? t("requestFeed.allLimited")
                            : entry.note === "sign-in"
                              ? t("requestFeed.noUsableSignIn")
                              : "—")}
                    </span>
                    {entry.affinity && (
                      <span className="sr-only">{t("requestFeed.sessionKeptItsAccount")}</span>
                    )}
                  </span>
                  <span className="flex items-center gap-1.5 tabular-nums">
                    <StatusDot tone={tone} />
                    {word}
                  </span>
                  {detail && (
                    <span data-slot="request-detail" className="col-span-2 col-start-2 truncate text-2xs text-muted-foreground tabular-nums">
                      {detail}
                    </span>
                  )}
                  {why && (
                    <span data-slot="request-pick" className="col-span-2 col-start-2 truncate text-2xs text-muted-foreground">
                      {t("requestFeed.whyThisAccount")}
                      {why}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        ) : (
          <Note>
            {status.running
              ? t("requestFeed.noRequestsYetConnectClaudeCode")
              : t("requestFeed.theGatewayIsOffRequestsShow")}
          </Note>
        )}
      </Card>
    </PageSection>
  );
}
