import { useEffect, useState, type ReactNode } from "react";
import { Private } from "@/components/Private";
import {
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Check,
  Copy,
  Eye,
  EyeOff,
  Link2,
  Plus,
  RefreshCw,
  Unlink,
} from "lucide-react";
import { PageFrame } from "@/app/PageFrame";
import { addAccountHash, intentHash } from "@/app/routes";
import { Disclosure } from "@/components/Disclosure";
import { ProviderBadge } from "@/components/ProviderBadge";
import { Note, OptionSelect, SectionHeading, SettingRow } from "@/components/SettingRow";
import { StatusDot } from "@/components/StatusDot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useI18n, type T } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { meterFill } from "@/lib/meter";
import {
  agoLabel,
  antigravitySnippet,
  classShareLine,
  compactCount,
  requestDetail,
  sessionCacheLine,
  usd,
  gatewayUrl,
  isLoopbackHost,
  maskKey,
  moveInOrder,
  openAiSnippet,
  parsePort,
  proxyCurlSnippet,
  quotaAtRisk,
  resetLabel,
  validHost,
} from "@/lib/proxy-ui";
import { cn } from "@/lib/utils";
import type {
  ProxyAccountStatus,
  ProxyClientId,
  ProxyClientStatus,
  ProxyRequestLog,
  ProxyStatus,
} from "../../shared/types";
import { DEFAULT_PROXY_CONFIG } from "../../shared/proxy-types";

type Strategy = NonNullable<ProxyStatus["routingStrategy"]>;
type Patch = Parameters<ReturnType<typeof useRelay>["api"]["proxyConfigure"]>[0];
export type ProxyTab = "canli" | "araclar" | "kurallar";

const cardClass = "gap-0 px-4 py-3.5";
/** How often the live counters and quotas are read while the page is open. */
const POLL_MS = 3_000;
const COPIED_MS = 1_500;
const AFFINITY_SECONDS = [300, 900, 3_600] as const;
const TAB_KEY = "relay.proxy.tab";

const CLIENT_NAMES: Record<ProxyClientId, string> = { "claude-code": "Claude Code", codex: "Codex CLI" };
/** The provider whose accounts answer a client's requests. */
const CLIENT_PROVIDER: Record<ProxyClientId, "claude" | "codex"> = { "claude-code": "claude", codex: "codex" };
const PROVIDER_NAMES: Record<"claude" | "codex", string> = { claude: "Claude", codex: "Codex" };

/**
 * How many accounts could answer this client now: in the pool, signed in, of its provider.
 * A client bound with none would only get "no account" errors.
 */
export const usableFor = (accounts: readonly ProxyAccountStatus[], id: ProxyClientId) =>
  accounts.filter((a) => a.inPool && a.signedIn && (a.provider ?? "claude") === CLIENT_PROVIDER[id]).length;

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

/** The tab last open, remembered per viewer where storage allows. */
function useTab(): [ProxyTab, (tab: ProxyTab) => void] {
  const [tab, setTab] = useState<ProxyTab>(() => {
    try {
      const saved = window.localStorage.getItem(TAB_KEY);
      if (saved === "canli" || saved === "araclar" || saved === "kurallar") return saved;
    } catch {
      // No storage (a static render): the live tab.
    }
    return "canli";
  });
  const choose = (next: ProxyTab) => {
    setTab(next);
    try {
      window.localStorage.setItem(TAB_KEY, next);
    } catch {
      // The choice lasts until the window closes.
    }
  };
  return [tab, choose];
}

/** Copy a value with a short "Copied" acknowledgement; main writes the clipboard. */
function useCopy() {
  const { api, setNotice } = useRelay();
  const { t } = useI18n();
  const [copied, setCopied] = useState<string>();
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(undefined), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = (id: string, text: string) =>
    void api.copyText(text).then(
      () => setCopied(id),
      // Said, never swallowed: a Copy that does nothing looks like a broken button.
      () => setNotice(t("Panoya kopyalanamadı.", "Could not copy to the clipboard.")),
    );
  return { copied, copy };
}

type Copy = ReturnType<typeof useCopy>;

/** An address or key as a compact chip; the button copies the real value. */
function CopyChip({
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
        {copy.copied === id ? <Check className="text-ok" /> : <Copy />}
      </Button>
    </span>
  );
}

/** Who answered the latest request, in a few words. */
function lastRequestLine(status: ProxyStatus, now: number, t: T): string | undefined {
  const last = status.recent?.find((r) => r.accountId);
  if (!last) return undefined;
  const name = status.accounts.find((a) => a.id === last.accountId)?.name;
  return t(
    `son istek ${agoLabel(last.at, now, t)}${name ? ` · ${name}` : ""}`,
    `last request ${agoLabel(last.at, now, t)}${name ? ` · ${name}` : ""}`,
  );
}

/** Accounts the gateway can send a request to now: in the pool, signed in, not full. */
const readyCount = (accounts: readonly ProxyAccountStatus[]) =>
  accounts.filter((a) => a.inPool && a.signedIn && (a.quotaPercent ?? 0) < 100).length;

