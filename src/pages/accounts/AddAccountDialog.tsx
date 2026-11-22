import { useEffect, useRef, useState, type ReactNode } from "react";
import { Private } from "@/components/Private";
import { ArrowLeft, Check, ChevronRight, Globe2, LoaderCircle, Monitor, Terminal } from "lucide-react";
import type { Account, AccountProvider, OneClickCascadeResult } from "../../../shared/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { WorkspaceSelect } from "../../features/DesktopSetup";
import {
  CliFlowPanel,
  DesktopPendingActions,
  autoCaptureLine,
} from "@/app/ConnectionPanels";
import { RelayErrorAlert } from "@/app/RelayErrorAlert";
import { CliSetupActions } from "../../features/CliSetup";
import {
  ProfileFields,
  groupsShown,
  profileInput,
  profileValue,
  type ProfileValue,
} from "../../features/ProfileFields";
import {
  blockReason,
  cliBlocked,
  cliDetail,
  cliState,
  desktopBlock,
} from "@/lib/onboarding";
import {
  CascadeResult,
  ConnectionDone,
  DetectedImport,
  ProviderForm,
  AntigravityOAuthForm,
  importable,
  useConnectForm,
  useDetectedProviders,
  type ImportOutcome,
} from "./AddAccountProviders";
import { ProviderBadge } from "@/components/ProviderBadge";
import type { AddProvider } from "@/app/routes";
import {
  isProvisionalName,
  provisionalName,
  suggestProfile,
} from "@/lib/profile-suggestion";

type Step = 1 | 2 | 3;

export function AddAccountDialog({
  open,
  onOpenChange,
  provider,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Open on this provider's own way in (e.g. "Add a Codex account first" on the gateway). */
  provider?: AddProvider;
}) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{t("common.addAccount")}</DialogTitle>
        </DialogHeader>
        {/* Radix unmounts the content when closed, so each opening starts at the first provider. */}
        <AddAccountFlow close={() => onOpenChange(false)} start={provider} />
      </DialogContent>
    </Dialog>
  );
}

/** Which part of the add dialog is open. */
type View = "home" | "claude" | "codex" | "antigravity";

/**
 * Adding accounts. The first view lists the sessions found on this Mac, ticked, and adds them all
 * with one button; under it are the other ways in: a new Claude sign-in (the Claude app reopens
 * at its sign-in and Relay saves the account by itself), Codex (its CLI sign-in or an API key) and
 * Google Antigravity. A Claude account that still waits for the Claude app continues in the
 * steps (`AddAccountSteps`).
 */
