import { useEffect, useState } from "react";
import { Private } from "@/components/Private";
import { ArrowUpRight, Globe2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Trans, useI18n, type Locale } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { pendingFlow } from "@/data/selectors";
import { duplicateCliAccount } from "../../shared/account-state";
import { ConnectionProgress } from "../features/ConnectionProgress";
import { WorkspaceSelect } from "../features/DesktopSetup";
import { codeTabStep } from "@/lib/onboarding";
import { localizeError } from "../messages";
import type { AutoCaptureState } from "../../shared/types";
import type { T } from "../../shared/i18n/translate";

const cardClass = "gap-3 px-4 py-4";
const panelClass = `mx-5 mb-3 ${cardClass}`;
const titleClass = "flex items-start gap-3";
const iconClass = "mt-0.5 size-5 shrink-0 text-brand";
const actionsClass = "flex flex-wrap items-center gap-2";

/**
 * What Relay's automatic save of a Claude app sign-in is doing for `accountId`, as one line;
 * undefined when it is not armed for that profile or has nothing to say.
 */
export function autoCaptureLine(
  state: AutoCaptureState | undefined,
  accountId: string,
  t: T,
  language: Locale,
): string | undefined {
  if (state?.accountId !== accountId) return undefined;
  switch (state.status) {
    case "waiting":
      return state.alreadySaved
        ? t("connectionPanels.theClaudeAppIsSignedIn", { stateAlreadySaved: state.alreadySaved })
        : t("connectionPanels.relaySavesTheSignInWhen");
    case "choose-org":
      return t("connectionPanels.thisAccountHasMoreThanOne");
    case "saving":
      return t("connectionPanels.relaySavesTheSignInThe");
    case "saved":
      return t("connectionPanels.claudeAppSignInSaved");
    case "failed":
      return state.error === "timeout"
        ? t("connectionPanels.theWaitTimedOutIfYou")
        : state.error === "other-pending"
          ? t("connectionPanels.anotherAccountSSignInIs")
          : localizeError(state.error ?? "", language);
  }
}

