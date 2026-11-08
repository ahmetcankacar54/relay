import { useEffect, useState } from "react";
import { Check, Copy, Eye, EyeOff, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Note, SectionHeading, SettingRow } from "@/components/SettingRow";
import { StatusDot } from "@/components/StatusDot";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { meterFill } from "@/lib/meter";
import {
  claudeCodeSnippet,
  gatewayUrl,
  isLoopbackHost,
  maskKey,
  openAiSnippet,
  parsePort,
  resetLabel,
  validHost,
} from "@/lib/proxy-ui";
import { cn } from "@/lib/utils";
import type { ProxyAccountStatus, ProxyStatus } from "../../../shared/types";

const cardClass = "gap-0 px-4 py-3.5";
/** How often the live counters and quotas are read while the tab is open. */
const POLL_MS = 3_000;
const COPIED_MS = 1_500;

/** The gateway's state, read on mount, after every Relay change, and every few seconds. */
function useProxyStatus() {
  const { api, data, desktop } = useRelay();
  const [status, setStatus] = useState<ProxyStatus | undefined>(desktop?.proxyStatus);
  useEffect(() => {
    let live = true;
    const load = () => {
      try {
        api.proxyStatus().then(
          (next) => live && setStatus(next),
          () => {},
        );
      } catch {
        // No gateway in this build: the tab keeps what the snapshot said.
      }
    };
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
  shown,
  copyText,
  copied,
  onCopy,
}: {
  id: string;
  title: string;
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
        <h4 className="text-xs font-semibold">{title}</h4>
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

/** The master switch and the live state: green while the gateway answers, grey while it is off. */
function StatusCard({
  status,
  disabled,
  onToggle,
}: {
  status?: ProxyStatus;
  disabled: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const { t } = useI18n();
  const running = status?.running === true;
  return (
    <Card className={cardClass}>
      <SettingRow
        label={
          <span
            role="status"
            data-slot="proxy-status"
            className="flex items-center gap-2 font-display text-sm font-semibold"
          >
            <StatusDot tone={running ? "ok" : "off"} hollow={!running} />
            {running && status
              ? t(`Proxy Aktif: ${status.host}:${status.port}`, `Proxy active: ${status.host}:${status.port}`)
              : t("Proxy Devre Dışı", "Proxy off")}
          </span>
        }
        htmlFor="proxy-enabled"
        description={t(
          "Hesapların arasında istekleri limite göre dağıtan yerel bir ağ geçidi. Claude Code, Cursor gibi araçlar tek bir adrese bağlanır.",
          "A local gateway that spreads requests over your accounts by their limits. Tools such as Claude Code or Cursor connect to one address.",
        )}
      >
        <Switch
          id="proxy-enabled"
          checked={running}
          disabled={disabled || !status}
          onCheckedChange={onToggle}
        />
      </SettingRow>
      {status?.error && !running && (
        <p role="alert" className="border-t pt-2 text-xs text-crit">
          {status.error}
        </p>
      )}
    </Card>
  );
}

/** Port, host and the client key, with Show/Hide, Copy and Yenile (regenerate). */
function ConnectionCard({
  status,
  disabled,
  copied,
  onCopy,
  onConfigure,
  onRegenerate,
}: {
  status?: ProxyStatus;
  disabled: boolean;
  copied?: string;
  onCopy: (id: string, text: string) => void;
  onConfigure: (patch: { port: number; host: string }) => Promise<boolean>;
  onRegenerate: () => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<{ port: string; host: string }>();
  const [reveal, setReveal] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const port = draft?.port ?? String(status?.port ?? 8317);
  const host = draft?.host ?? status?.host ?? "127.0.0.1";
  const parsedPort = parsePort(port);
  const changed = !!status && (parsedPort !== status.port || host.trim() !== status.host);
  const valid = parsedPort !== undefined && validHost(host);
  const key = status?.clientApiKey;
  return (
    <Card className={cardClass}>
      <SectionHeading
        title={t("Bağlantı bilgileri", "Connection details")}
        description={t(
          "Araçların bağlanacağı adres ve istemci anahtarı.",
          "The address tools connect to, and the client key.",
        )}
      />
      <div className="grid gap-3 pt-2">
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
              onClick={() =>
                void onConfigure({ port: parsedPort!, host: host.trim() }).then((saved) => saved && setDraft(undefined))
              }
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
            <Button
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() => setConfirming(true)}
            >
              <RefreshCw />
              {t("Yenile", "Regenerate")}
            </Button>
          </div>
          {confirming && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Note className="text-foreground">
                {t(
                  "Eski anahtar çalışmaz ve çalışan proxy yeniden başlar. Araçlara yenisini girmen gerekir.",
                  "The old key stops working and a running gateway restarts. You will need to enter the new one in your tools.",
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
          title="Cursor / VS Code / OpenAI"
          shown={openAiSnippet(host, port, key, true)}
          copyText={openAiSnippet(host, port, key)}
          copied={copied === "openai"}
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

/** One counter in the monitor. */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-0.5 rounded-md border bg-muted/30 px-3 py-2">
      <span className="text-2xs text-muted-foreground">{label}</span>
      <span className="font-display text-base font-semibold tabular-nums">{value}</span>
    </div>
  );
}

/** An account in the monitor: its name, how full its fuller limit is, and when that renews. */
function AccountRow({ account }: { account: ProxyAccountStatus }) {
  const { t } = useI18n();
  const percent = account.quotaPercent;
  return (
    <li
      data-active={account.active || undefined}
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_minmax(6rem,9rem)_5.5rem] items-center gap-3 border-t py-2 first:border-t-0",
        account.active && "-mx-2 rounded-md bg-primary/5 px-2",
      )}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm">{account.name}</span>
          {account.active && (
            <Badge variant="outline" className="text-ok">
              <StatusDot tone="ok" />
              {t("Aktif", "Active")}
            </Badge>
          )}
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
          className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
        >
          <div
            className={cn("h-full rounded-full", meterFill(percent))}
            style={{ width: `${Math.min(100, percent ?? 0)}%` }}
          />
        </div>
        <span className="w-9 text-right text-xs tabular-nums">{percent === undefined ? "—" : `%${percent}`}</span>
      </div>
      <span className="text-right text-xs text-muted-foreground tabular-nums">
        {resetLabel(account.resetInMinutes, t)}
      </span>
    </li>
  );
}

/** What the gateway is doing: how it routes, its counters, and every account's room left. */
function MonitorCard({ status }: { status?: ProxyStatus }) {
  const { t, language } = useI18n();
  const number = (n: number) => n.toLocaleString(language === "tr" ? "tr-TR" : "en-US");
  const stats = status?.stats;
  const accounts = status?.accounts ?? [];
  return (
    <Card className={cardClass}>
      <SectionHeading
        title={t("Canlı yönlendirme monitörü", "Live routing monitor")}
        description={t(
          "Her istek, limiti en yakın zamanda sıfırlanan hesaba gider; aynı oturum, istem önbelleği korunsun diye aynı hesapta kalır.",
          "Each request goes to the account whose limit resets soonest. A session stays on its account so the prompt cache is kept.",
        )}
        aside={<Badge variant="secondary">Soonest-Reset-First</Badge>}
      />
      <div className="grid gap-3 pt-2">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label={t("Toplam istek", "Total requests")} value={number(stats?.totalRequests ?? 0)} />
          <Stat label={t("Açık bağlantı", "Active connections")} value={number(stats?.activeRequests ?? 0)} />
          <Stat label={t("Önbellek isabeti", "Prompt cache hits")} value={number(stats?.promptCacheHits ?? 0)} />
          <Stat
            label={t("İsabet oranı", "Hit rate")}
            value={`%${(stats?.cacheHitRate ?? 0).toLocaleString(language === "tr" ? "tr-TR" : "en-US", { maximumFractionDigits: 1 })}`}
          />
        </div>
        {accounts.length ? (
          <ul aria-label={t("Bağlı hesaplar", "Connected accounts")}>
            {accounts.map((account) => (
              <AccountRow key={account.id} account={account} />
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

/**
 * Settings → Proxy & Gateway: turn the local gateway on, see how tools connect to it, watch how it
 * spends the accounts, and decide whether it may cross to another provider.
 */
export function ProxyTab() {
  const { t } = useI18n();
  const { api, busy, desktop, action } = useRelay();
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
  const configure = async (patch: Parameters<typeof api.proxyConfigure>[0]) => {
    let saved = false;
    await action("proxy-configure", async () => {
      setStatus(await api.proxyConfigure(patch));
      saved = true;
    });
    return saved;
  };
  return (
    <div className="grid max-w-3xl gap-4">
      <StatusCard
        status={status}
        disabled={disabled}
        onToggle={(enabled) => void action("proxy-toggle", async () => setStatus(await api.proxyToggle(enabled)))}
      />
      <ConnectionCard
        status={status}
        disabled={disabled}
        copied={copied}
        onCopy={copy}
        onConfigure={configure}
        onRegenerate={() => void action("proxy-key", async () => setStatus(await api.proxyRegenerateKey()))}
      />
      <GuideCard status={status} copied={copied} onCopy={copy} />
      <MonitorCard status={status} />
      <Card className={cardClass}>
        <SettingRow
          label={t("Sağlayıcılar arası yedekleme", "Cross-provider fallback")}
          htmlFor="proxy-cross-provider"
          description={t(
            "Claude hesaplarının hepsi doluysa isteği Codex / Gemini hesabına çevirip gönderir. Kapalıyken istek, kendi sağlayıcısının hesabı boşalana kadar bekler. Değişince çalışan proxy yeniden başlar.",
            "When every Claude account is used up, the request is translated and sent to a Codex / Gemini account. Off, it waits for an account of its own provider. A running gateway restarts when this changes.",
          )}
        >
          <Switch
            id="proxy-cross-provider"
            checked={status?.allowCrossProviderFallback === true}
            disabled={disabled || !status}
            onCheckedChange={(allowCrossProviderFallback) =>
              void configure({ allowCrossProviderFallback })
            }
          />
        </SettingRow>
      </Card>
    </div>
  );
}