export function AddAccountFlow({ close, start }: { close: () => void; start?: AddProvider }) {
  const relay = useRelay();
  const { t } = useI18n();
  const { accounts, busy, desktop, desktopBusy, pendingDesktop } = relay;
  // A Claude account this dialog left half-made: a profile still waiting for its Claude app
  // sign-in. Only that one is picked up again; a sign-in or save running for an account that
  // already has its Claude app sign-in is not this dialog's business.
  const waiting = [pendingDesktop?.id, desktop?.autoCapture?.accountId].find(
    (id) => !!id && accounts.some((a) => a.id === id && !a.desktop),
  );
  // Asked for a provider: its own way in, whatever else waits. Claude starts at the list of
  // what was found, where its import and a new sign-in both sit.
  const [view, setView] = useState<View>(
    start === "codex" || start === "antigravity" ? start : waiting && !start ? "claude" : "home",
  );
  const [continueId, setContinueId] = useState<string | undefined>(
    start === "codex" || start === "antigravity" ? undefined : waiting,
  );
  const [outcomes, setOutcomes] = useState<ImportOutcome[]>();
  const [single, setSingle] = useState<{ result: OneClickCascadeResult; provider: AccountProvider }>();
  const detected = useDetectedProviders();
  const sessions = importable(detected);
  const [form, setForm] = useConnectForm(
    view === "antigravity" ? "antigravity" : "codex",
    accounts.map((a) => a.name),
  );
  const desktopLock = desktopBlock({ desktop, desktopBusy, pendingDesktop });
  const home = () => {
    setView("home");
    setSingle(undefined);
    setOutcomes(undefined);
    setContinueId(undefined);
    setForm((f) => ({ ...f, apiKey: "" }));
  };
  const imported = (list: ImportOutcome[]) => {
    // A Claude account that still waits for the Claude app goes on in the steps.
    const waiting = list.find(
      (o): o is Extract<ImportOutcome, { result: OneClickCascadeResult }> =>
        "result" in o && o.provider === "claude" && o.result.layers.desktop === "pending",
    );
    setOutcomes(list);
    if (waiting) {
      setContinueId(waiting.result.account.id);
      setView("claude");
    }
  };
  const back = !busy && (
    <Button type="button" variant="ghost" size="sm" className="w-fit" onClick={home}>
      <ArrowLeft />
      {t("addAccountDialog.back")}
    </Button>
  );

  if (single)
    return <ConnectionDone result={single.result} provider={single.provider} onAnother={home} close={close} />;
  if (outcomes && view === "home") return <ImportDone outcomes={outcomes} onAnother={home} close={close} />;
  if (view === "claude")
    return (
      <div className="grid gap-3">
        {back}
        {outcomes?.some((o) => "result" in o && o.provider !== "claude") && (
          <p role="status" className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
            <Check aria-hidden="true" className="size-4 text-ok" />
            {t("addAccountDialog.addedTheClaudeAccountIsNext", { join: outcomes.flatMap((o) => ("result" in o && o.provider !== "claude" ? [o.result.account.name] : [])).join(", ") })}
          </p>
        )}
        <AddAccountSteps
          key={continueId ?? "new"}
          close={close}
          initial={continueId ? { step: 1, id: continueId } : undefined}
          autoBegin={!continueId && !pendingDesktop && !desktop?.autoCapture}
          forceLogin={!continueId}
        />
      </div>
    );
  if (view === "antigravity")
    return (
      <div className="grid gap-3">
        {back}
        <AntigravityOAuthForm
          form={form}
          onChange={setForm}
          onResult={(result) => setSingle({ result, provider: "antigravity" })}
          close={close}
        />
      </div>
    );
  if (view === "codex")
    return (
      <div className="grid gap-3">
        {back}
        <ProviderForm
          provider="codex"
          form={form}
          onChange={setForm}
          session={detected.codex}
          onResult={(result) => setSingle({ result, provider: "codex" })}
          close={close}
        />
      </div>
    );

  const ways: { view: View; provider: AccountProvider; title: string; hint: string; disabled?: string }[] = [
    {
      view: "claude",
      provider: "claude",
      title: t("addAccountDialog.signInWithAnotherClaudeAccount"),
      hint: t("addAccountDialog.theClaudeAppReopensAtIts"),
      ...(desktopLock && blockReason(desktopLock, t) ? { disabled: blockReason(desktopLock, t) } : {}),
    },
    {
      view: "codex",
      provider: "codex",
      title: t("addAccountDialog.openaiCodex"),
      hint: t("addAccountDialog.aCodexCliSignInOr"),
    },
    {
      view: "antigravity",
      provider: "antigravity",
      title: t("addAccountDialog.googleAntigravity"),
      hint: t("addAccountDialog.signInWithGoogleNoApi"),
    },
  ];
  return (
    <div className="grid gap-4">
      <RelayErrorAlert />
      {sessions.length > 0 && <DetectedImport sessions={sessions} onDone={imported} />}
      <section aria-labelledby="add-other-title" className="grid gap-1.5">
        <h3 id="add-other-title" className="text-xs font-semibold text-muted-foreground">
          {sessions.length ? t("addAccountDialog.addAnotherAccount") : t("addAccountDialog.howDoYouWantToAdd")}
        </h3>
        <ul className="grid gap-1.5">
          {ways.map((way) => (
            <li key={way.view}>
              <button
                type="button"
                data-way={way.view}
                disabled={!!busy || !!way.disabled}
                onClick={() => setView(way.view)}
                className="flex w-full items-center gap-3 rounded-lg border bg-card px-3.5 py-2.5 text-left outline-none hover:bg-foreground/5 focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60"
              >
                <ProviderBadge provider={way.provider} />
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="text-sm font-medium">{way.title}</span>
                  <span className="text-xs text-muted-foreground">{way.disabled ?? way.hint}</span>
                </span>
                <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              </button>
            </li>
          ))}
        </ul>
      </section>
      <div className="flex justify-end">
        <Button type="button" variant="ghost" size="sm" onClick={close}>
          {t("common.close")}
        </Button>
      </div>
    </div>
  );
}

