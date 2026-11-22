import { useState } from "react";
import { Disclosure } from "@/components/Disclosure";
import { Note, OptionSelect, SectionHeading, SettingRow } from "@/components/SettingRow";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/data/i18n";
import { FORMAT_LOCALE } from "../../../shared/i18n/locales";
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
  const locale = FORMAT_LOCALE[language];
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
      label: t("rulesTab.expiringFirstRecommended"),
      hint: t("rulesTab.theAccountWhoseWeekEndsFirst"),
    },
    {
      value: "balanced",
      label: t("rulesTab.balanced"),
      hint: t("rulesTab.requestsGoToTheAccountWith"),
    },
    {
      value: "strict-priority",
      label: t("rulesTab.inOrder"),
      hint: t("rulesTab.accountsAreUsedInTheOrder"),
    },
  ];
  const presets = [
    { host: "127.0.0.1", label: mac ? t("rulesTab.thisMacOnly") : t("rulesTab.thisComputerOnly") },
    ...(status.tailscaleAddress
      ? [{ host: status.tailscaleAddress, label: t("rulesTab.myTailnet") }]
      : []),
  ];
  const current = host.trim();
  return (
    <div className="grid gap-4">
      <Card padded data-slot="routing-config">
        <SectionHeading
          title={t("rulesTab.choosingAnAccount")}
          description={t("rulesTab.whichAccountANewSessionStarts")}
        />
        <div role="radiogroup" aria-label={t("rulesTab.routingStrategy")} className="grid gap-2 pt-2 @lg:grid-cols-3">
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
            label={t("rulesTab.keepASessionOnItsAccount")}
            htmlFor="proxy-affinity"
            description={t("rulesTab.thePromptCacheBelongsToThe", { ratio })}
          >
            <OptionSelect
              id="proxy-affinity"
              value={String(status.affinityTtlSeconds ?? DEFAULT_PROXY_CONFIG.affinityTtlSeconds)}
              disabled={disabled}
              options={AFFINITY_SECONDS.map((s) => ({
                value: String(s),
                label: s < 3_600 ? t("rulesTab.minutes", { minutes: s / 60 }) : t("rulesTab.n1Hour"),
              }))}
              onChange={(value) => void onConfigure({ affinityTtlSeconds: Number(value) })}
            />
          </SettingRow>
          <SettingRow
            label={t("rulesTab.sendSubagentsToAnotherAccount")}
            htmlFor="proxy-subagent-overflow"
            description={t("rulesTab.aFreshSubagentWritesItsOwn")}
          >
            <Switch
              id="proxy-subagent-overflow"
              checked={status.subagentOverflow === true}
              disabled={disabled}
              onCheckedChange={(on) => void onConfigure({ subagentOverflow: on })}
            />
          </SettingRow>
          <p className="pt-2 text-2xs text-muted-foreground">
            {t("rulesTab.anAccountPast90OfIts")}
          </p>
        </div>
      </Card>
      <Card padded data-slot="network">
        <SectionHeading
          title={t("rulesTab.whoCanConnect")}
          description={t("rulesTab.toUseItFromAnotherComputer")}
        />
        <div role="radiogroup" aria-label={t("rulesTab.listenAddress")} className="flex flex-wrap gap-2 pt-2">
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
          <Disclosure title={t("rulesTab.addressAndPort")} summary={`${status.host}:${status.port}`} openKey={draft ? "draft" : undefined}>
            <div className="grid grid-cols-[1fr_7rem] gap-3 pt-1">
              <label className="grid gap-1 text-xs font-medium" htmlFor="proxy-host">
                {t("rulesTab.host")}
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
                {t("rulesTab.port")}
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
              {t("rulesTab.apply")}
            </Button>
            <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setDraft(undefined)}>
              {t("common.cancel")}
            </Button>
            <Note>
              {valid
                ? status.running
                  ? t("rulesTab.theRunningGatewayRestartsOnThe")
                  : t("rulesTab.theGatewayUsesThisAddressWhen")
                : !hostAllowed
                  ? t("rulesTab.use127001Localhost")
                  : t("rulesTab.enterAPortFrom1To")}
            </Note>
          </div>
        )}
        {!isLoopbackHost(current) && validHost(current) && current !== status.tailscaleAddress && (
          <Note className="pt-2 text-warn-foreground">
            {t("rulesTab.thisIsNotALocalAddress")}
          </Note>
        )}
        {!isLoopbackHost(current) && validHost(current) && (
          <Note className="pt-2">
            {t("rulesTab.connectOnlyYourOwnComputersSubscription")}
          </Note>
        )}
      </Card>
      <Note className="px-1">
        {t("rulesTab.doNotUseSubscriptionAccountsFrom")}
      </Note>
    </div>
  );
}