/** Workspace choice and the reopen / cancel / complete actions for a pending Desktop sign-in. */
export function DesktopPendingActions() {
  const relay = useRelay();
  const { t, language } = useI18n();
  const {
    api,
    desktop,
    desktopBusy,
    pendingDesktop,
    hasUnclaimedDesktop,
    targetOrg,
    setOrg,
    action,
  } = relay;
  if (!pendingDesktop) return null;
  const identityReady =
    hasUnclaimedDesktop || desktop?.activeProfileId === pendingDesktop.id;
  const workspaces = desktop?.organizations.length ?? 0;
  const auto = desktop?.autoCapture?.accountId === pendingDesktop.id ? desktop.autoCapture : undefined;
  // Saved by Relay unless that stopped: the manual save stays as the way out.
  const manual = !auto || auto.status === "failed";
  const line = autoCaptureLine(auto, pendingDesktop.id, t, language);
  return (
    <>
      {line && (
        <p role="status" className="text-sm text-muted-foreground">
          {line}
        </p>
      )}
      {auto?.status === "choose-org" && auto.orgs ? (
        <WorkspaceSelect
          accounts={relay.accounts}
          organizations={auto.orgs}
          value=""
          onChange={(orgId) =>
            void action("auto-capture", () => api.chooseAutoCaptureOrg(pendingDesktop.id, orgId))
          }
          suggested={auto.suggestedOrg}
          t={t}
        />
      ) : (
        manual &&
        workspaces > 1 && (
          <WorkspaceSelect
            accounts={relay.accounts}
            organizations={desktop!.organizations}
            value={targetOrg}
            onChange={setOrg}
            suggested={desktop!.orgHint?.orgId}
            t={t}
          />
        )
      )}
      {manual && identityReady && !workspaces && (
        <p className="text-sm text-muted-foreground">{codeTabStep(t)}</p>
      )}
      <div className={actionsClass}>
        <Button
          variant="outline"
          size="sm"
          disabled={desktopBusy}
          onClick={() => void action("open", () => api.openCodeTab())}
        >
          <ArrowUpRight />
          {t("common.openCode")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={desktopBusy || auto?.status === "saving"}
          onClick={() => relay.requestDesktop(pendingDesktop, "cancel")}
        >
          {t("connectionPanels.cancelAndReturnToPreviousAccount")}
        </Button>
        {manual && identityReady && targetOrg && (
          <Button
            size="sm"
            disabled={desktopBusy}
            onClick={() => relay.requestDesktop(pendingDesktop, "capture")}
          >
            {t("common.saveSignIn")}
          </Button>
        )}
      </div>
    </>
  );
}

/** Desktop sign-in in progress for a profile; shown above every page until saved or cancelled. */
export function DesktopPendingPanel() {
  const relay = useRelay();
  const { t } = useI18n();
  const { desktop, pendingDesktop, hasUnclaimedDesktop, targetOrg } = relay;
  if (!pendingDesktop) return null;
  const desktopIdentityReady =
    hasUnclaimedDesktop || desktop?.activeProfileId === pendingDesktop.id;
  return (
    <Card id="desktop-pending-panel" className={panelClass} aria-live="polite">
      <div className={titleClass}>
        <Globe2 className={iconClass} />
        <div className="min-w-0">
          <h3 className="font-semibold">
            {pendingDesktop.name} ·{" "}
            {t("connectionPanels.claudeAppSignIn")}
          </h3>
        </div>
      </div>
      <ConnectionProgress
        current={desktopIdentityReady ? 2 : 1}
        state={
          desktop?.busy ? "working" : desktop?.error ? "failed" : "waiting"
        }
        label={
          desktop?.busy
            ? t("connectionPanels.saveInProgress")
            : desktop?.error
              ? t("connectionPanels.signInNotSaved")
              : desktopIdentityReady
                ? targetOrg
                  ? t("common.saveClaudeAppSignIn")
                  : t("common.openCode")
                : t("common.signInToTheClaudeApp")
        }
        steps={[
          { title: t("connectionPanels.claudeAppOpen") },
          { title: t("connectionPanels.signIn") },
          { title: t("common.openCode") },
        ]}
      />
      <DesktopPendingActions />
    </Card>
  );
}

/**
 * Browser (CLI) sign-in flow for usage limits; shown above every page. The
 * `embedded` copy lives inside the add dialog and account sheet (which cover the
 * page panel) and drops the page-level id and margins.
 */
export function CliFlowPanel({ embedded = false }: { embedded?: boolean }) {
  const relay = useRelay();
  const { t, language } = useI18n();
  const { api, accounts, busy, flow, flowAccount, action } = relay;
  const pending = pendingFlow;
  const [code, setCode] = useState("");
  useEffect(() => setCode(""), [flow?.id]);
  if (!flow) return null;
  // The account the approval must come from: the browser may be signed in to another one.
  const expected = flowAccount?.desktop?.email ?? flowAccount?.auth?.email;
  const waiting = flow.status === "starting" || flow.status === "waiting";
  const note =
    flow.status === "failed" ? (
      localizeError(flow.error ?? "", language)
    ) : waiting && flow.inWindow ? (
      t("connectionPanels.inTheRelayWindowSignIn")
    ) : waiting ? (
      <>
        {t("connectionPanels.allowAccessOnThePageThat")}{" "}
        {expected ? (
          <>
            <Trans
              id="connectionPanels.thePageMustBeSignedIn"
              params={{ email: expected }}
              components={{ private: (c) => <Private>{c}</Private> }}
            />{" "}
          </>
        ) : null}
        {flow.windowAvailable
          ? t("connectionPanels.ifTheBrowserIsSignedIn")
          : t("connectionPanels.ifTheBrowserIsSignedIn2")}
      </>
    ) : undefined;
  return (
    <Card
      id={embedded ? undefined : "cli-connection-panel"}
      className={cn(
        embedded ? cardClass : panelClass,
        flow.status === "connected" && "border-brand/40",
      )}
      aria-live="polite"
    >
      <div className={titleClass}>
        {flow.status === "connected" ? (
          <ShieldCheck className={iconClass} />
        ) : (
          <Globe2 className={iconClass} />
        )}
        <div className="min-w-0">
          <h3 className="font-semibold">
            {flowAccount?.name} · {t("connectionPanels.usageSignIn")}
          </h3>
          {note && <p className="text-sm text-muted-foreground">{note}</p>}
        </div>
      </div>
      {flow.status === "connected" && flowAccount?.auth?.email && (
        <p className="text-sm font-medium">
          <Private>{flowAccount.auth.email}</Private>
          {flowAccount.auth.subscription
            ? ` · ${flowAccount.auth.subscription}`
            : ""}
        </p>
      )}
      {flow.status === "connected" &&
        flowAccount &&
        duplicateCliAccount(flowAccount, accounts) && (
          <p className="rounded-md bg-amber-500/10 px-2.5 py-1.5 text-sm text-amber-700 dark:text-amber-400">
            {t("connectionPanels.thisAccountIsAlsoConnectedTo")}
          </p>
        )}
      <ConnectionProgress
        current={
          flow.status === "starting" ? 0 : flow.status === "waiting" ? 1 : 2
        }
        state={
          flow.status === "connected"
            ? "complete"
            : flow.status === "failed"
              ? "failed"
              : flow.status === "cancelled"
                ? "cancelled"
                : flow.status === "waiting"
                  ? "waiting"
                  : "working"
        }
        label={
          flow.status === "connected"
            ? t("connectionPanels.accountVerified")
            : flow.status === "failed"
              ? t("connectionPanels.signInNotCompleted")
              : flow.status === "cancelled"
                ? t("connectionPanels.signInCancelled")
                : flow.status === "verifying"
                  ? t("connectionPanels.relayVerifiesTheAccount")
                  : flow.status === "waiting"
                    ? flow.inWindow
                      ? t("connectionPanels.approveInTheWindow")
                      : t("connectionPanels.approveInTheBrowser")
                    : t("connectionPanels.signInStarts")
        }
        steps={[
          { title: t("connectionPanels.startSignIn") },
          {
            title: flow.inWindow
              ? t("connectionPanels.approveInTheWindow")
              : t("connectionPanels.approveInTheBrowser"),
          },
          { title: t("connectionPanels.verifyTheAccount") },
        ]}
      />
      {flow.codeRequested && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const value = code;
            setCode("");
            relay.submitCode(value);
          }}
        >
          <label className="grid min-w-56 flex-1 gap-1.5 text-sm font-medium">
            {t("connectionPanels.ifTheBrowserShowsACode")}
            <Input
              type="password"
              autoComplete="off"
              value={code}
              maxLength={4096}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          <Button variant="outline" disabled={!!busy || !code.trim()}>
            {t("connectionPanels.submitCode")}
          </Button>
        </form>
      )}
      <div className={actionsClass}>
        {pending(flow) ? (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={!!busy || !flow.browserReady}
              onClick={() =>
                void action("reopen", () =>
                  api.reopenLogin(flow.accountId, flow.id, "browser"),
                )
              }
            >
              <ArrowUpRight />
              {flow.inWindow
                ? t("connectionPanels.openInBrowser")
                : t("connectionPanels.reopenBrowser")}
            </Button>
            {(flow.inWindow || flow.windowAvailable) && (
              <Button
                variant="ghost"
                size="sm"
                disabled={!!busy || !flow.browserReady}
                onClick={() =>
                  void action("reopen", () =>
                    api.reopenLogin(flow.accountId, flow.id, "window"),
                  )
                }
              >
                {flow.inWindow
                  ? t("connectionPanels.showTheWindow")
                  : t("connectionPanels.openInRelayWindow")}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              disabled={!!busy}
              onClick={() =>
                void action("cancel", () =>
                  api.cancelLogin(flow.accountId, flow.id),
                )
              }
            >
              {t("connectionPanels.cancel")}
            </Button>
          </>
        ) : (
          <>
            {flow.status !== "connected" && (
              <Button
                size="sm"
                disabled={!!busy}
                onClick={() => {
                  if (!flowAccount) return;
                  setCode("");
                  void relay.startCli(flowAccount);
                }}
              >
                {flowAccount?.auth?.email
                  ? t("common.renewUsageSignIn")
                  : t("common.signInToReadUsage")}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                relay.dismissFlow();
              }}
            >
              {t("connectionPanels.done")}
            </Button>
          </>
        )}
      </div>
    </Card>
  );
}

export function ConnectionPanels({ cliFlow = true }: { cliFlow?: boolean }) {
  return (
    <>
      <DesktopPendingPanel />
      {cliFlow && <CliFlowPanel />}
    </>
  );
}