/** What one import added (or why not), then another round or done. */
function ImportDone({
  outcomes,
  onAnother,
  close,
}: {
  outcomes: ImportOutcome[];
  onAnother: () => void;
  close: () => void;
}) {
  const { t } = useI18n();
  const added = outcomes.filter((o) => "result" in o).length;
  return (
    <div className="grid gap-3" data-slot="import-done">
      <h3 className="text-lg leading-snug font-semibold">
        {t("addAccountDialog.accountsAdded", { count: added })}
      </h3>
      <ul className="grid gap-1.5">
        {outcomes.map((outcome, index) => (
          <li key={index} className="grid gap-1 rounded-lg border bg-card px-3.5 py-2.5">
            <span className="flex items-center gap-2 text-sm">
              <ProviderBadge provider={outcome.provider} />
              {"result" in outcome ? (
                <span className="min-w-0 truncate">
                  {outcome.result.account.name}
                  {outcome.result.account.auth?.email ? <> · <Private>{outcome.result.account.auth.email}</Private></> : ""}
                </span>
              ) : (
                <span role="alert" className="min-w-0 text-crit">
                  {outcome.error}
                </span>
              )}
            </span>
            {"result" in outcome && <CascadeResult result={outcome.result} />}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onAnother}>
          {t("addAccountDialog.addAnotherAccount2")}
        </Button>
        <Button type="button" onClick={close}>
          {t("addAccountDialog.done")}
        </Button>
      </div>
    </div>
  );
}

/**
 * Where the wizard stands: three segments, each a bar over its numbered name; done and current
 * bars are filled, the current name is bold.
 */
function StepIndicator({ step }: { step: Step }) {
  const { t } = useI18n();
  const titles = [
    t("common.claudeApp"),
    t("addAccountDialog.claudeCodeSignIn"),
    t("common.ready"),
  ];
  return (
    <div className="grid gap-2">
      <ol
        className="grid grid-cols-3 gap-1.5 text-xs"
        aria-label={t("addAccountDialog.steps")}
      >
        {titles.map((title, index) => {
          const n = (index + 1) as Step;
          const done = n < step;
          const active = n === step;
          return (
            <li
              key={title}
              className="grid min-w-0 gap-1.5"
              aria-current={active ? "step" : undefined}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "h-1 rounded-full",
                  done || active ? "bg-primary" : "bg-track",
                )}
              />
              <span
                className={cn(
                  "flex min-w-0 items-start gap-1 leading-tight",
                  active ? "font-semibold" : "text-muted-foreground",
                )}
              >
                {done && <Check aria-hidden="true" className="size-3 shrink-0 text-ok" />}
                {done ? title : `${n} · ${title}`}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** A step's own heading. */
function StepTitle({ children }: { children: ReactNode }) {
  return <h3 className="text-lg font-semibold leading-snug">{children}</h3>;
}

/**
 * Adding an account in three steps, with one confirmation for the Claude app's restarts:
 * 1. the Claude app sign-in: the account open in Claude now, or a new sign-in; Relay saves it by
 *    itself once Code is opened (see AutoCapture);
 * 2. the usage sign-in, started on its own in Relay's window;
 * 3. the name, type and group, suggested from the sign-in.
 * The profile is created with a provisional name at the start; closing before the Claude app
 * sign-in removes it again. Rendered outside the dialog so it can be tested statically.
 */
export function AddAccountSteps({
  close,
  initial,
  intro,
  autoBegin = false,
  forceLogin = false,
}: {
  close: () => void;
  /** Start the Claude app sign-in at once: the click that opened these steps asked for it. */
  autoBegin?: boolean;
  /** Always a new sign-in, never the account open in the Claude app now (that one is imported). */
  forceLogin?: boolean;
  /** The first step's one-click panel, above its step-by-step button. */
  intro?: ReactNode;
  /** Tests start at a later step for an existing profile. */
  initial?: { step: Step; id: string };
}) {
  const relay = useRelay();
  const { t, language } = useI18n();
  const { api, accounts, busy, action, desktop, desktopBusy, pendingDesktop, settings } = relay;
  const [step, setStep] = useState<Step>(initial?.step ?? 1);
  const [createdId, setCreatedId] = useState(initial?.id);
  const [created, setCreated] = useState<Account>();
  // The snapshot catches up after creation; until then use the API's result.
  const account =
    accounts.find((a) => a.id === createdId) ??
    (created?.id === createdId ? created : undefined);
  const desktopLock = desktopBlock({ desktop, desktopBusy, pendingDesktop });
  const current = !forceLogin && !!relay.hasUnclaimedDesktop;
  const cli = cliState(relay.data?.diagnostics);
  const flow = relay.flow?.accountId === account?.id ? relay.flow : undefined;
  const auto = desktop?.autoCapture?.accountId === account?.id ? desktop?.autoCapture : undefined;
  const linked = !!account?.desktop;
  const connected = !!account?.auth?.loggedIn;

  // A saved Claude app sign-in moves on to the usage step, a finished usage sign-in to the end.
  useEffect(() => {
    if (linked) setStep((s) => (s === 1 ? 2 : s));
  }, [linked]);
  useEffect(() => {
    if (connected) setStep((s) => (s === 2 ? 3 : s));
  }, [connected]);

  // The usage sign-in starts on its own, once per profile. A call the action lock refused, or
  // one that failed, leaves it unstarted, so the next render tries again.
  const startedFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (step !== 2 || !account || connected || flow || cliBlocked(cli)) return;
    if (startedFor.current === account.id) return;
    const id = account.id;
    void relay.startCli(account).then((started) => {
      if (started) startedFor.current = id;
    });
  }, [step, account, connected, flow, cli, relay]);

  // Closing before the Claude app sign-in was saved takes the provisional profile away again,
  // also one whose creation was still running then.
  const latest = useRef({ account, pending: false });
  latest.current = { account, pending: pendingDesktop?.id === account?.id };
  const creating = useRef<Promise<Account> | undefined>(undefined);
  const closed = useRef(false);
  useEffect(() => {
    closed.current = false;
    return () => {
      closed.current = true;
      const { account: left, pending } = latest.current;
      if (initial) return;
      if (!left) {
        void creating.current?.then((made) => api.removeAccount(made.id)).catch(() => {});
        return;
      }
      if (left.desktop || left.auth?.loggedIn) return;
      void api.disarmAutoCapture(left.id).catch(() => {});
      if (!pending) void api.removeAccount(left.id).catch(() => {});
    };
  }, []);

  const begin = () =>
    void action("create", async () => {
      let next = account;
      if (!next) {
        const made = api.createAccount({ name: provisionalName(accounts, t), kind: "personal" });
        creating.current = made;
        try {
          next = await made;
        } finally {
          creating.current = undefined;
        }
        // Closed meanwhile: the cleanup above removes it, so no sign-in starts for it.
        if (closed.current) return;
        setCreated(next);
        setCreatedId(next.id);
      }
      relay.requestDesktop(next, current ? "capture" : "login");
    });

  // Opened by "Sign in with another Claude account": that click starts the sign-in, once.
  const begun = useRef(false);
  useEffect(() => {
    if (!autoBegin || begun.current || account || busy || desktopLock) return;
    begun.current = true;
    begin();
  });

  const [profile, setProfile] = useState<ProfileValue>();
  useEffect(() => {
    if (step !== 3 || !account || profile) return;
    const suggestion = isProvisionalName(account.name, t) ? suggestProfile(account, accounts, language) : undefined;
    setProfile(
      suggestion
        ? { name: suggestion.name, kind: suggestion.kind, group: suggestion.group ?? "" }
        : profileValue(account),
    );
  }, [step, account, accounts, profile]);
  const save = (then: () => void) =>
    void action("profile", async () => {
      if (account && profile) {
        const input = profileInput(profile, groupsShown(settings.desktopHistoryTransfer, profile.kind, t));
        const same =
          input.name === account.name &&
          input.kind === account.kind &&
          (input.group ?? "") === profileValue(account).group;
        if (!same) await api.updateAccount(account.id, input);
      }
      then();
    });
  const another = () =>
    save(() => {
      setCreated(undefined);
      setCreatedId(undefined);
      setProfile(undefined);
      setStep(1);
    });

  const showIntroFirst =
    step === 1 &&
    !!intro &&
    !(account && pendingDesktop?.id === account.id) &&
    !(auto && auto.status !== "failed" && auto.status !== "saved");

  return (
    <div className="grid gap-4">
      {showIntroFirst ? (
        <>
          <RelayErrorAlert />
          <div className="grid gap-3 rounded-lg border bg-card px-3.5 py-3">
            {intro}
          </div>
          {auto?.status === "failed" && (
            <p role="status" className="text-sm text-warn-foreground">
              {autoCaptureLine(auto, auto.accountId, t, language)}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <Button variant="outline" size="sm" disabled={!!busy || !!desktopLock} onClick={begin}>
                {busy === "create" && <LoaderCircle className="animate-spin" />}
                {current
                  ? t("addAccountDialog.addThisAccount")
                  : t("addAccountDialog.openSignInInTheClaude")}
              </Button>
              {desktopLock && blockReason(desktopLock, t) && (
                <small className="text-xs text-muted-foreground">{blockReason(desktopLock, t)}</small>
              )}
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={close}>
              {t("common.cancel")}
            </Button>
          </div>
        </>
      ) : (
        <>
          <StepIndicator step={step} />
          {/* The page banners sit under the overlay; failures from these steps show here. */}
          <RelayErrorAlert />
          {step === 1 && (
            <>
              <StepTitle>
                {current
                  ? t("addAccountDialog.addTheAccountOpenInThe")
                  : t("addAccountDialog.signInWithTheNewAccount")}
              </StepTitle>
              {account && pendingDesktop?.id === account.id ? (
                <div className="grid gap-3">
                  <StatusLine tone="warn" icon={<Monitor />}>
                    {t("common.signInToTheClaudeApp")}
                  </StatusLine>
                  <DesktopPendingActions />
                </div>
              ) : auto && auto.status !== "failed" && auto.status !== "saved" ? (
                <div className="grid gap-3">
                  <StatusLine tone="warn" icon={<Monitor />}>
                    {autoCaptureLine(auto, auto.accountId, t, language)}
                  </StatusLine>
                  {auto.status === "choose-org" && auto.orgs && (
                    <WorkspaceSelect
                      accounts={accounts}
                      organizations={auto.orgs}
                      value=""
                      onChange={(orgId) =>
                        void action("auto-capture", () => api.chooseAutoCaptureOrg(auto.accountId, orgId))
                      }
                      suggested={auto.suggestedOrg}
                      t={t}
                    />
                  )}
                  {auto.status === "waiting" && (
                    <div>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={desktopBusy}
                        onClick={() => void action("open", () => api.openCodeTab())}
                      >
                        {t("common.openCode")}
                      </Button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="grid gap-3">
                  {auto?.status === "failed" && (
                    <p role="status" className="text-sm text-warn-foreground">
                      {autoCaptureLine(auto, auto.accountId, t, language)}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <Button disabled={!!busy || !!desktopLock} onClick={begin}>
                      {busy === "create" && <LoaderCircle className="animate-spin" />}
                      {current
                        ? t("addAccountDialog.addThisAccount")
                        : t("addAccountDialog.openSignInInTheClaude")}
                    </Button>
                    {desktopLock && blockReason(desktopLock, t) && (
                      <small className="text-xs text-muted-foreground">{blockReason(desktopLock, t)}</small>
                    )}
                  </div>
                </div>
              )}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={close}>
                  {t("common.cancel")}
                </Button>
              </div>
            </>
          )}
        </>
      )}
      {step === 2 && account && (
        <>
          <StepTitle>
            {t("addAccountDialog.claudeCodeSignInFor", { accountName: account.name })}
          </StepTitle>
          <p className="text-sm text-muted-foreground">
            {t("addAccountDialog.theGatewayTheTerminalAndLimit")}
          </p>
          {/* The page-frame panel sits under the overlay; finish the sign-in here. */}
          {flow ? (
            <CliFlowPanel embedded />
          ) : connected ? (
            <StatusLine tone="ok" icon={<Globe2 />}>
              {t("addAccountDialog.connected")}
              {account.auth?.email ? ` · ${account.auth.email}` : ""}
            </StatusLine>
          ) : cliBlocked(cli) ? (
            <div className="grid gap-2">
              <StatusLine tone="warn" icon={<Terminal />}>
                {`Claude Code · ${cliDetail(cli, relay.data?.diagnostics.version, t)}`}
              </StatusLine>
              <p className="text-sm text-muted-foreground">
                {t("addAccountDialog.relayNeedsClaudeCodeToRead")}
              </p>
              <CliSetupActions />
            </div>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            {!flow && !connected && !cliBlocked(cli) && (
              <Button
                variant="outline"
                disabled={!!busy}
                onClick={() => void relay.startCli(account)}
              >
                <Globe2 />
                {t("addAccountDialog.signInWithClaudeCode")}
              </Button>
            )}
            <Button variant={connected ? "default" : "ghost"} onClick={() => setStep(3)}>
              {connected ? t("addAccountDialog.continue") : t("addAccountDialog.doItLater")}
            </Button>
          </div>
        </>
      )}
      {step === 3 && account && (
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save(close);
          }}
        >
          <StepTitle>{t("addAccountDialog.accountReady")}</StepTitle>
          <div className="grid gap-2">
            <StatusLine tone={linked ? "ok" : "warn"} icon={<Monitor />} static>
              {linked
                ? t("addAccountDialog.claudeAppSignInSaved")
                : t("addAccountDialog.claudeAppSignInNotSaved")}
            </StatusLine>
            <StatusLine tone={connected ? "ok" : "warn"} icon={<Globe2 />} static>
              {connected
                ? account.auth?.email
                  ? t("addAccountDialog.claudeCodeSignInConnectedEmail", { email: account.auth.email })
                  : t("addAccountDialog.claudeCodeSignInConnected")
                : t("addAccountDialog.noClaudeCodeSignInThe")}
            </StatusLine>
          </div>
          {profile && (
            <ProfileFields id="add-account" value={profile} onChange={setProfile} exceptId={account.id} />
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="ghost" disabled={!!busy || !profile?.name.trim()} onClick={another}>
              {t("addAccountDialog.addAnotherAccount2")}
            </Button>
            <Button type="submit" disabled={!!busy || !profile?.name.trim()}>
              {busy === "profile" && <LoaderCircle className="animate-spin" />}
              {t("addAccountDialog.saveAndFinish")}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

/**
 * One state row: a check when done, a spinner while waiting (or a still mark with `static`),
 * then what it is.
 */
function StatusLine({
  tone,
  icon,
  children,
  static: still = false,
}: {
  tone: "ok" | "warn";
  icon: ReactNode;
  children: ReactNode;
  static?: boolean;
}) {
  return (
    <div
      className="flex items-center gap-2.5 rounded-lg border bg-card px-3.5 py-2.5 text-sm [&>svg]:size-4 [&>svg]:shrink-0"
      aria-live="polite"
    >
      {tone === "ok" ? (
        <span aria-hidden="true" className="grid size-5 shrink-0 place-items-center rounded-full bg-ok/15 text-ok">
          <Check className="size-3" />
        </span>
      ) : still ? (
        <span aria-hidden="true" className="size-5 shrink-0 rounded-full border-2 border-warn/60" />
      ) : (
        <LoaderCircle aria-hidden="true" className="animate-spin text-warn" />
      )}
      <span className="min-w-0 flex-1">{children}</span>
      <span aria-hidden="true" className="text-muted-foreground [&>svg]:size-4">
        {icon}
      </span>
    </div>
  );
}
