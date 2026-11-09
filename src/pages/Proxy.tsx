import { useEffect, useMemo, useState } from "react";
import { Check, Copy, Eye, EyeOff, Plus, RefreshCw } from "lucide-react";
import { PageFrame } from "@/app/PageFrame";
import { routeHash, intentHash } from "@/app/routes";
import { ProviderBadge } from "@/components/ProviderBadge";
import { Note, OptionSelect, SectionHeading, SettingRow } from "@/components/SettingRow";
import { StatusDot } from "@/components/StatusDot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { meterFill } from "@/lib/meter";
import {
  antigravitySnippet,
  claudeCodeSnippet,
  codexSnippet,
  gatewayUrl,
  isLoopbackHost,
  maskKey,
  parsePort,
  proxyCurlSnippet,
  quotaTone,
  resetLabel,
  validHost,
} from "@/lib/proxy-ui";
import { cn } from "@/lib/utils";
import type { AccountProvider, ProxyAccountStatus, ProxyStatus } from "../../shared/types";
import { accountProvider, providerLabel } from "./accounts/accountLabels";

type Strategy = NonNullable<ProxyStatus["routingStrategy"]>;
type Patch = Parameters<ReturnType<typeof useRelay>["api"]["proxyConfigure"]>[0];

const cardClass = "gap-0 px-4 py-3.5";
/** How often the live counters and quotas are read while the page is open. */
const POLL_MS = 3_000;
const COPIED_MS = 1_500;
/** The providers the gateway pools, in the order the summary cards show them. */
const POOL_PROVIDERS = ["claude", "codex", "antigravity"] as const satisfies readonly AccountProvider[];
const AFFINITY_SECONDS = [300, 900, 3_600] as const;

