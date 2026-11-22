import { useState } from "react";
import { Eye, EyeOff, RefreshCw } from "lucide-react";
import { Note } from "@/components/SettingRow";
import { StatusDot } from "@/components/StatusDot";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useI18n, type T } from "@/data/i18n";
import { agoLabel, gatewayUrl, maskKey } from "@/lib/proxy-ui";
import type { ProxyAccountStatus, ProxyStatus } from "../../../shared/types";
import { CopyChip } from "../Proxy";
import type { Copy } from "./hooks";
import { CLIENT_NAMES } from "./shared";

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
export function GatewayHeader({
  status,
  disabled,
  copy,
  onToggle,
  onRegenerate,
  unreadable,
}: {
  status?: ProxyStatus;
  disabled: boolean;
  copy: Copy;
  onToggle: (enabled: boolean) => void;
  onRegenerate: () => void;
  /** Reads keep failing: say so rather than "Loading…". */
  unreadable: boolean;
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
    <Card padded className="gap-3" data-slot="gateway-card">
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
            <StatusDot tone={unreadable ? "crit" : running ? "ok" : "off"} hollow={!running && !unreadable} />
            {unreadable
              ? t("Ağ geçidi durumu okunamıyor", "Can't read the gateway state")
              : !status
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
