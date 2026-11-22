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
import { FORMAT_LOCALE } from "../../../shared/i18n/locales";
import { CopyChip } from "../Proxy";
import type { Copy } from "./hooks";
import { CLIENT_NAMES } from "./shared";

/** Who answered the latest request, in a few words. */
function lastRequestLine(status: ProxyStatus, now: number, t: T): string | undefined {
  const last = status.recent?.find((r) => r.accountId);
  if (!last) return undefined;
  const name = status.accounts.find((a) => a.id === last.accountId)?.name;
  const ago = agoLabel(last.at, now, t);
  return name ? t("gatewayHeader.lastRequestBy", { ago, account: name }) : t("gatewayHeader.lastRequest", { ago });
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
  const { t, language } = useI18n();
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
          aria-label={t("gatewayHeader.turnTheGatewayOnOrOff")}
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
              ? t("gatewayHeader.canTReadTheGatewayState")
              : !status
                ? t("gatewayHeader.loading")
                : running
                  ? t("gatewayHeader.gatewayRunning")
                  : t("gatewayHeader.gatewayOff")}
          </span>
          <span className="text-xs text-muted-foreground">
            {[
              t("gatewayHeader.accountsReady", { ready }),
              last,
              bound.length ? t("gatewayHeader.connected", { join: bound.join(", ") }) : undefined,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <CopyChip id="endpoint" label={t("gatewayHeader.address")} shown={endpoint} value={endpoint} copy={copy} />
          <CopyChip
            id="key"
            label={t("gatewayHeader.key")}
            shown={key ? (reveal ? key : maskKey(key)) : t("gatewayHeader.madeOnFirstStart")}
            value={key}
            copy={copy}
          >
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={!key}
              aria-label={reveal ? t("gatewayHeader.hideKey") : t("gatewayHeader.showKey")}
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
            aria-label={t("gatewayHeader.regenerateKey")}
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
              ? t("gatewayHeader.theOldKeyStopsWorkingAt", { clients: new Intl.ListFormat(FORMAT_LOCALE[language]).format(bound) })
              : t("gatewayHeader.theOldKeyStopsWorkingAt2")}
          </Note>
          <Button
            size="sm"
            disabled={disabled}
            onClick={() => {
              setConfirming(false);
              onRegenerate();
            }}
          >
            {t("gatewayHeader.generateNewKey")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
            {t("common.cancel")}
          </Button>
        </div>
      )}
    </Card>
  );
}