/**
 * The page's head: the master switch with what the gateway is doing in one line, the address and
 * key to copy, and the key's regeneration behind a confirmation.
 */
function GatewayHeader({
  status,
  disabled,
  copy,
  onToggle,
  onRegenerate,
}: {
  status?: ProxyStatus;
  disabled: boolean;
  copy: Copy;
  onToggle: (enabled: boolean) => void;
  onRegenerate: () => void;
}) {
  const { t } = useI18n();
  const [reveal, setReveal] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const running = status?.running === true;
  const key = status?.clientApiKey;
  const endpoint = gatewayUrl(status?.host ?? "127.0.0.1", status?.port ?? 8317);
  const ready = readyCount(status?.accounts ?? []);
  const last = status && running ? lastRequestLine(status, Date.now(), t) : undefined;
  const bound = (status?.clients ?? []).filter((c) => c.bound).map((c) => CLIENT_NAMES[c.id]);
  return (
    <Card className={cn(cardClass, "gap-3")} data-slot="gateway-card">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <Switch
          id="proxy-enabled"
          aria-label={t("Ağ geçidini aç veya kapat", "Turn the gateway on or off")}
          checked={running}
          disabled={disabled || !status}
          onCheckedChange={onToggle}
        />
        <div className="grid min-w-[12rem] flex-1 gap-0.5">
          <span
            role="status"
            data-slot="proxy-status"
            className="flex items-center gap-2 font-display text-base font-semibold"
          >
            <StatusDot tone={running ? "ok" : "off"} hollow={!running} />
            {!status
              ? t("Okunuyor…", "Loading…")
              : running
                ? t("Ağ geçidi çalışıyor", "Gateway running")
                : t("Ağ geçidi kapalı", "Gateway off")}
          </span>
          <span className="text-xs text-muted-foreground">
            {[
              t(`${ready} hesap hazır`, `${ready} accounts ready`),
              last,
              bound.length ? t(`${bound.join(", ")} bağlı`, `${bound.join(", ")} connected`) : undefined,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <CopyChip id="endpoint" label={t("Adres", "Address")} shown={endpoint} value={endpoint} copy={copy} />
          <CopyChip
            id="key"
            label={t("Anahtar", "Key")}
            shown={key ? (reveal ? key : maskKey(key)) : t("açılınca oluşur", "made on first start")}
            value={key}
            copy={copy}
          >
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={!key}
              aria-label={reveal ? t("Anahtarı gizle", "Hide key") : t("Anahtarı göster", "Show key")}
              aria-pressed={reveal}
              onClick={() => setReveal((r) => !r)}
            >
              {reveal ? <EyeOff /> : <Eye />}
            </Button>
          </CopyChip>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={disabled || !key}
            aria-label={t("Anahtarı yenile", "Regenerate key")}
            onClick={() => setConfirming(true)}
          >
            <RefreshCw />
          </Button>
        </div>
      </div>
      {status?.error && !running && (
        <p role="alert" className="border-t pt-2 text-xs text-crit">
          {status.error}
        </p>
      )}
      {confirming && (
        <div className="flex flex-wrap items-center gap-2 border-t pt-2.5">
          <Note className="text-foreground">
            {bound.length
              ? t(
                  `Eski anahtar hemen çalışmaz olur. ${bound.join(" ve ")} yeni anahtarı kendiliğinden alır; diğer araçlara elle girmen gerekir.`,
                  `The old key stops working at once. ${bound.join(" and ")} get the new one by themselves; other tools need it entered by hand.`,
                )
              : t(
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
    </Card>
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

/** A limit window as a thin bar with its percent and reset; a dash while unknown. */
function WindowMeter({
  label,
  percent,
  minutes,
  fullAt,
}: {
  label: string;
  percent?: number;
  minutes?: number;
  /** When the window fills at the recent pace, if before it resets. */
  fullAt?: number;
}) {
  const { t, language } = useI18n();
  const clock = fullAt
    ? new Date(fullAt).toLocaleTimeString(language === "tr" ? "tr-TR" : "en-US", { hour: "2-digit", minute: "2-digit" })
    : undefined;
  return (
    <div className="grid min-w-0 gap-1">
      <div className="flex items-baseline justify-between gap-2 text-2xs text-muted-foreground">
        <span>{label}</span>
        <span className="tabular-nums">
          {percent === undefined ? "—" : t(`%${percent}`, `${percent}%`)}
          {minutes !== undefined && ` · ${resetLabel(minutes, t)}`}
          {clock && (
            <span
              data-slot="full-at"
              className="text-warn-foreground"
              title={t(
                "Son yarım saatin hızıyla bu dönem sıfırlanmadan dolar.",
                "At the last half hour's pace this window fills before it resets.",
              )}
            >
              {t(` · ${clock} gibi dolar`, ` · full by ${clock}`)}
            </span>
          )}
        </span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? 0}
        className="h-1.5 w-full overflow-hidden rounded-full bg-track"
      >
        {percent !== undefined && (
          <div className={cn("h-full rounded-full", meterFill(percent))} style={{ width: `${percent}%` }} />
        )}
      </div>
    </div>
  );
}

/** The wall-clock time a wait of `minutes` ends at. */
function untilClock(minutes: number, language: string): string {
  return new Date(Date.now() + minutes * 60_000).toLocaleTimeString(language === "tr" ? "tr-TR" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Why the gateway is leaving an account out, for the badge's tooltip. */
function waitingTitle(reason: "limit" | "auth" | "transient", t: (tr: string, en: string) => string): string {
  if (reason === "auth")
    return t(
      "Giriş reddedildi ya da okunamadı; Relay yeniliyor. Bu hesaptaki oturumlar giriş dönünce aynı hesaba döner.",
      "Its sign-in was refused or could not be read; Relay is renewing it. Sessions on this account come back to it once it works.",
    );
  if (reason === "transient")
    return t(
      "Anthropic yoğun ya da araya bir engel girdi; birkaç saniye beklenir. Oturumlar hesabında kalır.",
      "Anthropic is busy or something in front of it refused; a few seconds' wait. Sessions stay on the account.",
    );
  return t(
    "Bir limit dönemi doldu; sıfırlanınca yeniden kullanılır. Oturumları başka hesaba geçti.",
    "A limit window is spent; it is used again when it resets. Its sessions moved to another account.",
  );
}

/** What an account's state needs said: last served, out of the pool, no sign-in, full, about to lose quota. */
function AccountState({ account }: { account: ProxyAccountStatus }) {
  const { t, language } = useI18n();
  const risk = quotaAtRisk(account);
  if (!account.inPool) return <Badge variant="secondary">{t("Havuz dışı", "Out of pool")}</Badge>;
  if (!account.signedIn) return <Badge variant="destructive">{t("Giriş yok", "Not signed in")}</Badge>;
  if (account.extraUsage?.kind === "billed")
    return <Badge variant="destructive">{t("Ekstra kullanım", "Extra usage")}</Badge>;
  if (account.waiting) {
    const when = resetLabel(account.waiting.minutes, t);
    const label =
      account.waiting.reason === "auth"
        ? t(`Giriş yenileniyor · ${when}`, `Renewing sign-in · ${when}`)
        : account.waiting.reason === "transient"
          ? t(`Kısa ara · ${when}`, `Short pause · ${when}`)
          : t(`Limitte · ${when}`, `At its limit · ${when}`);
    return (
      <Badge
        variant="secondary"
        data-slot="waiting"
        title={`${waitingTitle(account.waiting.reason, t)} ${t(
          `Bitiş: ${untilClock(account.waiting.minutes, language)}.`,
          `Until ${untilClock(account.waiting.minutes, language)}.`,
        )}`}
      >
        {label}
      </Badge>
    );
  }
  if ((account.quotaPercent ?? 0) >= 100) return <Badge variant="secondary">{t("Dolu", "Full")}</Badge>;
  if (risk)
    return (
      <Badge
        variant="outline"
        className="border-warn/50 text-warn-foreground"
        data-slot="at-risk"
        title={t(
          `Haftalık limit ${resetLabel(risk.minutes, t)} içinde sıfırlanıyor; kalan %${risk.percent} o zamana kadar kullanılmazsa boşa gider.`,
          `The weekly limit resets in ${resetLabel(risk.minutes, t)}; the ${risk.percent}% left is lost unless it is used by then.`,
        )}
      >
        {t(`%${risk.percent} yanacak`, `${risk.percent}% expiring`)}
      </Badge>
    );
  if (account.active)
    return (
      <Badge variant="outline" className="text-ok-foreground">
        <StatusDot tone="ok" />
        {t("Son istek", "Last request")}
      </Badge>
    );
  return null;
}

/**
 * The pool: every account in the order the gateway uses them, with both limit windows, what it
 * served, and a switch that takes it out of the pool without removing it from Relay.
 */
function PoolCard({
  status,
  disabled,
  onConfigure,
}: {
  status: ProxyStatus;
  disabled: boolean;
  onConfigure: (patch: Patch) => Promise<boolean>;
}) {
  const { t, language } = useI18n();
  const locale = language === "tr" ? "tr-TR" : "en-US";
  const accounts = status.accounts;
  const order = accounts.map((a) => a.id);
  const excluded = accounts.filter((a) => !a.inPool).map((a) => a.id);
  const strict = status.routingStrategy === "strict-priority";
  const move = (id: string, by: -1 | 1) => void onConfigure({ accountOrder: moveInOrder(order, id, by) });
  const setInPool = (id: string, on: boolean) =>
    void onConfigure({
      excludedAccountIds: on ? excluded.filter((x) => x !== id) : [...excluded, id],
    });
  return (
    <Card className={cardClass} data-slot="pool">
      <SectionHeading
        title={t("Havuz", "Pool")}
        description={
          strict
            ? t(
                "Hesaplar bu sırayla kullanılır; biri dolunca sıradaki başlar. Okla sırala, anahtarla havuzdan çıkar.",
                "Accounts are used in this order; the next starts when one is full. Reorder with the arrows; the switch takes one out.",
              )
            : t(
                "Her istek kendi sağlayıcısının hesaplarından birine gider. Anahtar hesabı silmeden havuzdan çıkarır.",
                "Each request goes to an account of its own provider. The switch takes an account out without removing it.",
              )
        }
      />
      {accounts.length ? (
        <ul aria-label={t("Havuzdaki hesaplar", "Accounts in the pool")} className="grid pt-1">
          {accounts.map((account, index) => {
            const provider = account.provider ?? "claude";
            const quiet = !account.inPool;
            const cache = account.tokens ? account.tokens.cacheRead : undefined;
            return (
              <li
                key={account.id}
                data-account={account.id}
                data-in-pool={String(account.inPool)}
                data-active={account.active || undefined}
                className={cn(
                  "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 border-t py-2.5 first:border-t-0",
                  quiet && "opacity-60",
                )}
              >
                <span className="row-span-2 flex flex-col self-start">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    disabled={disabled || index === 0}
                    aria-label={t(`${account.name} yukarı`, `Move ${account.name} up`)}
                    onClick={() => move(account.id, -1)}
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    disabled={disabled || index === accounts.length - 1}
                    aria-label={t(`${account.name} aşağı`, `Move ${account.name} down`)}
                    onClick={() => move(account.id, 1)}
                  >
                    <ArrowDown />
                  </Button>
                </span>
                <div className="grid min-w-0 gap-0.5">
                  <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <ProviderBadge provider={provider} />
                    <span className="min-w-0 truncate text-sm font-medium">{account.name}</span>
                    <AccountState account={account} />
                  </span>
                  <span
                    className="truncate text-2xs text-muted-foreground tabular-nums"
                    title={
                      [
                        account.live
                          ? t(
                              "Yüzdeler bu hesabın son yanıtındaki limit başlıklarından okundu.",
                              "The percents are from the limit headers of this account's last answer.",
                            )
                          : undefined,
                        account.percentCost
                          ? t(
                              `5 saatlik limitin %1'i son 7 günde ${account.percentCost.windows} dönemde ortalama ${usd(account.percentCost.dollars, locale)} tuttu (Claude Code kullanımı, API fiyatıyla). claude.ai sohbetleri bu hesapta yoksa oran daha güvenilirdir.`,
                              `1% of the 5-hour limit took ${usd(account.percentCost.dollars, locale)} on average over ${account.percentCost.windows} windows in the last 7 days (Claude Code use, at API prices). It is more reliable when the account is not also used for claude.ai chats.`,
                            )
                          : undefined,
                      ]
                        .filter(Boolean)
                        .join(" ") || undefined
                    }
                  >
                    {account.email && <Private>{account.email}</Private>}
                    {account.email && (account.requests || cache || account.live || account.percentCost) ? " · " : ""}
                    {[
                      account.requests
                        ? t(`${account.requests} istek`, `${account.requests} requests`)
                        : undefined,
                      cache
                        ? t(`önbellek ${compactCount(cache, locale)}`, `cache ${compactCount(cache, locale)}`)
                        : undefined,
                      account.live ? t("canlı", "live") : undefined,
                      account.percentCost
                        ? t(`%1 ≈ ${usd(account.percentCost.dollars, locale)}`, `1% ≈ ${usd(account.percentCost.dollars, locale)}`)
                        : undefined,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </div>
                <Switch
                  className="self-start"
                  checked={account.inPool}
                  disabled={disabled}
                  aria-label={t(`${account.name} havuzda`, `${account.name} in the pool`)}
                  onCheckedChange={(on) => setInPool(account.id, on)}
                />
                <div className="col-span-2 col-start-2 grid grid-cols-2 gap-4">
                  {account.fiveHourPercent === undefined && account.weeklyPercent === undefined ? (
                    <span className="col-span-2 text-2xs text-muted-foreground">
                      {provider === "claude"
                        ? t("Limitler henüz okunmadı", "Limits not read yet")
                        : t("Relay bu sağlayıcının limitini okuyamıyor", "Relay cannot read this provider's limits")}
                    </span>
                  ) : (
                    <>
                      <WindowMeter
                        label={t("5 saat", "5 hours")}
                        percent={account.fiveHourPercent}
                        minutes={account.fiveHourResetMinutes}
                        fullAt={account.fullAt}
                      />
                      <WindowMeter
                        label={t("Hafta", "Week")}
                        percent={account.weeklyPercent}
                        minutes={account.weeklyResetMinutes}
                      />
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="grid justify-items-start gap-2 pt-2">
          <p className="text-sm text-muted-foreground">
            {t(
              "Havuz boş. Bir hesap ekle; ağ geçidi istekleri onunla karşılar.",
              "The pool is empty. Add an account and the gateway answers with it.",
            )}
          </p>
          <Button asChild size="sm">
            <a href={intentHash("hesaplar", "ekle")}>
              <Plus />
              {t("Hesap ekle", "Add account")}
            </a>
          </Button>
        </div>
      )}
    </Card>
  );
}

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

/** The sessions heard from lately: whose account holds their cache, and whether it is still warm. */
function SessionsCard({ status }: { status: ProxyStatus }) {
  const { t, language } = useI18n();
  const locale = language === "tr" ? "tr-TR" : "en-US";
  const now = Date.now();
  const name = (id: string) => status.accounts.find((a) => a.id === id)?.name ?? "—";
  return (
    <Card className={cardClass} data-slot="sessions">
      <SectionHeading
        title={t("Oturumlar", "Sessions")}
        description={t(
          "Oturumun önbelleği hesabındadır. Sıcakken dönmek ucuzdur; soğuyunca ya da hesap değişince bütün istem yeniden yazılır.",
          "A session's cache lives on its account. Coming back while it is warm is cheap; once cold, or on another account, the whole prompt is written again.",
        )}
      />
      <ol aria-label={t("Oturumlar", "Sessions")} className="grid pt-1">
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
  );
}

/** The latest requests: which account answered, what the upstream said, and failovers. */
function RequestFeed({ status }: { status: ProxyStatus }) {
  const { t, language } = useI18n();
  const locale = language === "tr" ? "tr-TR" : "en-US";
  const recent = status.recent ?? [];
  const name = (id?: string) => status.accounts.find((a) => a.id === id)?.name;
  const ratio = status.stats.cacheHitRate.toLocaleString(locale, { maximumFractionDigits: 1 });
  const now = Date.now();
  return (
    <Card className={cardClass} data-slot="request-feed">
      <SectionHeading
        title={t("Son istekler", "Recent requests")}
        description={t(
          "Limit dolarsa aynı istek sıradaki hesapla denenir; aynı oturum, önbellek korunsun diye hesabında kalır.",
          "When a limit is hit, the same request goes to the next account; a session stays on its account to keep the cache.",
        )}
      />
      <dl className="grid grid-cols-3 gap-2 py-2">
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
                title={entry.error ? t(`Yanıt: ${entry.error}`, `Answer: ${entry.error}`) : undefined}
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
  );
}

/** A copyable block for the tools Relay cannot set up itself. */
function CodeBlock({
  id,
  title,
  shown,
  copyText,
  copy,
}: {
  id: string;
  title: string;
  shown: string;
  copyText: string;
  copy: Copy;
}) {
  const { t } = useI18n();
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold">{title}</h4>
        <Button variant="ghost" size="sm" aria-label={t(`${title} kopyala`, `Copy ${title}`)} onClick={() => copy.copy(id, copyText)}>
          {copy.copied === id ? <Check className="text-ok" /> : <Copy />}
          {copy.copied === id ? t("Kopyalandı", "Copied") : t("Kopyala", "Copy")}
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

/** A client's state in a word. */
function clientWord(client: ProxyClientStatus, t: T): { tone: "ok" | "warn" | "off"; text: string } {
  if (client.blocked) return { tone: "warn", text: t("Ayar dosyası okunamadı", "Cannot read its settings") };
  if (client.bound) return { tone: "ok", text: t("Bağlı", "Connected") };
  if (client.stale) return { tone: "warn", text: t("Eski adres ya da anahtar", "Old address or key") };
  if (!client.installed) return { tone: "off", text: t("Bu Mac’te bulunamadı", "Not found on this Mac") };
  return { tone: "off", text: t("Bağlı değil", "Not connected") };
}

/**
 * The Tools tab: Claude Code and Codex are pointed at the gateway with one button (Relay writes
 * their settings and restores them on disconnect); other tools get copyable settings.
 */
function ToolsTab({
  status,
  disabled,
  copy,
  onBind,
  onUnbind,
}: {
  status: ProxyStatus;
  disabled: boolean;
  copy: Copy;
  onBind: (id: ProxyClientId) => void;
  onUnbind: (id: ProxyClientId) => void;
}) {
  const { t } = useI18n();
  const host = status.host;
  const port = status.port;
  const key = status.clientApiKey;
  const hints: Record<ProxyClientId, string> = {
    "claude-code": t(
      "Bağlıyken hangi hesabın kullanılacağını ağ geçidi seçer; terminalde hesap değiştirmen gerekmez. Bağlıyken terminaldeki Claude Code, claude.ai bağlayıcılarını (Gmail, Drive gibi) yüklemez; Claude uygulaması etkilenmez. Relay kapanınca ayar dosyası eski haline döner, açılınca yeniden bağlanır.",
      "While connected, the gateway picks the account; no need to switch accounts in the terminal. While connected, Claude Code in the terminal does not load your claude.ai connectors (Gmail, Drive and the like); the Claude app is not affected. When Relay quits the settings file goes back as it was, and it is connected again when Relay starts.",
    ),
    codex: t(
      "Codex’in config.toml dosyasına Relay sağlayıcısı eklenir; varsa önceki sağlayıcı satırı yorum olarak saklanır.",
      "Relay adds its provider to Codex's config.toml; a provider line already there is kept as a comment.",
    ),
  };
  return (
    <div className="grid gap-4">
      <Card className={cardClass} data-slot="clients">
        <SectionHeading
          title={t("Araçları bağla", "Connect tools")}
          description={t(
            "Relay aracın kendi ayar dosyasına adresi ve anahtarı yazar. Ayır dediğinde dosyadaki eski değerleri geri koyar.",
            "Relay writes the address and key into the tool's own settings file. Disconnect puts the old values back.",
          )}
        />
        <ul className="grid pt-1">
          {(status.clients ?? []).map((client) => {
            const usable = usableFor(status.accounts, client.id);
            const provider = PROVIDER_NAMES[CLIENT_PROVIDER[client.id]];
            const word: ReturnType<typeof clientWord> =
              usable === 0 && !client.blocked
                ? client.bound
                  ? { tone: "warn", text: t(`Bağlı · kullanılabilir ${provider} hesabı yok`, `Connected · no usable ${provider} account`) }
                  : { tone: "off", text: t(`Havuzda ${provider} hesabı yok`, `No ${provider} account in the pool`) }
                : clientWord(client, t);
            return (
              <li
                key={client.id}
                data-client={client.id}
                data-bound={String(client.bound)}
                className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t py-3 first:border-t-0"
              >
                <div className="grid min-w-[14rem] flex-1 gap-0.5">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    {CLIENT_NAMES[client.id]}
                    {client.id === "claude-code" && (
                      <Badge variant="outline" className="text-ok-foreground">
                        {t("Önerilen", "Recommended")}
                      </Badge>
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground">{hints[client.id]}</span>
                  <span className="font-mono text-2xs text-muted-foreground">{client.file}</span>
                </div>
                <span className="flex items-center gap-1.5 text-xs">
                  <StatusDot tone={word.tone} hollow={word.tone === "off"} />
                  {word.text}
                </span>
                {!client.bound && usable === 0 ? (
                  // Bound with no account, every request would fail: the account comes first.
                  <Button asChild size="sm" variant="outline">
                    <a href={addAccountHash(CLIENT_PROVIDER[client.id])} data-slot="add-first">
                      <Plus />
                      {t(`Önce ${provider} hesabı ekle`, `Add a ${provider} account first`)}
                    </a>
                  </Button>
                ) : client.bound ? (
                  <Button variant="outline" size="sm" disabled={disabled} onClick={() => onUnbind(client.id)}>
                    <Unlink />
                    {t("Ayır", "Disconnect")}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant={client.stale ? "default" : "outline"}
                    disabled={disabled || !!client.blocked}
                    onClick={() => onBind(client.id)}
                  >
                    <Link2 />
                    {client.stale ? t("Yeniden bağla", "Reconnect") : t("Bağla", "Connect")}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </Card>
      <Card className={cardClass}>
        <Disclosure
          title={t("Diğer araçlar (elle kurulum)", "Other tools (manual setup)")}
          summary={t("Cursor, OpenAI SDK, Antigravity, cURL", "Cursor, OpenAI SDK, Antigravity, cURL")}
        >
          <div className="grid gap-4 pt-2">
            <Note className="text-warn">
              {t(
                "Claude aboneliğini Claude Code dışındaki araçlarda kullanmak hesabını riske atabilir. Abonelik hesaplarını Claude Code ve Codex ile kullan.",
                "Using a Claude subscription in tools other than Claude Code can put the account at risk. Use subscription accounts with Claude Code and Codex.",
              )}
            </Note>
            <CodeBlock
              id="openai"
              title={t("OpenAI uyumlu araçlar (Cursor, SDK)", "OpenAI-compatible tools (Cursor, SDK)")}
              shown={openAiSnippet(host, port, key, true)}
              copyText={openAiSnippet(host, port, key)}
              copy={copy}
            />
            <CodeBlock
              id="antigravity"
              title={t("Antigravity modelleri · cURL", "Antigravity models · cURL")}
              shown={antigravitySnippet(host, port, key, true)}
              copyText={antigravitySnippet(host, port, key)}
              copy={copy}
            />
            <CodeBlock
              id="curl"
              title={t("Bağlantı testi · cURL", "Connection test · cURL")}
              shown={proxyCurlSnippet(host, port, key, true)}
              copyText={proxyCurlSnippet(host, port, key)}
              copy={copy}
            />
          </div>
        </Disclosure>
      </Card>
    </div>
  );
}

/** The Rules tab: how an account is picked, how long a session keeps it, and who may connect. */
function RulesTab({
  status,
  disabled,
  onConfigure,
}: {
  status: ProxyStatus;
  disabled: boolean;
  onConfigure: (patch: Patch) => Promise<boolean>;
}) {
  const { t, language } = useI18n();
  const locale = language === "tr" ? "tr-TR" : "en-US";
  const [draft, setDraft] = useState<{ port: string; host: string }>();
  const strategy: Strategy = status.routingStrategy ?? "soonest-reset";
  const port = draft?.port ?? String(status.port);
  const host = draft?.host ?? status.host;
  const parsedPort = parsePort(port);
  const changed = parsedPort !== status.port || host.trim() !== status.host;
  const valid = parsedPort !== undefined && validHost(host);
  const ratio = status.stats.cacheHitRate.toLocaleString(locale, { maximumFractionDigits: 1 });
  const strategies: { value: Strategy; label: string; hint: string }[] = [
    {
      value: "soonest-reset",
      label: t("Önce yanacak olan (önerilen)", "Expiring first (recommended)"),
      hint: t(
        "Limiti en yakında sıfırlanan hesap önce kullanılır. Claude sıfırlamada kalanı silindiği için boşa giden kota en aza iner.",
        "The account whose limit resets soonest goes first. What is left at a reset is gone, so the least quota is wasted.",
      ),
    },
    {
      value: "balanced",
      label: t("Dengeli", "Balanced"),
      hint: t("İstekler en çok boş kapasitesi olan hesaba gider.", "Requests go to the account with the most room left."),
    },
    {
      value: "strict-priority",
      label: t("Sıralı", "In order"),
      hint: t(
        "Hesaplar Canlı sekmesindeki sırayla kullanılır; biri dolunca sıradaki başlar.",
        "Accounts are used in the order on the Live tab; the next starts when one is full.",
      ),
    },
  ];
  const presets = [
    { host: "127.0.0.1", label: t("Yalnızca bu Mac", "This Mac only") },
    ...(status.tailscaleAddress
      ? [{ host: status.tailscaleAddress, label: t("Tailscale ağım", "My tailnet") }]
      : []),
    { host: "0.0.0.0", label: t("Tüm yerel ağ", "Whole local network") },
  ];
  const current = host.trim();
  return (
    <div className="grid gap-4">
      <Card className={cardClass} data-slot="routing-config">
        <SectionHeading
          title={t("Hesap seçimi", "Choosing an account")}
          description={t("Yeni bir oturumun hangi hesapla başlayacağı.", "Which account a new session starts on.")}
        />
        <div role="radiogroup" aria-label={t("Yönlendirme stratejisi", "Routing strategy")} className="grid gap-2 pt-2 sm:grid-cols-3">
          {strategies.map((s) => (
            <button
              key={s.value}
              type="button"
              role="radio"
              aria-checked={strategy === s.value}
              disabled={disabled}
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
        <div className="pt-3">
          <SettingRow
            label={t("Oturum aynı hesapta kalsın", "Keep a session on its account")}
            htmlFor="proxy-affinity"
            description={t(
              `Önbellek hesaba özeldir; hesap değişirse baştan yazılır. Ağ geçidine bağlı Claude Code önbelleği kendiliğinden 5 dakika tutar; Relay bağlarken 1 saate çıkarır (elle bağladıysan CLAUDE_CODE_PROMPT_CACHE_TTL=1h ekle). Daha kısa süre, ara verilen oturumu başka hesaba kaydırabilir. Şu anki önbellek isabeti %${ratio}.`,
              `The prompt cache belongs to the account; a switch rebuilds it. Behind a gateway Claude Code keeps its cache for 5 minutes by itself; Relay raises it to 1 hour when it connects Claude Code (connected by hand? add CLAUDE_CODE_PROMPT_CACHE_TTL=1h). A shorter time can move a paused session to another account. Cache hits now: ${ratio}%.`,
            )}
          >
            <OptionSelect
              id="proxy-affinity"
              value={String(status.affinityTtlSeconds ?? DEFAULT_PROXY_CONFIG.affinityTtlSeconds)}
              disabled={disabled}
              options={AFFINITY_SECONDS.map((s) => ({
                value: String(s),
                label: s < 3_600 ? t(`${s / 60} dakika`, `${s / 60} minutes`) : t("1 saat", "1 hour"),
              }))}
              onChange={(value) => void onConfigure({ affinityTtlSeconds: Number(value) })}
            />
          </SettingRow>
          <SettingRow
            label={t("Alt ajanları başka hesaba gönder", "Send subagents to another account")}
            htmlFor="proxy-subagent-overflow"
            description={t(
              "Yeni bir alt ajan kendi önbelleğini sıfırdan yazar; başka hesaba gitmesi önbellek kaybettirmez, oturumun hesabını rahatlatır. Açıkken bir oturumun alt ajanları oturumun hesabı dışındaki tek bir hesaba gider ve orada kalır. Ana konuşmayı paylaşan fork alt ajanlar oturumla kalır.",
              "A fresh subagent writes its own cache from scratch, so another account costs it no cache and spares the session's account. When on, a session's subagents go to one account other than the session's and stay there. Forks, which share the conversation, stay with the session.",
            )}
          >
            <Switch
              id="proxy-subagent-overflow"
              checked={status.subagentOverflow === true}
              disabled={disabled}
              onCheckedChange={(on) => void onConfigure({ subagentOverflow: on })}
            />
          </SettingRow>
          <p className="pt-2 text-2xs text-muted-foreground">
            {t(
              "5 saatlik limitinin %90'ını ya da haftalığın %98'ini geçmiş hesap, başka hesapta yer varken yeni oturum almaz; süren oturumlar önbellekleri için hesaplarında kalır.",
              "An account past 90% of its 5-hour limit or 98% of its week takes no new session while another has room; running sessions stay on their accounts for their caches.",
            )}
          </p>
        </div>
      </Card>
      <Card className={cardClass} data-slot="network">
        <SectionHeading
          title={t("Kim bağlanabilir", "Who can connect")}
          description={t(
            "Başka bir bilgisayardan kullanacaksan Tailscale gibi kapalı bir ağ seç.",
            "To use it from another computer, choose a private network such as Tailscale.",
          )}
        />
        <div role="radiogroup" aria-label={t("Dinlenen adres", "Listen address")} className="flex flex-wrap gap-2 pt-2">
          {presets.map((p) => (
            <Button
              key={p.host}
              role="radio"
              size="sm"
              variant="outline"
              aria-checked={current === p.host}
              disabled={disabled}
              className={cn(current === p.host && "border-primary bg-primary/5")}
              onClick={() => setDraft({ port, host: p.host })}
            >
              {p.label} · <span className="font-mono">{p.host}</span>
            </Button>
          ))}
        </div>
        <div className="pt-3">
          <Disclosure title={t("Adres ve port", "Address and port")} summary={`${status.host}:${status.port}`} openKey={draft ? "draft" : undefined}>
            <div className="grid grid-cols-[1fr_7rem] gap-3 pt-1">
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
          </Disclosure>
        </div>
        {draft && changed && (
          <div className="flex flex-wrap items-center gap-2 pt-2">
            <Button
              size="sm"
              disabled={disabled || !valid}
              onClick={() =>
                void onConfigure({ port: parsedPort!, host: current }).then((saved) => saved && setDraft(undefined))
              }
            >
              {t("Uygula", "Apply")}
            </Button>
            <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setDraft(undefined)}>
              {t("Vazgeç", "Cancel")}
            </Button>
            <Note>
              {valid
                ? status.running
                  ? t("Çalışan geçit yeni adresle yeniden başlar; bağlı araçlar da güncellenir.", "The running gateway restarts on the new address; connected tools are updated too.")
                  : t("Ağ geçidi açıldığında bu adresi kullanır.", "The gateway uses this address when you turn it on.")
                : t("Geçerli bir adres ve 1–65535 arası bir port gir.", "Enter a valid host and a port from 1 to 65535.")}
            </Note>
          </div>
        )}
        {!isLoopbackHost(current) && validHost(current) && current !== status.tailscaleAddress && (
          <Note className="pt-2 text-warn">
            {t(
              "Bu adres yerel değil: anahtarı bilen ağdaki herkes hesaplarını kullanabilir. Tailscale gibi kapalı bir ağ kullan.",
              "This is not a local address: anyone on the network who has the key can spend your accounts. Keep it on a private network such as Tailscale.",
            )}
          </Note>
        )}
      </Card>
      <Note className="px-1">
        {t(
          "Abonelik hesaplarını aynı anda birden çok makineden kullanma; sunucu (VPS) ya da VPN üzerinden giriş yapma. Bunlar hesabın kısıtlanmasına yol açabilir.",
          "Do not use subscription accounts from several machines at once, and do not sign in from a server (VPS) or a VPN. Either can get the account restricted.",
        )}
      </Note>
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
  const { status, setStatus } = useProxyStatus();
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
      description={t(
        "Claude Code ve Codex tek bir adrese bağlanır; ağ geçidi isteği limiti en uygun hesaba gönderir.",
        "Claude Code and Codex connect to one address; the gateway sends each request to the account with the best room.",
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
      <div className="grid max-w-5xl gap-4 px-5 pb-6">
        <GatewayHeader
          status={status}
          disabled={disabled}
          copy={copy}
          onToggle={toggle}
          onRegenerate={() => void action("proxy-key", async () => setStatus(await api.proxyRegenerateKey()))}
        />
        {boundEmpty.map((client) => (
          <Attention
            key={client.id}
            tone="crit"
            action={
              <span className="flex flex-wrap gap-2">
                <Button asChild size="sm">
                  <a href={addAccountHash(CLIENT_PROVIDER[client.id])}>
                    {t(`${PROVIDER_NAMES[CLIENT_PROVIDER[client.id]]} hesabı ekle`, `Add a ${PROVIDER_NAMES[CLIENT_PROVIDER[client.id]]} account`)}
                  </a>
                </Button>
                <Button size="sm" variant="outline" disabled={disabled} onClick={() => unbind(client.id)}>
                  {t("Ayır", "Disconnect")}
                </Button>
              </span>
            }
          >
            {t(
              `${CLIENT_NAMES[client.id]} bu geçide bağlı ama havuzda kullanılabilir ${PROVIDER_NAMES[CLIENT_PROVIDER[client.id]]} hesabı yok: istekleri başarısız olur.`,
              `${CLIENT_NAMES[client.id]} is connected to this gateway, but the pool has no usable ${PROVIDER_NAMES[CLIENT_PROVIDER[client.id]]} account: its requests fail.`,
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
              `${boundOff.map((c) => CLIENT_NAMES[c.id]).join(" ve ")} bu geçide bağlı ama geçit kapalı: istek gönderemez.`,
              `${boundOff.map((c) => CLIENT_NAMES[c.id]).join(" and ")} ${boundOff.length > 1 ? "are" : "is"} connected to this gateway, but it is off: no requests go through.`,
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
                <div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
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
      </div>
    </PageFrame>
  );
}
