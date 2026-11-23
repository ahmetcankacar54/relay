import { useRef, useState } from "react";
import { ExternalLink } from "@/components/ExternalLink";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { errorMessage } from "@/data/error-message";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { cn } from "@/lib/utils";
import {
  FEATURE_RISKS,
  POLICY_LINKS,
  RISK_LADDER,
  enabledRisks,
  pendingRisks,
  turnOffSteps,
  type FeatureRiskId,
  type FeaturesInUse,
} from "../../shared/feature-risk";
import { DEFAULT_PROXY_CONFIG } from "../../shared/proxy-types";
import { enabledMeters } from "../../shared/meters";
import type { Account, ProxyStatus, RelaySettings } from "../../shared/types";

/**
 * A feature's risk in one short note with its policy pages, where the feature lives (the
 * gateway's head, the pool's Antigravity group). The same words the consent dialog shows.
 */
export function RiskNote({ id, slot, className }: { id: FeatureRiskId; slot: string; className?: string }) {
  const { t } = useI18n();
  const risk = FEATURE_RISKS[id];
  return (
    <span className={cn("text-xs text-muted-foreground", className)}>
      <span data-slot={slot}>{t(risk.body)}</span>
      {risk.links.map((link) => (
        <span key={link}>
          {" "}
          <ExternalLink href={POLICY_LINKS[link].href}>{t(POLICY_LINKS[link].label)}</ExternalLink>
        </span>
      ))}
    </span>
  );
}

/**
 * What the consent dialog says: each feature's risk with its policy pages, then the whole ladder
 * with these features' rungs marked. Rendered outside the portal so it can be tested statically.
 */
