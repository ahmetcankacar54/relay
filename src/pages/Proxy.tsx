import type { ReactNode } from "react";
import { AlertTriangle, Plus } from "lucide-react";
import { PageBody, PageFrame } from "@/app/PageFrame";
import { addAccountHash, intentHash } from "@/app/routes";
import { useRiskConsent } from "@/components/RiskConsent";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { quotaAtRisk } from "@/lib/proxy-ui";
import { cn } from "@/lib/utils";
import type { ProxyClientId } from "../../shared/types";
import { FORMAT_LOCALE } from "../../shared/i18n/locales";
import { clientRisks, gatewayRisks, proxyPatchRisks } from "../../shared/feature-risk";
import { DEFAULT_PROXY_CONFIG } from "../../shared/proxy-types";
import { GatewayHeader } from "./proxy/GatewayHeader";
import { useCopy, useProxyStatus, useTab, type ProxyTab } from "./proxy/hooks";
import { OverflowCard } from "./proxy/OverflowCard";
import { PoolCard } from "./proxy/PoolCard";
import { RequestFeed } from "./proxy/RequestFeed";
import { RulesTab } from "./proxy/RulesTab";
import { SessionsCard } from "./proxy/SessionsCard";
import { CLIENT_NAMES, CLIENT_PROVIDER, providerName, usableFor, type Patch } from "./proxy/shared";
import { ToolsTab } from "./proxy/ToolsTab";

/** One thing that needs the user now, above the tabs. */
function Attention({ tone, children, action }: { tone: "warn" | "crit"; children: ReactNode; action?: ReactNode }) {
  return (
    <div
      role="status"
      data-slot="proxy-attention"
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3.5 py-2.5 text-sm",
        tone === "crit" ? "border-crit/40 bg-crit/5" : "border-warn/40 bg-warn/5",
      )}
    >
      <AlertTriangle aria-hidden="true" className={cn("size-4 shrink-0", tone === "crit" ? "text-crit" : "text-warn")} />
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </div>
  );
}

/**
 * Proxy & Gateway: one head with the switch, address and key; then Live (the pool and the
 * requests), Tools (connect Claude Code and Codex in one click) and Rules (routing and network).
 */