/** The gateway's state, read on mount, after every Relay change, and every few seconds. */
function useProxyStatus() {
  const { api, data, desktop } = useRelay();
  const [status, setStatus] = useState<ProxyStatus | undefined>(desktop?.proxyStatus);
  useEffect(() => {
    let live = true;
    // A failed read keeps the last state on screen; the next tick tries again.
    const load = () =>
      void api.proxyStatus().then(
        (next) => live && setStatus(next),
        () => {},
      );
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [api, data]);
  return { status, setStatus };
}

/** A command or setting to copy: a monospace block with a Copy button, the key hidden on screen. */
function CodeBlock({
  id,
  title,
  hint,
  shown,
  copyText,
  copied,
  onCopy,
}: {
  id: string;
  title: string;
  hint?: string;
  /** What the block displays: the key may be masked here. */
  shown: string;
  /** What Copy puts on the clipboard: always the real text. */
  copyText: string;
  copied: boolean;
  onCopy: (id: string, text: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h4 className="text-xs font-semibold">{title}</h4>
          {hint && <p className="text-2xs text-muted-foreground">{hint}</p>}
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t(`${title} kopyala`, `Copy ${title}`)}
          onClick={() => onCopy(id, copyText)}
        >
          {copied ? <Check className="text-ok" /> : <Copy />}
          {copied ? t("Kopyalandı", "Copied") : t("Kopyala", "Copy")}
        </Button>
      </div>
      <pre
        data-slot="code-block"
        className="overflow-x-auto rounded-md border bg-muted/50 px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all select-all"
      >
        {shown}
      </pre>
    </div>
  );
}

/** The master switch, the live state, the endpoint and the client key. */
function GatewayCard({
  status,
  disabled,
  copied,
  onCopy,
  onToggle,
  onRegenerate,
}: {
  status?: ProxyStatus;
  disabled: boolean;
  copied?: string;
  onCopy: (id: string, text: string) => void;
  onToggle: (enabled: boolean) => void;
  onRegenerate: () => void;
}) {
  const { t } = useI18n();
  const [reveal, setReveal] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const running = status?.running === true;
  const key = status?.clientApiKey;
  const endpoint = gatewayUrl(status?.host ?? "127.0.0.1", status?.port ?? 8317);
  return (
    <Card className={cardClass} data-slot="gateway-card">
      <SettingRow
        label={
          <span className="flex items-center gap-2 font-display text-sm font-semibold">
            <StatusDot tone={running ? "ok" : "off"} hollow={!running} />
            {t("Yerel API ağ geçidi", "Local API gateway")}
            <Badge
              role="status"
              data-slot="proxy-status"
              variant="outline"
              className={cn(running && "border-ok/40 text-ok-foreground")}
            >
              {!status
                ? t("Okunuyor…", "Loading…")
                : running
                  ? t(`Çalışıyor · :${status.port}`, `Running · :${status.port}`)
                  : t("Durduruldu", "Stopped")}
            </Badge>
          </span>
        }
        htmlFor="proxy-enabled"
        description={t(
          "Hesapların arasında istekleri limite göre dağıtan yerel bir ağ geçidi. Claude Code, Codex, Cursor gibi araçlar tek bir adrese bağlanır.",
          "A local gateway that spreads requests over your accounts by their limits. Tools such as Claude Code, Codex or Cursor connect to one address.",
        )}
      >
        <Switch id="proxy-enabled" checked={running} disabled={disabled || !status} onCheckedChange={onToggle} />
      </SettingRow>
      {status?.error && !running && (
        <p role="alert" className="border-t pt-2 text-xs text-crit">
          {status.error}
        </p>
      )}
      <div className="grid gap-3 border-t pt-3">
        <div className="grid gap-1">
          <label className="text-xs font-medium" htmlFor="proxy-endpoint">
            {t("Uç nokta adresi", "Endpoint URL")}
          </label>
          <div className="flex items-center gap-2">
            <Input id="proxy-endpoint" readOnly className="font-mono text-xs" spellCheck={false} value={endpoint} />
            <Button
              variant="outline"
              size="sm"
              aria-label={t("Adresi kopyala", "Copy endpoint")}
              onClick={() => onCopy("endpoint", endpoint)}
            >
              {copied === "endpoint" ? <Check className="text-ok" /> : <Copy />}
              {copied === "endpoint" ? t("Kopyalandı", "Copied") : t("Kopyala", "Copy")}
            </Button>
          </div>
        </div>
        <div className="grid gap-1">
          <label className="text-xs font-medium" htmlFor="proxy-key">
            {t("İstemci API anahtarı", "Client API key")}
          </label>
          <div className="flex items-center gap-2">
            <Input
              id="proxy-key"
              readOnly
              className="font-mono text-xs"
              type="text"
              spellCheck={false}
              autoComplete="off"
              value={key ? (reveal ? key : maskKey(key)) : ""}
              placeholder={t("Proxy ilk açıldığında oluşur", "Created when the gateway first starts")}
            />
            <Button
              variant="outline"
              size="icon-sm"
              disabled={!key}
              aria-label={reveal ? t("Anahtarı gizle", "Hide key") : t("Anahtarı göster", "Show key")}
              aria-pressed={reveal}
              onClick={() => setReveal((r) => !r)}
            >
              {reveal ? <EyeOff /> : <Eye />}
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              disabled={!key}
              aria-label={t("Anahtarı kopyala", "Copy key")}
              onClick={() => key && onCopy("key", key)}
            >
              {copied === "key" ? <Check className="text-ok" /> : <Copy />}
            </Button>
            <Button variant="outline" size="sm" disabled={disabled} onClick={() => setConfirming(true)}>
              <RefreshCw />
              {t("Yenile", "Regenerate")}
            </Button>
          </div>
          {confirming && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Note className="text-foreground">
                {t(
                  "Eski anahtar hemen çalışmaz olur. Araçlara yenisini girmen gerekir.",
                  "The old key stops working at once. You will need to enter the new one in your tools.",
                )}
              </Note>
              <Button
                size="sm"
                disabled={disabled}
                onClick={() => {
                  setConfirming(false);
                  onRegenerate();
                }}
              >
                {t("Yeni anahtar üret", "Generate new key")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                {t("Vazgeç", "Cancel")}
              </Button>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

type PoolAccount = Pick<ProxyAccountStatus, "id" | "quotaPercent" | "active" | "signedIn">;

/**
 * One provider's pool: how many accounts it has, how many can take a request now, and how full
 * they are on average. Only limits Relay has read count: an account it cannot read (Codex and
 * Antigravity have no limit reader yet) is never shown as empty.
 */
function PoolCard({
  provider,
  accounts,
  running,
}: {
  provider: AccountProvider;
  accounts: PoolAccount[];
  running: boolean;
}) {
  const { t } = useI18n();
  const ready = accounts.filter((a) => a.signedIn && (a.quotaPercent ?? 0) < 100).length;
  const active = accounts.some((a) => a.active);
  const known = accounts
    .map((a) => a.quotaPercent)
    .filter((p): p is number => typeof p === "number");
  const avgUsed = known.length
    ? Math.round(known.reduce((sum, p) => sum + Math.min(100, Math.max(0, p)), 0) / known.length)
    : undefined;
  return (
    <Card className={cn(cardClass, "gap-2")} data-slot="pool-card" data-provider={provider}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 font-display text-sm font-semibold">
          <ProviderBadge provider={provider} />
          <span className="truncate">{providerLabel(provider)}</span>
        </h3>
        {running && active && (
          <span className="flex items-center gap-1 text-2xs text-ok-foreground">
            <StatusDot tone="ok" />
            {t("Aktif", "Active")}
          </span>
        )}
      </div>
      <div className="flex items-baseline justify-between gap-2">
        <p className="font-display text-2xl font-semibold tabular-nums">{accounts.length}</p>
        {accounts.length > 0 && (
          <span className="font-mono text-2xs text-muted-foreground tabular-nums">
            {avgUsed === undefined
              ? t("Kota bilinmiyor", "Quota unknown")
              : t(`ort. %${avgUsed} dolu`, `avg. ${avgUsed}% used`)}
          </span>
        )}
      </div>
      {avgUsed !== undefined && (
        <div
          role="meter"
          aria-label={t(`${providerLabel(provider)} ortalama limit kullanımı`, `${providerLabel(provider)} average limit used`)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={avgUsed}
          className="h-1.5 w-full overflow-hidden rounded-full bg-track"
        >
          <div className={cn("h-full rounded-full", meterFill(avgUsed))} style={{ width: `${avgUsed}%` }} />
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {accounts.length
          ? t(`${ready} hesap istek alabilir`, `${ready} can take requests`)
          : t("Havuzda hesap yok", "No accounts in the pool")}
      </p>
      <Button asChild variant="outline" size="sm" className="mt-1 w-fit">
        <a href={accounts.length ? routeHash("hesaplar") : intentHash("hesaplar", "ekle")}>
          {accounts.length ? null : <Plus />}
          {accounts.length ? t("Hesaplara git", "Go to accounts") : t("Hesap ekle", "Add account")}
        </a>
      </Button>
    </Card>
  );
}

/** One counter in the telemetry grid. */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-0.5 rounded-md border bg-muted/30 px-3 py-2">
      <span className="text-2xs text-muted-foreground">{label}</span>
      <span className="font-display text-base font-semibold tabular-nums">{value}</span>
    </div>
  );
}

/** An account in the pool: its provider, name, routing state, how full its fuller limit is, and when that renews. */
function AccountRow({ account, provider }: { account: ProxyAccountStatus; provider: AccountProvider }) {
  const { t } = useI18n();
  const percent = account.quotaPercent;
  return (
    <li
      data-active={account.active || undefined}
      data-provider={provider}
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_minmax(6rem,9rem)_5.5rem] items-center gap-3 border-t py-2 first:border-t-0",
        account.active && "-mx-2 rounded-md bg-primary/5 px-2",
      )}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <ProviderBadge provider={provider} />
          <span className="truncate text-sm">{account.name}</span>
          {account.active ? (
            <Badge variant="outline" className="text-ok-foreground">
              <StatusDot tone="ok" />
              {t("Son istek", "Last request")}
            </Badge>
          ) : !account.signedIn ? (
            <Badge variant="secondary">{t("Giriş yok", "Not signed in")}</Badge>
          ) : (percent ?? 0) >= 100 ? (
            <Badge variant="secondary">{t("Dolu", "Full")}</Badge>
          ) : null}
        </div>
        {account.email && <p className="truncate text-xs text-muted-foreground">{account.email}</p>}
      </div>
      <div className="flex items-center gap-2">
        <div
          role="progressbar"
          aria-label={t(`${account.name} limit kullanımı`, `${account.name} limit used`)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          data-tone={quotaTone(percent)}
          className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
        >
          <div className={cn("h-full rounded-full", meterFill(percent))} style={{ width: `${Math.min(100, percent ?? 0)}%` }} />
        </div>
        <span className="w-9 text-right text-xs tabular-nums">{percent === undefined ? "—" : t(`%${percent}`, `${percent}%`)}</span>
      </div>
      <span className="text-right text-xs text-muted-foreground tabular-nums">{resetLabel(account.resetInMinutes, t)}</span>
    </li>
  );
}

/** What the gateway is doing: its counters and every account's room left. */
function MonitorCard({ status }: { status?: ProxyStatus }) {
  const { t, language } = useI18n();
  const locale = language === "tr" ? "tr-TR" : "en-US";
  const number = (n: number) => n.toLocaleString(locale);
  const stats = status?.stats;
  const ratio = (stats?.cacheHitRate ?? 0).toLocaleString(locale, { maximumFractionDigits: 1 });
  const accounts = status?.accounts ?? [];
  return (
    <Card className={cardClass}>
      <SectionHeading
        title={t("Canlı yönlendirme monitörü", "Live routing monitor")}
        description={t(
          "Her istek kendi sağlayıcısının hesaplarından birine gider; limit dolarsa ya da giriş reddedilirse aynı istek sıradaki hesapla denenir. Aynı oturum, istem önbelleği korunsun diye aynı hesapta kalır.",
          "Each request goes to an account of its own provider; when that account is at its limit or its sign-in is refused, the same request is tried on the next one. A session stays on its account so the prompt cache is kept.",
        )}
      />
      <div className="grid gap-3 pt-2">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label={t("Toplam istek", "Total requests")} value={number(stats?.totalRequests ?? 0)} />
          <Stat label={t("Aktif akış", "Active streams")} value={number(stats?.activeRequests ?? 0)} />
          <Stat label={t("Önbellek isabeti", "Prompt cache hits")} value={number(stats?.promptCacheHits ?? 0)} />
          <Stat
            label={t("Önbellek oranı", "Cache hit ratio")}
            value={t(`%${ratio}`, `${ratio}%`)}
          />
        </div>
        {accounts.length ? (
          <ul aria-label={t("Bağlı hesaplar", "Connected accounts")}>
            {accounts.map((account) => (
              <AccountRow key={account.id} account={account} provider={account.provider ?? "claude"} />
            ))}
          </ul>
        ) : (
          <Note>{t("Henüz bağlı hesap yok.", "No connected accounts yet.")}</Note>
        )}
        {!status?.running && (
          <Note>
            {t(
              "Proxy kapalı: sayaçlar proxy açıkken dolar. Limitler Relay’in son okuduğu değerlerdir.",
              "The gateway is off: counters fill while it runs. Limits are the values Relay last read.",
            )}
          </Note>
        )}
      </div>
    </Card>
  );
}

/** How the gateway picks an account and where it listens. */
function ConfigCard({
  status,
  disabled,
  onConfigure,
}: {
  status?: ProxyStatus;
  disabled: boolean;
  onConfigure: (patch: Patch) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<{ port: string; host: string }>();
  const strategy: Strategy = status?.routingStrategy ?? "soonest-reset";
  const port = draft?.port ?? String(status?.port ?? 8317);
  const host = draft?.host ?? status?.host ?? "127.0.0.1";
  const parsedPort = parsePort(port);
  const changed = !!status && (parsedPort !== status.port || host.trim() !== status.host);
  const valid = parsedPort !== undefined && validHost(host);
  const strategies: { value: Strategy; label: string; hint: string }[] = [
    {
      value: "soonest-reset",
      label: t("En yakın sıfırlama (önerilen)", "Soonest reset (recommended)"),
      hint: t("Limiti en yakında yenilenen hesap önce kullanılır; boşa giden kota azalır.", "The account whose limit renews soonest goes first, so less quota is wasted."),
    },
    {
      value: "balanced",
      label: t("Dengeli kapasite", "Balanced capacity"),
      hint: t("İstekler en çok boş kapasitesi olan hesaba gider.", "Requests go to the account with the most room left."),
    },
    {
      value: "strict-priority",
      label: t("Sıralı öncelik", "Strict priority"),
      hint: t("Hesaplar listedeki sırayla kullanılır; biri dolunca sıradaki başlar.", "Accounts are used in list order; the next starts when one is full."),
    },
  ];
  return (
    <Card className={cardClass} data-slot="routing-config">
      <SectionHeading
        title={t("Yönlendirme stratejisi ve ayarlar", "Routing strategy and settings")}
        description={t(
          "İsteklerin hangi hesaba gideceğini ve ağ geçidinin nerede dinleyeceğini seç.",
          "Choose which account serves a request, and where the gateway listens.",
        )}
      />
      <div className="grid gap-4 pt-2">
        <div role="radiogroup" aria-label={t("Yönlendirme stratejisi", "Routing strategy")} className="grid gap-2 sm:grid-cols-3">
          {strategies.map((s) => (
            <button
              key={s.value}
              type="button"
              role="radio"
              aria-checked={strategy === s.value}
              disabled={disabled || !status}
              onClick={() => strategy !== s.value && void onConfigure({ routingStrategy: s.value })}
              className={cn(
                "grid content-start gap-1 rounded-md border bg-card px-3 py-2 text-left outline-none hover:bg-foreground/5 focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60",
                strategy === s.value && "border-primary bg-primary/5",
              )}
            >
              <span className="text-xs font-semibold">{s.label}</span>
              <span className="text-2xs text-muted-foreground">{s.hint}</span>
            </button>
          ))}
        </div>
        <div className="grid gap-1">
          <span className="text-xs font-medium">{t("Adres ve port", "Host and port")}</span>
          <div className="flex flex-wrap gap-2">
            {[
              { host: "127.0.0.1", label: t("Yalnızca bu Mac", "This Mac only") },
              { host: "0.0.0.0", label: t("Ağdaki cihazlar", "Devices on the network") },
            ].map((p) => (
              <Button
                key={p.host}
                size="sm"
                variant="outline"
                aria-pressed={host.trim() === p.host}
                disabled={disabled}
                className={cn(host.trim() === p.host && "border-primary bg-primary/5")}
                onClick={() => setDraft({ port, host: p.host })}
              >
                <span className="font-mono">{p.host}</span> · {p.label}
              </Button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-[1fr_7rem] gap-3">
          <label className="grid gap-1 text-xs font-medium" htmlFor="proxy-host">
            {t("Adres", "Host")}
            <Input
              id="proxy-host"
              value={host}
              disabled={disabled}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={!validHost(host)}
              onChange={(e) => setDraft({ port, host: e.target.value })}
            />
          </label>
          <label className="grid gap-1 text-xs font-medium" htmlFor="proxy-port">
            {t("Port", "Port")}
            <Input
              id="proxy-port"
              inputMode="numeric"
              value={port}
              disabled={disabled}
              aria-invalid={parsedPort === undefined}
              onChange={(e) => setDraft({ host, port: e.target.value })}
            />
          </label>
        </div>
        {draft && changed && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={disabled || !valid}
              onClick={() => void onConfigure({ port: parsedPort!, host: host.trim() }).then((saved) => saved && setDraft(undefined))}
            >
              {t("Uygula", "Apply")}
            </Button>
            <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setDraft(undefined)}>
              {t("Vazgeç", "Cancel")}
            </Button>
            <Note>
              {valid
                ? status?.running
                  ? t("Çalışan proxy yeni adresle yeniden başlar.", "The running gateway restarts on the new address.")
                  : t("Proxy açıldığında bu adresi kullanır.", "The gateway uses this address when you turn it on.")
                : t("Geçerli bir adres ve 1–65535 arası bir port gir.", "Enter a valid host and a port from 1 to 65535.")}
            </Note>
          </div>
        )}
        {!isLoopbackHost(host.trim()) && validHost(host) && (
          <Note className="text-warn">
            {t(
              "Bu adres yerel değil: anahtarı bilen ağdaki herkes hesaplarını kullanabilir. Tailscale gibi kapalı bir ağ kullan.",
              "This is not a local address: anyone on the network who has the key can spend your accounts. Keep it on a private network such as Tailscale.",
            )}
          </Note>
        )}
        <div>
          <SettingRow
            label={t("Oturum eşleşmesi süresi", "Session affinity")}
            htmlFor="proxy-affinity"
            description={t(
              "Aynı oturum bu süre boyunca aynı hesapta kalır; istem önbelleği korunur.",
              "A session stays on its account for this long, so the prompt cache is kept.",
            )}
          >
            <OptionSelect
              id="proxy-affinity"
              value={String(status?.affinityTtlSeconds ?? 300)}
              disabled={disabled || !status}
              options={AFFINITY_SECONDS.map((s) => ({
                value: String(s),
                label: s < 3_600 ? t(`${s / 60} dakika`, `${s / 60} minutes`) : t("1 saat", "1 hour"),
              }))}
              onChange={(value) => void onConfigure({ affinityTtlSeconds: Number(value) })}
            />
          </SettingRow>
        </div>
      </div>
    </Card>
  );
}

/** Copyable setup for the tools that talk to the gateway. The key shows hidden unless revealed above. */
function GuideCard({
  status,
  copied,
  onCopy,
}: {
  status?: ProxyStatus;
  copied?: string;
  onCopy: (id: string, text: string) => void;
}) {
  const { t } = useI18n();
  const host = status?.host ?? "127.0.0.1";
  const port = status?.port ?? 8317;
  const key = status?.clientApiKey;
  return (
    <Card className={cardClass}>
      <SectionHeading
        title={t("İstemci kurulum rehberi", "Client setup guide")}
        description={t(
          "Komutu kopyala, aracı proxy’ye yönlendir. Kopyalanan metin gerçek anahtarı içerir.",
          "Copy the command to point a tool at the gateway. The copied text holds the real key.",
        )}
      />
      <div className="grid gap-4 pt-2">
        <CodeBlock
          id="claude-code"
          title="Claude Code CLI"
          shown={claudeCodeSnippet(host, port, key, true)}
          copyText={claudeCodeSnippet(host, port, key)}
          copied={copied === "claude-code"}
          onCopy={onCopy}
        />
        <CodeBlock
          id="openai"
          title="Codex / Cursor / OpenAI SDK"
          shown={codexSnippet(host, port, key, true)}
          copyText={codexSnippet(host, port, key)}
          copied={copied === "openai"}
          onCopy={onCopy}
        />
        <CodeBlock
          id="antigravity"
          title={t("Antigravity modelleri · cURL", "Antigravity models · cURL")}
          shown={antigravitySnippet(host, port, key, true)}
          copyText={antigravitySnippet(host, port, key)}
          copied={copied === "antigravity"}
          onCopy={onCopy}
        />
        <CodeBlock
          id="curl"
          title={t("cURL testi", "cURL test")}
          shown={proxyCurlSnippet(host, port, key, true)}
          copyText={proxyCurlSnippet(host, port, key)}
          copied={copied === "curl"}
          onCopy={onCopy}
        />
        {!status?.running && (
          <Note>
            {t(
              `Proxy kapalıyken ${gatewayUrl(host, port)} yanıt vermez; önce yukarıdan aç.`,
              `While the gateway is off, ${gatewayUrl(host, port)} does not answer. Turn it on above first.`,
            )}
          </Note>
        )}
      </div>
    </Card>
  );
}

/**
 * Proxy & Gateway: turn the local gateway on, see how tools connect to it, which providers fill its
 * pool, how it routes, and how it spends every account.
 */
export function ProxyPage() {
  const { t } = useI18n();
  const { api, busy, desktop, action, accounts } = useRelay();
  const { status, setStatus } = useProxyStatus();
  const [copied, setCopied] = useState<string>();
  const disabled = !!busy || !!desktop?.busy;
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(undefined), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = (id: string, text: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => setCopied(id),
      () => {},
    );
  };
  /** True once the change is saved: `action` shows a failure itself and resolves either way. */
  const configure = async (patch: Patch) => {
    let saved = false;
    await action("proxy-configure", async () => {
      setStatus(await api.proxyConfigure(patch));
      saved = true;
    });
    return saved;
  };
  const pools = useMemo(() => {
    const byProvider: Record<AccountProvider, PoolAccount[]> = {
      claude: [],
      codex: [],
      antigravity: [],
      gemini: [],
    };
    // Before the first status arrives, the snapshot's accounts fill the pools.
    const rows: (PoolAccount & { provider?: AccountProvider })[] =
      status?.accounts ??
      accounts.map((a) => ({ id: a.id, active: false, signedIn: a.auth?.loggedIn === true, provider: accountProvider(a) }));
    for (const a of rows) byProvider[a.provider ?? "claude"].push(a);
    return byProvider;
  }, [status?.accounts, accounts]);
  return (
    <PageFrame
      automationInline
      title={t("Proxy & Gateway", "Proxy & Gateway")}
      description={t(
        "Claude Code, Codex ve Antigravity OAuth hesapları için yerel ağ geçidi.",
        "Local gateway for Claude Code, Codex, and Antigravity OAuth accounts.",
      )}
      actions={
        <Button asChild variant="outline" size="sm">
          <a href={intentHash("hesaplar", "ekle")}>
            <Plus />
            {t("Hesap ekle", "Add account")}
          </a>
        </Button>
      }
    >
      <div className="grid max-w-4xl gap-4 px-5 pb-6">
        <GatewayCard
          status={status}
          disabled={disabled}
          copied={copied}
          onCopy={copy}
          onToggle={(enabled) => void action("proxy-toggle", async () => setStatus(await api.proxyToggle(enabled)))}
          onRegenerate={() => void action("proxy-key", async () => setStatus(await api.proxyRegenerateKey()))}
        />
        <section aria-label={t("Sağlayıcı havuzları", "Provider pools")} className="grid gap-3 sm:grid-cols-3">
          {POOL_PROVIDERS.map((provider) => (
            <PoolCard key={provider} provider={provider} accounts={pools[provider]} running={status?.running === true} />
          ))}
        </section>
        <MonitorCard status={status} />
        <ConfigCard status={status} disabled={disabled} onConfigure={configure} />
        <GuideCard status={status} copied={copied} onCopy={copy} />
      </div>
    </PageFrame>
  );
}