export function RiskConsentBody({ ids }: { ids: readonly FeatureRiskId[] }) {
  const { t } = useI18n();
  const rungs = new Set(ids.map((id) => FEATURE_RISKS[id].rung));
  return (
    <div className="grid gap-4 text-sm" data-slot="risk-consent">
      {ids.map((id) => {
        const risk = FEATURE_RISKS[id];
        return (
          <section key={id} className="grid gap-1" data-risk={id} data-level={risk.level}>
            <h3 className="flex flex-wrap items-baseline gap-2 font-semibold">
              {t(risk.title)}
              <span
                className={cn(
                  "rounded px-1.5 text-2xs font-medium",
                  risk.level === "R2" ? "bg-crit/10 text-crit" : "bg-warn/10 text-warn",
                )}
              >
                {t(risk.level === "R2" ? "featureRisk.levelAgainstTerms" : "featureRisk.levelGreyArea")}
              </span>
            </h3>
            <p className="text-muted-foreground">{t(risk.body)}</p>
            <p className="flex flex-wrap gap-x-3">
              {risk.links.map((link) => (
                <ExternalLink key={link} href={POLICY_LINKS[link].href}>
                  {t(POLICY_LINKS[link].label)}
                </ExternalLink>
              ))}
            </p>
          </section>
        );
      })}
      <div className="grid gap-1.5 border-t pt-3">
        <h3 className="text-xs font-semibold">{t("featureRisk.ladderTitle")}</h3>
        <ol className="grid gap-0.5 text-xs" data-slot="risk-ladder">
          {RISK_LADDER.map((rung, index) => {
            const here = rungs.has(index + 1);
            return (
              <li
                key={rung}
                aria-current={here ? "step" : undefined}
                className={cn("flex gap-2 text-muted-foreground", here && "font-semibold text-foreground")}
              >
                <span className="w-4 tabular-nums">{index + 1}.</span>
                <span>
                  {t(rung)}
                  {here && ` · ${t("featureRisk.thisFeature")}`}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

/**
 * The consent dialog: what the features risk, "I understand", and a way out (`declineLabel`).
 * Open while `ids` is set; Escape or a click outside calls `onDismiss`.
 */
function RiskConsentDialog({
  ids,
  description,
  declineLabel,
  note,
  saving,
  onAccept,
  onDecline,
  onDismiss,
}: {
  ids?: readonly FeatureRiskId[];
  description: string;
  declineLabel: string;
  note?: string;
  saving: boolean;
  onAccept: () => void;
  onDecline: () => void;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog open={!!ids?.length} onOpenChange={(open) => !open && !saving && onDismiss()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("featureRisk.dialogTitle")}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {ids && <RiskConsentBody ids={ids} />}
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
        <DialogFooter>
          <Button variant="ghost" disabled={saving} onClick={onDecline} data-slot="risk-decline">
            {declineLabel}
          </Button>
          <Button disabled={saving} onClick={onAccept} data-slot="risk-accept">
            {t("featureRisk.iUnderstand")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Asks once before a risky feature is turned on. `ask(ids)` resolves true at once when every risk
 * is already accepted at its current text; otherwise it opens the dialog and resolves true only
 * after "I understand" was saved in main, false on Cancel. Render `dialog` once in the page.
 */
export function useRiskConsent() {
  const { api, settings, setNotice } = useRelay();
  const { t } = useI18n();
  const [ids, setIds] = useState<FeatureRiskId[]>();
  const [saving, setSaving] = useState(false);
  const answer = useRef<(accepted: boolean) => void>(undefined);
  const close = (accepted: boolean) => {
    answer.current?.(accepted);
    answer.current = undefined;
    setIds(undefined);
  };
  const ask = (wanted: readonly FeatureRiskId[]): Promise<boolean> => {
    const pending = pendingRisks(settings, wanted);
    if (!pending.length) return Promise.resolve(true);
    // A second ask while one is open answers the first with a no.
    answer.current?.(false);
    setIds(pending);
    return new Promise((resolve) => {
      answer.current = resolve;
    });
  };
  const accept = () => {
    if (!ids) return;
    setSaving(true);
    void api
      .acknowledgeRisk(ids)
      .then(
        () => close(true),
        (error) => {
          setNotice(errorMessage(error));
          close(false);
        },
      )
      .finally(() => setSaving(false));
  };
  const dialog = (
    <RiskConsentDialog
      ids={ids}
      description={t("featureRisk.dialogDescription")}
      declineLabel={t("common.cancel")}
      saving={saving}
      onAccept={accept}
      onDecline={() => close(false)}
      onDismiss={() => close(false)}
    />
  );
  return { ask, dialog };
}

/**
 * What is on now, from what the main window knows: the saved settings (early start, the meters),
 * the accounts, and the gateway's live state (its bound clients and pool) once it has been read.
 */
export function featuresInUse(settings: RelaySettings, accounts: readonly Account[], status?: ProxyStatus): FeaturesInUse {
  return {
    earlyStart: settings.planning.autoStart,
    accounts,
    gateway: {
      on: settings.proxy?.enabled === true || status?.running === true,
      host: status?.host ?? settings.proxy?.host ?? DEFAULT_PROXY_CONFIG.host,
      excludedAccountIds: status?.accounts.filter((a) => !a.inPool).map((a) => a.id),
      boundClients: (status?.clients ?? []).filter((c) => c.bound).map((c) => c.id),
    },
    meters: enabledMeters(settings),
  };
}

/**
 * Features turned on before Relay asked about their risks (an older version) are asked about
 * once, in the main window. Nothing stops while the dialog waits: "I understand" keeps them,
 * "Turn it off" turns them off through the pages' own calls. Closed without an answer, it asks
 * again at the next start.
 */
export function ExistingRiskConsent() {
  const { api, settings, accounts, data, desktop, action, setNotice } = useRelay();
  const { t } = useI18n();
  const [answered, setAnswered] = useState<readonly FeatureRiskId[]>([]);
  const [saving, setSaving] = useState(false);
  const state = featuresInUse(settings, accounts, desktop?.proxyStatus);
  // Only once the first snapshot is in: before it, settings and accounts are the defaults.
  const pending = data ? pendingRisks(settings, enabledRisks(state)).filter((id) => !answered.includes(id)) : [];
  const settle = () => setAnswered((done) => [...done, ...pending]);
  const accept = () => {
    setSaving(true);
    void api
      .acknowledgeRisk(pending)
      .then(settle, (error) => setNotice(errorMessage(error)))
      .finally(() => setSaving(false));
  };
  const turnOff = () => {
    const steps = turnOffSteps(pending, state);
    setSaving(true);
    void action("risk-turn-off", async () => {
      for (const step of steps) {
        if (step.kind === "unbind") await api.proxyUnbindClient(step.client);
        else if (step.kind === "gateway-off") await api.proxyToggle(false);
        else if (step.kind === "gateway-host") await api.proxyConfigure({ host: step.host });
        else if (step.kind === "exclude") await api.proxyConfigure({ excludedAccountIds: step.accountIds });
        else if (step.kind === "early-start-off") await api.updatePlanning({ autoStart: false });
        else if (step.kind === "meters") await api.updateSettings({ meters: step.keep });
        else await api.removeAccount(step.accountId);
      }
    })
      .then((done) => done && settle())
      .finally(() => setSaving(false));
  };
  return (
    <RiskConsentDialog
      ids={pending}
      description={t("featureRisk.alreadyOnDescription")}
      declineLabel={t("featureRisk.turnItOff")}
      note={pending.includes("antigravity-account") ? t("featureRisk.turnOffRemovesAntigravity") : undefined}
      saving={saving}
      onAccept={accept}
      onDecline={turnOff}
      onDismiss={settle}
    />
  );
}
