import { useState, type ReactNode } from "react";
import { Globe2, KeyRound, Monitor, Network } from "lucide-react";
import { PageSection } from "@/components/PageSection";
import { AccountLimits } from "@/features/Providers";
import { AntigravityAction, AntigravityPrompt, antigravityAccountState, type AntigravityAsk } from "@/features/AntigravityAccount";
import { UsageCard } from "@/features/UsageCard";
import { HistorySummary } from "@/features/HistorySummary";
import { DesktopSetup } from "@/features/DesktopSetup";
import { Private } from "@/components/Private";
import { RefreshIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Disclosure } from "@/components/Disclosure";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { pendingFlow } from "@/data/selectors";
import { useExtensionStatus } from "@/data/useExtension";
import { useTerminalStatus } from "@/data/useTerminal";
import { CliFlowPanel } from "@/app/ConnectionPanels";
import { PageBody } from "@/app/PageFrame";
import { RelayErrorAlert } from "@/app/RelayErrorAlert";
import { routeHash } from "@/app/routes";
import { isClaudeAccount, usageSignInStatus } from "@/lib/account-health";
import { formatRelative } from "@/lib/time";
import type { Account, ExtensionStatus, RelaySettings } from "../../../../shared/types";
import type { TerminalStatus } from "../../../../shared/terminal-identity";
import {
  desktopCliMismatch,
  desktopCliWorkspaceMismatch,
  duplicateCliAccount,
} from "../../../../shared/account-state";
import { historySources } from "../../../../shared/history-policy";
import { freshUsage } from "../../../../shared/usage";
import { accountPlan, groupName, providerLabel } from "../accountLabels";
import { ConnectionList, ConnectionRow } from "./Connections";
import { ExtensionConnection } from "./ExtensionConnection";
import { TerminalConnection } from "./TerminalConnection";
import { SwitchThresholdCard } from "./SwitchThreshold";
import type { T } from "../../../../shared/i18n/translate";

/**
 * The closed Code history row's summary: how many other accounts' history the next merge brings
 * (`historySources`, the list the open section names), and why, by the history setting.
 */
export function historyLine(
  sources: number,
  transfer: RelaySettings["desktopHistoryTransfer"],
  t: T,
): string {
  if (!sources) return t("body.notShared");
  return transfer === "same-group"
    ? t("body.sharedWithAccountsInTheSame", { sources })
    : t("body.sharedWithAccounts", { sources });
}

