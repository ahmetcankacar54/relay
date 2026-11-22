import { ArrowRight } from "lucide-react";
import { PageSection } from "@/components/PageSection";
import { Note } from "@/components/SettingRow";
import { StatusDot } from "@/components/StatusDot";
import { Card } from "@/components/ui/card";
import { useI18n } from "@/data/i18n";
import { agoLabel, classShareLine, pickLine, requestDetail } from "@/lib/proxy-ui";
import type { ProxyRequestLog, ProxyStatus } from "../../../shared/types";

/** A status code as a short word with its tone. */
function statusTone(entry: ProxyRequestLog): { tone: "ok" | "warn" | "crit"; word: [string, string] } {
  if (entry.status === 101) return { tone: "ok", word: ["akış", "stream"] };
  // Answered, but billed beyond the plan: it cost money.
  if (entry.note === "extra-usage") return { tone: "crit", word: ["ekstra kullanım", "extra usage"] };
  if (entry.note === "refused") return { tone: "warn", word: ["429 geri çevrildi", "429 turned down"] };
  if (entry.failover) return { tone: "warn", word: [`${entry.status} → sıradaki`, `${entry.status} → next`] };
  if (entry.status < 400) return { tone: "ok", word: [String(entry.status), String(entry.status)] };
  if (entry.status === 429) return { tone: "warn", word: ["429 limit", "429 limit"] };
  if (entry.note === "sign-in") return { tone: "crit", word: ["401 giriş", "401 sign-in"] };
  return { tone: "crit", word: [String(entry.status), String(entry.status)] };
}

/** The latest requests: which account answered, what the upstream said, and failovers. */
export function RequestFeed({ status }: { status: ProxyStatus }) {
  const { t, language } = useI18n();
  const locale = language === "tr" ? "tr-TR" : "en-US";
  const recent = status.recent ?? [];
  const name = (id?: string) => status.accounts.find((a) => a.id === id)?.name;
  const ratio = status.stats.cacheHitRate.toLocaleString(locale, { maximumFractionDigits: 1 });
  const now = Date.now();
  return (
    <PageSection
      slot="request-feed"
      title={t("Son istekler", "Recent requests")}
      info={t(
        "Limit dolarsa aynı istek sıradaki hesapla denenir; aynı oturum, önbellek korunsun diye hesabında kalır.",
        "When a limit is hit, the same request goes to the next account; a session stays on its account to keep the cache.",
      )}
    >
      <Card padded>
        <dl className="grid grid-cols-3 gap-2 pb-2">
          {[
            [t("İstek", "Requests"), status.stats.totalRequests.toLocaleString(locale)],
            [t("Şu an", "Now"), status.stats.activeRequests.toLocaleString(locale)],
            [t("Önbellek", "Cache"), t(`%${ratio}`, `${ratio}%`)],
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
          <ol aria-label={t("Son istekler", "Recent requests")} className="grid">
            {recent.slice(0, 12).map((entry, index) => {
              const { tone, word } = statusTone(entry);
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
                    [entry.error ? t(`Yanıt: ${entry.error}`, `Answer: ${entry.error}`) : "", why]
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
                          ? t("hesap yok", "no account")
                          : entry.note === "all-limited"
                            ? t("hepsi limitte", "all limited")
                            : entry.note === "sign-in"
                              ? t("giriş kullanılamıyor", "no usable sign-in")
                              : "—")}
                    </span>
                    {entry.affinity && (
                      <span className="sr-only">{t("oturum hesabında kaldı", "session kept its account")}</span>
                    )}
                  </span>
                  <span className="flex items-center gap-1.5 tabular-nums">
                    <StatusDot tone={tone} />
                    {t(...word)}
                  </span>
                  {detail && (
                    <span data-slot="request-detail" className="col-span-2 col-start-2 truncate text-2xs text-muted-foreground tabular-nums">
                      {detail}
                    </span>
                  )}
                  {why && (
                    <span data-slot="request-pick" className="col-span-2 col-start-2 truncate text-2xs text-muted-foreground">
                      {t("Neden bu hesap: ", "Why this account: ")}
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
              ? t(
                  "Henüz istek yok. Araçlar sekmesinden Claude Code ya da Codex’i bağla.",
                  "No requests yet. Connect Claude Code or Codex on the Tools tab.",
                )
              : t("Ağ geçidi kapalı: istekler açıkken burada akar.", "The gateway is off: requests show here while it runs.")}
          </Note>
        )}
      </Card>
    </PageSection>
  );
}