export function ProxyPage({ initialTab }: { initialTab?: ProxyTab }) {
  const { t, language } = useI18n();
  const { api, busy, desktop, action, settings } = useRelay();
  const proxy = useProxyStatus();
  const { setStatus, unreadable } = proxy;
  // Reads keep failing: the last state read may be stale, so none of it is shown.
  const status = unreadable ? undefined : proxy.status;
  const copy = useCopy();
  const [savedTab, setTab] = useTab();
  const tab = initialTab ?? savedTab;
  const disabled = !!busy || !!desktop?.busy;
  const consent = useRiskConsent();
  // The pool as main will judge it: an account the page shows out of the pool is excluded.
  const poolAccounts = status?.accounts ?? [];
  const pool = {
    enabled: settings.proxy?.enabled === true,
    host: status?.host ?? DEFAULT_PROXY_CONFIG.host,
    excludedAccountIds: poolAccounts.filter((a) => !a.inPool).map((a) => a.id),
    boundClients: (status?.clients ?? []).filter((c) => c.bound).map((c) => c.id),
  };
  /** True once the change is saved: `action` shows a failure itself and resolves either way. */
  const configure = async (patch: Patch) => {
    if (!(await consent.ask(proxyPatchRisks(pool, patch, poolAccounts)))) return false;
    let saved = false;
    await action("proxy-configure", async () => {
      setStatus(await api.proxyConfigure(patch));
      saved = true;
    });
    return saved;
  };
  // Without the risk accepted the switch stays off: it shows `running`, which nothing changed.
  const toggle = (enabled: boolean) =>
    void (async () => {
      if (enabled && !(await consent.ask(gatewayRisks(pool, poolAccounts)))) return;
      await action("proxy-toggle", async () => setStatus(await api.proxyToggle(enabled)));
    })();
  const bind = (id: ProxyClientId) =>
    void (async () => {
      if (!(await consent.ask(clientRisks(id)))) return;
      await action("proxy-client", async () => setStatus(await api.proxyBindClient(id)));
    })();
  const unbind = (id: ProxyClientId) => void action("proxy-client", async () => setStatus(await api.proxyUnbindClient(id)));
  const boundOff = !status?.running ? (status?.clients ?? []).filter((c) => c.bound) : [];
  // Bound, running, and nothing of its provider can answer: its requests all fail.
  const boundEmpty = status?.running
    ? (status.clients ?? []).filter((c) => c.bound && usableFor(status.accounts, c.id) === 0)
    : [];
  const risky = (status?.accounts ?? []).filter((a) => a.inPool && quotaAtRisk(a));
  const signedOut = (status?.accounts ?? []).filter((a) => a.inPool && !a.signedIn);
  const billed = (status?.accounts ?? []).filter((a) => a.extraUsage?.kind === "billed");
  return (
    <PageFrame
      automationInline
      title={t("proxy.proxyGateway")}
      description={t("proxy.oneAddressEachRequestGoesTo")}
      actions={
        <Button asChild variant="outline" size="sm">
          <a href={intentHash("hesaplar", "ekle")}>
            <Plus />
            {t("common.addAccount")}
          </a>
        </Button>
      }
    >
      <PageBody className="max-w-5xl">
        <GatewayHeader
          status={status}
          disabled={disabled}
          copy={copy}
          onToggle={toggle}
          onRegenerate={() => void action("proxy-key", async () => setStatus(await api.proxyRegenerateKey()))}
          unreadable={unreadable}
        />
        {boundEmpty.map((client) => (
          <Attention
            key={client.id}
            tone="crit"
            action={
              <span className="flex flex-wrap gap-2">
                <Button asChild size="sm">
                  <a href={addAccountHash(CLIENT_PROVIDER(client.id))}>
                    {t("proxy.addAAccount", { providerName: providerName(client.id) })}
                  </a>
                </Button>
                <Button size="sm" variant="outline" disabled={disabled} onClick={() => unbind(client.id)}>
                  {t("proxy.disconnect")}
                </Button>
              </span>
            }
          >
            {t("proxy.isConnectedToThisGatewayBut", { client: CLIENT_NAMES[client.id], providerName: providerName(client.id) })}
          </Attention>
        ))}
        {boundOff.length > 0 && (
          <Attention
            tone="crit"
            action={
              <Button size="sm" disabled={disabled} onClick={() => toggle(true)}>
                {t("proxy.turnOn")}
              </Button>
            }
          >
            {t("proxy.connectedToThisGatewayButIt", {
              names: new Intl.ListFormat(FORMAT_LOCALE[language]).format(boundOff.map((c) => CLIENT_NAMES[c.id])),
              count: boundOff.length,
            })}
          </Attention>
        )}
        {signedOut.length > 0 && (
          <Attention
            tone="warn"
            action={
              <Button asChild size="sm" variant="outline">
                <a href={intentHash("hesaplar", "ekle")}>{t("proxy.goToAccounts")}</a>
              </Button>
            }
          >
            {t("proxy.notSignedInTheGatewayCannot", { join: signedOut.map((a) => a.name).join(", ") })}
          </Attention>
        )}
        {(status?.alarms ?? []).slice(0, 1).map((alarm) => {
          const on = status?.accounts.find((a) => a.id === alarm.accountId)?.name;
          return (
            <Attention key={alarm.id} tone="warn">
              {t("proxy.aPromptKeepsSendingRequestsRequests", {
                requests: alarm.requests,
                subagents: alarm.subagents,
                hasAccount: on ? "yes" : "no",
                account: on ?? "",
                hasSession: alarm.sessionId ? "yes" : "no",
                session: alarm.sessionId ?? "",
              })}
            </Attention>
          );
        })}
        {billed.length > 0 && (
          <Attention tone="crit">
            {t("proxy.theLatestAnswerWasBilledAs", { join: billed.map((a) => a.name).join(", ") })}
          </Attention>
        )}
        {risky.length > 0 && status?.routingStrategy !== "soonest-reset" && (
          <Attention
            tone="warn"
            action={
              <Button size="sm" variant="outline" disabled={disabled} onClick={() => void configure({ routingStrategy: "soonest-reset" })}>
                {t("proxy.useExpiringFirst")}
              </Button>
            }
          >
            {t("proxy.theWeeklyLimitResetsSoonAnd", { join: risky.map((a) => a.name).join(", ") })}
          </Attention>
        )}
        <Tabs value={tab} onValueChange={(v) => setTab(v as ProxyTab)} className="grid gap-4">
          <TabsList aria-label={t("proxy.gatewaySections")}>
            <TabsTrigger value="canli">{t("proxy.live")}</TabsTrigger>
            <TabsTrigger value="araclar">{t("proxy.tools")}</TabsTrigger>
            <TabsTrigger value="kurallar">{t("proxy.rules")}</TabsTrigger>
          </TabsList>
          {status && (
            <>
              <TabsContent value="canli">
                <div className="grid gap-4 @4xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
                  <PoolCard status={status} disabled={disabled} onConfigure={configure} />
                  <div className="grid content-start gap-4">
                    <RequestFeed status={status} />
                    {status.sessions?.length ? <SessionsCard status={status} /> : null}
                  </div>
                </div>
              </TabsContent>
              <TabsContent value="araclar">
                <ToolsTab status={status} disabled={disabled} copy={copy} onBind={bind} onUnbind={unbind} />
              </TabsContent>
              <TabsContent value="kurallar">
                <div className="grid gap-4">
                  <RulesTab status={status} disabled={disabled} onConfigure={configure} />
                  <OverflowCard status={status} disabled={disabled} onStatus={setStatus} />
                </div>
              </TabsContent>
            </>
          )}
        </Tabs>
      </PageBody>
      {consent.dialog}
    </PageFrame>
  );
}
