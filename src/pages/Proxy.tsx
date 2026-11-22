import type { ReactNode } from "react";
import { AlertTriangle, Check, CopyIcon, Plus } from "lucide-react";
import { PageBody, PageFrame } from "@/app/PageFrame";
import { addAccountHash, intentHash } from "@/app/routes";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { quotaAtRisk } from "@/lib/proxy-ui";
import { cn } from "@/lib/utils";
import type { ProxyClientId } from "../../shared/types";
import { GatewayHeader } from "./proxy/GatewayHeader";
import { useCopy, useProxyStatus, useTab, type Copy, type ProxyTab } from "./proxy/hooks";
import { PoolCard } from "./proxy/PoolCard";
import { RequestFeed } from "./proxy/RequestFeed";
import { RulesTab } from "./proxy/RulesTab";
import { SessionsCard } from "./proxy/SessionsCard";
import { CLIENT_NAMES, CLIENT_PROVIDER, providerName, usableFor, type Patch } from "./proxy/shared";
import { ToolsTab } from "./proxy/ToolsTab";

/** "A, B and C". */
const listNames = (names: string[], and: string) =>
  names.length > 1 ? `${names.slice(0, -1).join(", ")}${and}${names[names.length - 1]}` : names.join("");

/** An address or key as a compact chip; the button copies the real value. */
export function CopyChip({
  id,
  label,
  shown,
  value,
  copy,
  children,
}: {
  id: string;
  label: string;
  shown: string;
  value?: string;
  copy: Copy;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <span className="flex min-w-0 items-center gap-0.5 rounded-md border bg-muted/40 py-0.5 pr-0.5 pl-2.5">
      <span className="sr-only">{label}: </span>
      <span data-slot={`chip-${id}`} className="truncate font-mono text-xs">
        {shown}
      </span>
      {children}
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={!value}
        aria-label={t(`${label} kopyala`, `Copy ${label}`)}
        onClick={() => value && copy.copy(id, value)}
      >
        {copy.copied === id ? <Check className="text-ok" /> : <CopyIcon />}
      </Button>
    </span>
  );
}

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
  const { t } = useI18n();
  const { api, busy, desktop, action } = useRelay();
  const proxy = useProxyStatus();
  const { setStatus, unreadable } = proxy;
  // Reads keep failing: the last state read may be stale, so none of it is shown.
  const status = unreadable ? undefined : proxy.status;
  const copy = useCopy();
  const [savedTab, setTab] = useTab();
  const tab = initialTab ?? savedTab;
  const disabled = !!busy || !!desktop?.busy;
  /** True once the change is saved: `action` shows a failure itself and resolves either way. */
  const configure = async (patch: Patch) => {
    let saved = false;
    await action("proxy-configure", async () => {
      setStatus(await api.proxyConfigure(patch));
      saved = true;
    });
    return saved;
  };
  const toggle = (enabled: boolean) => void action("proxy-toggle", async () => setStatus(await api.proxyToggle(enabled)));
  const bind = (id: ProxyClientId) => void action("proxy-client", async () => setStatus(await api.proxyBindClient(id)));
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
      title={t("Proxy & Gateway", "Proxy & Gateway")}
      description={t("Tek adres; her istek en uygun hesaba gider", "One address; each request goes to the account with room")}
      actions={
        <Button asChild variant="outline" size="sm">
          <a href={intentHash("hesaplar", "ekle")}>
            <Plus />
            {t("Hesap ekle", "Add account")}
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
                    {t(`${providerName(client.id)} hesabı ekle`, `Add a ${providerName(client.id)} account`)}
                  </a>
                </Button>
                <Button size="sm" variant="outline" disabled={disabled} onClick={() => unbind(client.id)}>
                  {t("Ayır", "Disconnect")}
                </Button>
              </span>
            }
          >
            {t(
              `${CLIENT_NAMES[client.id]} bu geçide bağlı ama havuzda kullanılabilir ${providerName(client.id)} hesabı yok: istekleri başarısız olur.`,
              `${CLIENT_NAMES[client.id]} is connected to this gateway, but the pool has no usable ${providerName(client.id)} account: its requests fail.`,
            )}
          </Attention>
        ))}
        {boundOff.length > 0 && (
          <Attention
            tone="crit"
            action={
              <Button size="sm" disabled={disabled} onClick={() => toggle(true)}>
                {t("Geçidi aç", "Turn on")}
              </Button>
            }
          >
            {t(
              `${listNames(boundOff.map((c) => CLIENT_NAMES[c.id]), " ve ")} bu geçide bağlı ama geçit kapalı: istek gönderemez.`,
              `${listNames(boundOff.map((c) => CLIENT_NAMES[c.id]), " and ")} ${boundOff.length > 1 ? "are" : "is"} connected to this gateway, but it is off: no requests go through.`,
            )}
          </Attention>
        )}
        {signedOut.length > 0 && (
          <Attention
            tone="warn"
            action={
              <Button asChild size="sm" variant="outline">
                <a href={intentHash("hesaplar", "ekle")}>{t("Hesaplara git", "Go to accounts")}</a>
              </Button>
            }
          >
            {t(
              `${signedOut.map((a) => a.name).join(", ")}: giriş yok, ağ geçidi bu hesabı kullanamaz.`,
              `${signedOut.map((a) => a.name).join(", ")}: not signed in, the gateway cannot use it.`,
            )}
          </Attention>
        )}
        {(status?.alarms ?? []).slice(0, 1).map((alarm) => {
          const on = status?.accounts.find((a) => a.id === alarm.accountId)?.name;
          return (
            <Attention key={alarm.id} tone="warn">
              {t(
                `Bir istem durmadan istek gönderiyor: ${alarm.requests} istek, ${alarm.subagents} alt ajan${on ? ` · ${on}` : ""}${alarm.sessionId ? ` · oturum ${alarm.sessionId}` : ""}. Döngüde olabilir; Claude Code'da Esc ile durdurabilirsin.`,
                `A prompt keeps sending requests: ${alarm.requests} requests, ${alarm.subagents} subagents${on ? ` · ${on}` : ""}${alarm.sessionId ? ` · session ${alarm.sessionId}` : ""}. It may be in a loop; Esc in Claude Code stops it.`,
              )}
            </Attention>
          );
        })}
        {billed.length > 0 && (
          <Attention tone="crit">
            {t(
              `${billed.map((a) => a.name).join(", ")}: son yanıt plan yerine ekstra kullanımdan (ücretli) karşılandı. Ağ geçidi bu hesabı limiti sıfırlanana kadar kullanmıyor.`,
              `${billed.map((a) => a.name).join(", ")}: the latest answer was billed as extra usage (paid), not to the plan. The gateway leaves this account out until its limit resets.`,
            )}
          </Attention>
        )}
        {risky.length > 0 && status?.routingStrategy !== "soonest-reset" && (
          <Attention
            tone="warn"
            action={
              <Button size="sm" variant="outline" disabled={disabled} onClick={() => void configure({ routingStrategy: "soonest-reset" })}>
                {t("Önce yanacak olanı kullan", "Use expiring first")}
              </Button>
            }
          >
            {t(
              `${risky.map((a) => a.name).join(", ")}: haftalık limit yakında sıfırlanıyor ve kalan kota boşa gidecek.`,
              `${risky.map((a) => a.name).join(", ")}: the weekly limit resets soon and the room left will be lost.`,
            )}
          </Attention>
        )}
        <Tabs value={tab} onValueChange={(v) => setTab(v as ProxyTab)} className="grid gap-4">
          <TabsList aria-label={t("Ağ geçidi bölümleri", "Gateway sections")}>
            <TabsTrigger value="canli">{t("Canlı", "Live")}</TabsTrigger>
            <TabsTrigger value="araclar">{t("Araçlar", "Tools")}</TabsTrigger>
            <TabsTrigger value="kurallar">{t("Kurallar", "Rules")}</TabsTrigger>
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
                <RulesTab status={status} disabled={disabled} onConfigure={configure} />
              </TabsContent>
            </>
          )}
        </Tabs>
      </PageBody>
    </PageFrame>
  );
}
