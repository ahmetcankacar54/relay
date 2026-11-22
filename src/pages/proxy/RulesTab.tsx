import { useState } from "react";
import { Disclosure } from "@/components/Disclosure";
import { Note, OptionSelect, SectionHeading, SettingRow } from "@/components/SettingRow";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/data/i18n";
import { macWording, usePlatform } from "@/data/platform";
import { isLoopbackHost, parsePort, validHost } from "@/lib/proxy-ui";
import { cn } from "@/lib/utils";
import type { ProxyStatus } from "../../../shared/types";
import { gatewayHostAllowed } from "../../../shared/proxy-url";
import { DEFAULT_PROXY_CONFIG } from "../../../shared/proxy-types";
import type { Patch } from "./shared";

type Strategy = NonNullable<ProxyStatus["routingStrategy"]>;

const AFFINITY_SECONDS = [300, 900, 3_600] as const;

/** The Rules tab: how an account is picked, how long a session keeps it, and who may connect. */
export function RulesTab({
  status,
  disabled,
  onConfigure,
}: {
  status: ProxyStatus;
  disabled: boolean;
  onConfigure: (patch: Patch) => Promise<boolean>;
}) {
  const { t, language } = useI18n();
  const mac = macWording(usePlatform());
  const locale = language === "tr" ? "tr-TR" : "en-US";
  const [draft, setDraft] = useState<{ port: string; host: string }>();
  const strategy: Strategy = status.routingStrategy ?? "soonest-reset";
  const port = draft?.port ?? String(status.port);
  const host = draft?.host ?? status.host;
  const parsedPort = parsePort(port);
  const changed = parsedPort !== status.port || host.trim() !== status.host;
  const hostAllowed = gatewayHostAllowed(host.trim());
  const valid = parsedPort !== undefined && hostAllowed;
  const ratio = status.stats.cacheHitRate.toLocaleString(locale, { maximumFractionDigits: 1 });
  const strategies: { value: Strategy; label: string; hint: string }[] = [
    {
      value: "soonest-reset",
      label: t("Önce yanacak olan (önerilen)", "Expiring first (recommended)"),
      hint: t(
        "Haftası ilk biten hesap önce kullanılır: sıfırlamada kalan kota silinir, sonra bitecek hafta bekleyebilir. Model limitleri (Fable) ayrıca sayılır. Açık oturumlar da yeni bir isteme geçerken haftası bir gün ya da daha erken biten hesaba taşınır; tur ortasında hiç taşınmaz.",
        "The account whose week ends first goes first: what is left at a reset is gone, while a later week can wait. Model limits (Fable) count on their own. Open sessions also move, at the start of a new prompt, to an account whose week ends a day or more sooner; never mid-turn.",
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
    { host: "127.0.0.1", label: mac ? t("Yalnızca bu Mac", "This Mac only") : t("Yalnızca bu bilgisayar", "This computer only") },
    ...(status.tailscaleAddress
      ? [{ host: status.tailscaleAddress, label: t("Tailscale ağım", "My tailnet") }]
      : []),
  ];
  const current = host.trim();
  return (
    <div className="grid gap-4">
      <Card padded data-slot="routing-config">
        <SectionHeading
          title={t("Hesap seçimi", "Choosing an account")}
          description={t("Yeni bir oturumun hangi hesapla başlayacağı.", "Which account a new session starts on.")}
        />
        <div role="radiogroup" aria-label={t("Yönlendirme stratejisi", "Routing strategy")} className="grid gap-2 pt-2 @lg:grid-cols-3">
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
      <Card padded data-slot="network">
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
                  aria-invalid={!hostAllowed}
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
                : !hostAllowed
                  ? t("127.0.0.1, localhost ya da bir Tailscale adresi kullanın.", "Use 127.0.0.1, localhost or a Tailscale address.")
                  : t("1–65535 arası bir port gir.", "Enter a port from 1 to 65535.")}
            </Note>
          </div>
        )}
        {!isLoopbackHost(current) && validHost(current) && current !== status.tailscaleAddress && (
          <Note className="pt-2 text-warn-foreground">
            {t(
              "Bu adres yerel değil: anahtarı bilen ağdaki herkes hesaplarını kullanabilir. Tailscale gibi kapalı bir ağ kullan.",
              "This is not a local address: anyone on the network who has the key can spend your accounts. Keep it on a private network such as Tailscale.",
            )}
          </Note>
        )}
        {!isLoopbackHost(current) && validHost(current) && (
          <Note className="pt-2">
            {t(
              "Yalnızca kendi bilgisayarların bağlansın. Abonelik girişleri kişisel kullanım içindir: gateway'i başkalarıyla paylaşmak ya da bir sunucuya koymak hesapların kısıtlanmasına yol açabilir.",
              "Connect only your own computers. Subscription sign-ins are for personal use: sharing the gateway with others or running it on a server can get the accounts restricted.",
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