/** The page's contents under its header; rendered apart so it can be tested statically. */
export function AccountDetailBody({
  account: a,
  now,
  extensionStatus,
  terminalStatus,
}: {
  account: Account;
  now?: number;
  /** The browser extension's status, for static rendering; otherwise read, and checked, on mount. */
  extensionStatus?: ExtensionStatus;
  /** The terminal's sign-in status, for static rendering; otherwise read, and checked, on mount. */
  terminalStatus?: TerminalStatus;
}) {
  const relay = useRelay();
  const { t, language } = useI18n();
  const {
    api,
    data,
    desktop,
    accounts,
    settings,
    busy,
    usageBusy,
    desktopBusy,
    pendingDesktop,
    hasUnclaimedDesktop,
    targetOrg,
    desktopRequest,
    setupId,
    setSetupId,
    action,
    setNotice,
    historyRevision,
  } = relay;
  const usage = data?.usage[a.id];
  const authFlow = data?.authFlows.find((f) => f.accountId === a.id);
  const waiting = pendingFlow(authFlow);
  const mismatch = desktopCliMismatch(a);
  const duplicate = duplicateCliAccount(a, accounts);
  const signIn = usageSignInStatus(a, usage, waiting, t, data?.diagnostics?.platform);
  // The header badge's name, never the raw word ("plus", "Antigravity OAuth").
  const plan = accountPlan(a);
  const browserSteps = ["darwin", "preview", "linux"].includes(data?.diagnostics?.platform ?? "");
  const extension = useExtensionStatus({ check: browserSteps, initial: extensionStatus });
  const terminal = useTerminalStatus({ check: browserSteps, initial: terminalStatus });
  // Only what a switch needs counts: the Claude app sign-in and the usage sign-in. The extension
  // and the terminal are optional and say their own state on their rows.
  const claude = isClaudeAccount(a);
  const gateway = desktop?.proxyStatus;
  // The gateway lists every account; only one with a sign-in can take requests.
  const signedIn = a.auth?.loggedIn === true;
  const inPool = !!gateway?.running && signedIn;
  // Antigravity's own app is a connection too: the app and agy run on the account Relay moves them to.
  const [antigravityAsk, setAntigravityAsk] = useState<AntigravityAsk>();
  const appState = a.provider === "antigravity" ? antigravityAccountState(data?.antigravity, a.id) : undefined;
  const appRow = appState !== undefined && appState !== "unavailable";
  const connections = claude
    ? [!!a.desktop, signIn.tone === "ok"]
    : [...(appRow ? [appState === "current" || appState === "saved"] : []), signedIn, inPool];
  const ready = connections.filter(Boolean).length;
  const history = historySources(a, accounts, settings);
  return (
    <PageBody className="gap-3 pb-6">
      <RelayErrorAlert />
      {duplicate && (
        <p
          role="status"
          className="rounded-lg border border-warn/40 bg-warn/10 px-4 py-2.5 text-sm"
        >
          {t("body.thisAccountIsAlsoConnectedTo", { duplicateName: duplicate.name })}
        </p>
      )}
      {a.desktop?.rejectedAt && (
        <div
          role="alert"
          data-slot="sign-in-ended"
          className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-crit/40 bg-crit/10 px-4 py-2.5 text-sm"
        >
          <p className="min-w-0 flex-1">
            {t("body.thisAccountSSavedClaudeSign")}
          </p>
          <Button
            size="sm"
            disabled={desktopBusy || !!pendingDesktop}
            onClick={() => relay.requestDesktop(a, "reconnect")}
          >
            {t("body.signInAgain")}
          </Button>
        </div>
      )}
      {mismatch && (
        <p
          role="alert"
          className="rounded-lg border border-crit/40 bg-crit/10 px-4 py-2.5 text-sm"
        >
          {desktopCliWorkspaceMismatch(a)
            ? t("body.theUsageSignInBelongsTo")
            : t("body.theClaudeAppSignInAnd")}
        </p>
      )}
      <div className="grid gap-5">
        <PageSection title={t("body.limits")} aside={freshUsage(usage, now ?? Date.now()) && usage?.checkedAt ? (
                  <span className="flex items-center gap-1">
                    {t("body.updated", { formatRelative: formatRelative(usage.checkedAt, now ?? Date.now(), language) })}
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={t("common.refreshLimits")}
                      disabled={usageBusy.has(a.id)}
                      onClick={() => void relay.refreshUsage(a)}
                    >
                      <RefreshIcon className={usageBusy.has(a.id) ? "animate-spin" : undefined} />
                    </Button>
                  </span>
                ) : undefined}>
          <Card padded>
            {freshUsage(usage, now ?? Date.now()) ? (
              <AccountLimits usage={usage} now={now ?? Date.now()} max={8} layout="grid" />
            ) : !claude ? (
              // No Claude sign-in to offer: Relay has no limit reader for this provider yet.
              <p data-slot="no-limit-reader" className="text-xs text-muted-foreground">
                {t("body.relayCannotReadLimitsTheGateway", { providerLabel: providerLabel(a.provider) })}
              </p>
            ) : (
            <UsageCard
              usage={usage}
              busy={usageBusy.has(a.id)}
              connectBusy={!!busy || waiting}
              settings={settings}
              t={t}
              language={language}
              now={now}
              refresh={(allowPrompt) => void relay.refreshUsage(a, allowPrompt)}
              connect={() => void relay.startCli(a)}
              appSignIn={!!a.desktop}
              connectElsewhere
            />
            )}
          </Card>
        </PageSection>
        <PageSection title={t("body.connections")} aside={<span className="text-xs text-muted-foreground">{t("body.ready", { ready, connectionsLength: connections.length })}</span>}>
          <Card padded data-slot="connections">
            <ConnectionList>
            {!claude && (
              <>
                {appRow && (
                  <ConnectionRow
                    icon={<Monitor />}
                    title={t("body.antigravityApp")}
                    purpose={t("body.theAppAndAgyRunOn")}
                    tone={appState === "current" || appState === "saved" ? "ok" : "warn"}
                    status={
                      appState === "current"
                        ? t("body.openNow")
                        : appState === "saved"
                          ? t("body.signInSaved")
                          : appState === "waiting"
                            ? t("body.waitingForSignIn")
                            : t("body.signInNotSaved")
                    }
                    action={<AntigravityAction account={a} onAsk={setAntigravityAsk} primary />}
                  >
                    <div className="mt-2 empty:hidden">
                      <AntigravityPrompt ask={antigravityAsk} onClose={() => setAntigravityAsk(undefined)} now={now ?? Date.now()} />
                    </div>
                  </ConnectionRow>
                )}
                <ConnectionRow
                  icon={<KeyRound />}
                  title={t("body.gatewaySignIn")}
                  purpose={t("body.theGatewaySendsRequestsWithIt")}
                  tone={signedIn ? "ok" : "warn"}
                  status={signedIn ? t("body.saved") : t("body.notSignedInAddTheAccount")}
                  where={signedIn && a.auth?.email ? <Private>{a.auth.email}</Private> : undefined}
                />
                <ConnectionRow
                  icon={<Network />}
                  title={t("common.gateway")}
                  purpose={t("body.spreadsRequestsOverTheAccounts")}
                  tone={inPool ? "ok" : "off"}
                  status={
                    gateway?.running
                      ? inPool
                        ? t("body.inThePool")
                        : t("body.notInThePoolNoSign")
                      : t("body.gatewayOff")
                  }
                  action={
                    <Button size="sm" variant="outline" asChild>
                      <a href={routeHash("proxy")}>{t("body.open")}</a>
                    </Button>
                  }
                />
              </>
            )}
            {claude && (
            <>
            <ConnectionRow
              icon={<Monitor />}
              title={t("common.claudeApp")}
              purpose={t("body.opensTheClaudeAppWithThis")}
              tone={a.desktop ? (a.desktop.rejectedAt ? "crit" : "ok") : "off"}
              status={
                a.desktop
                  ? a.desktop.rejectedAt
                    ? t("body.ended")
                    : t("body.saved")
                  : t("body.notSaved")
              }
              action={
                a.desktop ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={desktopBusy || !!pendingDesktop}
                    onClick={() => relay.requestDesktop(a, "reconnect")}
                  >
                    {t("body.renew")}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    disabled={
                      desktopBusy ||
                      !desktop?.available ||
                      !!pendingDesktop ||
                      !!desktop?.recoveryRequired
                    }
                    onClick={() => {
                      setSetupId(a.id);
                      relay.cancelDesktopRequest();
                    }}
                  >
                    {t("common.saveSignIn")}
                  </Button>
                )
              }
            >
              {setupId === a.id && !pendingDesktop && !desktopRequest && (
                <DesktopSetup
                  account={a}
                  accounts={accounts}
                  desktop={desktop}
                  unclaimed={hasUnclaimedDesktop}
                  org={targetOrg}
                  busy={desktopBusy}
                  t={t}
                  selectOrg={relay.setOrg}
                  close={() => setSetupId(undefined)}
                  connect={() =>
                    relay.requestDesktop(a, hasUnclaimedDesktop ? "capture" : "login")
                  }
                />
              )}
            </ConnectionRow>
            <ConnectionRow
              icon={<Globe2 />}
              title={t("body.usageSignIn")}
              purpose={t("body.readsTheLimits")}
              tone={signIn.tone}
              status={signIn.label}
              action={
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!!busy || waiting}
                  onClick={() => void relay.startCli(a)}
                >
                  {a.auth?.email ? t("body.renew2") : t("body.signIn")}
                </Button>
              }
              refresh={
                a.auth?.email && (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t("body.verifyUsageSignIn")}
                      title={t("body.verifyUsageSignIn")}
                      disabled={!!busy || waiting}
                      onClick={() =>
                        void action(`verify:${a.id}`, async () => {
                          const checked = await api.checkAuth(a.id);
                          setNotice(
                            checked.auth?.loggedIn
                              ? t("body.usageSignInVerified", { aName: a.name, email: checked.auth.email ?? "" })
                              : t("body.relayCannotVerifyTheUsageSign"),
                          );
                        })
                      }
                    >
                      <RefreshIcon />
                    </Button>
                )
              }
            >
              {relay.flow?.accountId === a.id && <CliFlowPanel embedded />}
              {/* The renewal Relay runs by itself near a sign-in's end, started now. */}
              {data?.diagnostics?.platform === "darwin" && a.desktop && a.auth?.loggedIn && (
                <Button
                  size="xs"
                  variant="ghost"
                  className="justify-self-start"
                  disabled={!!busy || waiting}
                  onClick={() =>
                    void action(`renew-quiet:${a.id}`, async () => {
                      const outcome = await api.renewSignInNow(a.id);
                      setNotice(
                        outcome.result === "connected"
                          ? t("body.theClaudeCodeSignInWas", { aName: a.name })
                          : outcome.result === "waiting"
                            ? t("body.claudeAiAsksForARecent", { aName: a.name, detail: outcome.detail ?? "" })
                            : t("body.couldNotBeRenewedInThe", { aName: a.name, detail: outcome.detail ?? outcome.result }),
                      );
                      await relay.refreshUsage(a);
                    })
                  }
                >
                  {t("body.renewTheSignInInThe")}
                </Button>
              )}
            </ConnectionRow>
            {/* The extension's and terminal's sign-ins are kept on macOS and Linux; the browser preview shows the rows too. */}
            {browserSteps && <ExtensionConnection account={a} extension={extension} />}
            {browserSteps && <TerminalConnection account={a} terminal={terminal} />}
            </>
            )}
            </ConnectionList>
          </Card>
        </PageSection>
        <PageSection title={t("common.account")}>
          <Card padded>
            <dl className="-mx-1 grid text-sm @xl:grid-cols-2 @xl:gap-x-8">
              {([
                [t("common.provider"), providerLabel(a.provider)],
                [t("body.email"), (a.desktop?.email ?? a.auth?.email) ? <Private>{a.desktop?.email ?? a.auth?.email}</Private> : "—"],
                [t("body.organization"), a.auth?.orgName ? <Private>{a.auth.orgName}</Private> : "—"],
                [
                  t("body.typeGroup"),
                  (a.kind === "personal" ? t("common.personal") : t("common.work")) +
                    (a.kind === "work" ? ` · ${groupName(a, t)}` : ""),
                ],
                ...(plan ? [[t("body.subscription"), plan.label]] : []),
                // The plan is set on the Planning page; here it only says whether the account is in it.
                ...(claude
                  ? [[
                      t("body.inThePlan"),
                      <a key="plan" href={routeHash("planlama")} className="text-primary hover:underline">
                        {a.planning?.plan ? t("body.yesPlanning") : t("body.noPlanning")}
                      </a>,
                    ]]
                  : []),
              ] as [string, ReactNode][]).map(([label, value]) => (
                <div key={label} className="flex min-w-0 items-baseline justify-between gap-3 border-t px-1 py-2 first:border-0 @xl:[&:nth-child(2)]:border-0">
                  <dt className="shrink-0 text-muted-foreground">{label}</dt>
                  <dd className="min-w-0 truncate text-right" title={typeof value === "string" ? value : undefined}>
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          </Card>
          {/* Only a Claude account is switched to automatically; Codex and Antigravity feed the gateway. */}
          {claude && <SwitchThresholdCard account={a} />}
          {a.desktop && (
            <Card padded>
              <Disclosure
                title={t("body.codeHistory")}
                summary={historyLine(history.length, settings.desktopHistoryTransfer, t)}
              >
                <HistorySummary
                  key={`${a.id}:${historyRevision}`}
                  account={a}
                  sources={history}
                  api={api}
                  t={t}
                />
              </Disclosure>
            </Card>
          )}
        </PageSection>
      </div>
    </PageBody>
  );
}
